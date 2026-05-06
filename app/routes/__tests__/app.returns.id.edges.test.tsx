/** @vitest-environment jsdom */
/**
 * Edge-case branches for `app.returns.$id.tsx` not covered by the
 * existing `app.returns.id.uncovered.test.tsx` companion suite.
 *
 * Variants covered:
 *  - status=cancelled (no approve/reject/refund actions)
 *  - status=completed + refunded refundStatus (completion banner)
 *  - fraudRiskLevel=high banner
 *  - fraudRiskLevel=critical banner
 *  - isGiftReturn banner ("Gift return" pill / "Gift Recipient" card)
 *  - cancellation requested banner ("Customer requested cancellation")
 *  - exchange resolutionType action button ("Process Exchange")
 *  - replacement resolutionType action button ("Process Replacement")
 *  - empty timeline state ("No events yet")
 *  - non-empty timeline (events list rendered)
 *  - missing fyndShipmentId fallback (no Ret/Fwd Shipment ID rows)
 *  - present fyndShipmentId (Shipment ID row rendered)
 *  - manual return hides Shipment & Logistics card
 *  - rejected status hides approve/refund actions
 *  - blocklisted flag pill
 *  - fynd sync failed prominent banner
 *
 * NEVER modifies source. Mocks every Node-only module the route pulls in.
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
  buildReturnRequestId: vi.fn(() => "RMA-EDGE-001"),
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
  id: "item_edge_1",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/222",
  sku: "SKU-EDGE",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Edge Test Product",
  variantTitle: "Default",
  imageUrl: null,
  price: "19.99",
  notes: null,
  fyndBagId: null,
  fyndArticleId: null,
  fyndSellerIdentifier: null,
  fyndSize: null,
  fyndShipmentId: null,
};

function makeReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "ret_edge_001",
    returnRequestNo: "RMA-EDGE-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/8888",
    shopifyOrderName: "#5678",
    customerName: "Edge Customer",
    customerEmailNorm: "edge@example.com",
    customerCity: "London",
    customerCountry: "UK",
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
    shopDomain: "edge-shop.myshopify.com",
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
    customerEmail: "edge@example.com",
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

describe("app.returns.$id — edge-case branches", () => {
  it("status=cancelled hides approve/reject/process refund buttons", async () => {
    const rc = makeReturnCase({ status: "cancelled" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toContain("Approve Return");
    expect(container.textContent).not.toContain("Process Refund");
    expect(container.textContent).not.toContain("Reject Return");
  });

  it("status=completed + refundStatus=refunded shows Refund processed banner", async () => {
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      refundJson: JSON.stringify({
        refundId: "gid://shopify/Refund/12345",
        amount: "19.99",
        currency: "USD",
        createdAt: "2026-05-02T00:00:00Z",
        source: "admin",
      }),
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Refund processed");
    });
    expect(container.textContent).toContain("Refund #12345");
  });

  it("fraudRiskLevel=high renders Fraud Risk card with high risk label", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "high", fraudRiskScore: 80 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fraud Risk");
    });
    expect(container.textContent).toContain("80/100");
    expect(container.textContent?.toLowerCase()).toContain("high risk");
  });

  it("fraudRiskLevel=critical renders Fraud Risk card with critical score", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "critical", fraudRiskScore: 99 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fraud Risk");
    });
    expect(container.textContent).toContain("99/100");
  });

  it("fraudRiskLevel=low does NOT render the high-risk banner styling", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "low", fraudRiskScore: 5 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    // low-risk score shouldn't show the score detail rendered
    // (renders only when fraudRiskLevel is high or critical)
    expect(container.textContent).not.toContain("5/100");
  });

  it("isGiftReturn=true renders the Gift Return pill", async () => {
    const rc = makeReturnCase({
      isGiftReturn: true,
      giftRecipientName: "Recipient",
      giftRecipientEmail: "recipient@example.com",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Gift Return");
    });
    expect(container.textContent).toContain("Gift Recipient");
  });

  it("cancellationRequestedAt set => cancellation request banner is shown", async () => {
    const rc = makeReturnCase({
      cancellationRequestedAt: new Date("2026-05-03T00:00:00Z").toISOString(),
      cancellationRequestedBy: "customer_portal",
      cancellationReason: "Mistake",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer requested cancellation");
    });
    expect(container.textContent).toContain("Mistake");
  });

  it("resolutionType=exchange shows Process Exchange action button", async () => {
    const rc = makeReturnCase({ status: "approved", resolutionType: "exchange" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Exchange");
    });
    expect(container.textContent).not.toContain("Process Replacement");
  });

  it("resolutionType=replacement shows Process Replacement action button", async () => {
    const rc = makeReturnCase({ status: "approved", resolutionType: "replacement" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Replacement");
    });
    expect(container.textContent).not.toContain("Process Exchange");
  });

  it("empty events array => 'No events yet' placeholder is rendered", async () => {
    const rc = makeReturnCase({ events: [] });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("No events yet");
  });

  it("missing events field => 'No events yet' placeholder is still rendered", async () => {
    const rc = makeReturnCase();
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("No events yet");
  });

  it("non-empty events array => events are listed (no placeholder)", async () => {
    const rc = makeReturnCase({
      events: [
        {
          id: "evt_1",
          eventType: "approved",
          source: "admin",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({ adminEmail: "admin@example.com" }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).not.toContain("No events yet");
    expect(container.textContent).toContain("Approved");
  });

  it("missing fyndShipmentId => no 'Shipment ID' label in Fynd Reference", async () => {
    const rc = makeReturnCase({ fyndShipmentId: null });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).not.toContain("Ret Shipment ID");
    expect(container.textContent).not.toContain("Fwd Shipment ID");
  });

  it("present fyndShipmentId => Shipment ID row appears in Fynd Reference", async () => {
    const rc = makeReturnCase({ fyndShipmentId: "FYND-SHIP-EDGE-1" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Reference");
    });
    expect(container.textContent).toContain("FYND-SHIP-EDGE-1");
  });

  it("isManualReturn=true hides the Shipment & Logistics card", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).not.toContain("Shipment & Logistics");
  });

  it("status=rejected hides Approve/Process Refund buttons", async () => {
    const rc = makeReturnCase({ status: "rejected" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toContain("Approve Return");
    expect(container.textContent).not.toContain("Process Refund");
  });

  it("isBlocklisted=true => 'Flagged customer' indicator is rendered", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ isBlocklisted: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Flagged customer");
    });
  });

  it("fyndSyncStatus=failed => prominent 'Fynd sync failed' banner with retry button", async () => {
    const rc = makeReturnCase({
      fyndSyncStatus: "failed",
      fyndSyncError: "Connection refused",
      fyndSyncRetries: 2,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync failed");
    });
    expect(container.textContent).toContain("Sync to Fynd");
  });

  it("status=initiated => Approve Return + Reject Return both rendered", async () => {
    const rc = makeReturnCase({ status: "initiated" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Return");
    });
    expect(container.textContent).toContain("Reject Return");
  });

  it("customerReturnCount=1 => no 'returns' multi-history pill", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_edge_001"],
      loaderData: makeLoaderData({ customerReturnCount: 1 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toMatch(/\b\d+ returns\b/);
  });
});
