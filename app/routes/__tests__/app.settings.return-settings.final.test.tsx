/**
 * @vitest-environment jsdom
 *
 * Final-mile branch coverage for app/routes/app.settings.return-settings.tsx.
 *
 * Targets:
 *   - lines 1230-1236: Fynd refund-gate toggle ON/OFF (clears statuses + seeds
 *                      "after_delivery" preset on first enable)
 *   - line 1350:       Return Flow status checkbox uncheck onChange branch
 *   - line 1368:       Refund Flow status checkbox uncheck onChange branch
 *   - line 1410:       Fynd consolidation toggle onChange
 * plus a few other tab branches (Return Flow checked-in, Delivery group both
 * directions, refund-gate label states).
 *
 * NO source modifications. All existing tests remain untouched.
 */
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: { shopSettings: { upsert: vi.fn() } },
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchAllLocations: vi.fn(async () => []),
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
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
import { act, fireEvent, waitFor } from "@testing-library/react";
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

const renderForm = (
  overrides: Partial<typeof baseLoaderData> = {},
): ReturnType<typeof renderWithRouter> =>
  renderWithRouter(ReturnSettings, {
    initialEntries: ["/app/settings/return-settings"],
    loaderData: { ...baseLoaderData, ...overrides } as Record<string, unknown>,
  });

/** Find the toggle <input type="checkbox"> next to a section heading text. */
function findGateToggle(
  container: HTMLElement,
  headingText: string,
): HTMLInputElement | null {
  const heads = Array.from(container.querySelectorAll("div")).filter(
    (d) => d.textContent?.trim() === headingText,
  );
  for (const head of heads) {
    let row: HTMLElement | null = head.parentElement;
    // Walk up a few levels to find the flex row containing the toggle.
    for (let i = 0; i < 4 && row; i += 1) {
      const cb = row.querySelector(
        "input[type='checkbox']",
      ) as HTMLInputElement | null;
      if (cb) return cb;
      row = row.parentElement;
    }
  }
  return null;
}

