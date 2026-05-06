/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.rules.tsx ──
// The route file imports `authenticate` from app/shopify.server and prisma
// from app/db.server purely for the loader/action. Stub those modules so
// importing the component in jsdom doesn't crash on Node-only deps.
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

// app/shopify.server.ts (which is what the route imports) calls shopifyApp()
// at module load. Even though we mock that file above, vitest still resolves
// nested deps in some cases — provide a stub factory so the import never
// throws.
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
import { waitFor, fireEvent, act } from "@testing-library/react";
import ReturnRules from "../app.settings.rules";

const baseLoaderData = {
  returnWindowDays: 30,
  minimumReturnPrice: "0",
  returnReasons: ["Wrong size", "Damaged item"],
  returnReasonsByCategory: [{ category: "Apparel", reasons: ["Too tight", "Too loose"] }],
  restrictedRegions: [{ country: "Cuba" }],
  returnOffers: [
    {
      id: "offer-1",
      offerType: "discount_pct" as const,
      offerValue: 15,
      message: "Keep your item and get 15% off your next order!",
      reasonCode: "Wrong size",
    },
  ],
  returnOffersEnabled: true,
  feesByReason: [{ reason: "Wrong size", feeAmount: 5 }],
  windowsByCountry: [{ country: "US", days: 45 }],
  shopCurrency: "USD",
};

describe("app.settings.rules component (default export)", () => {
  it("renders the Return Rules page heading", async () => {
    const { findByText } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Return Rules")).toBeTruthy();
  });

  it("renders all major section headings from the loader data", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Return Offers");
    });
    expect(container.textContent).toContain("Return Price Rules");
    expect(container.textContent).toContain("Reasons");
    expect(container.textContent).toContain("Restricted regions");
    expect(container.textContent).toContain("Return Days");
    expect(container.textContent).toContain("Per-Reason Restocking Fees");
    expect(container.textContent).toContain("Country-Specific Return Windows");
  });

  it("hydrates the return-window and minimum-price inputs from loader data", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    let windowInput: HTMLInputElement | null = null;
    let priceInput: HTMLInputElement | null = null;
    await waitFor(() => {
      windowInput = container.querySelector(
        'input[name="returnWindowDays"]',
      ) as HTMLInputElement | null;
      priceInput = container.querySelector(
        'input[name="minimumReturnPrice"]',
      ) as HTMLInputElement | null;
      expect(windowInput).toBeTruthy();
      expect(priceInput).toBeTruthy();
    });
    expect(windowInput!.value).toBe("30");
    expect(priceInput!.value).toBe("0");
  });

  it("renders existing reasons as removable chips", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Wrong size");
    });
    expect(container.textContent).toContain("Damaged item");
    const removeBtn = container.querySelector('button[aria-label="Remove Damaged item"]');
    expect(removeBtn).toBeTruthy();
  });

  it("adds a new reason when typing into the reason input and clicking Add", async () => {
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
    await act(async () => {
      fireEvent.change(reasonInput!, { target: { value: "Late delivery" } });
    });
    await waitFor(() => {
      expect(reasonInput!.value).toBe("Late delivery");
    });
    // Click the Add button next to the reason input. There may be multiple
    // "Add" buttons on the page, so pick the one inside the same parent.
    const addBtn = reasonInput!.parentElement?.querySelector("s-button") as HTMLElement | null;
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Late delivery");
    });
  });

  it("renders the existing return offer with its discount and message", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("15% off");
    });
    expect(container.textContent).toContain("Keep your item and get 15% off your next order!");
    expect(container.textContent).toContain("Wrong size");
  });

  it("renders the restricted region from loader data", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Cuba");
    });
  });

  it("renders Save and Discard action buttons", async () => {
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("s-button"));
      const labels = buttons.map((b) => b.textContent?.trim());
      expect(labels).toEqual(expect.arrayContaining(["Save", "Discard"]));
    });
    const discardLink = container.querySelector('a[href="/app/settings"]');
    expect(discardLink).toBeTruthy();
  });
});
