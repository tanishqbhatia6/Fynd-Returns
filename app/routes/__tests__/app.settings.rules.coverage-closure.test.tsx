// @vitest-environment jsdom
/**
 * @vitest-environment jsdom
 *
 * Coverage closure for app.settings.rules.tsx. Targets the still-uncovered
 * statements after the existing component tests:
 *   - line 252  (removeCategory body)
 *   - line 468  (Remove-category button onClick)
 *   - line 582  (remove fee row "×" button onClick)
 *   - line 634  (country code input onChange in windows-by-country row)
 *   - lines 644-645 (days input onChange in windows-by-country row)
 *   - line 652  (remove country row "×" button onClick)
 *   - line 663  (+ Add country dashed button onClick)
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
    shop: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop-1", settings: null })),
  syncShopLocaleAndCurrency: vi.fn(async () => undefined),
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
import {
  waitFor as rtlWaitFor,
  fireEvent,
  configure,
} from "@testing-library/react";
import ReturnRules from "../app.settings.rules";

configure({ asyncUtilTimeout: 8000 });
const waitFor: typeof rtlWaitFor = (cb, opts) =>
  rtlWaitFor(cb, { timeout: 8000, ...opts });

const baseLoaderData = {
  returnWindowDays: 30,
  minimumReturnPrice: "0",
  returnReasons: ["Wrong size", "Damaged item"],
  returnReasonsByCategory: [
    { category: "Apparel", reasons: ["Too tight"] },
    { category: "Footwear", reasons: ["Sole peeling"] },
  ],
  restrictedRegions: [{ country: "Cuba" }],
  returnOffers: [],
  returnOffersEnabled: false,
  feesByReason: [{ reason: "Wrong size", feeAmount: 5 }],
  windowsByCountry: [
    { country: "US", days: 45 },
    { country: "DE", days: 30 },
  ],
  shopCurrency: "USD",
};

describe("app.settings.rules — coverage closure", () => {
  it("removes a category via its Remove button (lines 252, 468)", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    // Wait for both seeded category rows to render.
    await waitFor(() => {
      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder^="Category / Product type"]',
        ),
      );
      expect(inputs.length).toBe(2);
    });

    // Click the first category's "Remove" button.
    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Remove");
    expect(removeButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(removeButtons[0]);

    // After the click only one category-name input should remain.
    await waitFor(() => {
      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder^="Category / Product type"]',
        ),
      );
      expect(inputs.length).toBe(1);
    });
  });

  it("mutates and removes fee rows + adds/edits/removes country windows (lines 582, 634, 644-645, 652, 663)", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    // Wait until the country-windows section has rendered.
    let countryInputs: HTMLInputElement[] = [];
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(2);
    });

    // line 634: edit a country code on row 0 → triggers country onChange.
    fireEvent.change(countryInputs[0], { target: { value: "GB" } });
    expect(countryInputs[0].value).toBe("GB");

    // lines 644-645: edit the days input on row 0 → triggers days onChange.
    // Locate the row's days input — it's the number input whose name is NOT
    // "returnWindowDays" and is the first such within row 0.
    const daysInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[type="number"][min="1"][max="365"]',
      ),
    ).filter((i) => !i.getAttribute("name"));
    expect(daysInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(daysInputs[0], { target: { value: "60" } });
    expect(daysInputs[0].value).toBe("60");
    // Non-numeric → falls back to 30 inside handler.
    fireEvent.change(daysInputs[0], { target: { value: "abc" } });

    // line 652: remove the first country window row via its "×" button.
    // Each country row has a unique 80px-wide days input; the × button is the
    // last button within that row.
    let countryRows: Element[] = [];
    await waitFor(() => {
      countryRows = Array.from(
        container.querySelectorAll<HTMLElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      ).map((i) => i.parentElement!);
      expect(countryRows.length).toBe(2);
    });
    const xBtnRow0 = Array.from(
      countryRows[0].querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "×");
    expect(xBtnRow0).toBeTruthy();
    fireEvent.click(xBtnRow0!);
    await waitFor(() => {
      const remaining = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(remaining.length).toBe(1);
    });

    // line 663: + Add country dashed button.
    const addCountryBtn = Array.from(
      container.querySelectorAll("button"),
    ).find((b) => b.textContent?.trim() === "+ Add country");
    expect(addCountryBtn).toBeTruthy();
    fireEvent.click(addCountryBtn!);
    await waitFor(() => {
      const after = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(after.length).toBe(2);
    });

    // line 582: remove the existing fee row via its "×" button. There is only
    // one fee row seeded ("Wrong size", 5). The fee row contains a <span>
    // showing the reason text — locate that, walk up to the row, then click.
    const reasonSpans = Array.from(
      container.querySelectorAll<HTMLSpanElement>("span"),
    ).filter((s) => s.textContent?.trim() === "Wrong size");
    expect(reasonSpans.length).toBeGreaterThan(0);
    // The fee row's reason span sits inside a flex row that also contains the
    // fee-amount number input and the "×" button.
    const feeRow = reasonSpans
      .map((s) => s.parentElement!)
      .find(
        (row) =>
          row.querySelector('input[type="number"][step="0.01"]') &&
          Array.from(row.querySelectorAll("button")).some(
            (b) => b.textContent?.trim() === "×",
          ),
      );
    expect(feeRow).toBeTruthy();
    const feeRemoveBtn = Array.from(
      feeRow!.querySelectorAll<HTMLButtonElement>("button"),
    ).find((b) => b.textContent?.trim() === "×")!;
    expect(feeRemoveBtn).toBeTruthy();
    const feeCountBefore = container.querySelectorAll(
      'input[type="number"][step="0.01"]',
    ).length;
    fireEvent.click(feeRemoveBtn);
    await waitFor(() => {
      const after = container.querySelectorAll(
        'input[type="number"][step="0.01"]',
      ).length;
      expect(after).toBe(feeCountBefore - 1);
    });
  });
});
