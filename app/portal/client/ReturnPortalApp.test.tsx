/**
 * @vitest-environment jsdom
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReturnPortalApp } from "./App";
import type { PortalBootstrap } from "./types";

function bootstrap(overrides: Partial<PortalBootstrap> = {}): PortalBootstrap {
  return {
    appUrl: "https://app.test",
    shop: "store.myshopify.com",
    returnWindowDays: 30,
    returnPolicy: "Items must be unused.",
    returnReasons: ["Wrong size", "Damaged"],
    returnReasonsByCategory: {},
    config: {
      showOrderTracking: true,
      showReturnTracking: true,
      showCreateReturnTab: true,
      defaultTab: "return",
      allowMediaUploads: true,
      allowReturnCancellation: true,
    },
    labels: {},
    locale: "en",
    currency: "USD",
    timezone: "UTC",
    features: { portalExchangeEnabled: true },
    csrfToken: "csrf",
    brandLogoUrl: "",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: init?.status || 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
}

describe("ReturnPortalApp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.__RPM_PORTAL_CSRF__ = "csrf";
    window.__RPM_AUTH_TOKEN__ = undefined;
  });

  it("renders only enabled tabs", () => {
    render(
      <ReturnPortalApp
        bootstrap={bootstrap({
          config: {
            showOrderTracking: true,
            showReturnTracking: false,
            showCreateReturnTab: true,
            defaultTab: "order",
            allowMediaUploads: true,
            allowReturnCancellation: true,
          },
        })}
      />,
    );

    expect(screen.getByRole("tab", { name: /track order/i })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /track return/i })).toBeNull();
    expect(screen.getByRole("tab", { name: /create return/i })).toBeTruthy();
  });

  it("validates an empty lookup before calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ReturnPortalApp bootstrap={bootstrap()} />);

    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Please enter");
  });

  it("completes an OTP-gated lookup and renders returns", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/api/portal/lookup") && !body.portalToken) {
        return jsonResponse({ requiresOtp: true, sessionId: "sess_1" });
      }
      if (url.endsWith("/api/portal/otp/verify")) {
        return jsonResponse({ portalToken: "portal_token" });
      }
      if (url.endsWith("/api/portal/lookup") && body.portalToken) {
        return jsonResponse({
          returns: [
            {
              id: "ret_1",
              returnRequestNo: "RPM-1001",
              shopifyOrderName: "#1001",
              status: "approved",
              createdAt: "2026-01-01T00:00:00.000Z",
              items: [{ id: "item_1", title: "Shirt", qty: 1, reasonCode: "Wrong size" }],
            },
          ],
          orders: [],
          portalCsrfToken: "csrf_2",
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReturnPortalApp bootstrap={bootstrap()} />);

    fireEvent.change(screen.getByLabelText(/return request id/i), {
      target: { value: "RPM-1001" },
    });
    fireEvent.click(screen.getByRole("button", { name: /look up/i }));

    expect(await screen.findByText(/verify your email/i)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("000000"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByText("RPM-1001")).toBeTruthy();
    expect(window.__RPM_AUTH_TOKEN__).toBe("portal_token");
    expect(window.__RPM_PORTAL_CSRF__).toBe("csrf_2");
  });

  it("submits selected items through the create-return API", async () => {
    const createPayloads: Record<string, unknown>[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/order?")) {
        return jsonResponse({
          order: {
            id: "gid://shopify/Order/1",
            name: "#1001",
            email: "customer@example.com",
            createdAt: "2026-01-01T00:00:00.000Z",
            processedAt: "2026-01-01T00:00:00.000Z",
            currencyCode: "USD",
            lineItems: [
              {
                id: "li_1",
                title: "Shirt",
                quantity: 2,
                price: "50",
                productTags: ["apparel"],
                productType: "Tops",
              },
            ],
          },
          lineItemAvailability: {
            li_1: { orderedQty: 2, returnedQty: 0, availableQty: 2, alreadyInReturn: false },
          },
          returnOffers: { enabled: false, offers: [] },
          portalCsrfToken: "csrf_order",
        });
      }
      if (url.endsWith("/api/portal/create-return")) {
        createPayloads.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          success: true,
          returnId: "ret_1",
          returnRequestId: "RPM-NEW",
          status: "pending",
          summary: { orderName: "#1001", itemsCount: 1, nextSteps: "Review pending." },
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReturnPortalApp bootstrap={bootstrap()} />);

    fireEvent.click(screen.getByRole("tab", { name: /create return/i }));
    fireEvent.change(screen.getByPlaceholderText(/#1001/i), { target: { value: "1001" } });
    fireEvent.click(screen.getByRole("button", { name: /find order/i }));

    expect(await screen.findByText("Select items")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /select shirt/i }));
    fireEvent.change(screen.getByLabelText(/upload return photos/i), {
      target: {
        files: [new File(["image"], "shirt.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^submit return$/i }));

    expect(await screen.findByText("RPM-NEW")).toBeTruthy();
    const createPayload = createPayloads[0];
    expect(createPayload?.portalCsrfToken).toBe("csrf_order");
    expect(createPayload?.shopifyOrderName).toBe("#1001");
    expect(createPayload?.items).toEqual([
      expect.objectContaining({ lineItemId: "li_1", qty: 1, reasonCode: "Wrong size" }),
    ]);
  });

  it("clubs duplicate Fynd shipment bags into one selectable line item", async () => {
    const createPayloads: Record<string, unknown>[] = [];
    const shipments = [
      {
        shipmentId: "SHIP-14425",
        shipmentStatus: "delivery_done",
        eligible: true,
        items: Array.from({ length: 4 }, (_, index) => ({
          id: "gid://shopify/LineItem/14425",
          bagId: `BAG-${index + 1}`,
          title: "RETURN3",
          variantTitle: "M",
          sku: "RETURN3",
          quantity: 1,
          price: "100",
          imageUrl: null,
          productTags: [],
          productType: "Tops",
          fyndQuantityAvailable: 1,
          fyndLineNumber: index + 1,
        })),
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/order?")) {
        return jsonResponse({
          order: {
            id: "gid://shopify/Order/14425",
            name: "#FYNDSHOPIFYX14425",
            email: "customer@example.com",
            createdAt: "2026-01-01T00:00:00.000Z",
            processedAt: "2026-01-01T00:00:00.000Z",
            currencyCode: "INR",
            lineItems: [
              {
                id: "gid://shopify/LineItem/14425",
                title: "RETURN3",
                variantTitle: "M",
                sku: "RETURN3",
                quantity: 4,
                price: "100",
                productTags: [],
                productType: "Tops",
              },
            ],
          },
          shipments,
          lineItemAvailability: {
            "gid://shopify/LineItem/14425": {
              orderedQty: 4,
              returnedQty: 0,
              availableQty: 4,
              alreadyInReturn: false,
            },
          },
          returnOffers: { enabled: false, offers: [] },
          portalCsrfToken: "csrf_order",
        });
      }
      if (url.endsWith("/api/portal/create-return")) {
        createPayloads.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          success: true,
          returnId: "ret_14425",
          returnRequestId: "RPM-14425",
          status: "pending",
          summary: { orderName: "#FYNDSHOPIFYX14425", itemsCount: 3 },
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReturnPortalApp bootstrap={bootstrap()} />);

    fireEvent.click(screen.getByRole("tab", { name: /create return/i }));
    fireEvent.change(screen.getByPlaceholderText(/#1001/i), {
      target: { value: "FYNDSHOPIFYX14425" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find order/i }));

    expect(await screen.findByText("Select items")).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /select return3/i })).toHaveLength(1);
    expect(screen.getByText(/Available 4/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /select return3/i }));
    const itemRow = screen.getByText("RETURN3").closest(".rpm-item-row");
    expect(itemRow).toBeTruthy();
    fireEvent.change(within(itemRow as HTMLElement).getByRole("combobox"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/upload return photos/i), {
      target: {
        files: [new File(["image"], "return3.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^submit return$/i }));

    expect(await screen.findByText("RPM-14425")).toBeTruthy();
    expect(createPayloads[0]?.items).toEqual([
      expect.objectContaining({ lineItemId: "gid://shopify/LineItem/14425", qty: 1, reasonCode: "Wrong size" }),
      expect.objectContaining({ lineItemId: "gid://shopify/LineItem/14425", qty: 1, reasonCode: "Wrong size" }),
      expect.objectContaining({ lineItemId: "gid://shopify/LineItem/14425", qty: 1, reasonCode: "Wrong size" }),
    ]);
    expect(createPayloads[0]?.shipmentsSnapshot).toEqual(shipments);
  });

  it("clubs identical Fynd rows even when each row has a different line id", async () => {
    const createPayloads: Record<string, unknown>[] = [];
    const shipments = [
      {
        shipmentId: "SHIP-SPLIT",
        shipmentStatus: "delivery_done",
        eligible: true,
        items: Array.from({ length: 4 }, (_, index) => ({
          id: `fynd-bag-line-${index + 1}`,
          bagId: `BAG-SPLIT-${index + 1}`,
          title: "RETURN3",
          variantTitle: "M",
          sku: "RETURN3",
          quantity: 1,
          price: "100",
          imageUrl: null,
          productTags: [],
          productType: "Tops",
          fyndQuantityAvailable: 1,
          fyndLineNumber: index + 1,
        })),
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/portal/order?")) {
        return jsonResponse({
          order: {
            id: "FYNDSHOPIFYX14425",
            name: "#FYNDSHOPIFYX14425",
            email: "customer@example.com",
            createdAt: "2026-01-01T00:00:00.000Z",
            processedAt: "2026-01-01T00:00:00.000Z",
            currencyCode: "INR",
            lineItems: shipments[0].items.map((item) => ({
              id: item.id,
              title: item.title,
              variantTitle: item.variantTitle,
              sku: item.sku,
              quantity: 1,
              price: item.price,
              productTags: [],
              productType: "Tops",
            })),
          },
          shipments,
          lineItemAvailability: Object.fromEntries(
            shipments[0].items.map((item) => [
              item.id,
              { orderedQty: 1, returnedQty: 0, availableQty: 1, alreadyInReturn: false },
            ]),
          ),
          returnOffers: { enabled: false, offers: [] },
          portalCsrfToken: "csrf_order",
        });
      }
      if (url.endsWith("/api/portal/create-return")) {
        createPayloads.push(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>);
        return jsonResponse({
          success: true,
          returnId: "ret_split",
          returnRequestId: "RPM-SPLIT",
          status: "pending",
          summary: { orderName: "#FYNDSHOPIFYX14425", itemsCount: 3 },
        });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ReturnPortalApp bootstrap={bootstrap()} />);

    fireEvent.click(screen.getByRole("tab", { name: /create return/i }));
    fireEvent.change(screen.getByPlaceholderText(/#1001/i), {
      target: { value: "FYNDSHOPIFYX14425" },
    });
    fireEvent.click(screen.getByRole("button", { name: /find order/i }));

    expect(await screen.findByText("Select items")).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /select return3/i })).toHaveLength(1);
    expect(screen.getByText(/Available 4/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /select return3/i }));
    const itemRow = screen.getByText("RETURN3").closest(".rpm-item-row");
    expect(itemRow).toBeTruthy();
    fireEvent.change(within(itemRow as HTMLElement).getByRole("combobox"), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByLabelText(/upload return photos/i), {
      target: {
        files: [new File(["image"], "return3.png", { type: "image/png" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /^submit return$/i }));

    expect(await screen.findByText("RPM-SPLIT")).toBeTruthy();
    expect(createPayloads[0]?.items).toEqual([
      expect.objectContaining({ lineItemId: "fynd-bag-line-1", qty: 1 }),
      expect.objectContaining({ lineItemId: "fynd-bag-line-2", qty: 1 }),
      expect.objectContaining({ lineItemId: "fynd-bag-line-3", qty: 1 }),
    ]);
  });
});
