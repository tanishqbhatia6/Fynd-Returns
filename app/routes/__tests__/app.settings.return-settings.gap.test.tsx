/**
 * @vitest-environment jsdom
 *
 * Gap-coverage tests for app.settings.return-settings.tsx. Targets the
 * branches the existing `.uncovered.test.tsx` misses:
 *
 *   - Line 1229-1236: Fynd refund-gate toggle (turn ON when preset is "none"
 *     -> auto-seeds "after_delivery" preset; turn OFF -> resets to "none"
 *     and clears statuses).
 *   - Line 1350: Return Flow checkbox UNCHECK branch (filter() path).
 *   - Line 1368: Refund Flow checkbox UNCHECK branch.
 *   - Line 1410: Fynd consolidation toggle onChange handler.
 *   - Lines 603, 805, 834, 864, 897, 914, 998, 1028, 1053: onChange
 *     handlers for photoRequired, autoApproveEnabled, autoRefundEnabled,
 *     syncRefundToFynd, paymentMethod radios, refundLocationMode/select,
 *     portalExchangeEnabled.
 *
 * Strategy: render with loaderData seeded so the targeted branch is in
 * its starting state, fire the exact onChange/click event that flips it,
 * assert the resulting DOM/text reflects the new state.
 *
 * Tests intentionally do NOT modify the source under test.
 */
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
  },
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchAllLocations: vi.fn(async () => []),
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
import ReturnSettings from "../app.settings.return-settings";

const baseLoaderData = {
  noReturnPeriodEnabled: false,
  noReturnPeriodStart: "",
  noReturnPeriodEnd: "",
  restrictedProductTags: [] as string[],
  photoRequired: false,
  returnFeeAmount: "0",
  returnFeeCurrency: "USD",
  autoApproveEnabled: false,
  autoRefundEnabled: false,
  refundLocationMode: "auto",
  refundLocationId: null as string | null,
  refundPaymentMethod: "original",
  refundStoreCreditPct: 100,
  shopLocations: [] as Array<{ id: string; name: string; isActive?: boolean }>,
  discountCodeRefundEnabled: false,
  discountCodePrefix: "RETURN",
  discountCodeExpiryDays: 90,
  portalExchangeEnabled: false,
  portalAllowedFulfillmentStatuses: ["FULFILLED", "PARTIALLY_FULFILLED"],
  fyndConsolidateReturns: false,
  fyndConsolidateWindowHours: 4,
  syncRefundToFynd: false,
  allowedFyndStatusesForRefund: [] as string[],
  refundGatePreset: "none",
  allowedFyndStatusesForReturn: [] as string[],
  returnIdConfig: {
    prefix: "RPM",
    separator: "-",
    bodyMode: "hash" as const,
    hashLength: 8,
    sequentialPadding: 6,
    suffix: "",
  },
  scheduledReportEnabled: false,
  scheduledReportFrequency: "weekly",
  scheduledReportDay: 1,
  scheduledReportEmails: "",
  giftReturnsEnabled: false,
  greenReturnsDonateEnabled: false,
  greenReturnsDonateMessage: "",
};

const renderForm = (overrides: Partial<typeof baseLoaderData> = {}) =>
  renderWithRouter(ReturnSettings, {
    initialEntries: ["/app/settings/return-settings"],
    loaderData: { ...baseLoaderData, ...overrides },
  });

const ready = async (container: HTMLElement) =>
  waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
    timeout: 5000,
  });

/**
 * Locate a section's main toggle checkbox by walking from the heading text
 * to the surrounding flex row. The toggle is the first checkbox inside
 * that row.
 */
function findSectionToggle(container: HTMLElement, headingText: string): HTMLInputElement | null {
  const headings = Array.from(container.querySelectorAll("div")).filter(
    (d) => d.textContent?.trim() === headingText,
  );
  if (!headings.length) return null;
  // Walk up to the section root, then query for the first checkbox inside.
  let node: HTMLElement | null = headings[0];
  for (let i = 0; i < 6 && node; i++) {
    const cb = node.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    if (cb) return cb;
    node = node.parentElement;
  }
  return null;
}