describe("ReturnSettings — final-mile branch coverage", () => {
  it("toggles Fynd Refund-Gate ON from preset='none' (else-branch: seeds after_delivery)", async () => {
    const { container } = renderForm({ refundGatePreset: "none" });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const toggle = findGateToggle(container, "Fynd Status Gate for Refunds");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(true);
    // After enabling, "after_delivery" preset gets selected — the radio with
    // that value should now be checked.
    const afterDeliveryRadio = container.querySelector(
      "input[type='radio'][name='refundGatePresetRadio'][value='after_delivery']",
    ) as HTMLInputElement | null;
    expect(afterDeliveryRadio?.checked).toBe(true);
  });

  it("toggles Fynd Refund-Gate OFF from a non-none preset (if-branch: clears statuses)", async () => {
    const { container } = renderForm({
      refundGatePreset: "after_delivery",
      allowedFyndStatusesForRefund: ["delivery_done"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const toggle = findGateToggle(container, "Fynd Status Gate for Refunds");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(true);
    fireEvent.click(toggle!);
    expect(toggle!.checked).toBe(false);
    // Disabled label shown.
    expect(container.textContent).toContain(
      "Disabled — refunds allowed regardless of Fynd status",
    );
  });

  it("toggles Fynd Refund-Gate ON when preset is already non-none (else-if false branch)", async () => {
    const { container } = renderForm({
      refundGatePreset: "after_pickup",
      allowedFyndStatusesForRefund: ["return_bag_picked"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const toggle = findGateToggle(container, "Fynd Status Gate for Refunds");
    expect(toggle).toBeTruthy();
    await act(async () => { fireEvent.click(toggle!); }); // OFF
    await waitFor(() => { expect(toggle!.checked).toBe(false); });
    await act(async () => { fireEvent.click(toggle!); }); // ON again
    await waitFor(() => { expect(toggle!.checked).toBe(true); });
  });

  it("unchecks a Return Flow status checkbox in custom mode (line ~1350)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["return_bag_picked", "return_completed"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    // Find the Return-Flow `return_bag_picked` checkbox (already checked)
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.match(/^return_bag_picked$/),
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb); // uncheck → exercises filter() branch
    expect(cb.checked).toBe(false);
  });

  it("checks a Return Flow status checkbox in custom mode (check branch)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: [],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    // Use a unique status name that only appears in Return Flow.
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.trim() === "return_dp_not_assigned",
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    await waitFor(() => expect(cb.checked).toBe(true));
  });

  it("unchecks a Refund Flow status checkbox in custom mode (line ~1368)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["refund_initiated", "refund_pending"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.match(/^refund_initiated$/),
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb); // uncheck → filter branch
    expect(cb.checked).toBe(false);
  });

  it("checks a Refund Flow status checkbox in custom mode (check branch)", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: [],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.match(/^credit_note_generated$/),
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    await act(async () => { fireEvent.click(cb); });
    await waitFor(() => { expect(cb.checked).toBe(true); });
  });

  it("unchecks a Delivery & Handover status checkbox in custom mode", async () => {
    const { container } = renderForm({
      refundGatePreset: "custom",
      allowedFyndStatusesForRefund: ["delivery_done", "handed_over_to_customer"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.match(/^delivery_done$/),
    );
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    await act(async () => { fireEvent.click(cb); });
    await waitFor(() => { expect(cb.checked).toBe(false); });
    // Now "No statuses selected" warning still hidden because handed_over remains.
    await act(async () => {
      fireEvent.click(
        labels[0]
          .closest("div")!
          .querySelectorAll("input[type='checkbox']")[0] as HTMLInputElement,
      );
    });
  });

  it("toggles Fynd Return Consolidation ON via the toggle onChange (line ~1410)", async () => {
    const { container } = renderForm({ fyndConsolidateReturns: false });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const toggle = findGateToggle(container, "Fynd Return Consolidation");
    expect(toggle).toBeTruthy();
    expect(toggle!.checked).toBe(false);
    await act(async () => { fireEvent.click(toggle!); });
    await waitFor(() => { expect(toggle!.checked).toBe(true); });
    await act(async () => { fireEvent.click(toggle!); });
    await waitFor(() => { expect(toggle!.checked).toBe(false); });
  });

  it("renders the Fynd refund-gate ENABLED status footer label", async () => {
    const { container } = renderForm({
      refundGatePreset: "after_qc",
      allowedFyndStatusesForRefund: ["return_accepted"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    // PRESET_LABELS["after_qc"].label is rendered in the footer.
    expect(container.textContent).toMatch(/Enabled —/);
  });

  it("renders the Fynd refund-gate preset details summary for non-custom presets", async () => {
    const { container } = renderForm({
      refundGatePreset: "after_pickup",
      allowedFyndStatusesForRefund: ["return_bag_picked"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    // The <summary> should mention "Fynd statuses included"
    expect(container.textContent).toContain("Fynd statuses included");
  });

  it("changes Fynd consolidation window between all four values via radio onChange", async () => {
    const { container } = renderForm({
      fyndConsolidateReturns: true,
      fyndConsolidateWindowHours: 4,
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    const radios = Array.from(
      container.querySelectorAll(
        "input[type='radio'][name='fyndConsolidateWindowHours']",
      ),
    ) as HTMLInputElement[];
    expect(radios.length).toBe(4);
    for (const r of radios) {
      fireEvent.click(r);
    }
    // Last clicked is the 24h radio
    expect(radios[radios.length - 1].checked).toBe(true);
  });

  it("toggles a Forward Journey status checkbox uncheck path (return-init gate)", async () => {
    const { container } = renderForm({
      allowedFyndStatusesForReturn: ["delivery_done", "handed_over_to_customer"],
    });
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy(), {
      timeout: 5000,
    });
    // Find Forward-journey "Handed Over to Customer" label and uncheck.
    const labels = Array.from(container.querySelectorAll("label")).filter(
      (l) => l.textContent?.includes("Handed Over to Customer"),
    );
    expect(labels.length).toBeGreaterThan(0);
    const cb = labels[0].querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb); // uncheck — filter() branch
    expect(cb.checked).toBe(false);
  });
});
