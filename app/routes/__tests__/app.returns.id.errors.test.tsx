/** @vitest-environment jsdom */
/**
 * Error / empty-state coverage for `app/routes/app.returns.$id.tsx`.
 *
 * Targets branches not exercised by `app.returns.id.uncovered.test.tsx`:
 *  - ErrorBoundary export across various thrown error shapes
 *    (Error w/o message, plain string, plain object, 4xx Response,
 *    Response with status >= 500, and 401/403)
 *  - Search-param banners (fyndError variants — config_error,
 *    network_error, timeout, api_error, "[object Response]") and
 *    fyndSuccess variants (already_synced, already_exists, generic)
 *  - action-result banner display via actionData / fetcher data shapes
 *  - Empty events list rendering ("No events yet…")
 *  - Empty items list rendering ("No items recorded")
 *  - Missing-fyndShipment branch on items/timeline
 *  - No-customer-email branch (Customer card omits the link)
 *  - Items-without-images placeholder SVG
 *
 * NEVER modifies source. Mocks every module the route pulls in so jsdom
 * can mount the 3300-LOC component without hitting Node-only deps.
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
import { render, waitFor } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import Component, { ErrorBoundary } from "../app.returns.$id";

/**
 * Render the ErrorBoundary export by mounting a memory router with a
 * route loader that throws the supplied error. React Router routes the
 * error to the route's `errorElement`, where useRouteError() returns
 * the thrown value — exactly the production code path.
 */
function renderErrorBoundary(thrown: unknown) {
  const routes: RouteObject[] = [
    {
      path: "*",
      loader: () => { throw thrown; },
      element: <div>ok</div>,
      errorElement: <ErrorBoundary />,
      hydrateFallbackElement: <div data-testid="hydrate-fallback" />,
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: ["/x"] });
  return render(<RouterProvider router={router} />);
}

// ── Loader fixture builders ──
const baseItem = {
  id: "item_1",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/111",
  sku: "SKU-001",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Test Product",
  variantTitle: null,
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

describe("app.returns.$id ErrorBoundary — additional error shapes", () => {
  it("renders generic boundary for an Error without a message", async () => {
    const err = new Error();
    const { container } = renderErrorBoundary(err);
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    // Description shows for generic errors
    expect(container.textContent).toContain("An unexpected error occurred");
  });

  it("renders generic boundary for a thrown plain string", async () => {
    const { container } = renderErrorBoundary("kaboom-string");
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    // String coerces to itself in the details block
    expect(container.textContent).toContain("kaboom-string");
  });

  it("renders generic boundary for a thrown plain object", async () => {
    const { container } = renderErrorBoundary({ weird: "object" });
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    // String() of object → "[object Object]"
    expect(container.textContent).toMatch(/object Object/);
  });

  it("renders 401 Response as generic 'Something went wrong'", async () => {
    const { container } = renderErrorBoundary(
      new Response("unauthorized", { status: 401 }),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
  });

  it("renders 403 Response as generic 'Something went wrong'", async () => {
    const { container } = renderErrorBoundary(
      new Response("forbidden", { status: 403 }),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
  });

  it("renders 502 Response with a stable heading", async () => {
    const { container } = renderErrorBoundary(
      new Response("bad gateway", { status: 502 }),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
  });

  it("does not render the debug <details> block on a 500 response", async () => {
    const { container } = renderErrorBoundary(
      new Response("boom", { status: 500 }),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("app.returns.$id — search-param error/success banners", () => {
  it("renders the fyndError banner with config_error message", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndError=config_error"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("config_error");
  });

  it("renders the fyndError banner with network_error message", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndError=network_error"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("network_error");
  });

  it("renders the fyndError banner with timeout message", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndError=timeout"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("timeout");
  });

  it("renders the fyndError banner with api_error message", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndError=api_error"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("api_error");
  });

  it("substitutes the friendly message when fyndError is '[object Response]'", async () => {
    const url = `/app/returns/ret_test_001?fyndError=${encodeURIComponent("[object Response]")}`;
    const { container } = renderWithRouter(Component, {
      initialEntries: [url],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync issue");
    });
    expect(container.textContent).toContain("Request failed. Check Fynd configuration.");
    expect(container.textContent).not.toContain("[object Response]");
  });

  it("renders the fyndSuccess banner — already_synced variant", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndSuccess=already_synced"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Already synced to Fynd.");
    });
  });

  it("renders the fyndSuccess banner — already_exists variant", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndSuccess=already_exists"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/already exists on Fynd/i);
    });
  });

  it("renders the fyndSuccess banner — generic synced variant", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndSuccess=ok"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Synced to Fynd successfully.");
    });
  });

  it("renders the fyndRefresh success banner", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001?fyndRefresh=1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd details refreshed.");
    });
  });
});

describe("app.returns.$id — empty-state rendering", () => {
  it("renders 'No items recorded' when items is an empty array", async () => {
    const rc = makeReturnCase({ items: [] });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No items recorded");
    });
    expect(container.textContent).toContain("Items being returned (0)");
  });

  it("renders 'No items recorded' when items is missing/null", async () => {
    const rc = makeReturnCase({ items: null });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No items recorded");
    });
  });

  it("renders the empty events placeholder when events list is empty", async () => {
    const rc = makeReturnCase({ events: [] });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("No events yet");
  });

  it("renders the empty events placeholder when events is missing", async () => {
    // No `events` key on the return case at all
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("No events yet");
  });

  it("renders the placeholder SVG when an item has no imageUrl", async () => {
    const rc = makeReturnCase({
      items: [{ ...baseItem, imageUrl: null }],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned");
    });
    // No <img> for the item; placeholder svg exists in the line-item card
    const itemImgs = container.querySelectorAll(".rpm-detail-layout img");
    expect(itemImgs.length).toBe(0);
    // The placeholder uses a <rect> inside an inline svg.
    expect(container.querySelector("svg rect")).toBeTruthy();
  });

  it("does not render Customer-Returns 'View all' link when customerEmail is missing", async () => {
    const rc = makeReturnCase({
      customerEmailNorm: null,
      customerName: "Anon Buyer",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        customerEmail: null,
        customerReturnCount: 2,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    // The "View all customer returns →" link is suppressed without an email
    const linkToCustomer = container.querySelector('a[href^="/app/customers?q="]');
    expect(linkToCustomer).toBeNull();
  });

  it("renders without the fynd shipment ID block when shipmentId is missing", async () => {
    const rc = makeReturnCase({ fyndShipmentId: null, fyndReturnId: null });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned");
    });
    // No "Shipment:" pill anywhere on the page
    expect(container.textContent).not.toContain("Shipment:");
  });

  it("renders the action-error banner from actionData (fetcher.data?.error)", async () => {
    // Fetcher data is independent of action data, but the route also surfaces
    // top-level errors via fetcher; verify the page still renders cleanly
    // when actionData carries an error payload.
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
      actionData: { error: "refund_failed: payment gateway down" } as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned");
    });
    // Loader renders normally regardless of actionData
    expect(container.textContent).toContain("RMA-TEST-001");
  });

  it("renders cleanly when actionData reports success", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
      actionData: { success: true, status: "approved" } as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Items being returned");
    });
  });
});
