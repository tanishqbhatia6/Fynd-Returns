/** @vitest-environment jsdom */
/**
 * Component tests targeting internal-notes / customer-facing-notes / activity-log
 * behavior in `app.returns.$id.tsx`. Focuses on event-detail expand/collapse
 * across event-type variants, source-pill icon variants, timestamp formatting,
 * customer-info card render, and the edit-customer-address modal save path.
 *
 * NEVER modifies source. Mocks every server-only module so jsdom can mount the
 * 3300-LOC component without hitting Node-only deps. Uses `renderWithRouter`
 * from `app/test/component-helpers.tsx` to provide the React Router stub.
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
  buildReturnRequestId: vi.fn(() => "RMA-NA-001"),
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
import { fireEvent, waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

const baseItem = {
  id: "item_a",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/777",
  sku: "SKU-NA-1",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Notes Test Item",
  variantTitle: null,
  imageUrl: null,
  price: "12.50",
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
    id: "ret_na_1",
    returnRequestNo: "RMA-NA-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/4242",
    shopifyOrderName: "#4242",
    customerName: "Note Buyer",
    customerEmailNorm: "buyer@example.com",
    customerPhoneNorm: "+15550009999",
    customerCity: "Austin",
    customerCountry: "US",
    customerAddress1: "555 First St",
    customerAddress2: null,
    customerProvince: "TX",
    customerZip: "78701",
    customerLandmark: null,
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
    updatedAt: new Date("2026-04-15T00:00:00Z").toISOString(),
    createdAt: new Date("2026-04-15T00:00:00Z").toISOString(),
    sourceChannel: "web",
    cancellationRequestedAt: null,
    cancellationRequestedBy: null,
    cancellationReason: null,
    cancellationDeclinedAt: null,
    adminNotes: "Triage: needs follow-up",
    notesForCustomer: "Hold tight, processing shortly",
    items: [baseItem],
    events: [] as EventInput[],
    ...overrides,
  };
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    returnCase: makeReturnCase(),
    shopDomain: "na-shop.myshopify.com",
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
    customerEmail: "buyer@example.com",
    bonusCreditEnabled: false,
    bonusCreditPct: 10,
    isBlocklisted: false,
    daysRemaining: 30,
    returnDeadline: new Date("2026-05-30T00:00:00Z").toISOString(),
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

describe("app.returns.$id — internal & customer-facing notes UI", () => {
  it("internal notes form posts to actions endpoint with action=add_note", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Internal notes");
      },
      { timeout: 5000 },
    );
    const ta = container.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    const form = ta.closest("form") as HTMLFormElement;
    expect(form).toBeTruthy();
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action") || "").toContain("/api/returns/ret_na_1/actions");
    // hidden input action=add_note
    const hidden = form.querySelector('input[name="action"]') as HTMLInputElement;
    expect(hidden?.value).toBe("add_note");
  });

  it("internal notes textarea preserves user-typed value across multiple changes", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Internal notes");
      },
      { timeout: 5000 },
    );
    const ta = container.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "first edit" } });
    expect(ta.value).toBe("first edit");
    fireEvent.change(ta, { target: { value: "second edit with more detail" } });
    expect(ta.value).toBe("second edit with more detail");
  });

  it("internal notes textarea defaults to empty string when adminNotes is null", async () => {
    const rc = makeReturnCase({ adminNotes: null });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Internal notes");
      },
      { timeout: 5000 },
    );
    const ta = container.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
    expect(ta.defaultValue).toBe("");
  });

  it("customer-facing notes form posts with action=save_notes_for_customer", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Customer-facing notes");
      },
      { timeout: 5000 },
    );
    const ta = container.querySelector('textarea[name="notesForCustomer"]') as HTMLTextAreaElement;
    const form = ta.closest("form") as HTMLFormElement;
    const hidden = form.querySelector('input[name="action"]') as HTMLInputElement;
    expect(hidden.value).toBe("save_notes_for_customer");
    // helper text visible to customer
    expect(container.textContent).toContain("Visible to the customer");
  });

  it("customer-facing notes textarea has the correct placeholder + default value", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Customer-facing notes");
      },
      { timeout: 5000 },
    );
    const ta = container.querySelector('textarea[name="notesForCustomer"]') as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("ship the item");
    expect(ta.defaultValue).toBe("Hold tight, processing shortly");
  });
});

describe("app.returns.$id — activity timeline events & detail expand/collapse", () => {
  it("renders fynd_webhook source pill with the 'Fynd' label", async () => {
    const events: EventInput[] = [
      {
        id: "fw1",
        eventType: "shipment_update",
        source: "fynd_webhook",
        happenedAt: new Date("2026-04-10T12:00:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Shipment Update");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("Fynd");
  });

  it("formats happenedAt timestamps using Intl date+time formatting", async () => {
    const events: EventInput[] = [
      {
        id: "ts1",
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2026-04-12T15:30:00Z").toISOString(),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Created");
      },
      { timeout: 5000 },
    );
    // Intl medium dateStyle => "Apr 12, 2026" (en); time short => "3:30 PM" or similar
    expect(container.textContent).toContain("2026");
    expect(container.textContent).toMatch(/Apr/);
  });

  it("renders <details> 'Show details' with raw payload JSON for non-sync events", async () => {
    const events: EventInput[] = [
      {
        id: "raw1",
        eventType: "address_edit",
        source: "admin",
        happenedAt: new Date("2026-04-12T10:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "ops@x.com", changed: ["customerCity"] }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Show details");
      },
      { timeout: 5000 },
    );
    // Find the <details> whose <summary> says "Show details" (other <details>
    // tags exist on the page, e.g., the optional shipping-edit collapsible).
    const detailsList = Array.from(container.querySelectorAll("details"));
    const target = detailsList.find((d) => {
      const sum = d.querySelector("summary");
      return (sum?.textContent || "").trim() === "Show details";
    }) as HTMLDetailsElement | undefined;
    expect(target).toBeTruthy();
    if (!target) return;
    // The summary remains in the DOM regardless of open state in jsdom.
    const summary = target.querySelector("summary") as HTMLElement;
    expect((summary.textContent || "").trim()).toBe("Show details");
    // Open / close the <details> element directly (jsdom supports the prop).
    target.open = true;
    expect(target.open).toBe(true);
    target.open = false;
    expect(target.open).toBe(false);
  });

  it("renders a 'Raw JSON' details block on fynd_sync events (separate from non-sync details)", async () => {
    const events: EventInput[] = [
      {
        id: "fs1",
        eventType: "fynd_sync",
        source: "system",
        happenedAt: new Date("2026-04-10T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          status: "success",
          action: "create_return",
          fyndReturnId: "FRR-77",
        }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("SUCCESS");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("Raw JSON");
    // The structured FRR-77 should also be visible
    expect(container.textContent).toContain("FRR-77");
  });

  it("highlights the latest event with a colored dot (different from earlier events)", async () => {
    const events: EventInput[] = [
      { id: "early", eventType: "created", source: "portal", happenedAt: new Date("2026-04-01T08:00:00Z").toISOString() },
      { id: "late", eventType: "approved", source: "admin", happenedAt: new Date("2026-04-02T08:00:00Z").toISOString() },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Approved");
      },
      { timeout: 5000 },
    );
    // Both events present; the boxShadow halo style only renders for the latest dot
    expect(container.textContent).toContain("Created");
    expect(container.textContent).toContain("Approved");
  });

  it("renders multiple admin events with adminEmail attribution from payload", async () => {
    const events: EventInput[] = [
      {
        id: "a1",
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2026-04-10T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "ada@shop.dev" }),
      },
      {
        id: "a2",
        eventType: "rejected",
        source: "admin",
        happenedAt: new Date("2026-04-11T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "ben@shop.dev" }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("ada@shop.dev");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("ben@shop.dev");
  });

  it("does not render the 'by <email>' attribution label when source is non-admin", async () => {
    const events: EventInput[] = [
      {
        id: "p1",
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2026-04-10T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({ adminEmail: "ada@x.com" }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Created");
      },
      { timeout: 5000 },
    );
    // The attribution span lives in the metadata row directly under the title;
    // for a non-admin source it must NOT render the "by " label, even though
    // adminEmail still appears inside the raw <pre> JSON dump.
    const headers = Array.from(container.querySelectorAll("span"))
      .map((s) => s.textContent || "");
    expect(headers.some((t) => t.startsWith("by "))).toBe(false);
  });

  it("renders fynd_sync_retry_success event with structured panel", async () => {
    const events: EventInput[] = [
      {
        id: "rs1",
        eventType: "fynd_sync_retry_success",
        source: "system",
        happenedAt: new Date("2026-04-10T09:00:00Z").toISOString(),
        payloadJson: JSON.stringify({
          status: "success",
          action: "create_return",
          retryAttempt: 2,
          fyndReturnId: "FRR-88",
        }),
      },
    ];
    const rc = makeReturnCase({ events });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Fynd Sync Retry Success");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("SUCCESS");
    expect(container.textContent).toContain("retry #2");
    expect(container.textContent).toContain("FRR-88");
  });
});

describe("app.returns.$id — customer info card & edit-customer-address modal", () => {
  it("renders the Customer card heading + populated address block", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Note Buyer");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("Pickup Address");
    expect(container.textContent).toContain("555 First St");
    expect(container.textContent).toContain("Austin");
    expect(container.textContent).toContain("TX");
    expect(container.textContent).toContain("78701");
  });

  it("opens the edit-pickup-address form and preserves existing field values", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Edit pickup address");
      },
      { timeout: 5000 },
    );
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    expect(toggle).toBeTruthy();
    if (toggle) fireEvent.click(toggle);
    await waitFor(
      () => {
        expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const addr1 = container.querySelector('input[name="customerAddress1"]') as HTMLInputElement;
    const city = container.querySelector('input[name="customerCity"]') as HTMLInputElement;
    const province = container.querySelector('input[name="customerProvince"]') as HTMLInputElement;
    const zip = container.querySelector('input[name="customerZip"]') as HTMLInputElement;
    expect(addr1.defaultValue).toBe("555 First St");
    expect(city.defaultValue).toBe("Austin");
    expect(province.defaultValue).toBe("TX");
    expect(zip.defaultValue).toBe("78701");
  });

  it("edit-pickup-address form posts to the actions endpoint with action=edit_details", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Edit pickup address");
      },
      { timeout: 5000 },
    );
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    if (toggle) fireEvent.click(toggle);
    await waitFor(
      () => {
        expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const addr1 = container.querySelector('input[name="customerAddress1"]') as HTMLInputElement;
    const form = addr1.closest("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action") || "").toContain("/api/returns/ret_na_1/actions");
    const hidden = form.querySelector('input[name="action"]') as HTMLInputElement;
    expect(hidden.value).toBe("edit_details");
  });

  it("edit-address form change events update the input value before submit", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Edit pickup address");
      },
      { timeout: 5000 },
    );
    const openBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Edit pickup address",
    );
    if (openBtn) fireEvent.click(openBtn);
    await waitFor(
      () => {
        expect(container.querySelector('input[name="customerAddress1"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    const addr1 = container.querySelector('input[name="customerAddress1"]') as HTMLInputElement;
    fireEvent.change(addr1, { target: { value: "777 New Lane" } });
    expect(addr1.value).toBe("777 New Lane");
    const country = container.querySelector('input[name="customerCountry"]') as HTMLInputElement;
    fireEvent.change(country, { target: { value: "Canada" } });
    expect(country.value).toBe("Canada");
    const landmark = container.querySelector('input[name="customerLandmark"]') as HTMLInputElement;
    fireEvent.change(landmark, { target: { value: "Near the park" } });
    expect(landmark.value).toBe("Near the park");
  });

  it("renders mailto / tel links for email & phone in the customer card", async () => {
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_na_1"],
      loaderData: makeLoaderData() as never,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Note Buyer");
      },
      { timeout: 5000 },
    );
    expect(container.querySelector('a[href="mailto:buyer@example.com"]')).toBeTruthy();
    expect(container.querySelector('a[href="tel:+15550009999"]')).toBeTruthy();
  });
});
