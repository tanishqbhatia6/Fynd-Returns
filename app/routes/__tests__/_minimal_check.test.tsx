/** @vitest-environment jsdom */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../shopify.server", () => ({ default: {}, authenticate: { admin: vi.fn() } }));
vi.mock("../db.server", () => ({ default: { shop: { findUnique: vi.fn() } } }));
vi.mock("../lib/status-colors", () => ({ getStatusColor: vi.fn(() => "#0"), getStatusBg: vi.fn(() => "#0") }));
vi.mock("../lib/shopify-admin.server", () => ({
  fetchOrder: vi.fn(), fetchOrderByOrderNumber: vi.fn(), fetchOrderByFyndAffiliateId: vi.fn(),
  fetchAllLocations: vi.fn(async () => []), withRestCredentials: vi.fn((a) => a),
}));
vi.mock("../lib/return-request-id", () => ({
  parseReturnIdConfig: vi.fn(() => ({})), buildReturnRequestId: vi.fn(() => "X"), formatReturnRequestId: vi.fn((id) => `R-${id}`),
}));
vi.mock("../lib/return-id-counter.server", () => ({ nextReturnIdCounter: vi.fn() }));
vi.mock("../lib/fynd-payload.server", () => ({
  parseFyndPayloadForDisplay: vi.fn(), parseFyndOrderDetailsForTab: vi.fn(),
  getPickupAddressFromFyndPayload: vi.fn(), extractFyndJourney: vi.fn(() => []),
  extractCustomerFromFyndPayload: vi.fn(), extractShippingDetailsFromFyndPayload: vi.fn(),
  extractAffiliateOrderIdFromFyndPayload: vi.fn(), isLikelyFyndId: vi.fn(),
  buildTrackingUrlFromCourierAndAwb: vi.fn(),
}));
vi.mock("../lib/fynd.server", () => ({ isFyndPrivateUrl: vi.fn(), signFyndUrl: vi.fn(), createFyndClientOrError: vi.fn() }));
vi.mock("../lib/refund-gate-presets", () => ({ PRESET_LABELS: {} }));
vi.mock("../lib/observability/logger.server", () => ({ refundLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../components/json-viewer", () => ({ PayloadViewer: () => <div /> }));
vi.mock("../components/AppPage", () => ({ AppPage: ({ heading, children }: any) => <div><h1>{heading}</h1>{children}</div> }));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(), headers: vi.fn() },
  shopifyApp: vi.fn(() => ({})),
  ApiVersion: {}, AppDistribution: {}, DeliveryMethod: {},
}));

import { renderWithRouter } from "../../test/component-helpers";
import Comp from "../app.returns.$id";

describe("debug", () => {
  it("renders", async () => {
    const ld = {
      returnCase: { id: "x", status: "approved", refundStatus: null, items: [], shopifyOrderId: null, shopifyOrderName: "#1", returnRequestNo: "RMA-1", customerName: null, customerEmailNorm: null, customerCity: null, customerCountry: null, currency: "USD", isGreenReturn: false, fyndReturnId: null, fyndSyncStatus: null, fyndCurrentStatus: null, fyndPayloadJson: null, fyndShipmentId: null, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), resolutionType: "refund", customerAddress1: null, customerAddress2: null, customerProvince: null, customerZip: null, customerLandmark: null },
      shopDomain: "test.myshopify.com", shopifyOrder: null, isManualReturn: false, fyndPayloadInfo: null, fyndOrderDetailsTab: null, pickupAddress: null, returnJourney: [], shopLocations: [], fulfillmentLocationId: null, fulfillmentLocationName: null, refundLocationMode: "auto", refundPaymentMethod: "original", refundStoreCreditPct: 100, isCodOrder: false, returnLabelInfo: null, defaultReturnInstructions: null, customerReturnCount: 1, customerEmail: null, bonusCreditEnabled: false, bonusCreditPct: 0, isBlocklisted: true, daysRemaining: null, returnDeadline: null, discountCodeRefundEnabled: false, discountCodePrefix: "", discountCodeExpiryDays: 0, shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC", fyndCurrentStatus: null, customerReturnHistory: [], hasRealShipmentData: false, displayForwardAwb: null, displayReturnAwb: null, allowedFyndStatusesForRefund: [], refundGatePreset: null,
    };
    const { container } = renderWithRouter(Comp, { initialEntries: ["/x"], loaderData: ld as never });
    await new Promise(r => setTimeout(r, 200));
    console.log("LEN:", (container.textContent || "").length);
    console.log("HTML:", container.innerHTML.slice(0, 600));
    expect(true).toBe(true);
  });
});
