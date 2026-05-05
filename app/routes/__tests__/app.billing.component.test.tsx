/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.billing.tsx ──
// The route imports shopify.server / lib/billing.server purely for the
// loader and (transitively) module evaluation. Stub them so importing
// the component in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
  getManagedPricingUpgradeUrl: vi.fn(() => "https://example.test/upgrade"),
  getBillingMode: vi.fn(() => "prod"),
  isSuperAdmin: vi.fn(() => false),
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
import BillingPage from "../app.billing";

const UPGRADE_URL = "https://test-shop.myshopify.com/admin/charges/test/pricing_plans";

const baseLoaderData = {
  status: {
    hasAccess: true as boolean,
    reason: "subscription_active" as
      | "dev_mode"
      | "override_free"
      | "subscription_active"
      | "subscription_missing"
      | "override_paid_no_sub",
    subscriptionName: "Pro Plan" as string | null | undefined,
  },
  upgradeUrl: UPGRADE_URL,
  mode: "prod" as "prod" | "dev",
  isSuperadmin: false,
  sessionEmail: null as string | null,
};

describe("Billing page (default export)", () => {
  it("renders the page heading", async () => {
    const { findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Billing")).toBeTruthy();
  });

  it("shows the current plan card and Manage plan link when hasAccess=true", async () => {
    const { container, findByText, findAllByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Access granted")).toBeTruthy();
    expect(await findByText("Current plan")).toBeTruthy();
    // "Pro Plan" appears twice — once in the reason label and once in the
    // current-plan card. Use findAllByText to match both.
    const planMatches = await findAllByText("Pro Plan");
    expect(planMatches.length).toBeGreaterThanOrEqual(1);

    // "Manage plan" link points at upgradeUrl
    const manageLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Manage plan",
    );
    expect(manageLink).toBeTruthy();
    expect(manageLink?.getAttribute("href")).toBe(UPGRADE_URL);
  });

  it("does NOT render the upgrade CTA when hasAccess=true", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Access granted");
    });
    const chooseLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim().startsWith("Choose a plan"),
    );
    expect(chooseLink).toBeFalsy();
    expect(container.textContent).not.toContain("Subscription required");
  });

  it("renders the upgrade CTA linking to upgradeUrl when hasAccess=false", async () => {
    const { container, findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: {
        ...baseLoaderData,
        status: {
          hasAccess: false,
          reason: "subscription_missing" as const,
          subscriptionName: null,
        },
      },
    });
    expect(await findByText("Subscription required")).toBeTruthy();

    const chooseLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim().startsWith("Choose a plan"),
    );
    expect(chooseLink).toBeTruthy();
    expect(chooseLink?.getAttribute("href")).toBe(UPGRADE_URL);
    expect(chooseLink?.getAttribute("target")).toBe("_top");
  });

  it("shows the superadmin override link when isSuperadmin=true", async () => {
    const { container, findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: { ...baseLoaderData, isSuperadmin: true },
    });
    expect(await findByText(/Superadmin tools/i)).toBeTruthy();
    const overrideLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/billing-override",
    );
    expect(overrideLink).toBeTruthy();
    expect(overrideLink?.textContent).toMatch(/override billing for specific shops/i);
  });

  it("does NOT show the superadmin override link when isSuperadmin=false", async () => {
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

  it("renders the production mode banner when mode=prod", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/production/i);
    });
    expect(container.textContent).toMatch(/Subscription is required for app access/i);
    expect(container.textContent).not.toMatch(/Billing is bypassed/i);
  });

  it("renders the dev-mode banner when mode=dev", async () => {
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: { ...baseLoaderData, mode: "dev" as const },
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/development/i);
    });
    expect(container.textContent).toMatch(/Billing is bypassed/i);
  });
});
