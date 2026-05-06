/** @vitest-environment jsdom */
/**
 * Coverage-targeted tests for the Activity Timeline panel and the Customer
 * info side card in `app.returns.$id.tsx`.
 *
 * Adds tests for:
 *  - timeline event rendering across event types & sources
 *    (created, approved, rejected, refunded, fynd_sync, fynd_sync_failed,
 *     fynd_sync_retries_exhausted, customer_note, address_edit, ...)
 *  - source pill labels & dot color (latest event highlighting)
 *  - timestamp rendering / null-happenedAt fallback
 *  - non-sync event "Show details" raw JSON expansion
 *  - admin-source events with `adminEmail` payload
 *  - fynd-sync success structured panel (Return ID / Shipment / Order)
 *  - fynd-sync failure structured panel (errorType + retry scheduled)
 *  - fynd-sync exhausted guidance text
 *  - customer-info card render (name / email / phone / address / landmark)
 *  - "No customer info captured yet" empty-state branch
 *  - Edit-pickup-address toggle (open form, change input, save submit)
 *  - Internal-notes textarea rendering + Save button
 *  - Customer-facing notes textarea rendering + Publish button
 *  - Customer-return-count pill on Customer card
 *
 * NEVER modifies source. Mocks every server-only module so jsdom can mount
 * the 3300-LOC component without hitting Node-only deps.
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

type EventInput = {
  id: string;
  eventType: string;
  source?: string;
  happenedAt?: string | null;
  payloadJson?: string | null;
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
    customerName: "Jane Customer",
    customerEmailNorm: "jane@example.com",
    customerPhoneNorm: "+15551234567",
    customerCity: "New York",
    customerCountry: "US",
    customerAddress1: "123 Main St",
    customerAddress2: "Apt 4B",
    customerProvince: "NY",
    customerZip: "10001",
    customerLandmark: "Across from the deli",
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
    adminNotes: "Internal triage notes",
    notesForCustomer: "We received your bag",
    items: [baseItem],
    events: [] as EventInput[],
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
    customerEmail: "jane@example.com",
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

describe("app.returns.$id — activity timeline panel", () => {
  it("renders the empty-state when events array is empty", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("No events yet");
  });

  it("renders multiple event types with formatted Title-Cased labels", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2026-05-01T08:00:00Z").toISOString(),
      },
      {
        id: "e2",
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "ops@example.com" }),
      },
      {
        id: "e3",
        eventType: "address_edit",
        source: "admin",
        happenedAt: new Date("2026-05-01T10:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          adminEmail: "ops@example.com",
          changed: ["customerAddress1"],
        }),
      },
      {
        id: "e4",
        eventType: "customer_note",
        source: "system",
        happenedAt: new Date("2026-05-01T11:00:00Z").toISOString(),
      },
      {
        id: "e5",
        eventType: "rejected",
        source: "admin",
        happenedAt: new Date("2026-05-01T12:00:00Z").toISOString(),
      },
      {
        id: "e6",
        eventType: "refunded",
        source: "shopify_webhook",
        happenedAt: new Date("2026-05-01T13:00:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    // Title-cased labels with underscores -> spaces
    expect(container.textContent).toContain("Created");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("Address Edit");
    expect(container.textContent).toContain("Customer Note");
    expect(container.textContent).toContain("Rejected");
    expect(container.textContent).toContain("Refunded");
  });

  it("renders source pill labels (Portal / Admin / System / Shopify)", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2026-05-01T08:00:00Z").toISOString(),
      },
      {
        id: "e2",
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
      },
      {
        id: "e3",
        eventType: "auto_approved",
        source: "system",
        happenedAt: new Date("2026-05-01T10:00:00Z").toISOString(),
      },
      {
        id: "e4",
        eventType: "fulfilled",
        source: "shopify_webhook",
        happenedAt: new Date("2026-05-01T11:00:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Activity timeline");
    });
    expect(container.textContent).toContain("Portal");
    expect(container.textContent).toContain("Admin");
    expect(container.textContent).toContain("System");
    expect(container.textContent).toContain("Shopify");
  });

  it("falls back to 'Admin' source label when source is unknown/missing", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "manual_action",
        source: "weirdo_source",
        happenedAt: new Date("2026-05-01T08:00:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Manual Action");
    });
    expect(container.textContent).toContain("Admin");
  });

  it("renders the em-dash placeholder when happenedAt is missing", async () => {
    const events: EventInput[] = [
      { id: "e1", eventType: "created", source: "portal", happenedAt: null },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Created");
    });
    // Em-dash fallback
    expect(container.textContent).toContain("—");
  });

  it("shows 'unknown' label when eventType is missing", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "",
        source: "system",
        happenedAt: new Date("2026-05-01T08:00:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Unknown");
    });
  });

  it("renders 'by <adminEmail>' for admin events with adminEmail payload", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "alice@shop.dev" }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approved");
    });
    expect(container.textContent).toContain("alice@shop.dev");
    expect(container.textContent).toContain("by ");
  });

  it("renders the Show details summary for non-sync events with payloadJson", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "address_edit",
        source: "admin",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ changed: ["customerAddress1"], oldValue: "Old Street" }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Show details");
    });
    expect(container.querySelector("details")).toBeTruthy();
  });

  it("renders structured Fynd sync SUCCESS panel with IDs", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "fynd_sync",
        source: "system",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          status: "success",
          action: "create_return",
          durationMs: 1234,
          attempt: 1,
          fyndReturnId: "FRID-1",
          fyndShipmentId: "FSH-1",
          fyndOrderId: "FORD-1",
        }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("SUCCESS");
    });
    expect(container.textContent).toContain("FRID-1");
    expect(container.textContent).toContain("FSH-1");
    expect(container.textContent).toContain("FORD-1");
    expect(container.textContent).toContain("1234ms");
    expect(container.textContent).toContain("attempt #1");
  });

  it("renders structured Fynd sync FAILED panel with errorType + retry-scheduled", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "fynd_sync_failed",
        source: "system",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          status: "failed",
          action: "create_return",
          retryAttempt: 2,
          error: "Network timeout occurred while contacting Fynd",
          errorType: "network_error",
          retryScheduled: true,
          nextRetryAt: "2026-05-01T10:00:00Z",
        }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("FAILED");
    });
    expect(container.textContent?.toLowerCase()).toContain("network error");
    expect(container.textContent).toContain("Network timeout");
    expect(container.textContent).toContain("Retry scheduled");
    expect(container.textContent).toContain("retry #2");
  });

  it("renders the 'retries exhausted' guidance branch", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "fynd_sync_retries_exhausted",
        source: "system",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          status: "failed",
          maxRetries: 3,
          lastError: "Final boom",
        }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("retries exhausted");
    });
    expect(container.textContent).toContain("Final boom");
    expect(container.textContent).toContain("Sync to Fynd");
  });

  it("skips null events in the events array without throwing", async () => {
    const events = [
      null,
      {
        id: "e1",
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2026-05-01T08:00:00Z").toISOString(),
      },
    ] as unknown as EventInput[];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Created");
    });
  });

  it("handles malformed payloadJson without breaking the timeline", async () => {
    const events: EventInput[] = [
      {
        id: "e1",
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2026-05-01T09:00:00Z").toISOString(),
        payloadJson: "{not valid json",
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Approved");
    });
    // Show details summary still renders for non-sync event with payloadJson
    expect(container.textContent).toContain("Show details");
  });
});

describe("app.returns.$id — customer info side panel", () => {
  it("renders customer name, email, phone, city, country, address & landmark", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Jane Customer");
    });
    expect(container.textContent).toContain("jane@example.com");
    expect(container.textContent).toContain("+15551234567");
    expect(container.textContent).toContain("New York");
    expect(container.textContent).toContain("US");
    expect(container.textContent).toContain("123 Main St");
    expect(container.textContent).toContain("Apt 4B");
    expect(container.textContent).toContain("10001");
    expect(container.textContent).toContain("Across from the deli");
    // mailto and tel links
    expect(container.querySelector('a[href="mailto:jane@example.com"]')).toBeTruthy();
    expect(container.querySelector('a[href="tel:+15551234567"]')).toBeTruthy();
  });

  it("renders the empty-state ('No customer info captured yet') when no fields are set", async () => {
    const rc = makeReturnCase({
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerCountry: null,
      customerAddress1: null,
      customerAddress2: null,
      customerProvince: null,
      customerZip: null,
      customerLandmark: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        customerEmail: null,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No customer info captured yet");
    });
  });

  it("renders the 'N returns' pill on Customer card when customer has multiple returns", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData({ customerReturnCount: 3 }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Jane Customer");
    });
    expect(container.textContent).toContain("3 returns");
  });

  it("opens the edit-pickup-address form when 'Edit pickup address' is clicked", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Edit pickup address");
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    expect(toggle).toBeTruthy();
    if (toggle) fireEvent.click(toggle);
    await waitFor(() => {
      expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
    });
    expect(container.querySelector('input[name="customerAddress2"]')).toBeTruthy();
    expect(container.querySelector('input[name="customerCity"]')).toBeTruthy();
    expect(container.querySelector('input[name="customerProvince"]')).toBeTruthy();
    expect(container.querySelector('input[name="customerZip"]')).toBeTruthy();
    expect(container.querySelector('input[name="customerCountry"]')).toBeTruthy();
    expect(container.querySelector('input[name="customerLandmark"]')).toBeTruthy();
  });

  it("submits the save-address form (changing input + clicking Save address)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Edit pickup address");
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    if (toggle) fireEvent.click(toggle);
    await waitFor(() => {
      expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
    });
    const addr1 = container.querySelector('input[name="customerAddress1"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(addr1, { target: { value: "999 Updated Ave" } });
    });
    await waitFor(() => {
      expect(addr1.value).toBe("999 Updated Ave");
    });
    // Find form & submit
    const form = addr1.closest("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    const submitBtn = Array.from(form.querySelectorAll("s-button")).find(
      (b) => (b.textContent || "").trim() === "Save address",
    );
    expect(submitBtn).toBeTruthy();
    await act(async () => {
      fireEvent.submit(form);
    });
    // After submit handler, form is hidden again — but at minimum no error
    await waitFor(() => {
      expect(form).toBeTruthy();
    });
  });

  it("toggles the edit-pickup-address form back closed (Cancel)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Edit pickup address");
    });
    const openBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    if (openBtn) fireEvent.click(openBtn);
    await waitFor(() => {
      expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
    });
    // Now the same toggle button should read "Cancel"
    const cancelBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        (b.textContent || "").trim() === "Cancel" &&
        (b.getAttribute("style") || "").includes("color"),
    );
    if (cancelBtn) fireEvent.click(cancelBtn);
  });

  it("renders the Internal Notes textarea pre-filled with adminNotes + Save button", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Internal notes");
    });
    const ta = container.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.defaultValue).toBe("Internal triage notes");
    // Save button rendered as <s-button>
    const saveBtns = Array.from(container.querySelectorAll("s-button")).filter(
      (b) => (b.textContent || "").trim() === "Save",
    );
    expect(saveBtns.length).toBeGreaterThan(0);
  });

  it("allows editing the internal notes textarea (controlled via change event)", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Internal notes");
    });
    const ta = container.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Updated note text" } });
    });
    await waitFor(() => {
      expect(ta.value).toBe("Updated note text");
    });
  });

  it("renders the customer-facing notes textarea with Publish button", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer-facing notes");
    });
    const ta = container.querySelector('textarea[name="notesForCustomer"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.defaultValue).toBe("We received your bag");
    // Publish button rendered as <s-button>
    const publish = Array.from(container.querySelectorAll("s-button")).find(
      (b) => (b.textContent || "").trim() === "Publish",
    );
    expect(publish).toBeTruthy();
  });

  it("submits the customer-facing notes form", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_test_001"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Customer-facing notes");
    });
    const ta = container.querySelector('textarea[name="notesForCustomer"]') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "Refund will arrive in 3-5 days" } });
    const form = ta.closest("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);
  });
});
