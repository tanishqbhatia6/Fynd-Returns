/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.billing-override.tsx ──
// The route imports shopify.server / db.server / lib/billing.server purely
// for the loader and (transitively) module evaluation. Stub them so importing
// the component in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findMany: vi.fn() },
  },
}));
vi.mock("../lib/billing.server", () => ({
  getBillingMode: vi.fn(() => "prod"),
  isSuperAdmin: vi.fn(() => true),
  setBillingPlanOverride: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));

// boundary helpers from the server entry are imported transitively; stub.
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
import BillingOverridePage from "../app.settings.billing-override";

type ShopRow = {
  shopDomain: string;
  installedAt: string;
  override: "free" | "paid" | null;
  overrideReason: string | null;
  overrideBy: string | null;
  overrideAt: string | null;
  subscriptionStatus: string | null;
  subscriptionName: string | null;
};

const shopA: ShopRow = {
  shopDomain: "alpha-shop.myshopify.com",
  installedAt: "2026-01-15T00:00:00.000Z",
  override: "free",
  overrideReason: "Beta partner — comped",
  overrideBy: "ops@returnpromax.test",
  overrideAt: "2026-02-01T00:00:00.000Z",
  subscriptionStatus: "active",
  subscriptionName: "Pro Plan",
};
const shopB: ShopRow = {
  shopDomain: "beta-shop.myshopify.com",
  installedAt: "2026-03-20T00:00:00.000Z",
  override: "paid",
  overrideReason: null,
  overrideBy: null,
  overrideAt: null,
  subscriptionStatus: "cancelled",
  subscriptionName: null,
};
const shopC: ShopRow = {
  shopDomain: "gamma-shop.myshopify.com",
  installedAt: "2026-04-01T00:00:00.000Z",
  override: null,
  overrideReason: null,
  overrideBy: null,
  overrideAt: null,
  subscriptionStatus: null,
  subscriptionName: null,
};

const baseLoaderData = {
  actingEmail: "admin@returnpromax.test",
  mode: "prod" as "prod" | "dev",
  shops: [shopA, shopB, shopC],
};

describe("Billing override page (default export)", () => {
  it("renders the page heading and acting-admin banner", async () => {
    const { findByText, container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Billing override (superadmin)")).toBeTruthy();
    await waitFor(() => {
      expect(container.textContent).toContain("admin@returnpromax.test");
    });
    expect(container.textContent).toMatch(/Internal tool/i);
    expect(container.textContent).toContain("prod");
  });

  it("renders the admin table with one row per shop and the expected column headers", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const headers = Array.from(container.querySelectorAll("th")).map((th) =>
      th.textContent?.trim(),
    );
    expect(headers).toEqual(
      expect.arrayContaining([
        "Shop",
        "Installed",
        "Override",
        "Reason",
        "Last subscription",
        "Change",
      ]),
    );
    const dataRows = container.querySelectorAll("tbody tr");
    expect(dataRows.length).toBe(3);
    expect(container.textContent).toContain("alpha-shop.myshopify.com");
    expect(container.textContent).toContain("beta-shop.myshopify.com");
    expect(container.textContent).toContain("gamma-shop.myshopify.com");
  });

  it("renders FREE / PAID / default override pills based on each shop's override value", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("FREE");
    expect(container.textContent).toContain("PAID");
    expect(container.textContent).toContain("default (env)");
  });

  it("renders override controls (hidden shopDomain, select, reason input, save button) for every shop row", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("tbody tr form").length).toBe(3);
    });
    const forms = container.querySelectorAll("tbody tr form");
    forms.forEach((form) => {
      expect(form.getAttribute("method")).toBe("post");
      const hidden = form.querySelector(
        "input[type='hidden'][name='shopDomain']",
      ) as HTMLInputElement | null;
      expect(hidden).toBeTruthy();
      const select = form.querySelector(
        "select[name='override']",
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
      const optionValues = Array.from(select?.options ?? []).map((o) => o.value);
      expect(optionValues).toEqual(expect.arrayContaining(["", "free", "paid"]));
      const reason = form.querySelector(
        "input[name='reason']",
      ) as HTMLInputElement | null;
      expect(reason).toBeTruthy();
      expect(reason?.required).toBe(true);
      expect(reason?.minLength).toBe(4);
      const submit = form.querySelector(
        "button[type='submit']",
      ) as HTMLButtonElement | null;
      expect(submit?.textContent?.trim()).toBe("Save");
    });
  });

  it("pre-selects each row's current override value in the select control", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("tbody tr form").length).toBe(3);
    });
    const rows = Array.from(container.querySelectorAll("tbody tr"));
    const selectFor = (domain: string) => {
      const row = rows.find((r) => r.textContent?.includes(domain));
      return row?.querySelector("select[name='override']") as HTMLSelectElement | null;
    };
    expect(selectFor("alpha-shop.myshopify.com")?.value).toBe("free");
    expect(selectFor("beta-shop.myshopify.com")?.value).toBe("paid");
    expect(selectFor("gamma-shop.myshopify.com")?.value).toBe("");
    // Hidden shopDomain matches the row.
    const hiddenFor = (domain: string) => {
      const row = rows.find((r) => r.textContent?.includes(domain));
      return row?.querySelector(
        "input[type='hidden'][name='shopDomain']",
      ) as HTMLInputElement | null;
    };
    expect(hiddenFor("alpha-shop.myshopify.com")?.value).toBe(
      "alpha-shop.myshopify.com",
    );
    expect(hiddenFor("beta-shop.myshopify.com")?.value).toBe(
      "beta-shop.myshopify.com",
    );
  });

  it("renders the reason audit info (text + by/at) only for shops that have an override reason", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Beta partner — comped");
    expect(container.textContent).toContain("ops@returnpromax.test");
    expect(container.textContent).toContain("2026-02-01");
  });

  it("shows the empty state when no shops are installed", async () => {
    const { container, findByText } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: { ...baseLoaderData, shops: [] },
    });
    expect(await findByText("No shops installed yet.")).toBeTruthy();
    // Header row remains, but no data rows.
    const dataRows = container.querySelectorAll("tbody tr");
    // Empty-state row is one tr with colSpan; ensure no per-shop forms.
    expect(container.querySelectorAll("tbody tr form").length).toBe(0);
    expect(dataRows.length).toBe(1);
  });

  it("renders a Back to billing status link pointing to /app/billing", async () => {
    const { container } = renderWithRouter(BillingOverridePage, {
      initialEntries: ["/app/settings/billing-override"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const backLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to billing status"),
    );
    expect(backLink).toBeTruthy();
    expect(backLink?.getAttribute("href")).toBe("/app/billing");
  });
});
