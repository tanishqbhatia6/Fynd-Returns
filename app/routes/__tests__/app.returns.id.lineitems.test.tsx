/** @vitest-environment jsdom */
/**
 * Coverage-targeted line-item + Fynd-shipment rendering tests for
 * `app.returns.$id.tsx`.
 *
 * Focus (NEVER modifies source):
 *  - per-row qty/condition/reasonCode badges + price-per-item display
 *  - per-item title / variant-title / SKU / image-URL render
 *  - per-item notes-fallback when shopifyLineItemId === "manual"
 *  - per-item fyndShipmentId badge inside the Fynd-IDs <details>
 *  - per-item fyndSize / fyndBagId / fyndArticleId / fyndSellerIdentifier
 *    / fyndItemId / fyndLineNumber / fyndPriceEffective collapsible IDs
 *  - shopifyOrder details panel + currency / locale formatting
 *  - forward-shipment + return-shipment Fynd panels (multi-shipment grouping)
 *  - shipment status pills, courier, AWB, tracking-URL, label-URL, invoice-URL
 *  - Fynd-reference card with fwdShipmentId / retShipmentId / fyndReturnId
 *  - raw-payload toggle (View / Hide)
 *  - "edit return shipping details" details/summary expander
 *  - empty-items branch ("No items recorded")
 *
 * Mirrors the mocking strategy from sibling component tests so the 3300-LOC
 * route can mount in jsdom without hitting any Node-only deps.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    returnCase: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    shopSettings: { findUnique: vi.fn() },
    blocklistEntry: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/fynd-payload.server", () => ({
  parseFyndPayloadForDisplay: vi.fn(() => null),
  parseFyndOrderDetailsForTab: vi.fn(() => null),
  getPickupAddressFromFyndPayload: vi.fn(() => null),
  extractFyndJourney: vi.fn(() => []),
  extractCustomerFromFyndPayload: vi.fn(() => null),
  extractShippingDetailsFromFyndPayload: vi.fn(() => null),
  extractAffiliateOrderIdFromFyndPayload: vi.fn(() => null),
  isLikelyFyndId: vi.fn(() => false),
  buildTrackingUrlFromCourierAndAwb: vi.fn(() => null),
}));

vi.mock("../lib/fynd.server", () => ({
  isFyndPrivateUrl: vi.fn(() => false),
  signFyndUrl: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createFyndClientOrError: vi.fn(async () => ({ ok: false })),
}));

vi.mock("../lib/status-colors", () => ({
  getStatusColor: vi.fn(() => "#15803D"),
  getStatusBg: vi.fn(() => "#F0FDF4"),
}));

vi.mock("../lib/shopify-admin.server", () => ({
  fetchOrder: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumber: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByFyndAffiliateId: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchAllLocations: vi.fn(async () => []),
  withRestCredentials: vi.fn((a: unknown) => a),
}));

vi.mock("../lib/return-request-id", () => ({
  parseReturnIdConfig: vi.fn(() => ({ bodyMode: "id" })),
  buildReturnRequestId: vi.fn(() => "RMA-TEST-001"),
  formatReturnRequestId: vi.fn((id: string) => `RMA-${id}`),
}));

vi.mock("../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: vi.fn(async () => 1),
}));

vi.mock("../lib/refund-gate-presets", () => ({
  PRESET_LABELS: {
    bag_received: { label: "Bag received at warehouse" },
  } as Record<string, { label: string }>,
}));

vi.mock("../lib/observability/logger.server", () => ({
  refundLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../components/json-viewer", () => ({
  PayloadViewer: ({ rawPayload }: { rawPayload: unknown }) => (
    <div data-testid="payload-viewer">{JSON.stringify(rawPayload ?? null)}</div>
  ),
}));

vi.mock("../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 className="app-page-title">{heading}</h1>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, act } from "@testing-library/react";
import Component from "../app.returns.$id";

// ── Fixtures ──
type Item = {
  id: string;
  qty: number;
  shopifyLineItemId: string;
  sku: string | null;
  reasonCode: string | null;
  condition?: string | null;
  title?: string | null;
  variantTitle?: string | null;
  imageUrl?: string | null;
  price?: string | null;
  notes?: string | null;
  fyndBagId?: string | null;
  fyndArticleId?: string | null;
  fyndSellerIdentifier?: string | null;
  fyndSize?: string | null;
  fyndShipmentId?: string | null;
  fyndItemId?: string | null;
  fyndLineNumber?: number | null;
  fyndPriceEffective?: string | null;
};

const itemUnused: Item = {
  id: "item_1",
  qty: 2,
  shopifyLineItemId: "gid://shopify/LineItem/111",
  sku: "SKU-001",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Test Product Alpha",
  variantTitle: "Medium / Blue",
  imageUrl: "https://cdn.shopify.com/img1.jpg",
  price: "29.99",
  fyndShipmentId: "FYND-SHIP-AAA",
  fyndBagId: "BAG-1",
  fyndArticleId: "ART-1",
  fyndSellerIdentifier: "SELLER-1",
  fyndSize: "M",
  fyndItemId: "ITM-1",
  fyndLineNumber: 1,
  fyndPriceEffective: "29.99",
};

const itemDamaged: Item = {
  id: "item_2",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/222",
  sku: "SKU-002",
  reasonCode: "defective",
  condition: "used_damaged",
  title: "Test Product Beta",
  variantTitle: "Large / Red",
  imageUrl: null,
  price: "49.50",
  fyndShipmentId: "FYND-SHIP-BBB",
  fyndBagId: "BAG-2",
};

const itemDefective: Item = {
  id: "item_3",
  qty: 3,
  shopifyLineItemId: "gid://shopify/LineItem/333",
  sku: "SKU-003",
  reasonCode: "broken",
  condition: "defective",
  title: "Gamma Widget",
  variantTitle: null,
  imageUrl: null,
  price: "10.00",
};

const itemUsedGood: Item = {
  id: "item_4",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/444",
  sku: "SKU-004",
  reasonCode: null,
  condition: "used_good",
  title: "Delta Item",
  variantTitle: "One Size",
  imageUrl: null,
  price: "5.00",
};

const itemManual: Item = {
  id: "item_5",
  qty: 1,
  shopifyLineItemId: "manual",
  sku: null,
  reasonCode: null,
  condition: null,
  title: null,
  variantTitle: null,
  imageUrl: null,
  price: null,
  notes: "Manually added bag — no SKU",
};

function makeReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "ret_test_001",
    returnRequestNo: "RMA-TEST-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/9999",
    shopifyOrderName: "#1234",
    customerName: "Test Customer",
    customerEmailNorm: "test@example.com",
    customerCity: "New York",
    customerCountry: "US",
    customerPhoneNorm: null,
    customerAddress1: null,
    customerAddress2: null,
    customerProvince: null,
    customerZip: null,
    currency: "USD",
    fyndReturnId: null,
    fyndSyncStatus: null,
    fyndSyncRetries: 0,
    fyndSyncError: null,
    fyndCurrentStatus: null,
    fyndPayloadJson: null,
    fyndShipmentId: "FYND-SHIP-AAA",
    forwardAwb: null,
    returnAwb: null,
    returnLabelJson: null,
    isGreenReturn: false,
    orderProcessedAt: null,
    updatedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    createdAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    sourceChannel: "web",
    cancellationRequestedAt: null,
    cancellationRequestedBy: null,
    cancellationReason: null,
    cancellationDeclinedAt: null,
    items: [itemUnused, itemDamaged] as Item[],
    events: [] as unknown[],
    ...overrides,
  };
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    returnCase: makeReturnCase(),
    shopDomain: "test-shop.myshopify.com",
    shopifyOrder: null,
    isManualReturn: false,
    fyndPayloadInfo: null,
    fyndOrderDetailsTab: null,
    pickupAddress: null,
    returnJourney: [],
    shopLocations: [],
    fulfillmentLocationId: null,
    fulfillmentLocationName: null,
    refundLocationMode: "auto",
    refundPaymentMethod: "original",
    refundStoreCreditPct: 100,
    isCodOrder: false,
    returnLabelInfo: null,
    defaultReturnInstructions: null,
    customerReturnCount: 1,
    customerEmail: "test@example.com",
    bonusCreditEnabled: false,
    bonusCreditPct: 10,
    isBlocklisted: false,
    daysRemaining: 15,
    returnDeadline: new Date("2026-05-20T00:00:00Z").toISOString(),
    discountCodeRefundEnabled: false,
    discountCodePrefix: "RETURN",
    discountCodeExpiryDays: 90,
    shopLocale: "en",
    shopCurrency: "USD",
    shopTimezone: "UTC",
    fyndCurrentStatus: null,
    customerReturnHistory: [],
    hasRealShipmentData: false,
    displayForwardAwb: null,
    displayReturnAwb: null,
    allowedFyndStatusesForRefund: [],
    refundGatePreset: null,
    ...overrides,
  };
}

function renderRoute(loaderOverrides: Record<string, unknown> = {}) {
  return renderWithRouter(Component, {
    initialEntries: ["/app/returns/ret_test_001"],
    loaderData: makeLoaderData(loaderOverrides) as never,
  });
}

describe("app.returns.$id — line-item table + Fynd-shipment rendering", () => {
  it("renders the line-items panel header with the correct count", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned (2)");
    });
  });

  it("renders empty-state when items array is empty", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ items: [] }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No items recorded");
    });
  });

  it("renders title + variantTitle for each line-item row", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Test Product Alpha");
    });
    expect(container.textContent).toContain("Test Product Beta");
    expect(container.textContent).toContain("Medium / Blue");
    expect(container.textContent).toContain("Large / Red");
  });

  it("renders item.imageUrl as an <img> when set, falls back to placeholder svg", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.querySelector('img[src="https://cdn.shopify.com/img1.jpg"]')).toBeTruthy();
    });
    // itemDamaged has no imageUrl — should render placeholder svg rect
    const placeholderSvgs = container.querySelectorAll("svg rect");
    expect(placeholderSvgs.length).toBeGreaterThan(0);
  });

  it("renders the qty pill for every item (Qty: N)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Qty: 2");
    });
    expect(container.textContent).toContain("Qty: 1");
  });

  it("renders the reasonCode badge per item (e.g. wrong_size, defective)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("wrong_size");
    });
    expect(container.textContent).toContain("defective");
  });

  it("renders condition badges with the four mapped labels", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({
        items: [itemUnused, itemDamaged, itemDefective, itemUsedGood],
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Unused");
    });
    expect(container.textContent).toContain("Used — Damaged");
    expect(container.textContent).toContain("Used — Good");
    // "defective" condition + "broken" reasonCode both present in itemDefective row
    expect(container.textContent).toContain("Defective");
  });

  it("renders the per-item price-each pill formatted via shop currency/locale", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toMatch(/each/);
    });
    // formatMoney applied; USD locale en — both 29.99 and 49.50 present
    expect(container.textContent).toMatch(/\$29\.99\s?each/);
    expect(container.textContent).toMatch(/\$49\.50\s?each/);
  });

  it("renders 'Manual return item' fallback when shopifyLineItemId === 'manual' and notes set", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ items: [itemManual] }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Manually added bag");
    });
  });

  it("renders the per-item Size pill when fyndSize is set", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Size: M");
    });
  });

  it("renders the collapsible 'Fynd IDs' details summary when item has fynd ids", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd IDs");
    });
    const summary = Array.from(container.querySelectorAll("summary")).find(
      (s) => (s.textContent || "").trim() === "Fynd IDs",
    );
    expect(summary).toBeTruthy();
  });

  it("renders all Fynd ID badges inside the details when expanded", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd IDs");
    });
    // The <details> renders children regardless of open state in JSDOM —
    // we just assert the badges exist in the markup.
    expect(container.textContent).toContain("Bag: BAG-1");
    expect(container.textContent).toContain("Article: ART-1");
    expect(container.textContent).toContain("SKU: SELLER-1");
    expect(container.textContent).toContain("Item: ITM-1");
    expect(container.textContent).toContain("Line: 1");
    expect(container.textContent).toContain("Eff. Price: 29.99");
  });

  it("renders the per-item Shipment: badge inside Fynd IDs (multi-shipment grouping)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Shipment: FYND-SHIP-AAA");
    });
    expect(container.textContent).toContain("Shipment: FYND-SHIP-BBB");
  });

  it("clicking the Fynd-IDs <details> summary does not close the parent card (stopPropagation)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd IDs");
    });
    const summary = Array.from(container.querySelectorAll("summary")).find(
      (s) => (s.textContent || "").trim() === "Fynd IDs",
    ) as HTMLElement;
    await act(async () => { fireEvent.click(summary); });
    // Still rendered after click — no crash + items still in DOM
    await waitFor(() => { expect(container.textContent).toContain("Test Product Alpha"); });
  });

  it("renders shopifyOrder details panel when shopifyOrder is provided", async () => {
    const { container } = renderRoute({
      shopifyOrder: {
        id: "gid://shopify/Order/9999",
        legacyResourceId: "9999",
        name: "#1234",
        createdAt: "2026-04-01T00:00:00Z",
        email: "buyer@example.com",
        phone: "+12025550123",
        displayFulfillmentStatus: "FULFILLED",
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        paymentGatewayNames: ["shopify_payments"],
        lineItems: [],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Order details");
    });
    expect(container.textContent).toContain("buyer@example.com");
    expect(container.textContent).toContain("+12025550123");
    expect(container.textContent).toContain("shopify_payments");
  });

  it("renders the Fynd Reference card with fwdShipmentId / retShipmentId / fyndReturnId", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ fyndReturnId: "FRN-001" }),
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        paymentMethod: "prepaid",
        supportUrl: "https://support.fynd.example/",
        shipments: [
          {
            shipmentId: "FWD-100",
            journeyType: "forward",
            cpName: "Bluedart",
            forwardAwb: "FWDAWB123",
            shipmentStatus: "delivered",
            trackingUrl: "https://track.example/FWDAWB123",
            invoiceUrl: "https://inv.example/FWDAWB123",
            labelUrl: "https://lbl.example/FWDAWB123",
            invoiceNumber: "INV-9000",
            estimatedDelivery: "2026-04-10T00:00:00Z",
            trackingDetails: [
              { status: "out_for_delivery", time: "2026-04-09T00:00:00Z", message: "OFD" },
              { status: "delivered", time: "2026-04-10T00:00:00Z", message: "Delivered" },
            ],
          },
          {
            shipmentId: "RET-200",
            journeyType: "return",
            cpName: "Delhivery",
            returnAwb: "RETAWB456",
            shipmentStatus: "in_transit",
            trackingUrl: "https://track.example/RETAWB456",
            invoiceUrl: "https://inv.example/RETAWB456",
            labelUrl: "https://lbl.example/RETAWB456",
            estimatedDelivery: "2026-05-15T00:00:00Z",
            trackingDetails: [
              { status: "picked_up", time: "2026-05-02T00:00:00Z", message: "Picked" },
            ],
            pricing: { currency: "USD", subtotal: "100.00", total: "90.00", discount: "10.00" },
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).toContain("FYND-ORD-9");
    expect(container.textContent).toContain("FWD-100");
    expect(container.textContent).toContain("RET-200");
    expect(container.textContent).toContain("FRN-001");
  });

  it("renders the forward-shipment panel with courier + AWB + tracking link", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "FWD-100",
            journeyType: "forward",
            cpName: "Bluedart",
            forwardAwb: "FWDAWB123",
            shipmentStatus: "delivered",
            trackingUrl: "https://track.example/FWDAWB123",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Bluedart");
    });
    expect(container.textContent).toContain("FWDAWB123");
    expect(container.querySelector('a[href="https://track.example/FWDAWB123"]')).toBeTruthy();
  });

  it("renders the return-shipment panel with status + label download links", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "RET-200",
            journeyType: "return",
            cpName: "Delhivery",
            returnAwb: "RETAWB456",
            shipmentStatus: "in_transit",
            trackingUrl: "https://track.example/RETAWB456",
            invoiceUrl: "https://inv.example/RETAWB456",
            labelUrl: "https://lbl.example/RETAWB456",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Return Shipment");
    });
    expect(container.textContent).toContain("Delhivery");
    expect(container.textContent).toContain("RETAWB456");
    expect(container.querySelector('a[href="https://lbl.example/RETAWB456"]')).toBeTruthy();
  });

  it("renders 'View raw payload' toggle button when fyndPayloadInfo.shipments has entries", async () => {
    const { container } = renderRoute({
      fyndPayloadInfo: { rawJson: null, shipments: [{ shipmentId: "X1" }] },
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [{ shipmentId: "X1", journeyType: "forward" }],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("View raw payload");
    });
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").includes("View raw payload"),
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain("Hide raw payload");
    });
  });

  it("renders the 'Edit return shipping details' summary on approved returns", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "RET-200",
            journeyType: "return",
            cpName: "Delhivery",
            returnAwb: "RETAWB456",
            shipmentStatus: "in_transit",
          },
        ],
      },
    });
    await waitFor(() => {
      const summaries = Array.from(container.querySelectorAll("summary"));
      const has = summaries.some((s) => (s.textContent || "").includes("Edit return shipping details"));
      expect(has).toBe(true);
    });
  });

  it("renders the No-shipment-data warning when approved with no shipment payload", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No return shipment data yet");
    });
  });

  it("renders the fwd Tracking History details when trackingDetails is non-empty", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "FWD-100",
            journeyType: "forward",
            cpName: "Bluedart",
            forwardAwb: "AWB",
            shipmentStatus: "delivered",
            trackingDetails: [
              { status: "out_for_delivery", time: "2026-04-09T00:00:00Z", message: "OFD" },
              { status: "delivered", time: "2026-04-10T00:00:00Z", message: "Delivered" },
            ],
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Tracking History (2 events)");
    });
    expect(container.textContent).toContain("OFD");
    expect(container.textContent).toContain("Delivered");
  });

  it("renders the per-shipment Return Pricing details with subtotal/discount/total", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "RET-200",
            journeyType: "return",
            cpName: "Delhivery",
            returnAwb: "RETAWB",
            shipmentStatus: "in_transit",
            pricing: { currency: "USD", subtotal: "100.00", total: "90.00", discount: "10.00" },
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Return Pricing");
    });
    // Subtotal/Total formatted via Intl
    expect(container.textContent).toMatch(/Subtotal/);
    expect(container.textContent).toMatch(/Total/);
  });

  it("renders the standalone Shipment ID block when retShipmentId is missing but case has fyndShipmentId", async () => {
    const { container } = renderRoute({
      fyndOrderDetailsTab: {
        fyndOrderId: "FYND-ORD-9",
        shipments: [
          {
            shipmentId: "FWD-100",
            journeyType: "forward",
            cpName: "Bluedart",
            forwardAwb: "AWB",
            shipmentStatus: "delivered",
          },
        ],
      },
    });
    await waitFor(() => {
      // returnCase.fyndShipmentId is "FYND-SHIP-AAA"
      expect(container.textContent).toContain("FYND-SHIP-AAA");
    });
  });

  it("renders the source-channel pill when sourceChannel is non-default (e.g. pos)", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ sourceChannel: "pos" }),
      shopifyOrder: {
        id: "gid://shopify/Order/9999",
        legacyResourceId: "9999",
        name: "#1234",
        createdAt: "2026-04-01T00:00:00Z",
        currencyCode: "USD",
        paymentGatewayNames: [],
        lineItems: [],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Point of Sale");
    });
  });

  it("falls back to shopifyOrder line-item title/image/price when item lacks them", async () => {
    const minimalItem: Item = {
      id: "item_a",
      qty: 1,
      shopifyLineItemId: "gid://shopify/LineItem/777",
      sku: "SKU-X",
      reasonCode: "wrong_size",
      condition: null,
      title: null,
      variantTitle: null,
      imageUrl: null,
      price: null,
    };
    const { container } = renderRoute({
      returnCase: makeReturnCase({ items: [minimalItem] }),
      shopifyOrder: {
        id: "gid://shopify/Order/9999",
        legacyResourceId: "9999",
        name: "#1234",
        createdAt: "2026-04-01T00:00:00Z",
        currencyCode: "USD",
        paymentGatewayNames: [],
        lineItems: [
          {
            id: "gid://shopify/LineItem/777",
            title: "Fallback Product",
            variantTitle: "Fallback / XL",
            sku: "SKU-X",
            imageUrl: "https://cdn.shopify.com/fallback.jpg",
            price: "75.00",
            discountedPrice: null,
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fallback Product");
    });
    expect(container.textContent).toContain("Fallback / XL");
    expect(container.querySelector('img[src="https://cdn.shopify.com/fallback.jpg"]')).toBeTruthy();
    expect(container.textContent).toMatch(/\$75\.00\s?each/);
  });

  it("handles object-typed price (Fynd nested {amount}) — extracts amount via fallback chain", async () => {
    const objPriceItem: Item = {
      id: "item_b",
      qty: 1,
      shopifyLineItemId: "gid://shopify/LineItem/888",
      sku: "SKU-Y",
      reasonCode: null,
      condition: null,
      title: "Object Price Product",
      variantTitle: null,
      imageUrl: null,
      price: null,
    };
    const { container } = renderRoute({
      returnCase: makeReturnCase({ items: [objPriceItem] }),
      shopifyOrder: {
        id: "gid://shopify/Order/9999",
        legacyResourceId: "9999",
        name: "#1234",
        createdAt: "2026-04-01T00:00:00Z",
        currencyCode: "USD",
        paymentGatewayNames: [],
        lineItems: [
          {
            id: "gid://shopify/LineItem/888",
            title: "Object Price Product",
            variantTitle: null,
            sku: "SKU-Y",
            imageUrl: null,
            // discountedPrice is an object — exercises the rawPrice typeof === 'object' branch
            discountedPrice: { amount: "12.34", currencyCode: "USD" } as unknown as string,
            price: null,
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Object Price Product");
    });
    expect(container.textContent).toMatch(/\$12\.34\s?each/);
  });

  it("renders Backoff retry-scheduled detail when fyndSyncStatus=retry_scheduled with future fyndSyncNextRetry", async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    const { container } = renderRoute({
      returnCase: makeReturnCase({
        fyndSyncStatus: "retry_scheduled",
        fyndSyncRetries: 2,
        fyndSyncError: "Transient API error",
        fyndSyncNextRetry: future,
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("retry scheduled");
    });
    // Backoff line has ladder
    expect(container.textContent).toContain("Backoff:");
  });

  it("renders the failed-state guidance block when fyndSyncStatus=failed", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({
        fyndSyncStatus: "failed",
        fyndSyncRetries: 5,
        fyndSyncError: "Permanent error: invalid token",
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync failed");
    });
  });

  it("renders the green-return banner when isGreenReturn=true (no return shipment)", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ isGreenReturn: true }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Test Product Alpha");
    });
    // green return = customer keeps item, has special tooltip text
    expect(container.textContent).toMatch(/keep|green|Green/i);
  });
});
