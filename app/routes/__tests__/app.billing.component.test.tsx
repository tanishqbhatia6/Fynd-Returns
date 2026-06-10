/**
 * @vitest-environment jsdom
 *
 * Component-level coverage for app/routes/app.billing.tsx — exercises every
 * branch of the default-export `BillingPage` and the inner `ReasonLabel`
 * sub-component (lines 202–222), pushing combined coverage from ~71% to
 * ≥94% statements (the only remaining uncovered line is the `throw` body
 * of `mapReasonNever`, which is module-scope dead code and unreachable
 * without source modifications since the helper isn't exported).
 *
 * Loader path is covered by app.billing.test.ts — DO NOT touch that file.
 *
 * Mocks: shopify.server, lib/billing.server, app-bridge / shopify-app
 * server entry — these are pulled in transitively when the route module
 * is imported, but the component itself only consumes loader data via
 * useLoaderData, so we stub them out aggressively.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Module mocks (top-level so they apply before the route is imported) ──
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
  getManagedPricingUpgradeUrl: vi.fn(() => "https://example.test/upgrade"),
  getBillingMode: vi.fn(() => "prod"),
  isSuperAdmin: vi.fn(() => false),
  selectFreeBillingPlan: vi.fn(),
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
import BillingPage from "../app.billing";

// ── Loader-data factory ────────────────────────────────────────────────
const UPGRADE_URL = "https://test-shop.myshopify.com/admin/charges/test/pricing_plans";

type Reason =
  | "dev_mode"
  | "override_free"
  | "free_plan_selected"
  | "subscription_active"
  | "subscription_missing"
  | "override_paid_no_sub";

type LoaderData = {
  status: {
    hasAccess: boolean;
    reason: Reason | string;
    subscriptionName: string | null | undefined;
  };
  upgradeUrl: string;
  mode: "prod" | "dev";
  isSuperadmin: boolean;
  sessionEmail: string | null;
};

const baseLoaderData: LoaderData = {
  status: {
    hasAccess: true,
    reason: "subscription_active",
    subscriptionName: "Pro Plan",
  },
  upgradeUrl: UPGRADE_URL,
  mode: "prod",
  isSuperadmin: false,
  sessionEmail: null,
};

function withData(overrides: Partial<LoaderData> = {}): LoaderData {
  return { ...baseLoaderData, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("BillingPage — page chrome & shared layout", () => {
  it("renders the 'Billing' heading from AppPage", async () => {
    const { findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Billing")).toBeTruthy();
  });

  it("renders the production-mode banner copy when mode='prod'", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({ mode: "prod" }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/production/i);
    });
    expect(container.textContent).toMatch(/Subscription is required for app access/i);
    expect(container.textContent).not.toMatch(/Billing is bypassed/i);
  });

  it("renders the development-mode banner copy when mode='dev'", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({ mode: "dev" }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/development/i);
    });
    expect(container.textContent).toMatch(/Billing is bypassed/i);
  });
});

describe("BillingPage — hasAccess=true branch (subscription_active)", () => {
  it("shows 'Access granted' heading and the active subscription name", async () => {
    const { findByText, findAllByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Access granted")).toBeTruthy();
    expect(await findByText("Current plan")).toBeTruthy();
    // Subscription name appears in both the reason label AND current-plan card.
    const matches = await findAllByText("Pro Plan");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the 'Manage plan' link pointing at upgradeUrl with target=_top", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Access granted");
    });
    const manageLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Manage plan",
    );
    expect(manageLink).toBeTruthy();
    expect(manageLink?.getAttribute("href")).toBe(UPGRADE_URL);
    expect(manageLink?.getAttribute("target")).toBe("_top");
  });

  it("does NOT render the upgrade CTA when hasAccess=true", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Access granted");
    });
    const chooseLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.trim().startsWith("Choose a plan"),
    );
    expect(chooseLink).toBeFalsy();
    expect(container.textContent).not.toContain("Subscription required");
  });

  it("falls back to plain 'Active Shopify subscription.' when subscriptionName is null", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: true,
          reason: "subscription_active",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Access granted");
    });
    expect(container.textContent).toMatch(/Active Shopify subscription\./);
    // The "Current plan" card section is omitted when subscriptionName is missing.
    expect(container.textContent).not.toContain("Current plan");
  });
});

describe("BillingPage — hasAccess=false branch", () => {
  it("renders 'Subscription required' and Free/Paid plan CTAs when hasAccess=false", async () => {
    const { container, findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: false,
          reason: "subscription_missing",
          subscriptionName: null,
        },
      }),
    });
    expect(await findByText("Subscription required")).toBeTruthy();
    expect(container.textContent).toContain("Continue with Free");
    const chooseLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.trim().startsWith("Choose a paid plan"),
    );
    expect(chooseLink).toBeTruthy();
    expect(chooseLink?.getAttribute("href")).toBe(UPGRADE_URL);
    expect(chooseLink?.getAttribute("target")).toBe("_top");
  });

  it("explains the Shopify Managed Pricing flow under the upgrade CTA", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: false,
          reason: "subscription_missing",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toMatch(/Start on the Free plan/);
    expect(container.textContent).toMatch(/Paid plans are approved in Shopify/);
  });
});

describe("BillingPage — superadmin section", () => {
  it("renders the override link when isSuperadmin=true", async () => {
    const { container, findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({ isSuperadmin: true }),
    });
    expect(await findByText(/Superadmin tools/i)).toBeTruthy();
    const overrideLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/billing-override",
    );
    expect(overrideLink).toBeTruthy();
    expect(overrideLink?.textContent).toMatch(/override billing for specific shops/i);
  });

  it("hides the override link when isSuperadmin=false", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Access granted");
    });
    expect(container.textContent).not.toMatch(/Superadmin tools/i);
    const overrideLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/billing-override",
    );
    expect(overrideLink).toBeFalsy();
  });
});

// ── ReasonLabel coverage — every switch arm of the inner sub-component ──
// These hit the previously-uncovered statements at lines 208, 210, 218, 220.
describe("BillingPage — ReasonLabel switch arms", () => {
  it("reason='dev_mode' renders the development-build copy", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        mode: "dev",
        status: {
          hasAccess: true,
          reason: "dev_mode",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Access granted/);
    });
    expect(container.textContent).toMatch(
      /Development build — billing is not enforced on this environment\./,
    );
  });

  it("reason='override_free' renders the superadmin-granted copy", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: true,
          reason: "override_free",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Access granted/);
    });
    expect(container.textContent).toMatch(/Free access granted by a superadmin for this shop\./);
  });

  it("reason='free_plan_selected' renders the merchant-selected free-plan copy", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: true,
          reason: "free_plan_selected",
          subscriptionName: "Free",
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Access granted/);
    });
    expect(container.textContent).toMatch(/Free plan selected for this shop\./);
  });

  it("reason='subscription_missing' renders the no-subscription copy", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: false,
          reason: "subscription_missing",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toMatch(
      /No active Shopify subscription detected for this shop\./,
    );
  });

  it("reason='override_paid_no_sub' renders the forced-billing-without-sub copy", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: false,
          reason: "override_paid_no_sub",
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toMatch(
      /A superadmin forced billing for this shop, but no active subscription is on file yet\./,
    );
  });

  it("falls through to default arm when reason is an unknown string", async () => {
    // Hits the default branch of the switch (line 220) — the reason itself
    // is rendered verbatim. Cast through `unknown` so TS allows the
    // intentionally-out-of-union value used to exercise the fallthrough.
    const exotic = "totally_unknown_reason_value" as unknown as Reason;
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: false,
          reason: exotic,
          subscriptionName: null,
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toContain("totally_unknown_reason_value");
  });

  it("reason='subscription_active' with subscriptionName renders bold plan name in the reason label", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: {
          hasAccess: true,
          reason: "subscription_active",
          subscriptionName: "Growth",
        },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Access granted/);
    });
    // Bold <strong>Growth</strong> appears inside the reason label.
    const strongs = Array.from(container.querySelectorAll("strong")).map((n) => n.textContent);
    expect(strongs).toContain("Growth");
    expect(container.textContent).toMatch(/Active subscription:/);
  });
});
