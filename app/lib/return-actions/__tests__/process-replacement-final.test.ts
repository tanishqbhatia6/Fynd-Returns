/**
 * Final coverage closer for `handleProcessReplacement`.
 *
 * Sibling `process-replacement-deep.test.ts` covers the broad branch matrix.
 * This file targets the last six uncovered functions to push the file to
 * 100% function coverage:
 *
 *   FN @139:49  — `.map((s) => ...)` for stockoutLines human-readable string
 *   FN @148:25  — `.catch(() => {})` swallowing `replacement_inventory_blocked` create rejection
 *   FN @210:51  — `.map((e) => e.message).join("; ")` over draft top-level errors
 *   FN @222:45  — `.map((e) => e.message).join("; ")` over draft userErrors
 *   FN @331:27  — `.catch(() => {})` swallowing `fynd_replacement_synced` create rejection
 *   FN @342:25  — `.catch(() => {})` swallowing `fynd_replacement_sync_failed` create rejection
 *
 * Strategy: drive the SUT into each branch, then for the .catch arrow
 * handlers, force `prisma.returnEvent.create` to REJECT on the relevant
 * eventType and verify the handler still completes (the rejection is
 * silently swallowed by the .catch).
 *
 * No source mods. Mocks are shared between tests via vi.hoisted; reset in
 * beforeEach so cross-test pollution cannot mask coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchVariantInfoMock,
  closeShopifyReturnBestEffortMock,
  createFyndClientOrErrorMock,
  sendApprovalNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchVariantInfoMock: vi.fn<(...args: unknown[]) => Promise<Map<string, unknown>>>(
    async () => new Map(),
  ),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchVariantInfo: fetchVariantInfoMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
}));

import { handleProcessReplacement } from "../process-replacement.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const DRAFT_OK = {
  data: {
    draftOrderCreate: {
      draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
      userErrors: [],
    },
  },
};
const COMPLETE_OK = {
  data: {
    draftOrderComplete: {
      draftOrder: {
        id: "gid://shopify/DraftOrder/1",
        name: "D1",
        order: { id: "gid://shopify/Order/9", name: "#9" },
      },
      userErrors: [],
    },
  },
};

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "R-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      customerEmailNorm: "u@example.com",
      customerPhoneNorm: null,
      adminNotes: null,
      currency: "USD",
      refundStatus: null,
      cancellationRequestedAt: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndPayloadJson: null,
      fyndCurrentStatus: null,
      shopifyReturnId: null,
      exchangeOrderId: null,
      resolutionType: null,
      isGreenReturn: false,
      items: [
        {
          id: "li-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 2,
          sku: "SKU-1",
          price: "10.00",
          reasonCode: null,
          notes: null,
          title: "Item 1",
        },
      ],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: {
      graphql: vi.fn(async () => ({ json: async () => DRAFT_OK })),
    } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

function mkAdmin(createRes: unknown, completeRes: unknown): ReturnHandlerContext["admin"] {
  let n = 0;
  return {
    graphql: vi.fn(async () => {
      n++;
      const body = n === 1 ? createRes : completeRes;
      return { json: async () => body };
    }),
  } as never;
}

async function expectRedirect(p: Promise<unknown>, frag: string) {
  try {
    await p;
    throw new Error("expected redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(frag);
  }
}

async function expectJsonError(p: Promise<unknown>, status: number, fragment: string) {
  const res = (await p) as Response;
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body.error).toContain(fragment);
  return body;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
});

describe("handleProcessReplacement — final coverage closers", () => {
  // ─── FN @139 + FN @148 ─────────────────────────────────────────────
  it("stockout path: builds human string and writes inventory_blocked event (409)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 2,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: 0 }]]),
    );
    const ctx = mkCtx();
    const body = await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      409,
      "out of stock",
    );
    // FN @139 produced the human string via .map((s) => ...)
    expect(body.error).toContain("Item 1 (need 2, only 0 in stock)");
    expect(body.stockoutLines).toBeDefined();
    expect(body.stockoutLines[0]).toMatchObject({ title: "Item 1", required: 2, available: 0 });
    // The inventory_blocked event create call DID happen (resolved path)
    const calls = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(calls).toContain("replacement_inventory_blocked");
  });

  it("stockout path: clamps negative inventoryAvailable to 0 and joins multi-line message", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 2,
          variantId: "gid://shopify/ProductVariant/V1",
        },
        {
          id: "gid://shopify/LineItem/2",
          title: "Item 2",
          sku: "SKU-2",
          price: "5.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V2",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map<string, { inventoryAvailable: number }>([
        ["gid://shopify/ProductVariant/V1", { inventoryAvailable: -3 }], // negative → clamp
        ["gid://shopify/ProductVariant/V2", { inventoryAvailable: 0 }],
      ]),
    );
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 2,
            sku: "SKU-1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "Item 1",
          },
          {
            id: "li-2",
            shopifyLineItemId: "gid://shopify/LineItem/2",
            qty: 1,
            sku: "SKU-2",
            price: "5.00",
            reasonCode: null,
            notes: null,
            title: "Item 2",
          },
        ],
      } as never,
    });
    const body = await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      409,
      "out of stock",
    );
    // Negative inventory clamped to 0 in the human string + joined with "; "
    expect(body.error).toContain("Item 1 (need 2, only 0 in stock)");
    expect(body.error).toContain("Item 2 (need 1, only 0 in stock)");
    expect(body.error).toContain("; ");
  });

  it("stockout: catch silently swallows when returnEvent.create rejects (FN @148)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 2,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: 0 }]]),
    );
    // Reject ONLY for the inventory_blocked event; default impl handles
    // any other create. Because the .catch is a sync arrow on the
    // returned Promise, the rejection becomes a no-op and the 409
    // response is still returned.
    prismaMock.returnEvent.create.mockImplementationOnce(async (args: unknown) => {
      const data = (args as { data: { eventType: string } }).data;
      if (data.eventType === "replacement_inventory_blocked") {
        throw new Error("DB write failed");
      }
      return { id: "ev-x", ...data };
    });
    const ctx = mkCtx();
    // The handler still returns the 409 — no unhandled rejection escaped.
    const body = await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      409,
      "out of stock",
    );
    expect(body.stockoutLines).toBeDefined();
  });

  // ─── FN @210 ───────────────────────────────────────────────────────
  it("draft top-level errors path: maps + joins messages (FN @210)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const draftErr = { errors: [{ message: "Field bad" }, { message: "Another problem" }] };
    const ctx = mkCtx({ admin: mkAdmin(draftErr, COMPLETE_OK) });
    const body = await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      400,
      "Failed to create replacement order",
    );
    // Both error messages joined with "; "
    expect(body.error).toContain("Field bad");
    expect(body.error).toContain("Another problem");
    expect(body.error).toContain("; ");
  });

  it("draft top-level errors with scope keyword: returns 403 with reinstall message", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const draftErr = { errors: [{ message: "access denied: write_draft_orders required" }] };
    const ctx = mkCtx({ admin: mkAdmin(draftErr, COMPLETE_OK) });
    await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      403,
      "write_draft_orders",
    );
  });

  // ─── FN @222 ───────────────────────────────────────────────────────
  it("draft userErrors path: maps + joins messages (FN @222)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const draftUserErr = {
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [
            { field: ["email"], message: "Email is invalid" },
            { message: "Quantity must be positive" },
          ],
        },
      },
    };
    const ctx = mkCtx({ admin: mkAdmin(draftUserErr, COMPLETE_OK) });
    const body = await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      400,
      "Failed to create replacement draft order",
    );
    expect(body.error).toContain("Email is invalid");
    expect(body.error).toContain("Quantity must be positive");
    expect(body.error).toContain("; ");
  });

  it("draft userErrors with scope keyword: returns 400 with reinstall message", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const draftUserErr = {
      data: {
        draftOrderCreate: {
          draftOrder: null,
          userErrors: [{ message: "access scope write_draft_orders missing" }],
        },
      },
    };
    const ctx = mkCtx({ admin: mkAdmin(draftUserErr, COMPLETE_OK) });
    await expectJsonError(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      400,
      "write_draft_orders",
    );
  });

  // ─── FN @331 ───────────────────────────────────────────────────────
  it("fynd_replacement_synced: catch silently swallows create rejection (FN @331)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    // For every create: reject when eventType is fynd_replacement_synced;
    // otherwise resolve normally so the rest of the handler completes.
    prismaMock.returnEvent.create.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { eventType: string } }).data;
      if (data.eventType === "fynd_replacement_synced") {
        throw new Error("DB write failed for synced");
      }
      return { id: "ev-x", ...data };
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    // Must still redirect — the rejection is silently swallowed by .catch
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // Confirm the rejected create was attempted
    const attempted = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(attempted).toContain("fynd_replacement_synced");
  });

  // ─── FN @342 ───────────────────────────────────────────────────────
  it("fynd_replacement_sync_failed: catch silently swallows create rejection (FN @342)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // Force the Fynd push to throw → enters the catch that writes _failed
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("Fynd 503");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    prismaMock.returnEvent.create.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { eventType: string } }).data;
      if (data.eventType === "fynd_replacement_sync_failed") {
        throw new Error("DB write failed for sync_failed");
      }
      return { id: "ev-x", ...data };
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    // Still redirects — the .catch eats the DB rejection
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const attempted = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(attempted).toContain("fynd_replacement_sync_failed");
  });
});
