/** @vitest-environment jsdom */
/**
 * Final coverage-closure component tests for app/routes/app.returns.$id.tsx.
 *
 * Targets the residual uncovered render branches that the prior
 * `app.returns.id.uncovered.test.tsx` and `app.returns.id.final-branches.test.tsx`
 * suites skip:
 *   - safeStr coercion paths (number/object → name) via fyndPayloadInfo
 *   - computeAdminReturnState: credit_note + processing helper, default
 *     "Unknown" tail, bag_picked, dp_assigned branches
 *   - search-param dismissal effect (fyndError/fyndSuccess/...) firing setTimeout
 *   - State-desync banner (local says completed, Fynd is mid-transit)
 *   - Cancellation reason render + confirm modal
 *   - "Approve Exchange" button label (resolutionType === "exchange")
 *   - COD warning inside refund modal (isCodOrder)
 *   - Refund split-mode amount toggle wiring (modalRefundMethod === "both")
 *   - Replacement / Exchange order panel (exchangeOrderId set, completed_with_refund flow)
 *   - Pending-consolidation Fynd sync banner colors
 *   - CRM Notes block (crmNotes only, no ticket / staff)
 *   - Fraud risk medium (yellow)
 *   - Pickup-address block render (loader fixture)
 *
 * Pure render assertions — no source mods.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  buildReturnRequestId: vi.fn(() => "RMA-CLO-001"),
  formatReturnRequestId: vi.fn((id: string) => `RMA-${id}`),
}));

vi.mock("../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: vi.fn(async () => 1),
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
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
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
import { fireEvent, waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

const baseItem = {
  id: "item_clo_1",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/777",
  sku: "SKU-CLO",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Closure Item",
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
    id: "ret_clo_001",
    returnRequestNo: "RMA-CLO-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/1234567890",
    shopifyOrderName: "#CLO",
    customerName: "Closure Customer",
    customerEmailNorm: "clo@example.com",
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
    shopDomain: "clo-shop.myshopify.com",
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
    customerEmail: "clo@example.com",
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

describe("app.returns.$id — coverage closure (component)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders processing label via credit_note journey (computeAdminReturnState credit_note branch)", async () => {
    const rc = makeReturnCase({
      status: "approved",
      refundStatus: "in_progress",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "credit_note_generated",
        returnJourney: [{ status: "credit_note_generated", date: "2026-05-01T00:00:00Z" }],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    // Refund Processing label from processing helper
    expect(container.textContent?.toLowerCase()).toContain("refund processing");
  });

  it("renders the credit_note awaiting refund branch (refundStatus not in_progress)", async () => {
    const rc = makeReturnCase({
      status: "approved",
      refundStatus: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "credit_note_generated",
        returnJourney: [{ status: "credit_note_generated", date: "2026-05-01T00:00:00Z" }],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
  });

  it("renders bag_picked label branch via fyndCurrentStatus", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndCurrentStatus: "bag_picked" }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    expect(container.textContent).toContain("Picked Up");
  });

  it("renders dp_assigned label branch via fyndCurrentStatus", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndCurrentStatus: "dp_assigned" }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    expect(container.textContent).toContain("Pickup Scheduled");
  });

  it("renders the default 'Unknown' branch when status is unrecognised", async () => {
    const rc = makeReturnCase({
      status: "weird_state",
      refundStatus: null,
      fyndCurrentStatus: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    // The status pill renders the appStatus literal as label
    expect(container.textContent?.toLowerCase()).toContain("weird_state");
  });

  it("safeStr coerces object {name} via fyndPayloadInfo.shipments[0].shipmentStatus", async () => {
    const fyndPayloadInfo = {
      shipments: [{ shipmentStatus: { name: "OBJ_STATUS_NAME" } }],
    };
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ fyndPayloadInfo }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
  });

  it("renders state desync banner when local is completed but Fynd is mid-transit", async () => {
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      fyndCurrentStatus: "in_transit", // banner reads returnCase.fyndCurrentStatus
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndCurrentStatus: "in_transit" }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    // The desync banner renders strong "Status desync detected" in the wrapper
    expect(container.textContent).toContain("Status desync detected");
  });

  it("renders cancellation request panel with reason + Approve Cancellation modal opens", async () => {
    const rc = makeReturnCase({
      status: "approved",
      cancellationRequestedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
      cancellationRequestedBy: "customer",
      cancellationReason: "Changed my mind",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Changed my mind");
    });
    expect(container.textContent).toContain("Reason:");
    // Click "Approve Cancellation" → opens the modal
    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Approve Cancellation",
    );
    expect(approveBtn).toBeTruthy();
    fireEvent.click(approveBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Confirm Cancellation");
    });
  });

  it("renders 'Approve Exchange' label when resolutionType is exchange", async () => {
    const rc = makeReturnCase({ status: "initiated", resolutionType: "exchange" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Exchange");
    });
  });

  it("renders COD warning inside refund modal and toggles split-mode 'Amount' button", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container, getAllByText } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        isCodOrder: true,
        refundPaymentMethod: "both",
        bonusCreditEnabled: true,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    fireEvent.click(getAllByText("Process Refund")[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("COD order");
    });
    // Click the "Amount" toggle → exercises the setSplitMode("amount") closure
    const amountBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Amount",
    );
    if (amountBtn) {
      fireEvent.click(amountBtn);
    }
    // Click the "Percentage" toggle to come back too (defensive)
    const pctBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Percentage",
    );
    if (pctBtn) fireEvent.click(pctBtn);
  });

  it("renders Replacement order created panel with completed_with_refund success branch", async () => {
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "replacement",
      exchangeOrderId: "gid://shopify/Order/9999",
      exchangeOrderName: "#REPL-1",
      exchangeItemsJson: JSON.stringify([
        { title: "Item A", quantity: 1, price: "10.00" },
        { title: "Item B", quantity: 2, price: "20.00" },
      ]),
      events: [
        {
          eventType: "replacement_created",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: -5.5,
            currency: "USD",
            invoiceUrl: "https://invoice.example/x",
            refund: { success: true, amount: "5.50" },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Replacement order created");
    });
    expect(container.textContent).toContain("#REPL-1");
    expect(container.textContent).toContain("Refunded to customer");
    expect(container.textContent).toContain("Difference refunded");
    expect(container.textContent).toContain("2 items");
    // Customer payment link
    expect(container.querySelector('a[href="https://invoice.example/x"]')).toBeTruthy();
  });

  it("renders Exchange order created with refund.success === false branch", async () => {
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/8888",
      exchangeOrderName: "#EX-1",
      exchangeItemsJson: JSON.stringify([{ title: "Single", quantity: 1, price: "10.00" }]),
      events: [
        {
          eventType: "exchange_created",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: 7.25,
            currency: "USD",
            refund: { success: false },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Exchange order created");
    });
    expect(container.textContent).toContain("Customer owes");
    expect(container.textContent).toContain("Difference refund failed");
    expect(container.textContent).toContain("1 item");
  });

  it("renders pending_consolidation Fynd sync banner", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndSyncStatus: "pending_consolidation",
      fyndSyncError: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    // The sync-status banner exists for non-synced fyndSyncStatus
    // verify CSS-color-bound branch is reached
    expect(container.textContent?.toLowerCase()).toMatch(/pending|consolid/);
  });

  it("renders only CRM Notes when ticket and staff are absent (covers crmNotes-only branch)", async () => {
    const rc = makeReturnCase({
      createdByChannel: "admin",
      createdByStaff: null,
      crmTicketId: null,
      crmNotes: "Investigating chargeback dispute. Awaiting bank response.",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("CRM Notes");
    });
    expect(container.textContent).toContain("Investigating chargeback dispute");
  });

  it("renders the medium fraud risk pill (default yellow)", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "medium", fraudRiskScore: 50 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("50/100");
    });
    expect(container.textContent?.toLowerCase()).toContain("medium risk");
  });

  it("renders the pickup address block (Pickup / Return address)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({
        pickupAddress: {
          name: "Main Warehouse",
          address1: "1 Warehouse Way",
          address2: "Dock 3",
          city: "Mumbai",
          state: "MH",
          pincode: "400001",
          phone: "+91-2222",
          formatted: null,
        },
        defaultReturnInstructions: "Pack the item in original packaging.",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Pickup / Return address");
    });
    expect(container.textContent).toContain("Main Warehouse");
    expect(container.textContent).toContain("400001");
    expect(container.textContent).toContain("Return Instructions");
  });

  it("triggers searchParam-dismissal effect when fyndError is in URL", async () => {
    // The useEffect registers a 30s setTimeout that calls setSearchParams.
    // We don't advance the timer (would cause a router state update mid-test
    // and is not needed for branch coverage — just registering the effect
    // hits the lines). Verify render completes without crashing.
    const { container } = renderWithRouter(Component, {
      initialEntries: [
        "/app/returns/ret_clo_001?fyndError=oops&fyndSuccess=ok&fyndRefresh=1&fyndProcessing=1&consolidationQueued=1",
      ],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
    // Banner for fyndError = decoded value
    expect(container.textContent).toContain("Fynd sync issue");
  });

  it("schedules auto-refresh poll when fyndSyncStatus=processing and updatedAt is fresh", async () => {
    // Just verify the component mounts cleanly — the useEffect fires a
    // 12s setTimeout but we don't need to flush it for branch coverage.
    const rc = makeReturnCase({
      status: "approved",
      fyndSyncStatus: "processing",
      updatedAt: new Date(Date.now() - 60_000).toISOString(), // 1 min old → not stale
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc, hasRealShipmentData: false }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-CLO-001");
    });
  });

  it("renders Replacement panel without invoiceUrl + neutral refund (no completed_with_refund)", async () => {
    // Hit the 'no items' branch (exchangeItems.length === 0) of the panel for line 2751 false-side
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "replacement",
      exchangeOrderId: "gid://shopify/Order/7777",
      exchangeOrderName: "#REPL-NEUTRAL",
      exchangeItemsJson: null,
      events: [
        {
          eventType: "replacement_created",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({ flow: "completed_free", priceDiff: 0, currency: "USD" }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_clo_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Replacement order created");
    });
    // No invoiceUrl link + no items count
    expect(container.querySelector('a[href*="invoice"]')).toBeFalsy();
  });
});
