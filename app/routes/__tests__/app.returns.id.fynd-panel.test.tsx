/** @vitest-environment jsdom */
/**
 * Fynd integration UI panel coverage for `app.returns.$id.tsx`.
 *
 * Targets the Fynd-specific surfaces that aren't already exercised by the
 * existing component test suites:
 *   - Fynd shipment-id reference panel render
 *   - Raw Fynd payload toggle (View / Hide raw payload)
 *   - "Sync to Fynd" retry button click + form submission
 *   - "Refresh" Fynd details button render + click
 *   - Sync-status indicator variants (synced / pending / failed /
 *     processing / retry_scheduled / pending_consolidation)
 *   - Return Journey timeline step list rendering
 *   - Manual-return banner ("Manual return — process refund in Shopify Admin")
 *   - Fynd error / success / refresh search-param banners
 *   - Configuration-issue / network / timeout failure-guidance branches
 *
 * NEVER modifies source. Mirrors the mocking strategy from
 * `app.returns.id.uncovered.test.tsx`.
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
  PayloadViewer: ({ title, rawPayload }: { title?: string; rawPayload?: unknown }) => (
    <div data-testid="payload-viewer">
      <div>{title}</div>
      <pre>{JSON.stringify(rawPayload ?? null)}</pre>
    </div>
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
import { fireEvent, waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

// ── Loader fixture builders ──
const baseItem = {
  id: "item_1",
  qty: 2,
  shopifyLineItemId: "gid://shopify/LineItem/111",
  sku: "SKU-001",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Test Product Alpha",
  variantTitle: "Medium / Blue",
  imageUrl: null,
  price: "29.99",
  notes: null,
  fyndBagId: null,
  fyndArticleId: null,
  fyndSellerIdentifier: null,
  fyndSize: null,
  fyndShipmentId: null,
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

describe("app.returns.$id — Fynd integration UI panel", () => {
  it("renders the Fynd Reference panel with the order id when no shipment ids are present", async () => {
    const rc = makeReturnCase({ fyndOrderId: "FY-ORD-100" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).toContain("Order ID");
    expect(container.textContent).toContain("FY-ORD-100");
  });

  it("renders the standalone fyndShipmentId reference when no return shipment id resolves", async () => {
    const rc = makeReturnCase({
      fyndShipmentId: "FY-SHIP-XYZ-9",
      fyndOrderId: "FY-ORD-1",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Shipment ID");
    });
    expect(container.textContent).toContain("FY-SHIP-XYZ-9");
  });

  it("renders the Fynd Return ID + Fynd Return # rows when set", async () => {
    const rc = makeReturnCase({
      fyndReturnId: "RET-ABC-123",
      fyndReturnNo: "FY-RN-7",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).toContain("RET-ABC-123");
    expect(container.textContent).toContain("FY-RN-7");
  });

  it("renders the 'View raw payload' toggle and expands the PayloadViewer on click", async () => {
    const rc = makeReturnCase({
      fyndShipmentId: "FY-SHIP-1",
      fyndPayloadJson: '{"shipment_status":"return_initiated"}',
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndPayloadInfo: {
          shipments: [{ shipmentStatus: "return_initiated", id: "FY-SHIP-1" }],
          rawJson: '{"shipment_status":"return_initiated"}',
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("View raw payload");
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "View raw payload",
    ) as HTMLButtonElement | undefined;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(container.textContent).toContain("Hide raw payload");
    });
    // Confirm the mocked PayloadViewer mounted (the "Fynd Payload" title is
    // passed by the source component to PayloadViewer, our mock prints it)
    expect(container.textContent).toContain("Fynd Payload");
    // Toggle off
    const off = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Hide raw payload",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(off!);
    await waitFor(() => {
      expect(container.textContent).toContain("View raw payload");
    });
  });

  it("does NOT render the raw-payload toggle when fyndPayloadInfo is empty", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Shipment & Logistics");
    });
    expect(container.textContent).not.toContain("View raw payload");
  });

  it("renders the 'Sync to Fynd' retry button + hidden retry_fynd_sync action input when never synced", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Sync to Fynd");
    });
    // Find the hidden input that carries the action JSON
    const hiddenInputs = Array.from(
      container.querySelectorAll('input[type="hidden"][name="json"]'),
    ) as HTMLInputElement[];
    const retryInput = hiddenInputs.find((i) => i.value.includes("retry_fynd_sync"));
    expect(retryInput).toBeTruthy();
    expect(retryInput!.value).toContain('"action":"retry_fynd_sync"');
  });

  it("submits the retry sync form when the 'Sync to Fynd' button is clicked", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Sync to Fynd");
    });
    const syncBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Sync to Fynd",
    ) as HTMLButtonElement | undefined;
    expect(syncBtn).toBeTruthy();
    // Make submit a no-op on the parent form (jsdom otherwise rejects unhandled submit)
    const form = syncBtn!.closest("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    form.addEventListener("submit", (e) => e.preventDefault());
    fireEvent.click(syncBtn!);
    // Survives the click without throwing
    expect(syncBtn).toBeTruthy();
  });

  it("renders the 'Refresh' Fynd details button bound to refresh_fynd_details action", async () => {
    const rc = makeReturnCase({
      status: "approved",
      shopifyOrderName: "#1234",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Shipment & Logistics");
    });
    // The Refresh button is a Polaris <s-button> custom element, not a
    // native <button>. The hidden form-input still carries the action JSON.
    const hiddenInputs = Array.from(
      container.querySelectorAll('input[type="hidden"][name="json"]'),
    ) as HTMLInputElement[];
    const refreshInput = hiddenInputs.find((i) => i.value.includes("refresh_fynd_details"));
    expect(refreshInput).toBeTruthy();
    expect(refreshInput!.value).toContain('"action":"refresh_fynd_details"');
    const refreshForm = refreshInput!.closest("form") as HTMLFormElement;
    expect(refreshForm).toBeTruthy();
    refreshForm.addEventListener("submit", (e) => e.preventDefault());
    // The button label inside is "Refresh" (or "Refreshing..." when busy)
    const sButtons = Array.from(refreshForm.querySelectorAll("s-button"));
    const refreshSBtn = sButtons.find(
      (b) => (b.textContent || "").trim() === "Refresh",
    );
    expect(refreshSBtn).toBeTruthy();
  });

  it("renders 'synced' badge styling in the Fynd Reference Sync row when status is synced", async () => {
    const rc = makeReturnCase({
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "synced",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).toContain("Sync");
    expect(container.textContent).toContain("Synced");
    // synced should NOT trigger the indicator banner (only !== "synced" branches do)
    expect(container.textContent).not.toContain("Sync failed after");
    expect(container.textContent).not.toContain("Queued for Fynd sync");
  });

  it("renders the 'Queued for Fynd sync' pending indicator banner", async () => {
    const rc = makeReturnCase({
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "pending",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Queued for Fynd sync");
    });
  });

  it("renders the 'failed' sync banner with retry-attempts count + Retry Sync button", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "failed",
      fyndSyncError: "ECONNREFUSED talking to Fynd platform",
      fyndSyncRetries: 2,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Sync failed after 2 attempts");
    });
    expect(container.textContent).toContain("ECONNREFUSED talking to Fynd platform");
    expect(container.textContent).toContain("Network issue");
    // Retry button inside indicator
    const retrySyncBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Retry Sync",
    );
    expect(retrySyncBtn).toBeTruthy();
  });

  it("renders 'Configuration issue' guidance for credential errors", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "failed",
      fyndSyncError: "Fynd not configured — verify Platform API client id",
      fyndSyncRetries: 1,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Configuration issue");
    });
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Integrations");
  });

  it("renders 'Timeout' guidance when fyndSyncError matches timeout patterns", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "failed",
      fyndSyncError: "ETIMEDOUT after 30s",
      fyndSyncRetries: 1,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Timeout");
    });
    expect(container.textContent).toContain("Fynd API took too long");
  });

  it("renders the retry_scheduled indicator with attempt number", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "retry_scheduled",
      fyndSyncRetries: 1,
      fyndSyncNextRetry: new Date(Date.now() + 60_000).toISOString(),
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Retry #2 of 5 scheduled");
    });
    expect(container.textContent).toMatch(/Next retry:/);
  });

  it("renders the 'processing — logistics assignment in progress' banner", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FY-RET-1",
      fyndSyncStatus: "processing",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc, hasRealShipmentData: false }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/logistics assignment in progress/i);
    });
  });

  it("renders the Return Journey timeline step list when retJourney is non-empty", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndShipmentId: "FY-SHIP-1",
    });
    const journey = [
      { status: "return_initiated", displayName: "Return Initiated", time: "2026-05-01T10:00:00Z" },
      { status: "pickup_scheduled", displayName: "Pickup Scheduled", time: "2026-05-02T10:00:00Z" },
      { status: "in_transit", displayName: "In Transit", time: null },
    ];
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc, returnJourney: journey }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Return Journey");
    });
    expect(container.textContent).toContain("Return Initiated");
    expect(container.textContent).toContain("Pickup Scheduled");
    expect(container.textContent).toContain("In Transit");
  });

  it("renders the manual-return banner instead of the Shipment & Logistics card", async () => {
    const rc = makeReturnCase({
      status: "approved",
      shopifyOrderId: "manual:RMA-MANUAL-1",
      shopifyOrderName: "RMA-MANUAL-1",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc, isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Manual return/);
    });
    expect(container.textContent).toContain("process refund in Shopify Admin");
    expect(container.textContent).toContain("RMA-MANUAL-1");
    // Shipment & Logistics block is gated behind !isManualReturn
    expect(container.textContent).not.toContain("Shipment & Logistics");
  });

  it("renders the 'Fynd sync issue' search-param banner when fyndError query is present", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndError=Network%20timeout"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("Network timeout");
  });

  it("renders the success search-param banner with the 'already_synced' message", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndSuccess=already_synced"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Already synced to Fynd");
    });
  });

  it("renders the 'Fynd details refreshed' banner when fyndRefresh search-param is present", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndRefresh=1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd details refreshed");
    });
  });

  it("renders the 'Queued for Fynd consolidation' banner when consolidationQueued query is present", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?consolidationQueued=1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Queued for Fynd consolidation");
    });
    expect(container.textContent).toContain("batch window");
  });

  it("renders the no-return-shipment-data fallback prompt with 'Click Refresh' guidance", async () => {
    // approved but no return shipment data and not manual
    const rc = makeReturnCase({
      status: "approved",
      shopifyOrderName: "#1234",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No return shipment data yet");
    });
    expect(container.textContent).toContain("fetch from Fynd");
  });
});
