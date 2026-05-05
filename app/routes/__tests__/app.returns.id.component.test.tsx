/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.returns.$id.tsx ──
// The route is a 3300+ LOC default-exported component. Its module load pulls
// in shopify.server, db.server, and a swarm of lib/* helpers (some of which
// reach into Node-only deps like prisma, fynd-fdk, observability/logger).
// Stub everything the module evaluates so jsdom can mount the component.

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

vi.mock("../lib/refund-gate-presets", () => ({
  PRESET_LABELS: {} as Record<string, string>,
}));

vi.mock("../lib/observability/logger.server", () => ({
  refundLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// PayloadViewer is a heavy component pulled in for the raw JSON tab.
// Replace with a tiny stub so we don't drag in its tree.
vi.mock("../components/json-viewer", () => ({
  PayloadViewer: ({ data }: { data: unknown }) => (
    <div data-testid="payload-viewer">{JSON.stringify(data ?? null)}</div>
  ),
}));

// AppPage uses <Link> from react-router and is fine, but stubbing keeps the
// DOM small and stable for assertions about the H1.
vi.mock("../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 className="app-page-title">{heading}</h1>
      <div>{children}</div>
    </div>
  ),
}));

// boundary helpers from the server entry are referenced when shopify.server
// evaluates; stub them so vitest's module resolution stays well-behaved even
// though we already mocked shopify.server above.
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
import ReturnDetail from "../app.returns.$id";

// ── Minimal loader shape for an "approved" return with one item ──
const baseReturnCase = {
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
  items: [
    {
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
    },
  ],
};

const baseLoaderData = {
  returnCase: baseReturnCase,
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
};

describe("ReturnDetail (default export)", () => {
  it("renders the AppPage heading with the return request id", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("h1.app-page-title")).toBeTruthy();
    });
    const h1 = container.querySelector("h1.app-page-title");
    expect(h1?.textContent).toContain("Return RMA-TEST-001");
  });

  it("shows the return request id and order number in the status hero", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: baseLoaderData,
    });
    // Hero has: Return <mono>RMA-TEST-001</mono> for order <strong>#1234</strong>
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-TEST-001");
    });
    expect(container.textContent).toContain("#1234");
  });

  it("renders a status badge whose label reflects the unified state for an approved return", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: baseLoaderData,
    });
    // For an approved return with no refund/journey, the unified state hero
    // label is "Approved" — rendered at fontSize 22 / weight 700 in the
    // status hero.
    await waitFor(() => {
      expect(container.textContent).toContain("Approved");
    });
    const heroLabels = Array.from(container.querySelectorAll("div")).filter(
      (d) => {
        const s = (d as HTMLElement).style;
        return s.fontSize === "22px" && s.fontWeight === "700";
      },
    );
    expect(heroLabels.length).toBeGreaterThan(0);
    expect(heroLabels[0].textContent?.trim()).toBe("Approved");
  });

  it("renders the items list with the item count and product title", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned (1)");
    });
    expect(container.textContent).toContain("Test Product Alpha");
    expect(container.textContent).toContain("Medium / Blue");
  });

  it("renders the qty, reason code, and condition chips for the item", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Qty: 2");
    });
    expect(container.textContent).toContain("wrong_size");
    // "unused" condition maps to the label "Unused"
    expect(container.textContent).toContain("Unused");
  });

  it("renders the empty-state message when the return has no items", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: {
        ...baseLoaderData,
        returnCase: { ...baseReturnCase, items: [] },
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned (0)");
    });
    expect(container.textContent).toContain("No items recorded");
  });

  it("shows a flagged-customer pill when the loader marks the customer as blocklisted", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: { ...baseLoaderData, isBlocklisted: true },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Flagged customer");
    });
  });

  it("shows a return-window remaining pill when daysRemaining > 0", async () => {
    const { container } = renderWithRouter(ReturnDetail, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: { ...baseLoaderData, daysRemaining: 15 },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("15 days remaining");
    });
  });
});
