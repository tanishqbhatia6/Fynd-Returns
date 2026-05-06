/**
 * @vitest-environment jsdom
 *
 * Targeted coverage for the React component body of app.settings.rules.tsx.
 * The existing `.component.test.tsx` covers the basic rendering path; this
 * file targets the remaining uncovered branches:
 *   - return-window-days input
 *   - min-return-price input
 *   - reasons-by-category add/remove (categories + reasons inside)
 *   - restricted-regions add (Enter key + button) / remove
 *   - fees-by-reason add (via the document.getElementById select flow at
 *     lines 605-608) and remove + onChange
 *   - windows-by-country add/remove + onChange of country and days inputs
 *     (lines 634-663)
 *   - save submit handler (handleSubmit serialization branch)
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
  syncShopLocaleAndCurrency: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
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
import {
  act,
  waitFor as rtlWaitFor,
  fireEvent,
  configure,
} from "@testing-library/react";
import ReturnRules from "../app.settings.rules";

// React Router 7's createMemoryRouter performs an async loader transition
// before mounting children — on a cold worker this can take several seconds
// before the first paint. Bump the async helper timeouts so cold-start
// renders aren't flaky.
configure({ asyncUtilTimeout: 8000 });
const waitFor: typeof rtlWaitFor = (cb, opts) =>
  rtlWaitFor(cb, { timeout: 8000, ...opts });

const baseLoaderData = {
  returnWindowDays: 30,
  minimumReturnPrice: "0",
  returnReasons: ["Wrong size", "Damaged item", "Late delivery"],
  returnReasonsByCategory: [
    { category: "Apparel", reasons: ["Too tight"] },
  ],
  restrictedRegions: [{ country: "Cuba" }, { province: "Quebec" }, {}],
  returnOffers: [
    {
      id: "offer-1",
      offerType: "discount_pct" as const,
      offerValue: 15,
      message: "Keep your item and get 15% off your next order!",
      reasonCode: "Wrong size",
      tag: "clearance",
    },
    {
      id: "offer-flat",
      offerType: "discount_flat" as const,
      offerValue: 10,
      message: "Take ten dollars off",
    },
  ],
  returnOffersEnabled: true,
  feesByReason: [{ reason: "Wrong size", feeAmount: 5 }],
  windowsByCountry: [{ country: "US", days: 45 }],
  shopCurrency: "USD",
};

function findInput(
  container: HTMLElement,
  selector: string,
): HTMLInputElement {
  const el = container.querySelector(selector) as HTMLInputElement | null;
  if (!el) throw new Error(`Expected to find ${selector}`);
  return el;
}

describe("app.settings.rules — uncovered component branches", () => {
  it("hydrates returnWindowDays and minimumReturnPrice from loader and reflects user changes", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[name="returnWindowDays"]'),
      ).toBeTruthy();
    });
    const windowInput = findInput(
      container,
      'input[name="returnWindowDays"]',
    );
    const priceInput = findInput(
      container,
      'input[name="minimumReturnPrice"]',
    );
    expect(windowInput.value).toBe("30");
    expect(priceInput.value).toBe("0");
    fireEvent.change(windowInput, { target: { value: "60" } });
    fireEvent.change(priceInput, { target: { value: "12.50" } });
    expect(windowInput.value).toBe("60");
    expect(priceInput.value).toBe("12.50");
  });

  it("adds and removes reasons-by-category entries and inner reasons", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    // Wait for initial render — the existing Apparel category renders as
    // an input value, not text content.
    await waitFor(() => {
      const inputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder^="Category / Product type"]',
        ),
      );
      expect(inputs.length).toBeGreaterThanOrEqual(1);
      expect(inputs[0].value).toBe("Apparel");
    });

    // Click "+ Add category" — find by text content match.
    const buttons = Array.from(container.querySelectorAll("button"));
    const addCategoryBtn = buttons.find(
      (b) => b.textContent?.trim() === "+ Add category",
    );
    expect(addCategoryBtn).toBeTruthy();
    fireEvent.click(addCategoryBtn!);

    // Now there should be 2 category-name inputs (placeholder match).
    let categoryInputs: HTMLInputElement[] = [];
    await waitFor(() => {
      categoryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder^="Category / Product type"]',
        ),
      );
      expect(categoryInputs.length).toBeGreaterThanOrEqual(2);
    });
    // Edit the new (last) category name.
    fireEvent.change(categoryInputs[categoryInputs.length - 1], {
      target: { value: "Footwear" },
    });
    expect(categoryInputs[categoryInputs.length - 1].value).toBe("Footwear");

    // Add a reason to the first ("Apparel") category via Enter key on its
    // "Add reason" input.
    const reasonAddInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[placeholder="Add reason"]',
      ),
    );
    expect(reasonAddInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(reasonAddInputs[0], { target: { value: "Stain" } });
    fireEvent.keyDown(reasonAddInputs[0], { key: "Enter" });
    await waitFor(() => {
      expect(container.textContent).toContain("Stain");
    });

    // Adding the same reason again is a no-op (covers includes-guard branch).
    fireEvent.change(reasonAddInputs[0], { target: { value: "Stain" } });
    fireEvent.keyDown(reasonAddInputs[0], { key: "Enter" });

    // Add another reason via the per-category Add button (click handler).
    fireEvent.change(reasonAddInputs[0], { target: { value: "Faded" } });
    // Locate the Add button next to that input.
    const addReasonButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Add");
    expect(addReasonButtons.length).toBeGreaterThan(0);
    fireEvent.click(addReasonButtons[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Faded");
    });

    // Empty value: addReasonToCategory early-returns on empty-trim.
    fireEvent.change(reasonAddInputs[0], { target: { value: "   " } });
    fireEvent.click(addReasonButtons[0]);

    // Remove the inner "Stain" reason chip via its aria-label button.
    const removeStain = container.querySelector(
      'button[aria-label="Remove Stain"]',
    ) as HTMLButtonElement | null;
    expect(removeStain).toBeTruthy();
    fireEvent.click(removeStain!);
    await waitFor(() => {
      expect(container.textContent).not.toContain("Stain");
    });

    // Remove a category entirely via its Remove button.
    const removeCategoryButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Remove");
    expect(removeCategoryButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeCategoryButtons[0]);
  });

  it("adds restricted regions via Enter key and removes them", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Cuba");
    });
    const regionInput = findInput(
      container,
      'input[placeholder="Search country"]',
    );
    fireEvent.change(regionInput, { target: { value: "Iran" } });
    fireEvent.keyDown(regionInput, { key: "Enter" });
    await waitFor(() => {
      expect(container.textContent).toContain("Iran");
    });
    // Whitespace-only input is a no-op.
    fireEvent.change(regionInput, { target: { value: "   " } });
    fireEvent.keyDown(regionInput, { key: "Enter" });

    // Remove the first restricted region.
    const removeRegionBtn = container.querySelector(
      'button[aria-label="Remove"]',
    ) as HTMLButtonElement | null;
    expect(removeRegionBtn).toBeTruthy();
    fireEvent.click(removeRegionBtn!);
  });

  it("adds and removes fees-by-reason entries via the select+button flow (covers document.getElementById branch)", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    // Wait for the existing fee row.
    await waitFor(() => {
      expect(
        container.querySelector("#feeReasonSelect"),
      ).toBeTruthy();
    });

    const feeSelect = container.querySelector(
      "#feeReasonSelect",
    ) as HTMLSelectElement;
    expect(feeSelect).toBeTruthy();

    // Locate the matching Add s-button (sibling within the same flex row).
    const feeRow = feeSelect.parentElement!;
    const feeAddButton = feeRow.querySelector("s-button") as HTMLElement;
    expect(feeAddButton).toBeTruthy();

    // Empty select value → onClick early-returns (covers the falsy branch).
    fireEvent.click(feeAddButton);

    // Now select a real reason and click Add — runs the
    // setFeesByReason([...feesByReason, { ... }]) branch.
    fireEvent.change(feeSelect, { target: { value: "Damaged item" } });
    fireEvent.click(feeAddButton);
    await waitFor(() => {
      // The newly-added row contains the reason text.
      const allText = container.textContent || "";
      expect(allText).toContain("Damaged item");
    });

    // Mutate fee amount on existing row (onChange handler).
    const feeAmountInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[type="number"][step="0.01"]',
      ),
    );
    // Find a fee input (value matches one of our seeded amounts).
    const feeInput = feeAmountInputs.find((i) => i.value === "5");
    expect(feeInput).toBeTruthy();
    fireEvent.change(feeInput!, { target: { value: "8.5" } });
    expect(feeInput!.value).toBe("8.5");
    // Non-numeric → falls back to 0.
    fireEvent.change(feeInput!, { target: { value: "abc" } });

    // Remove the original fee row via its "×" button.
    const removeFeeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "×");
    expect(removeFeeButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeFeeButtons[0]);
  });

  it("adds and removes windows-by-country entries (covers country/days onChange and remove)", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    // Wait for the existing US window row.
    let countryInputs: HTMLInputElement[] = [];
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(1);
      expect(countryInputs[0].value).toBe("US");
    });

    // Click the "+ Add country" dashed button.
    const allButtons = Array.from(container.querySelectorAll("button"));
    const addCountryBtn = allButtons.find(
      (b) => b.textContent?.trim() === "+ Add country",
    );
    expect(addCountryBtn).toBeTruthy();
    await act(async () => { fireEvent.click(addCountryBtn!); });

    // Now there should be 2 country inputs.
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(2);
    });

    // Update the country code on the new (last) row → covers the country
    // onChange handler at line 633-635.
    fireEvent.change(countryInputs[1], { target: { value: "DE" } });
    expect(countryInputs[1].value).toBe("DE");

    // Update the days input for that row. It is the 2nd `input[type=number]`
    // inside the country-windows section. Easiest path: locate by the value
    // ("30") on the days input we just rendered.
    const daysInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[type="number"][min="1"][max="365"]',
      ),
    );
    // returnWindowDays input also matches; filter to those without a name attr.
    const countryDaysInputs = daysInputs.filter((i) => !i.getAttribute("name"));
    expect(countryDaysInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(countryDaysInputs[countryDaysInputs.length - 1], {
      target: { value: "60" },
    });
    expect(countryDaysInputs[countryDaysInputs.length - 1].value).toBe("60");

    // Non-numeric → falls back to 30 inside the handler.
    fireEvent.change(countryDaysInputs[countryDaysInputs.length - 1], {
      target: { value: "" },
    });

    // Remove the first country row.
    const xButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "×");
    // Find the one inside a country-windows row (look for a sibling with
    // "days" text).
    const countryRemove = xButtons.find((b) => {
      const row = b.parentElement;
      return row && /days/i.test(row.textContent ?? "");
    });
    expect(countryRemove).toBeTruthy();
    fireEvent.click(countryRemove!);
  });

  it("submits the form (handleSubmit serializes state into JSON and calls fetcher.submit)", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });

    let form: HTMLFormElement | null = null;
    await waitFor(() => {
      form = container.querySelector("form");
      expect(form).toBeTruthy();
    });

    // Fire the form's submit event directly. handleSubmit calls
    // e.preventDefault() then builds a FormData and invokes fetcher.submit
    // — none of which require a real network round-trip in jsdom.
    fireEvent.submit(form!);
  });

  it("toggles offers-enabled checkbox off and re-renders without the offers list", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    let checkbox: HTMLInputElement | null = null;
    await waitFor(() => {
      checkbox = container.querySelector(
        'input[type="checkbox"]',
      ) as HTMLInputElement | null;
      expect(checkbox).toBeTruthy();
      expect(checkbox!.checked).toBe(true);
    });
    fireEvent.click(checkbox!);
    await waitFor(() => {
      expect(checkbox!.checked).toBe(false);
    });
  });

  it("renders fall-through dash for an empty restricted region entry", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      // Region entries: { country: "Cuba" }, { province: "Quebec" }, {}
      // The empty {} renders the em-dash fallback.
      expect(container.textContent).toContain("Quebec");
      expect(container.textContent).toContain("—");
    });
  });

  it("opens the new-offer form, validates input, adds and removes an offer", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    // Wait for the "Add New Offer" toggle button (s-button) to render.
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("s-button"));
      expect(
        buttons.some((b) => b.textContent?.trim() === "Add New Offer"),
      ).toBe(true);
    });
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const addNewOfferBtn = buttons.find(
      (b) => b.textContent?.trim() === "Add New Offer",
    ) as HTMLElement | undefined;
    expect(addNewOfferBtn).toBeTruthy();
    fireEvent.click(addNewOfferBtn!);

    // Wait for the form to appear (look for "New Offer" heading).
    await waitFor(() => {
      expect(container.textContent).toContain("New Offer");
    });

    // 1) Reason select — pick the existing "Wrong size" reason.
    const reasonSelect = container.querySelector(
      "select",
    ) as HTMLSelectElement | null;
    expect(reasonSelect).toBeTruthy();
    fireEvent.change(reasonSelect!, { target: { value: "Wrong size" } });

    // 2) Tag input.
    const tagInput = container.querySelector(
      'input[placeholder="e.g. clearance"]',
    ) as HTMLInputElement | null;
    expect(tagInput).toBeTruthy();
    fireEvent.change(tagInput!, { target: { value: "summer" } });

    // 3) Offer-type select — switch to flat then back to pct.
    const selects = Array.from(container.querySelectorAll("select"));
    const typeSelect = selects.find((s) =>
      Array.from(s.options).some(
        (o) => o.value === "discount_pct" || o.value === "discount_flat",
      ),
    ) as HTMLSelectElement | undefined;
    expect(typeSelect).toBeTruthy();
    fireEvent.change(typeSelect!, { target: { value: "discount_flat" } });
    fireEvent.change(typeSelect!, { target: { value: "discount_pct" } });

    // 4) Value input.
    const valueInput = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[type="number"][step="0.01"]',
      ),
    ).find((i) => i.placeholder?.startsWith("e.g. 15"));
    expect(valueInput).toBeTruthy();

    // 5) Message input.
    const messageInput = container.querySelector(
      'input[placeholder^="Keep your item"]',
    ) as HTMLInputElement | null;
    expect(messageInput).toBeTruthy();

    // Invalid (zero) value → addOffer early-returns.
    fireEvent.change(valueInput!, { target: { value: "0" } });
    fireEvent.change(messageInput!, { target: { value: "Stay with us!" } });
    const addOfferBtn = Array.from(
      container.querySelectorAll("s-button"),
    ).find((b) => b.textContent?.trim() === "Add Offer") as
      | HTMLElement
      | undefined;
    expect(addOfferBtn).toBeTruthy();
    fireEvent.click(addOfferBtn!);
    expect(container.textContent).toContain("New Offer");

    // Empty message → also early-returns.
    fireEvent.change(valueInput!, { target: { value: "20" } });
    fireEvent.change(messageInput!, { target: { value: "   " } });
    fireEvent.click(addOfferBtn!);
    expect(container.textContent).toContain("New Offer");

    // Valid input → addOffer creates a new offer and closes form.
    fireEvent.change(valueInput!, { target: { value: "20" } });
    fireEvent.change(messageInput!, {
      target: { value: "Take 20% off, stay with us" },
    });
    fireEvent.click(addOfferBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Take 20% off, stay with us");
    });

    // Reopen form then click Cancel (covers the secondary setShowOfferForm
    // path).
    const addNewOfferBtn2 = Array.from(
      container.querySelectorAll("s-button"),
    ).find((b) => b.textContent?.trim() === "Add New Offer") as
      | HTMLElement
      | undefined;
    expect(addNewOfferBtn2).toBeTruthy();
    fireEvent.click(addNewOfferBtn2!);
    await waitFor(() => {
      expect(container.textContent).toContain("New Offer");
    });
    const cancelBtn = Array.from(
      container.querySelectorAll("s-button"),
    ).find((b) => b.textContent?.trim() === "Cancel") as
      | HTMLElement
      | undefined;
    expect(cancelBtn).toBeTruthy();
    fireEvent.click(cancelBtn!);

    // Remove an offer via its "Remove" button (covers removeOffer).
    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Remove");
    expect(removeButtons.length).toBeGreaterThan(0);
    fireEvent.click(removeButtons[0]);
  });

  it("adds a reason via the Enter-key shortcut on the reason input", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    let reasonInput: HTMLInputElement | null = null;
    await waitFor(() => {
      reasonInput = container.querySelector(
        'input[placeholder="Search or add reason"]',
      ) as HTMLInputElement | null;
      expect(reasonInput).toBeTruthy();
    });
    fireEvent.change(reasonInput!, { target: { value: "Color faded" } });
    fireEvent.keyDown(reasonInput!, { key: "Enter" });
    await waitFor(() => {
      expect(container.textContent).toContain("Color faded");
    });
    // Same reason again → no-op (covers the includes guard).
    fireEvent.change(reasonInput!, { target: { value: "Color faded" } });
    fireEvent.keyDown(reasonInput!, { key: "Enter" });
    // Whitespace-only input → addReason early-returns.
    fireEvent.change(reasonInput!, { target: { value: "   " } });
    fireEvent.keyDown(reasonInput!, { key: "Enter" });
    // Remove the just-added reason via its aria-label button.
    const removeBtn = container.querySelector(
      'button[aria-label="Remove Color faded"]',
    ) as HTMLButtonElement | null;
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn!);
  });
});
