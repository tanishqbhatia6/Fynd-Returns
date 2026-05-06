/** @vitest-environment jsdom */
/**
 * Action-button visibility tests for `app.returns.$id.tsx`.
 *
 * Drives the route component through every status branch
 * (initiated / pending / approved / rejected / completed / cancelled) and
 * a handful of cross-cutting flags (fyndSyncStatus=failed, fyndShipmentId,
 * isOrderCancellable, refundStatus=refunded, gift return, replacement /
 * exchange) so the action-button visibility rules are pinned by tests.
 *
 * NEVER modifies source. Mirrors the mocking strategy from
 * `app.returns.id.uncovered.test.tsx` so jsdom can mount the 3300-LOC
 * component without hitting Node-only deps.
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
import { waitFor } from "@testing-library/react";
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

function renderForStatus(
  rcOverrides: Record<string, unknown> = {},
  loaderOverrides: Record<string, unknown> = {},
) {
  const rc = makeReturnCase(rcOverrides);
  return renderWithRouter(Component, {
    initialEntries: ["/app/returns/ret_test_001"],
    loaderData: makeLoaderData({ returnCase: rc, ...loaderOverrides }) as never,
  });
}

describe("app.returns.$id — action-button visibility per status", () => {
  // ── Pending / Initiated ──
  it("shows Approve Return + Reject Return on initiated status", async () => {
    const { container } = renderForStatus({ status: "initiated" });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Return");
    });
    expect(container.textContent).toContain("Reject Return");
    // Refund flow should NOT be visible while pending
    expect(container.textContent).not.toContain("Process Refund");
  });

  it("shows Approve Return + Reject Return on pending status", async () => {
    const { container } = renderForStatus({ status: "pending" });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Return");
    });
    expect(container.textContent).toContain("Reject Return");
  });

  it("renders status pill 'Awaiting Review' for pending state", async () => {
    const { container } = renderForStatus({ status: "pending" });
    await waitFor(() => {
      expect(container.textContent).toContain("Awaiting Review");
    });
  });

  it("uses 'Approve Exchange' / 'Reject Exchange' labels when resolutionType is exchange", async () => {
    const { container } = renderForStatus({ status: "initiated", resolutionType: "exchange" });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Exchange");
    });
    expect(container.textContent).toContain("Reject Exchange");
    expect(container.textContent).not.toContain("Approve Return");
  });

  // ── Approved ──
  it("shows Process Refund on approved status (resolution=refund)", async () => {
    const { container } = renderForStatus({ status: "approved" });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    // Approve/Reject should NOT show once already approved
    expect(container.textContent).not.toContain("Approve Return");
    expect(container.textContent).not.toContain("Reject Return");
  });

  it("renders 'Approved' status pill for approved state", async () => {
    const { container } = renderForStatus({ status: "approved" });
    await waitFor(() => {
      expect(container.textContent).toContain("Approved");
    });
  });

  // ── Rejected ──
  it("shows no Approve/Reject/Refund actions on rejected status and renders Rejected pill", async () => {
    const { container } = renderForStatus({ status: "rejected" });
    await waitFor(() => {
      expect(container.textContent).toContain("Rejected");
    });
    expect(container.textContent).not.toContain("Approve Return");
    expect(container.textContent).not.toContain("Reject Return");
    expect(container.textContent).not.toContain("Process Refund");
  });

  it("renders rejection reason when provided on rejected return", async () => {
    const { container } = renderForStatus({
      status: "rejected",
      rejectionReason: "Outside return window",
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Outside return window");
    });
  });

  // ── Completed ──
  it("shows Process Refund on completed status when not yet refunded", async () => {
    const { container } = renderForStatus({ status: "completed" });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
  });

  it("renders 'Refund Completed' or 'Refunded' banner once refundStatus=refunded", async () => {
    const { container } = renderForStatus({ status: "completed", refundStatus: "refunded" });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Refund processed|Refund Completed|Refunded/);
    });
    // Refund flow should not appear when already refunded
    expect(container.textContent).not.toContain("Process Refund");
  });

  it("renders 'Return Received' status pill for completed state", async () => {
    const { container } = renderForStatus({ status: "completed" });
    await waitFor(() => {
      expect(container.textContent).toContain("Return Received");
    });
  });

  // ── Cancelled ──
  it("renders 'Cancelled' status pill for cancelled state and hides primary actions", async () => {
    const { container } = renderForStatus({ status: "cancelled" });
    await waitFor(() => {
      expect(container.textContent).toContain("Cancelled");
    });
    expect(container.textContent).not.toContain("Approve Return");
    expect(container.textContent).not.toContain("Reject Return");
    expect(container.textContent).not.toContain("Process Refund");
    // Cancel-Order button is also gated off in cancelled state
    expect(container.textContent).not.toContain("Cancel Order");
  });

  // ── Fynd sync failed: retry banner + Sync to Fynd button ──
  it("shows 'Sync to Fynd' retry banner when fyndSyncStatus=failed", async () => {
    const { container } = renderForStatus({
      status: "approved",
      fyndSyncStatus: "failed",
      fyndSyncError: "Network timeout",
      fyndSyncRetries: 3,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync failed");
    });
    expect(container.textContent).toContain("Sync to Fynd");
  });

  // ── Fynd trace panel link / payload ──
  it("renders fynd-trace UI when fyndShipmentId is present", async () => {
    const { container } = renderForStatus(
      {
        fyndShipmentId: "FYND-SHIP-99",
        fyndReturnId: "FYND-RET-99",
        fyndCurrentStatus: "return_initiated",
        fyndPayloadJson: JSON.stringify({
          shipment_status: "return_initiated",
          id: "FYND-SHIP-99",
        }),
      },
      {
        fyndCurrentStatus: "return_initiated",
        fyndPayloadInfo: {
          shipments: [{ shipmentStatus: "return_initiated", id: "FYND-SHIP-99" }],
        },
      },
    );
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-TEST-001");
    });
    // Either a Fynd trace panel/raw-toggle or some Fynd-specific status string
    expect(container.textContent?.toLowerCase()).toMatch(/fynd|return_initiated/);
  });

  // ── Cancel-order button ──
  it("renders Cancel Order button when order is cancellable (UNFULFILLED)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: makeReturnCase({ status: "approved" }),
        shopifyOrder: { displayFulfillmentStatus: "UNFULFILLED" },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Cancel Order");
    });
  });

  it("hides Cancel Order button when fulfillment status is FULFILLED", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: makeReturnCase({ status: "approved" }),
        shopifyOrder: { displayFulfillmentStatus: "FULFILLED" },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    expect(container.textContent).not.toContain("Cancel Order");
  });

  // ── Replacement / Exchange action buttons (resolutionType-driven) ──
  it("does not show replacement/exchange order CTAs for plain refund resolution", async () => {
    const { container } = renderForStatus({ status: "approved", resolutionType: "refund" });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    // Refund-only flow should not surface exchange-creation language
    expect(container.textContent).not.toMatch(/Create exchange order|Create replacement order/i);
  });

  // ── Gift return ──
  it("renders Gift Return badge + recipient card when isGiftReturn=true", async () => {
    const { container } = renderForStatus({
      isGiftReturn: true,
      giftRecipientName: "Bob Recipient",
      giftRecipientEmail: "bob@example.com",
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Gift Return");
    });
    expect(container.textContent).toContain("Gift Recipient");
    expect(container.textContent).toContain("bob@example.com");
  });

  // ── Manual return: hides Cancel Order even when status would otherwise allow it ──
  it("hides Cancel Order on manual returns (non-Shopify orders)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: makeReturnCase({
          status: "approved",
          shopifyOrderId: "manual:abc123",
        }),
        isManualReturn: true,
        shopifyOrder: { displayFulfillmentStatus: "UNFULFILLED" },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toContain("Cancel Order");
  });
});
