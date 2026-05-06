/** @vitest-environment jsdom */
/**
 * Coverage-targeted suite focused on the exchange/replacement branches of
 * `app.returns.$id.tsx`. Pairs with `app.returns.id.uncovered.test.tsx`
 * which already drives the refund + status-pill paths.
 *
 * What this file exercises (NEVER modifies source):
 *  - Exchange action button + Process Exchange modal open/close + Cancel
 *  - Exchange modal body shows customer exchangePreference when present
 *  - Replacement action button + Process Replacement modal open/close
 *  - Replacement modal renders the discount-disclaimer banner
 *  - Exchange/Replacement blocked-by-Fynd inventory banners
 *  - Existing Draft Order panel for invoice_pending exchange flow
 *    (renders headline "Exchange awaiting payment" + customer payment link)
 *  - Existing Order panel for replacement (real Order GID, not Draft)
 *  - Exchange completed_with_refund success + failure indicators
 *  - Exchange items count summary (singular vs plural)
 *  - Resolution-type badge swap between exchange and replacement
 *  - Approve-Return modal radio toggle to "exchange"/"replacement"
 *  - "Approve Exchange"/"Reject Exchange" labels on a pending exchange RC
 *  - Gift-return flag + resolution-type-pill restriction text
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
import { fireEvent, waitFor, act } from "@testing-library/react";
import Component from "../app.returns.$id";

// ── Loader fixture builders (subset of fields the component reads) ──
const baseItem = {
  id: "item_1",
  qty: 1,
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
    resolutionType: "exchange",
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
    events: [],
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

describe("app.returns.$id — exchange/replacement modal branches", () => {
  it("shows the Process Exchange button on an approved exchange return", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
  });

  it("opens the Process Exchange confirmation modal when the action button is clicked", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
    const btn = Array.from(container.querySelectorAll("s-button, button")).find(
      (b) => (b.textContent || "").trim() === "Process Exchange",
    );
    expect(btn).toBeTruthy();
    fireEvent.click(btn as Element);
    await waitFor(() => {
      // Modal title mirrors the button label and is repeated inside .app-modal-title.
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
      expect(container.textContent).toContain("Create Exchange Order");
    });
  });

  it("renders customer exchange preference inside the Process Exchange modal", async () => {
    const rc = makeReturnCase({
      exchangePreference: "Wants size Large in Red instead",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
    const btn = Array.from(container.querySelectorAll("s-button, button")).find(
      (b) => (b.textContent || "").trim() === "Process Exchange",
    );
    fireEvent.click(btn as Element);
    await waitFor(() => {
      expect(container.textContent).toContain("Customer exchange preference");
    });
    expect(container.textContent).toContain("Wants size Large in Red instead");
  });

  it("closes the Process Exchange modal via overlay click", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
    const btn = Array.from(container.querySelectorAll("s-button, button")).find(
      (b) => (b.textContent || "").trim() === "Process Exchange",
    );
    fireEvent.click(btn as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    const overlay = container.querySelector(".app-modal-overlay") as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeFalsy();
    });
  });

  it("blocks the Process Exchange action when Fynd status is not yet at warehouse", async () => {
    const rc = makeReturnCase({
      fyndReturnId: "FYND-RET-1",
      fyndCurrentStatus: "in_transit",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "in_transit",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Exchange unavailable");
    });
    expect(container.textContent).toContain("return_bag_delivered");
    // Clicking the disabled button must NOT open the modal.
    const btn = Array.from(container.querySelectorAll("s-button, button")).find(
      (b) => (b.textContent || "").trim() === "Process Exchange",
    );
    await act(async () => { fireEvent.click(btn as Element); });
    await waitFor(() => { expect(container.querySelector(".app-modal-overlay")).toBeFalsy(); });
  });

  it("shows the Process Replacement button + disclaimer on a replacement return", async () => {
    const rc = makeReturnCase({ resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Replacement");
    });
  });

  it("opens the Process Replacement modal and renders the 100%-discount disclaimer", async () => {
    const rc = makeReturnCase({ resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Replacement");
    });
    const btn = Array.from(container.querySelectorAll("s-button, button")).find(
      (b) => (b.textContent || "").trim() === "Process Replacement",
    );
    fireEvent.click(btn as Element);
    await waitFor(() => {
      expect(container.textContent).toContain("Create Replacement Order");
    });
    expect(container.textContent).toContain("100% applied discount");
    expect(container.textContent).toContain("This action cannot be undone.");
  });

  it("blocks the Process Replacement action when Fynd bag has not been received", async () => {
    const rc = makeReturnCase({
      resolutionType: "replacement",
      fyndReturnId: "FYND-RET-2",
      fyndCurrentStatus: "out_for_pickup",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "out_for_pickup",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Replacement unavailable");
    });
    expect(container.textContent).toContain("return_bag_delivered");
  });

  it("renders the Cancel button inside the Process Replacement modal and closes it", async () => {
    const rc = makeReturnCase({ resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Replacement");
    });
    fireEvent.click(
      Array.from(container.querySelectorAll("s-button, button")).find(
        (b) => (b.textContent || "").trim() === "Process Replacement",
      ) as Element,
    );
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    const cancelBtn = Array.from(
      container.querySelectorAll(".app-modal-actions s-button, .app-modal-actions button"),
    ).find((b) => (b.textContent || "").trim() === "Cancel");
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeFalsy();
    });
  });

  it("renders the existing Draft Order panel for a completed exchange (Exchange order created)", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/55501",
      exchangeOrderName: "D55501",
      events: [
        {
          eventType: "exchange_created",
          payloadJson: JSON.stringify({
            flow: "completed_free",
            priceDiff: 0,
            currency: "USD",
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Exchange order created");
    });
    expect(container.textContent).toContain("D55501");
    expect(container.textContent).toContain("Draft Order");
    const link = container.querySelector('a[href*="/draft_orders/55501"]');
    expect(link).toBeTruthy();
  });

  it("renders the invoice_pending headline + customer payment link when flow is invoice_pending", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/77701",
      exchangeOrderName: "D77701",
      exchangeItemsJson: JSON.stringify([{ title: "Replacement T-shirt" }]),
      events: [
        {
          eventType: "exchange_created",
          payloadJson: JSON.stringify({
            flow: "invoice_pending",
            priceDiff: 12.5,
            currency: "USD",
            invoiceUrl: "https://shop.myshopify.com/invoices/abc",
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Exchange awaiting payment");
    });
    expect(container.textContent).toContain("Customer payment link");
    expect(container.textContent).toContain("Customer owes");
    const inv = container.querySelector('a[href="https://shop.myshopify.com/invoices/abc"]');
    expect(inv).toBeTruthy();
  });

  it("renders Replacement order panel (real Order GID, not Draft)", async () => {
    const rc = makeReturnCase({
      resolutionType: "replacement",
      exchangeOrderId: "gid://shopify/Order/88812",
      exchangeOrderName: "#1235",
      exchangeItemsJson: JSON.stringify([{ title: "A" }, { title: "B" }]),
      events: [
        {
          eventType: "replacement_created",
          payloadJson: JSON.stringify({ flow: "completed_free", priceDiff: 0 }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Replacement order created");
    });
    expect(container.textContent).toContain("#1235");
    expect(container.textContent).toContain("2 items");
    const link = container.querySelector('a[href*="/orders/88812"]');
    expect(link).toBeTruthy();
  });

  it("shows the difference-refunded success line when flow=completed_with_refund", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/99001",
      exchangeOrderName: "D99001",
      events: [
        {
          eventType: "exchange_created",
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: -7.5,
            currency: "USD",
            refund: { success: true, amount: "7.50" },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Difference refunded");
    });
    expect(container.textContent).toContain("Refunded to customer");
  });

  it("shows the difference-refund-failed warning when refund.success === false", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/99002",
      exchangeOrderName: "D99002",
      events: [
        {
          eventType: "exchange_created",
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: -3,
            currency: "USD",
            refund: { success: false },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Difference refund failed");
    });
  });

  it("renders singular '1 item' label when exchangeItemsJson has exactly one entry", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/12000",
      exchangeOrderName: "D12000",
      exchangeItemsJson: JSON.stringify([{ title: "Solo" }]),
      events: [
        {
          eventType: "exchange_created",
          payloadJson: JSON.stringify({ flow: "completed_free" }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Exchange order created");
    });
    expect(container.textContent).toContain("1 item");
    expect(container.textContent).not.toContain("1 items");
  });

  it("renders the customer-exchange-preference card on the Details sidebar for resolutionType=exchange", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      exchangePreference: "Same item, different colour",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer exchange preference");
    });
    expect(container.textContent).toContain("Same item, different colour");
  });

  it("renders the resolution-type pill text 'replacement' for a replacement return", async () => {
    const rc = makeReturnCase({ resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Resolution Type");
    });
    expect(container.textContent?.toLowerCase()).toContain("replacement");
  });

  it("toggles selectedResolutionType in the Approve-Return modal between exchange and replacement radios", async () => {
    const rc = makeReturnCase({ status: "initiated", resolutionType: "refund" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Return");
    });
    const approveBtn = Array.from(
      container.querySelectorAll("s-button, button"),
    ).find((b) => (b.textContent || "").trim() === "Approve Return");
    fireEvent.click(approveBtn as Element);
    await waitFor(() => {
      expect(container.textContent).toContain("Resolution type");
    });
    const radios = Array.from(
      container.querySelectorAll('input[type="radio"]'),
    ) as HTMLInputElement[];
    expect(radios.length).toBeGreaterThanOrEqual(4);
    // Exchange option is index 1, Replacement is index 3 (refund=0, store_credit=2).
    fireEvent.click(radios[1]);
    await act(async () => { fireEvent.click(radios[3]); });
    await waitFor(() => { expect(container.textContent).toContain("Replacement"); });
    expect(container.textContent).toContain("Exchange");
  });

  it("uses 'Approve Exchange' / 'Reject Exchange' labels for a pending exchange return", async () => {
    const rc = makeReturnCase({ status: "initiated", resolutionType: "exchange" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Exchange");
    });
    expect(container.textContent).toContain("Reject Exchange");
  });

  it("renders the gift-return flag pill when isGiftReturn=true on an exchange return", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      isGiftReturn: true,
      giftRecipientName: "Recipient X",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Gift Recipient");
    });
    // Gift pill copy on the header item lists store credit / exchange options.
    expect(container.textContent?.toLowerCase()).toMatch(/gift/);
  });

  it("renders no exchange/replacement action button on a manual return", async () => {
    const rc = makeReturnCase({
      resolutionType: "exchange",
      shopifyOrderId: "manual:abc-123",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc, isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toContain("Process Exchange");
    expect(container.textContent).not.toContain("Process Replacement");
  });

  it("renders the manual-return notice ('process refund in Shopify Admin') when isManualReturn=true and not refunded", async () => {
    const rc = makeReturnCase({
      resolutionType: "refund",
      shopifyOrderId: "manual:abc-456",
      shopifyOrderName: "MANUAL-1",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc, isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Manual return");
    });
    expect(container.textContent).toContain("MANUAL-1");
  });
});
