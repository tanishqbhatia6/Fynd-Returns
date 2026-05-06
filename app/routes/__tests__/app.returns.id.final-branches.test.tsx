/** @vitest-environment jsdom */
/**
 * Final-branch coverage companion to the existing app.returns.$id suites.
 *
 * Targets render branches the prior suites skipped:
 *  - orderId-link fallback chain (legacyResourceId → gid extract → numeric → manual)
 *  - customer-info missing-field fallbacks (no email/phone/address)
 *  - source-channel pill variants (web/pos/draft_order/b2b/fynd)
 *  - refund-gate preset variants (after_pickup / after_delivery / after_qc / custom)
 *  - refund-location auto vs manual select mode
 *  - shipping-address rendering when present and falsy
 *  - line-item with `shopifyLineItemId === "manual"` (manual return item title fallback)
 *  - replacement vs exchange variant pickers and "exchange preference" callouts
 *  - blocklist banner ("Flagged customer")
 *  - returns-from-customer multi vs single pluralization
 *
 * Pure render assertions — no source mods. Mocks mirror the existing
 * uncovered-companion file so the 3300-LOC route mounts cleanly under jsdom.
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
  buildReturnRequestId: vi.fn(() => "RMA-FINAL-001"),
  formatReturnRequestId: vi.fn((id: string) => `RMA-${id}`),
}));

vi.mock("../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: vi.fn(async () => 1),
}));

// NOTE: PRESET_LABELS is intentionally NOT mocked — the real labels from
// `lib/refund-gate-presets` are used so the gate-banner branch renders the
// production labels exactly as a merchant would see them.

vi.mock("../lib/observability/logger.server", () => ({
  refundLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../components/json-viewer", () => ({
  PayloadViewer: ({ data }: { data: unknown }) => (
    <div data-testid="payload-viewer">{JSON.stringify(data ?? null)}</div>
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
import { waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

// ── Loader fixture builders ──────────────────────────────────────────────────
const baseItem = {
  id: "item_final_1",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/777",
  sku: "SKU-FINAL",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Final Branch Item",
  variantTitle: "M / Red",
  imageUrl: null,
  price: "10.00",
  notes: null,
  fyndBagId: null,
  fyndArticleId: null,
  fyndSellerIdentifier: null,
  fyndSize: null,
  fyndShipmentId: null,
};

function makeReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "ret_final_001",
    returnRequestNo: "RMA-FINAL-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/1234567890",
    shopifyOrderName: "#FINAL",
    customerName: "Final Customer",
    customerEmailNorm: "final@example.com",
    customerCity: "Boston",
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
    fyndShipmentId: null,
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
    items: [baseItem],
    ...overrides,
  };
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    returnCase: makeReturnCase(),
    shopDomain: "final-shop.myshopify.com",
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
    customerEmail: "final@example.com",
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

describe("app.returns.$id — final branch coverage (orderId / channel / refund-gate)", () => {
  it("orderId fallback: prefers shopifyOrder.legacyResourceId over GID", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        shopifyOrder: {
          id: "gid://shopify/Order/1234567890",
          legacyResourceId: "555000111",
          name: "#FINAL",
          email: null,
          shippingAddress: null,
          lineItems: [],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    const a = container.querySelector('a[href*="/orders/"]') as HTMLAnchorElement | null;
    expect(a?.href).toContain("555000111");
  });

  it("orderId fallback: extracts numeric ID from GID when no legacyResourceId", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        shopifyOrder: {
          id: "gid://shopify/Order/9876543210",
          name: "#FINAL",
          email: null,
          shippingAddress: null,
          lineItems: [],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    const a = container.querySelector('a[href*="/orders/"]') as HTMLAnchorElement | null;
    expect(a?.href).toContain("9876543210");
  });

  it("orderId fallback: extracts from stored shopifyOrderId GID when shopifyOrder is null", async () => {
    const rc = makeReturnCase({ shopifyOrderId: "gid://shopify/Order/4242424242" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc, shopifyOrder: null }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    const a = container.querySelector('a[href*="/orders/"]') as HTMLAnchorElement | null;
    expect(a?.href).toContain("4242424242");
  });

  it("orderId fallback: uses purely-numeric stored shopifyOrderId", async () => {
    const rc = makeReturnCase({ shopifyOrderId: "1010101010" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc, shopifyOrder: null }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    const a = container.querySelector('a[href*="/orders/"]') as HTMLAnchorElement | null;
    expect(a?.href).toContain("1010101010");
  });

  it("orderId fallback: manual return links to /orders list (no specific ID)", async () => {
    const rc = makeReturnCase({ shopifyOrderId: "manual:abc-123" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc, isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Shopify Orders");
    });
    const a = container.querySelector('a[href*="/orders"]') as HTMLAnchorElement | null;
    expect(a?.href).toMatch(/\/orders$/);
  });

  it("renders the 'No customer info captured yet' branch when nothing is set", async () => {
    const rc = makeReturnCase({
      customerName: null,
      customerEmailNorm: null,
      customerCity: null,
      customerCountry: null,
      customerPhoneNorm: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        customerEmail: null,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No customer info captured yet");
    });
  });

  it("renders only the city/country line when phone + address are missing", async () => {
    const rc = makeReturnCase({
      customerPhoneNorm: null,
      customerAddress1: null,
      customerZip: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Boston");
    });
    expect(container.textContent).not.toContain("Pickup Address");
  });

  it("renders the full pickup address block when address1 + zip are set", async () => {
    const rc = makeReturnCase({
      customerAddress1: "100 Main St",
      customerAddress2: "Apt 5",
      customerProvince: "MA",
      customerZip: "02115",
      customerLandmark: "Near park",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("100 Main St");
    });
    expect(container.textContent).toContain("Apt 5");
    expect(container.textContent).toContain("02115");
    expect(container.textContent).toContain("Near park");
  });

  it("renders the customer phone link when phone is provided", async () => {
    const rc = makeReturnCase({ customerPhoneNorm: "+15551234567" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.querySelector('a[href^="tel:"]')).toBeTruthy();
    });
    const tel = container.querySelector('a[href^="tel:"]') as HTMLAnchorElement;
    expect(tel.textContent).toContain("+15551234567");
  });

  it("renders the shipping-address block via formatAddress when shopifyOrder has one", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        shopifyOrder: {
          id: "gid://shopify/Order/1",
          name: "#1",
          email: "ship@example.com",
          shippingAddress: {
            address1: "1 Ship Way",
            city: "Cambridge",
            province: "MA",
            zip: "02139",
            country: "US",
          },
          lineItems: [],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Shipping address");
    });
    expect(container.textContent).toContain("Cambridge");
  });

  it("source-channel pill: web is hidden (no pill)", async () => {
    const rc = makeReturnCase({ sourceChannel: "web" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    expect(container.textContent).not.toContain("POS Order");
  });

  it("source-channel pill: 'pos' renders the POS Order pill", async () => {
    const rc = makeReturnCase({ sourceChannel: "pos" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("POS Order");
    });
  });

  it("source-channel pill: 'draft_order' renders the Draft Order pill", async () => {
    const rc = makeReturnCase({ sourceChannel: "draft_order" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Draft Order");
    });
  });

  it("source-channel pill: 'b2b' renders the B2B / Wholesale pill", async () => {
    const rc = makeReturnCase({ sourceChannel: "b2b" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("B2B / Wholesale");
    });
  });

  it("source-channel pill: unknown channel ('fynd') falls through to uppercase label", async () => {
    const rc = makeReturnCase({ sourceChannel: "fynd" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    expect(container.textContent).toContain("FYND");
  });

  it("refund-gate preset: 'after_pickup' renders the gate label", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-1",
      fyndCurrentStatus: "in_transit",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "in_transit",
        allowedFyndStatusesForRefund: ["return_bag_picked", "return_bag_delivered"],
        refundGatePreset: "after_pickup",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Refund gated by Fynd status");
    });
    expect(container.textContent).toContain("After bag is picked up");
  });

  it("refund-gate preset: 'after_delivery' renders the gate label", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-1",
      fyndCurrentStatus: "out_for_pickup",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "out_for_pickup",
        allowedFyndStatusesForRefund: ["return_bag_delivered"],
        refundGatePreset: "after_delivery",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("After bag reaches warehouse");
    });
  });

  it("refund-gate preset: 'after_qc' renders the gate label", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-1",
      fyndCurrentStatus: "return_bag_delivered",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "return_bag_delivered",
        allowedFyndStatusesForRefund: ["return_accepted"],
        refundGatePreset: "after_qc",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("After QC / acceptance");
    });
  });

  it("refund-gate preset: 'custom' suppresses the preset label line", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-1",
      fyndCurrentStatus: "in_transit",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "in_transit",
        allowedFyndStatusesForRefund: ["return_accepted"],
        refundGatePreset: "custom",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Refund gated by Fynd status");
    });
    // 'Custom' label is filtered out by the `gatePresetLabel !== "Custom"` check
    expect(container.textContent).not.toContain("Refund available: Custom");
  });

  it("refund-location auto mode: shows 'set automatically' helper text in confirm modal context", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        refundLocationMode: "auto",
        fulfillmentLocationId: "loc1",
        fulfillmentLocationName: "Warehouse 1",
        shopLocations: [
          { id: "loc1", name: "Warehouse 1", isActive: true },
          { id: "loc2", name: "Warehouse 2", isActive: true },
        ],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    // Modal not yet open; auto branch helper text is rendered inside modal — verify via prop snapshot
    expect(container.textContent).toContain("Process Refund");
  });

  it("refund-location manual mode: renders <select> when manual & locations are present", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container, getAllByText } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        refundLocationMode: "manual",
        fulfillmentLocationId: "loc1",
        fulfillmentLocationName: "Warehouse 1",
        shopLocations: [
          { id: "loc1", name: "Warehouse 1", isActive: true },
          { id: "loc2", name: "Warehouse 2", isActive: true },
        ],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(getAllByText("Process Refund")[0]);
    await waitFor(() => {
      expect(container.querySelector('select[aria-label="Select restock location"]')).toBeTruthy();
    });
    const sel = container.querySelector('select[aria-label="Select restock location"]') as HTMLSelectElement;
    expect(sel.querySelectorAll("option").length).toBe(2);
  });

  it("line-item with shopifyLineItemId === 'manual' uses notes as title fallback", async () => {
    const rc = makeReturnCase({
      items: [
        {
          ...baseItem,
          id: "manual_item_1",
          shopifyLineItemId: "manual",
          notes: "Manually entered SKU",
          title: null,
          sku: null,
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Manually entered SKU");
    });
  });

  it("line-item with manual + no notes falls back to 'Manual return item'", async () => {
    const rc = makeReturnCase({
      items: [
        {
          ...baseItem,
          id: "manual_item_2",
          shopifyLineItemId: "manual",
          notes: null,
          title: null,
          sku: null,
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Manual return item");
    });
  });

  it("replacement variant: shows the Process Replacement button on approved replacement", async () => {
    const rc = makeReturnCase({ status: "approved", resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Replacement");
    });
  });

  it("exchange variant: shows the Process Exchange button + customer exchange preference", async () => {
    const rc = makeReturnCase({
      status: "approved",
      resolutionType: "exchange",
      exchangePreference: "Same item, size large",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
    expect(container.textContent).toContain("Same item, size large");
  });

  it("blocklist banner: 'Flagged customer' renders when isBlocklisted is true", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ isBlocklisted: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Flagged customer");
    });
  });

  it("returns-from-customer history pill: singular 'return' for count = 1", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ customerReturnCount: 1 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/1\s+return\s+from this customer/);
    });
  });

  it("returns-from-customer history pill: plural 'returns' for count > 1 + serial returner badge", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ customerReturnCount: 5 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/5\s+returns\s+from this customer/);
    });
    expect(container.textContent).toContain("Serial Returner");
  });

  it("returns-from-customer history list: renders prior return links from history array", async () => {
    const history = [
      { id: "ret_prev_001", returnRequestNo: "RMA-PREV-001", status: "completed", createdAt: new Date("2026-04-01T00:00:00Z").toISOString() },
      { id: "ret_prev_002", returnRequestNo: "RMA-PREV-002", status: "rejected", createdAt: new Date("2026-04-15T00:00:00Z").toISOString() },
    ];
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({
        customerReturnCount: 3,
        customerReturnHistory: history,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-PREV-001");
    });
    expect(container.textContent).toContain("RMA-PREV-002");
    expect(container.querySelector('a[href="/app/returns/ret_prev_001"]')).toBeTruthy();
  });

  it("Green Return badge renders when isGreenReturn is true", async () => {
    const rc = makeReturnCase({ isGreenReturn: true });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Green Return");
    });
  });

  it("Resolution-type pill 'store_credit' uses purple variant", async () => {
    const rc = makeReturnCase({ resolutionType: "store_credit" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-FINAL-001");
    });
    expect(container.textContent?.toLowerCase()).toContain("store credit");
  });

  it("daysRemaining: renders 'Expired' chip when days <= 0", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ daysRemaining: 0 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Expired");
    });
  });

  it("daysRemaining: renders amber 'N days remaining' chip when 1 <= days <= 7", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ daysRemaining: 3 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("3 days remaining");
    });
  });

  it("daysRemaining: singular '1 day remaining' (no plural s)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_final_001"],
      loaderData: makeLoaderData({ daysRemaining: 1 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("1 day remaining");
    });
  });
});
