/**
 * @vitest-environment jsdom
 *
 * Verifies the SetupChecklist render path on the dashboard:
 *  - shows the card when at least one step is incomplete
 *  - hides itself once every step is done
 *  - links each pending step to the right settings page
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
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

vi.mock("../../db.server", () => ({ default: {} }));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import Dashboard from "../app._index";

const baseLoaderData = {
  totalReturns: 0,
  statusMap: {} as Record<string, number>,
  approvedCount: 0,
  topReasons: [],
  recentReturns: [],
  hasFyndConfig: false,
  shopDomain: "test-shop.myshopify.com",
  refundedCount: 0,
  pendingCount: 0,
  rejectedCount: 0,
  returnsOverTime: [],
  periodChange: 0,
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  from: undefined,
  to: undefined,
  allTimeReturns: 0,
  suggestions: [],
  error: null,
  revenueRetained: 0,
  exchangeRate: 0,
  greenReturnCount: 0,
  blocklistCount: 0,
  resolutionMap: {} as Record<string, number>,
  revenueAtRisk: 0,
  overdueCount: 0,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  fraudAlertCount: 0,
  fraudAlertReturns: [],
  avgRefundAmount: 0,
  totalRefundAmount: 0,
};

describe("Dashboard <SetupChecklist /> integration", () => {
  it("renders the checklist when at least one step is incomplete", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        setupChecklistData: {
          hasFyndConfig: false,
          hasSmtp: false,
          hasPortalBranding: false,
          hasFirstReturn: false,
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".app-setup-checklist")).toBeTruthy();
    });
    // Heading + required step titles render. SMTP is optional and should not
    // block account setup completion.
    expect(container.textContent).toContain("Finish setting up");
    expect(container.textContent).toContain("Connect Fynd");
    expect(container.textContent).not.toContain("Configure email");
    expect(container.textContent).toContain("Customise the customer portal");
    expect(container.textContent).toContain("Process your first return");
  });

  it("auto-hides once every step is done", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        setupChecklistData: {
          hasFyndConfig: true,
          hasSmtp: true,
          hasPortalBranding: true,
          hasFirstReturn: true,
        },
      },
    });
    await waitFor(() => {
      // Dashboard should be rendered
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe("Dashboard");
    });
    expect(container.querySelector(".app-setup-checklist")).toBeNull();
  });

  it("renders a partially-complete checklist with progress count", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        setupChecklistData: {
          hasFyndConfig: true,
          hasSmtp: false,
          hasPortalBranding: false,
          hasFirstReturn: true,
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".app-setup-checklist")).toBeTruthy();
    });
    // SMTP no longer counts toward setup progress, so this is 2 of 3.
    expect(container.textContent).toContain("2 of 3 complete · 67%");
  });

  it("falls back gracefully when setupChecklistData is missing entirely (legacy data shape)", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData, // no setupChecklistData key at all
    });
    await waitFor(() => {
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe("Dashboard");
    });
    // Every required step defaults to undone → checklist renders showing all
    // 3 incomplete. SMTP is optional.
    expect(container.querySelector(".app-setup-checklist")).toBeTruthy();
    expect(container.textContent).toContain("0 of 3 complete · 0%");
  });

  it("each pending step links to its settings page", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        setupChecklistData: {
          hasFyndConfig: false,
          hasSmtp: false,
          hasPortalBranding: false,
          hasFirstReturn: false,
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".app-setup-checklist")).toBeTruthy();
    });
    const links = Array.from(
      container.querySelectorAll(".app-setup-checklist a"),
    ) as HTMLAnchorElement[];
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/app/settings/integrations");
    expect(hrefs).not.toContain("/app/settings/notifications");
    expect(hrefs).toContain("/app/portal");
    expect(hrefs).toContain("/app/returns");
  });
});
