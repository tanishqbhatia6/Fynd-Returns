/**
 * @vitest-environment jsdom
 *
 * Component test for app.settings.return-settings.tsx — the giant return
 * settings form. The route module pulls in shopify.server / db.server / a
 * couple of admin-only helpers at the top so the loader can authenticate
 * the merchant; we stub them here so importing the file in jsdom doesn't
 * crash on Node-only deps. The default-exported component itself only
 * needs the loader-data shape, so we feed a minimal mock that satisfies
 * every flag and JSON-array field the loader returns.
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
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));
vi.mock("../lib/shopify-admin.server", () => ({
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
import { waitFor } from "@testing-library/react";
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
  shopLocations: [] as Array<{ id: string; name: string }>,
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

describe("ReturnSettings (default export)", () => {
  it("renders the 'Return Settings' page heading", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe("Return Settings");
    });
  });

  it("renders the no-return-period checkbox unchecked by default", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const cb = container.querySelector(
        "input[type='checkbox'][name='noReturnPeriodEnabled']",
      ) as HTMLInputElement | null;
      expect(cb).toBeTruthy();
      expect(cb?.checked).toBe(false);
    });
  });

  it("hides the start/end date inputs while the no-return period is disabled", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Return Settings");
    });
    expect(
      container.querySelector("input[name='noReturnPeriodStart']"),
    ).toBeFalsy();
    expect(
      container.querySelector("input[name='noReturnPeriodEnd']"),
    ).toBeFalsy();
  });

  it("renders date inputs when the no-return period is enabled", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: {
        ...baseLoaderData,
        noReturnPeriodEnabled: true,
        noReturnPeriodStart: "2026-01-01",
        noReturnPeriodEnd: "2026-01-31",
      },
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[name='noReturnPeriodStart']"),
      ).toBeTruthy();
    });
    const start = container.querySelector(
      "input[name='noReturnPeriodStart']",
    ) as HTMLInputElement | null;
    const end = container.querySelector(
      "input[name='noReturnPeriodEnd']",
    ) as HTMLInputElement | null;
    expect(start?.defaultValue).toBe("2026-01-01");
    expect(end?.defaultValue).toBe("2026-01-31");
  });

  it("seeds the currency selector from loader data", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: { ...baseLoaderData, returnFeeCurrency: "EUR" },
    });
    await waitFor(() => {
      const sel = container.querySelector(
        "select[name='returnFeeCurrency']",
      ) as HTMLSelectElement | null;
      expect(sel).toBeTruthy();
      expect(sel?.value).toBe("EUR");
    });
  });

  it("renders restricted-product-tag chips with remove buttons for each loader tag", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: {
        ...baseLoaderData,
        restrictedProductTags: ["final-sale", "clearance"],
      },
    });
    await waitFor(() => {
      expect(
        container.querySelector("button[aria-label='Remove final-sale']"),
      ).toBeTruthy();
    });
    expect(
      container.querySelector("button[aria-label='Remove clearance']"),
    ).toBeTruthy();
  });

  it("seeds the return-ID body-mode radio from the loader's returnIdConfig", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: {
        ...baseLoaderData,
        returnIdConfig: {
          ...baseLoaderData.returnIdConfig,
          bodyMode: "sequential" as const,
        },
      },
    });
    await waitFor(() => {
      const checked = container.querySelector(
        "input[type='radio'][name='ridBodyMode']:checked",
      ) as HTMLInputElement | null;
      expect(checked?.value).toBe("sequential");
    });
  });

  it("renders the gift-returns and scheduled-report toggles reflecting loader flags", async () => {
    const { container } = renderWithRouter(ReturnSettings, {
      initialEntries: ["/app/settings/return-settings"],
      loaderData: {
        ...baseLoaderData,
        giftReturnsEnabled: true,
        scheduledReportEnabled: true,
      },
    });
    await waitFor(() => {
      const gift = container.querySelector(
        "input[type='checkbox'][name='giftReturnsEnabled']",
      ) as HTMLInputElement | null;
      expect(gift?.checked).toBe(true);
    });
    const sched = container.querySelector(
      "input[type='checkbox'][name='scheduledReportEnabled']",
    ) as HTMLInputElement | null;
    expect(sched?.checked).toBe(true);
  });
});
