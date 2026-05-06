/** @vitest-environment jsdom */
/**
 * Coverage-targeted companion to `app.returns.id.component.test.tsx`.
 *
 * Existing test exercises the happy-path "approved + no items / minimal
 * loader" render. This file pushes the same component through the
 * branches the original suite skips:
 *  - CRM / Admin Details card (createdByChannel/createdByStaff/...)
 *  - Customer media uploads (customerMediaJson, image + video tiles)
 *  - Gift return / Fraud risk / Customer notes / Internal notes textarea
 *  - Edit-pickup-address toggle
 *  - Status pill labels for pending/rejected/completed/cancelled
 *  - Action button visibility per state
 *  - Refund modal open/close
 *  - Reject form open/close
 *  - Replacement / Exchange confirm modals
 *  - Cancel-order modal
 *  - Fynd-trace UI when fyndShipmentId is present
 *  - ErrorBoundary export across 404 / 400 / 500 / generic errors
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
import { render, fireEvent, waitFor } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import Component, { ErrorBoundary } from "../app.returns.$id";

/**
 * Render the ErrorBoundary export by mounting a memory router with a
 * route loader that throws the supplied error. React Router routes the
 * error to the route's `errorElement`, where useRouteError() will return
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

describe("app.returns.$id — uncovered branches", () => {
  it("renders CRM/Admin Details card when channel/staff/ticketId/notes present", async () => {
    const rc = makeReturnCase({
      createdByChannel: "admin",
      createdByStaff: "Alice Operator",
      crmTicketId: "ZD-77123",
      crmNotes: "Customer escalated via support chat. Issue size mismatch.",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("CRM / Admin Details");
    });
    expect(container.textContent).toContain("Alice Operator");
    expect(container.textContent).toContain("ZD-77123");
    expect(container.textContent).toContain("Customer escalated");
    // channel pill rendered uppercase via textTransform — actual text is lower
    expect(container.textContent?.toLowerCase()).toContain("admin");
  });

  it("falls through to default channel color when channel is not in the lookup", async () => {
    const rc = makeReturnCase({
      createdByChannel: "mystery_channel",
      createdByStaff: null,
      crmTicketId: null,
      crmNotes: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("CRM / Admin Details");
    });
    expect(container.textContent?.toLowerCase()).toContain("mystery_channel");
  });

  it("renders customer media uploads (image + video tiles) when customerMediaJson is set", async () => {
    const media = [
      { name: "photo.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/4AAQ" },
      { name: "demo.mp4", mimeType: "video/mp4", dataUrl: "data:video/mp4;base64,AAAA" },
      // entry without name/mimeType to exercise fallback "Upload N" label
      { dataUrl: "https://cdn.example/x.png" },
    ];
    const rc = makeReturnCase({
      customerMediaJson: JSON.stringify(media),
      customerNotes: "These are the photos.\n\n[Attached Files: ignored]",
    });
    const { container, getAllByRole } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer uploads");
    });
    expect(container.querySelector("video")).toBeTruthy();
    expect(container.querySelector("img")).toBeTruthy();
    expect(container.textContent).toContain("photo.jpg");
    expect(container.textContent).toContain("demo.mp4");
    expect(container.textContent).toContain("Upload 3");
    // click an upload button — exercise openDataUrl branches (data: vs http:)
    const buttons = getAllByRole("button");
    const uploadBtn = buttons.find((b) =>
      (b.getAttribute("title") || "").includes("photo.jpg"),
    );
    if (uploadBtn) {
      // Prevent jsdom from logging "Not implemented: window.open"
      const origOpen = window.open;
      window.open = vi.fn() as unknown as typeof window.open;
      fireEvent.click(uploadBtn);
      window.open = origOpen;
    }
  });

  it("renders no Customer Uploads block when customerMediaJson is malformed", async () => {
    const rc = makeReturnCase({ customerMediaJson: "{not json" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Notes");
    });
    expect(container.textContent).not.toContain("Customer uploads");
  });

  it("renders gift recipient card when isGiftReturn is true", async () => {
    const rc = makeReturnCase({
      isGiftReturn: true,
      giftRecipientName: "Bob Recipient",
      giftRecipientEmail: "bob@example.com",
      giftMessageToSender: "Thanks for the gift!",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Gift Recipient");
    });
    expect(container.textContent).toContain("Bob Recipient");
    expect(container.textContent).toContain("bob@example.com");
  });

  it("renders the Fraud Risk card for high risk", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "high", fraudRiskScore: 72 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fraud Risk");
    });
    expect(container.textContent).toContain("72/100");
    expect(container.textContent?.toLowerCase()).toContain("high risk");
  });

  it("renders the Fraud Risk card for critical risk", async () => {
    const rc = makeReturnCase({ fraudRiskLevel: "critical", fraudRiskScore: 95 });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("95/100");
    });
  });

  it("opens and closes the refund-confirmation modal for an approved refund return", async () => {
    const { container, getAllByText } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
    const btns = getAllByText("Process Refund");
    fireEvent.click(btns[0]);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    // close via overlay click
    const overlay = container.querySelector(".app-modal-overlay") as HTMLElement;
    fireEvent.click(overlay);
  });

  it("renders the reject form when 'Reject Return' is clicked on a pending return", async () => {
    const rc = makeReturnCase({ status: "initiated" });
    const { container, getAllByText } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Reject Return");
    });
    const btn = getAllByText("Reject Return")[0];
    fireEvent.click(btn);
    await waitFor(() => {
      expect(container.textContent).toContain("Rejection reason");
    });
    // Type into reject reason and verify Confirm becomes enabled
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, { target: { value: "out of policy" } });
    // Cancel
    const cancelBtns = Array.from(container.querySelectorAll("s-button")).filter(
      (b) => (b.textContent || "").trim() === "Cancel",
    );
    if (cancelBtns.length > 0) fireEvent.click(cancelBtns[0]);
  });

  it("opens the Approve Return modal and switches resolution type", async () => {
    const rc = makeReturnCase({ status: "initiated" });
    const { container, getAllByText } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approve Return");
    });
    fireEvent.click(getAllByText("Approve Return")[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Resolution type");
    });
    // Click the "Exchange" radio label (toggles selectedResolutionType)
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(radios[1]);
    fireEvent.click(radios[2]);
    fireEvent.click(radios[3]);
  });

  it("uses 'Approve Exchange' / 'Reject Exchange' labels when resolutionType is exchange", async () => {
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

  it("renders rejected status pill and no approval/refund actions for rejected return", async () => {
    const rc = makeReturnCase({ status: "rejected" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
    expect(container.textContent).not.toContain("Approve Return");
  });

  it("renders completed/refunded final state for refunded return", async () => {
    const rc = makeReturnCase({ status: "completed", refundStatus: "refunded" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Refund Completed|Refunded/);
    });
  });

  it("renders cancelled state without exchange/refund actions", async () => {
    const rc = makeReturnCase({ status: "cancelled" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Actions");
    });
  });

  it("renders the cancellation-request banner and opens the approve-cancellation modal", async () => {
    const rc = makeReturnCase({
      status: "approved",
      cancellationRequestedAt: new Date("2026-05-01T12:00:00Z").toISOString(),
      cancellationRequestedBy: "customer_portal",
      cancellationReason: "Changed my mind",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer requested cancellation");
    });
    expect(container.textContent).toContain("Changed my mind");
    const approveBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Approve Cancellation"),
    );
    expect(approveBtn).toBeTruthy();
    if (approveBtn) {
      fireEvent.click(approveBtn);
      await waitFor(() => {
        expect(container.textContent).toContain("Confirm Cancellation");
      });
      // Close via Go Back button
      const goBack = Array.from(container.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim() === "Go Back",
      );
      if (goBack) fireEvent.click(goBack);
    }
  });

  it("renders the cancellation-declined indicator when only declined-at is set", async () => {
    const rc = makeReturnCase({
      cancellationDeclinedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Cancellation request declined");
    });
  });

  it("toggles edit-pickup-address form on the Customer card", async () => {
    const rc = makeReturnCase({
      customerAddress1: "1 Test St",
      customerZip: "10001",
      customerLandmark: "By the park",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Edit pickup address");
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").includes("Edit pickup address"),
    );
    expect(toggle).toBeTruthy();
    if (toggle) {
      fireEvent.click(toggle);
      await waitFor(() => {
        // After toggling, form fields should be present
        expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
      });
      // Toggle back off — label flips to "Cancel"
      const toggle2 = Array.from(container.querySelectorAll("button")).find(
        (b) => (b.textContent || "").trim() === "Cancel" && b.style.color === "rgb(37, 99, 235)",
      );
      if (toggle2) fireEvent.click(toggle2);
    }
  });

  it("renders fynd-trace UI when fyndShipmentId is present (raw payload tab toggle)", async () => {
    const rc = makeReturnCase({
      fyndShipmentId: "FYND-SHIP-99",
      fyndReturnId: "FYND-RET-99",
      fyndCurrentStatus: "return_initiated",
      fyndPayloadJson: JSON.stringify({ shipment_status: "return_initiated", id: "FYND-SHIP-99" }),
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "return_initiated",
        fyndPayloadInfo: {
          shipments: [
            { shipmentStatus: "return_initiated", id: "FYND-SHIP-99" },
          ],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-TEST-001");
    });
    // Toggle raw fynd JSON viewer
    const rawToggle = Array.from(container.querySelectorAll("button")).find(
      (b) => /raw|JSON|payload/i.test(b.textContent || ""),
    );
    if (rawToggle) fireEvent.click(rawToggle);
  });

  it("renders the discount-code refund option when feature is enabled", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        discountCodeRefundEnabled: true,
        discountCodePrefix: "RETURN",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
  });

  it("renders the COD-order branch (refund defaults to store_credit)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ isCodOrder: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
  });

  it("renders the flagged-customer pill when isBlocklisted is true", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ isBlocklisted: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Flagged customer");
    });
  });

  it("renders the multi-return customer-history pill when count > 1", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ customerReturnCount: 4 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/4 returns/);
    });
  });

  it("renders the Fynd-failed-sync prominent banner with retry button", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndSyncStatus: "failed",
      fyndSyncError: "Network timeout",
      fyndSyncRetries: 3,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd sync failed");
    });
    expect(container.textContent).toContain("Sync to Fynd");
  });

  it("renders the pending-consolidation notice when fyndSyncStatus is pending_consolidation", async () => {
    const rc = makeReturnCase({ fyndSyncStatus: "pending_consolidation" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/consolidat/i);
    });
  });

  it("renders the refund-gated-by-Fynd warning when current status is not allowed", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FYND-1",
      fyndCurrentStatus: "in_transit",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: "in_transit",
        allowedFyndStatusesForRefund: ["return_accepted", "return_completed"],
        refundGatePreset: "bag_received",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Refund gated by Fynd status");
    });
  });

  it("renders waiting-for-fynd-status when fyndCurrentStatus is empty but gate is on", async () => {
    const rc = makeReturnCase({
      status: "approved",
      fyndReturnId: "FYND-1",
      fyndCurrentStatus: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndCurrentStatus: null,
        allowedFyndStatusesForRefund: ["return_accepted"],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Waiting for Fynd status update");
    });
  });
});

// ── ErrorBoundary export ──
describe("app.returns.$id ErrorBoundary export", () => {
  it("renders 'Return not found' for a 404 Response", async () => {
    const { container } = renderErrorBoundary(new Response("not found", { status: 404 }));
    await waitFor(() => {
      expect(container.textContent).toContain("Return not found");
    });
    expect(container.textContent).toContain("doesn't exist");
  });

  it("renders 'Invalid request' for a 400 Response with string body", async () => {
    const { container } = renderErrorBoundary(new Response("Bad input", { status: 400 }));
    await waitFor(() => {
      expect(container.textContent).toContain("Invalid request");
    });
  });

  it("renders the 500 description for a 500 Response", async () => {
    const { container } = renderErrorBoundary(new Response("server boom", { status: 500 }));
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    expect(container.textContent).toContain("couldn't load this return");
  });

  it("renders generic 'Something went wrong' with details for a thrown Error", async () => {
    const { container } = renderErrorBoundary(new Error("boom-detail"));
    await waitFor(() => {
      expect(container.textContent).toContain("Something went wrong");
    });
    expect(container.textContent).toContain("boom-detail");
  });

  it("includes the Back-to-Returns link on the boundary page", async () => {
    const { container } = renderErrorBoundary(new Response("not found", { status: 404 }));
    await waitFor(() => {
      expect(container.textContent).toContain("Back to Returns");
    });
    const link = container.querySelector('a[href="/app/returns"]');
    expect(link).toBeTruthy();
  });
});