describe("ReturnSettings — gap coverage", () => {
  it("toggles Fynd refund-gate ON from preset=none → seeds after_delivery preset (line 1233-1236)", async () => {
    const { container } = renderForm({ refundGatePreset: "none" });
    await ready(container);
    const toggle = findSectionToggle(container, "Fynd Status Gate for Refunds");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);
    fireEvent.click(toggle!);
    // After turning ON with preset="none", the else-if branch fires and
    // selects "after_delivery", which renders the "Recommended" badge and
    // the description text "After bag reaches warehouse".
    await waitFor(() => {
      expect(container.textContent).toContain("Recommended");
    });
    expect(container.textContent).toContain("After bag reaches warehouse");
  });

  it("toggles Fynd refund-gate OFF from enabled state → resets to none and clears statuses (line 1230-1232)", async () => {
    // Seed enabled with a non-empty allowed list and a non-"none" preset.
    const { container } = renderForm({
      refundGatePreset: "after_delivery",
      allowedFyndStatusesForRefund: ["delivery_done", "handed_over_to_customer"],
    });
    await ready(container);
    const toggle = findSectionToggle(container, "Fynd Status Gate for Refunds");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(true);
    fireEvent.click(toggle!);
    // After turning OFF, the disabled-text path renders.
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Disabled — refunds allowed regardless of Fynd status",
      );
    });
  });

  it("unchecks a Return Flow status (line 1350 else-branch — filter path)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["return_bag_picked"],
    });
    await ready(container);
    // Find the return_bag_picked checkbox — its label contains the
    // status name in monospace text.
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.trim() === "return_bag_picked",
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    // First click → uncheck (line 1350 else branch).
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("unchecks a Refund Flow status (line 1368 else-branch — filter path)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["refund_initiated"],
    });
    await ready(container);
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.trim() === "refund_initiated",
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("toggles Fynd consolidation checkbox onChange handler (line 1410)", async () => {
    const { container } = renderForm({ fyndConsolidateReturns: false });
    await ready(container);
    const toggle = findSectionToggle(container, "Fynd Return Consolidation");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);
    // Use fireEvent.change to invoke the onChange directly with a checked target.
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(container.textContent).toContain("4h batch window");
    });
    fireEvent.click(toggle!);
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Disabled — each return syncs to Fynd immediately",
      );
    });
  });

  it("toggles Photo Required onChange (line 603)", async () => {
    const { container } = renderForm({ photoRequired: false });
    await ready(container);
    const toggle = findSectionToggle(container, "Photo Required");
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(true);
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(false);
  });

  it("toggles Auto Approval and Auto Refund onChange (lines 805, 834)", async () => {
    const { container } = renderForm();
    await ready(container);
    const auto = findSectionToggle(container, "Auto Approval");
    const refund = findSectionToggle(container, "Auto Refund on Credit Note");
    expect(auto).toBeTruthy();
    expect(refund).toBeTruthy();
    fireEvent.click(auto!);
    fireEvent.click(refund!);
    expect(auto!.checked).toBe(true);
    expect(refund!.checked).toBe(true);
  });

  it("toggles Sync Refund to Fynd onChange (line 864)", async () => {
    const { container } = renderForm({ syncRefundToFynd: false });
    await ready(container);
    const toggle = findSectionToggle(container, "Sync Refund Status to Fynd");
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(true);
  });

  it("clicks the 'original' payment-method radio (line 897)", async () => {
    const { container } = renderForm({ refundPaymentMethod: "store_credit" });
    await ready(container);
    // Find label whose text includes "Original payment method"
    const labels = Array.from(container.querySelectorAll("label")).filter((l) =>
      l.textContent?.includes("Original payment method"),
    );
    expect(labels.length).toBeGreaterThan(0);
    const radio = labels[0].querySelector(
      "input[type='radio']",
    ) as HTMLInputElement;
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
  });

  it("clicks the 'store_credit' payment-method radio (line 914)", async () => {
    const { container } = renderForm({ refundPaymentMethod: "original" });
    await ready(container);
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) =>
        l.textContent?.includes("Store credit") &&
        !l.textContent?.includes("Split"),
    );
    expect(labels.length).toBeGreaterThan(0);
    const radio = labels[0].querySelector(
      "input[type='radio']",
    ) as HTMLInputElement;
    fireEvent.click(radio);
    expect(radio.checked).toBe(true);
    // Renders the store-credit info banner branch.
    expect(container.textContent).toContain(
      "Store credit requires new customer accounts",
    );
  });

  it("clicks both refundLocationMode radios (lines 998, 1008)", async () => {
    const { container } = renderForm({
      shopLocations: [
        { id: "gid://shopify/Location/1", name: "Main", isActive: true },
      ],
    });
    await ready(container);
    const auto = container.querySelector(
      "input[name='refundLocationMode'][value='auto']",
    ) as HTMLInputElement;
    const manual = container.querySelector(
      "input[name='refundLocationMode'][value='manual']",
    ) as HTMLInputElement;
    expect(auto).toBeTruthy();
    expect(manual).toBeTruthy();
    fireEvent.click(manual);
    expect(manual.checked).toBe(true);
    fireEvent.click(auto);
    expect(auto.checked).toBe(true);
  });

  it("changes the refundLocationId select onChange (line 1028)", async () => {
    const { container } = renderForm({
      shopLocations: [
        { id: "gid://shopify/Location/1", name: "A", isActive: true },
        { id: "gid://shopify/Location/2", name: "B", isActive: true },
      ],
    });
    await ready(container);
    const sel = container.querySelector(
      "select[name='refundLocationId']",
    ) as HTMLSelectElement;
    expect(sel).toBeTruthy();
    fireEvent.change(sel, { target: { value: "gid://shopify/Location/2" } });
    expect(sel.value).toBe("gid://shopify/Location/2");
    fireEvent.change(sel, { target: { value: "" } });
    expect(sel.value).toBe("");
  });

  it("toggles Portal Exchange onChange (line 1053)", async () => {
    const { container } = renderForm({ portalExchangeEnabled: false });
    await ready(container);
    const toggle = findSectionToggle(container, "Portal Exchange");
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(true);
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(false);
  });

  it("re-toggles a Delivery & Handover status off (custom mode, covers checked → unchecked path on Delivery section)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["delivery_done", "handed_over_to_customer"],
    });
    await ready(container);
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.trim() === "delivery_done",
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("renders the no-statuses-selected warning after unchecking the last refund status", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["delivery_done"],
    });
    await ready(container);
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.trim() === "delivery_done",
    );
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => {
      expect(container.textContent).toMatch(/No statuses selected/);
    });
  });
});
