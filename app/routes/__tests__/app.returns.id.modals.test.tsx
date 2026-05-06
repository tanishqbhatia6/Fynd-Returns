/** @vitest-environment jsdom */
/**
 * Modal-interaction tests for `app.returns.$id.tsx`.
 *
 * Coverage focus (NEVER modifies source):
 *  - Process Refund modal open/close via primary button + Cancel
 *  - Refund-method radio selection (original / store_credit / split-both)
 *  - Split-mode toggle (percentage / amount) inside the refund modal
 *  - Restock-location select rendering when refundLocationMode = "manual"
 *  - Bonus-credit preview block when bonusCreditEnabled is true
 *  - Refund submit button label changes based on refundMethod
 *  - Process Exchange modal open + line-item visibility inside
 *  - Cancel-Order modal open + restock checkbox toggle
 *
 * Uses jsdom + the renderWithRouter helper. Mirrors the mocking strategy
 * from the sibling action-buttons / exchange-replacement / uncovered tests.
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
import { fireEvent, waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

// ── Shared loader fixtures ──
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

const secondItem = {
  ...baseItem,
  id: "item_2",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/222",
  sku: "SKU-002",
  title: "Test Product Beta",
  variantTitle: "Large / Red",
  price: "49.50",
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
    fyndShipmentId: "FYND-SHIP-12345",
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
    items: [baseItem, secondItem],
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

function findButton(container: HTMLElement, label: string): Element | undefined {
  return Array.from(container.querySelectorAll("s-button, button")).find(
    (b) => (b.textContent || "").trim() === label,
  );
}

function renderRoute(loaderOverrides: Record<string, unknown> = {}) {
  return renderWithRouter(Component, {
    initialEntries: ["/app/returns/ret_test_001"],
    loaderData: makeLoaderData(loaderOverrides) as never,
  });
}

describe("app.returns.$id — refund + exchange modal interactions", () => {
  it("shows the Process Refund primary button on an approved refund return", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Process Refund");
    });
  });

  it("opens the Process Refund modal when the primary button is clicked", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    expect(container.textContent).toContain("Refund method");
  });

  it("renders all three refund-method radio options inside the modal", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelectorAll('input[type="radio"]').length).toBeGreaterThanOrEqual(3);
    });
    expect(container.textContent).toContain("Original payment");
    expect(container.textContent).toContain("Store credit");
    expect(container.textContent).toContain("Split refund");
  });

  it("changes the refund-submit label when store_credit radio is selected", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    // 0=original, 1=store_credit, 2=both (split)
    fireEvent.click(radios[1]);
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Issue store credit")).toBeTruthy();
    });
  });

  it("changes the refund-submit label to 'Process split refund' when split radio is selected", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[2]);
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process split refund")).toBeTruthy();
    });
  });

  it("renders Percentage/Amount split-mode toggle when split refund is selected", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[2]); // both
    await waitFor(() => {
      expect(container.textContent).toContain("Percentage");
    });
    expect(container.textContent).toContain("Amount");
  });

  it("toggles percentage->amount split mode and shows numeric inputs", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[2]); // both
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Amount")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Amount") as Element);
    await waitFor(() => {
      expect(container.querySelectorAll('input[type="number"]').length).toBeGreaterThanOrEqual(2);
    });
  });

  it("changes the percentage range slider value in split mode", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[2]); // both
    await waitFor(() => {
      expect(container.querySelector('input[type="range"]')).toBeTruthy();
    });
    const range = container.querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(range, { target: { value: "60" } });
    await waitFor(() => {
      expect(container.textContent).toContain("Store credit: 60%");
    });
    expect(container.textContent).toContain("Original: 40%");
  });

  it("renders the restock-location select when refundLocationMode=manual and locations exist", async () => {
    const { container } = renderRoute({
      refundLocationMode: "manual",
      shopLocations: [
        { id: "gid://shopify/Location/1", name: "Main Warehouse", isActive: true },
        { id: "gid://shopify/Location/2", name: "Secondary", isActive: true },
      ],
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector('select[aria-label="Select restock location"]')).toBeTruthy();
    });
    expect(container.textContent).toContain("Main Warehouse");
  });

  it("changes the selected restock location via the dropdown", async () => {
    const { container } = renderRoute({
      refundLocationMode: "manual",
      shopLocations: [
        { id: "gid://shopify/Location/1", name: "Main Warehouse", isActive: true },
        { id: "gid://shopify/Location/2", name: "Secondary", isActive: true },
      ],
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector('select[aria-label="Select restock location"]')).toBeTruthy();
    });
    const select = container.querySelector(
      'select[aria-label="Select restock location"]',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "gid://shopify/Location/2" } });
    expect(select.value).toBe("gid://shopify/Location/2");
  });

  it("shows the bonus-credit preview block when bonusCreditEnabled and store_credit is selected", async () => {
    const { container } = renderRoute({
      bonusCreditEnabled: true,
      bonusCreditPct: 15,
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[1]); // store_credit
    await waitFor(() => {
      expect(container.textContent).toContain("Store credit bonus");
    });
    expect(container.textContent).toContain("Total store credit");
  });

  it("displays the COD warning when isCodOrder is true and disables the original-payment radio", async () => {
    const { container } = renderRoute({ isCodOrder: true });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.textContent).toContain("COD order");
    });
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    expect(radios[0].disabled).toBe(true); // original disabled
    expect(radios[1].disabled).toBe(false); // store credit allowed
  });

  it("closes the refund modal via the Cancel button inside the modal-actions footer", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    // The Cancel button inside .app-modal-actions
    const cancelBtn = Array.from(
      container.querySelectorAll(".app-modal-actions s-button, .app-modal-actions button"),
    ).find((b) => (b.textContent || "").trim() === "Cancel");
    fireEvent.click(cancelBtn as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeFalsy();
    });
  });

  it("renders the order-name reference inside the refund modal body", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    expect(container.textContent).toContain("#1234");
    expect(container.textContent).toContain("This action cannot be undone.");
  });

  it("shows the store-credit hint banner when store_credit radio is selected", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    const radios = Array.from(container.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    fireEvent.click(radios[1]); // store_credit
    await waitFor(() => {
      expect(container.textContent).toContain("new customer accounts in Shopify");
    });
  });

  it("renders the Process Exchange modal listing the order reference for an exchange return", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ resolutionType: "exchange" }),
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Exchange")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Exchange") as Element);
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Create Exchange Order")).toBeTruthy();
    });
    expect(container.textContent).toContain("#1234");
    expect(container.textContent).toContain("draft order");
  });

  it("closes the exchange modal via overlay click on overlay element", async () => {
    const { container } = renderRoute({
      returnCase: makeReturnCase({ resolutionType: "exchange" }),
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Exchange")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Exchange") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
    });
    const overlay = container.querySelector(".app-modal-overlay") as HTMLElement;
    fireEvent.click(overlay);
    await waitFor(() => {
      expect(container.querySelector(".app-modal-overlay")).toBeFalsy();
    });
  });

  it("renders both line items from the return case in the page body (line-item visibility)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(container.textContent).toContain("Test Product Alpha");
    });
    expect(container.textContent).toContain("Test Product Beta");
    expect(container.textContent).toContain("Medium / Blue");
    expect(container.textContent).toContain("Large / Red");
  });

  it("opens the Cancel Order modal and toggles the restock checkbox", async () => {
    const { container } = renderRoute({
      shopifyOrder: { displayFulfillmentStatus: "UNFULFILLED" },
    });
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Cancel Order")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Cancel Order") as Element);
    await waitFor(() => {
      expect(container.textContent).toContain("Restock inventory");
    });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    expect(checkbox.checked).toBe(true); // default
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("clicking the modal body does NOT close the refund modal (event propagation stopped)", async () => {
    const { container } = renderRoute();
    await waitFor(() => {
      expect(findButton(container as HTMLElement, "Process Refund")).toBeTruthy();
    });
    fireEvent.click(findButton(container as HTMLElement, "Process Refund") as Element);
    await waitFor(() => {
      expect(container.querySelector(".app-modal")).toBeTruthy();
    });
    const modalBody = container.querySelector(".app-modal") as HTMLElement;
    fireEvent.click(modalBody);
    // Modal still open
    expect(container.querySelector(".app-modal-overlay")).toBeTruthy();
  });
});
