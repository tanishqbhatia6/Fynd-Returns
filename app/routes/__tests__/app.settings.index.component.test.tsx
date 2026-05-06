/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings._index.tsx ──
// The route imports shopify.server / db.server purely for the loader and
// (transitively) module evaluation. Stub them so importing the component in
// jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    blocklistEntry: { count: vi.fn() },
  },
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
import SettingsDashboard from "../app.settings._index";

const baseLoaderData = {
  hasFynd: false,
  hasReasons: false,
  hasPortalTheme: false,
  readAllOrders: false,
  notifCount: 0,
  smtpConfigured: false,
  returnWindowDays: 30,
  autoApprove: false,
  autoRefund: false,
  photoRequired: false,
  hasReturnFee: false,
  returnFeeAmount: 0,
  returnFeeCurrency: "USD",
  fyndEnv: null as string | null,
  reasonCount: 0,
  restrictedRegionCount: 0,
  refundPaymentMethod: "original",
  blocklistEnabled: false,
  blocklistCount: 0,
  autoRulesCount: 0,
  bonusCreditEnabled: false,
  bonusCreditPct: 10,
  greenReturnsEnabled: false,
  greenReturnsThreshold: 0,
  hasDefaultReturnInstructions: false,
  portalLanguage: "en",
  productPolicyCount: 0,
  discountCodeRefundEnabled: false,
  shopCurrency: "USD",
};

describe("Settings dashboard (default export)", () => {
  it("renders the Settings page heading", async () => {
    const { findByText } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Settings")).toBeTruthy();
  });

  it("renders all four section group titles", async () => {
    const { findByText } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Return Policies")).toBeTruthy();
    expect(await findByText("Integrations & Automation")).toBeTruthy();
    expect(await findByText("Revenue & Sustainability")).toBeTruthy();
    expect(await findByText("Customer Experience")).toBeTruthy();
  });

  it("renders the expected card titles linking to settings sub-routes", async () => {
    const { container, findByText } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Policy Rules")).toBeTruthy();
    expect(await findByText("Return Settings")).toBeTruthy();
    expect(await findByText("Fynd Integration")).toBeTruthy();
    expect(await findByText("Notifications")).toBeTruthy();
    expect(await findByText("Bonus Credit")).toBeTruthy();
    expect(await findByText("Green Returns")).toBeTruthy();
    expect(await findByText("Portal Appearance")).toBeTruthy();
    expect(await findByText("Billing")).toBeTruthy();

    // Every card is wrapped in a Link — verify a few hrefs are present.
    const anchors = Array.from(container.querySelectorAll("a"));
    const hrefs = anchors.map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/app/settings/rules",
        "/app/settings/return-settings",
        "/app/settings/integrations",
        "/app/settings/notifications",
        "/app/billing",
      ]),
    );
  });

  it("shows the Fynd setup banner when hasFynd=false", async () => {
    const { findByText, container } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Fynd Setup Guide")).toBeTruthy();
    const setupLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/setup",
    );
    expect(setupLink).toBeTruthy();
    // Fynd card status reflects "Not connected"
    expect(container.textContent).toMatch(/Not connected/);
  });

  it("hides the Fynd setup banner and shows Connected chip when hasFynd=true", async () => {
    const { container } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: { ...baseLoaderData, hasFynd: true, fyndEnv: "prod" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Integration");
    });
    expect(container.textContent).not.toContain("Fynd Setup Guide");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Production");
  });

  it("reflects SMTP-configured + auto-approve flags in the chips and summary", async () => {
    const { container } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: {
        ...baseLoaderData,
        smtpConfigured: true,
        autoApprove: true,
        autoRefund: true,
        notifCount: 4,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Notifications");
    });
    expect(container.textContent).toContain("SMTP connected");
    expect(container.textContent).toContain("4/4 enabled");
    // The summary bar renders the auto-approve / auto-refund mini-chips.
    expect(container.textContent).toContain("Auto-approve");
    expect(container.textContent).toContain("Auto-refund");
  });

  it("renders the reason-count and restricted-region chips when hasReasons=true", async () => {
    const { container } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: {
        ...baseLoaderData,
        hasReasons: true,
        reasonCount: 5,
        restrictedRegionCount: 2,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Policy Rules");
    });
    expect(container.textContent).toContain("5 reasons");
    expect(container.textContent).toContain("2 restricted regions");
  });

  it("shows the configuration progress counter reflecting configured cards", async () => {
    const { container } = renderWithRouter(SettingsDashboard, {
      initialEntries: ["/app/settings"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Configuration");
    });
    // With baseLoaderData (nothing enabled), the progress indicator renders
    // "<configured>/<total>". Assert the "<num>/<num>" format is present.
    expect(container.textContent).toMatch(/0\/\d+/);
    // Empty-state hint is shown in the summary bar.
    expect(container.textContent).toMatch(/Configure your return policies/i);
  });
});
