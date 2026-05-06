/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.tsx ──
// The component pulls in shopify.server / db.server / lib/* purely for the
// loader and (transitively) module-evaluation side effects. Stub them so
// importing the component in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    returnCase: { count: vi.fn() },
  },
}));
vi.mock("../lib/fynd-config.server", () => ({
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../lib/shop.server", () => ({
  syncShopLocaleAndCurrency: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
vi.mock("../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
}));

// AppProvider from @shopify/shopify-app-react-router/react expects to be
// inside an embedded Shopify host. Replace with a passthrough so children
// render in jsdom.
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-provider">{children}</div>
  ),
}));

// boundary helpers from the server entry are used by ErrorBoundary/headers,
// not by the default-exported App component, but the import is hoisted at
// module load so we stub it.
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
  // shopifyApp is referenced when app/shopify.server.ts is evaluated, even
  // though we mock the module — vitest still resolves nested deps in some
  // cases. Provide a stub factory so the import never throws.
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
import App from "../app";

const baseLoaderData = {
  apiKey: "test-api-key",
  shopDomain: "test-shop.myshopify.com",
  portalUrl: "https://test-shop.myshopify.com/apps/returns",
  appMode: "prod" as const,
  pendingCount: 0,
  adminSoundEnabled: false,
};

describe("App layout (default export)", () => {
  it("renders the navigation links inside AppProvider", async () => {
    const { container, findByTestId } = renderWithRouter(App, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    expect(await findByTestId("app-provider")).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector("s-app-nav")).toBeTruthy();
    });
    const nav = container.querySelector("s-app-nav");
    const links = nav?.querySelectorAll("s-link") ?? [];
    expect(links.length).toBe(7);
    const labels = Array.from(links).map((l) => l.textContent?.trim());
    expect(labels).toEqual(
      expect.arrayContaining([
        "Dashboard",
        "Customers",
        "Analytics",
        "Settings",
        "Customer Portal",
        "Documentation",
      ]),
    );
  });

  it("does not render a breadcrumb on the dashboard route", async () => {
    const { container } = renderWithRouter(App, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("s-app-nav")).toBeTruthy();
    });
    const breadcrumbDashboard = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent === "Dashboard",
    );
    expect(breadcrumbDashboard).toBeFalsy();
  });

  it("renders a breadcrumb when on a sub-route", async () => {
    const { container } = renderWithRouter(App, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const anchors = Array.from(container.querySelectorAll("a"));
      expect(
        anchors.find(
          (a) => a.getAttribute("href") === "/app" && a.textContent?.trim() === "Dashboard",
        ),
      ).toBeTruthy();
    });
    expect(container.textContent).toContain("Returns");
  });

  it("appends the pending-count badge to the Returns link when > 0", async () => {
    const { container } = renderWithRouter(App, {
      initialEntries: ["/app"],
      loaderData: { ...baseLoaderData, pendingCount: 4 },
    });
    await waitFor(() => {
      const returnsLink = Array.from(container.querySelectorAll("s-link")).find(
        (l) => l.getAttribute("href") === "/app/returns",
      );
      expect(returnsLink?.textContent).toContain("Returns (4)");
    });
  });

  it("shows the dev-mode banner with a 'Switch to Prod' link when appMode is dev", async () => {
    const { container, findByText } = renderWithRouter(App, {
      initialEntries: ["/app"],
      loaderData: { ...baseLoaderData, appMode: "dev" as const },
    });
    expect(await findByText(/Dev mode/i)).toBeTruthy();
    const switchLink = container.querySelector("a[href='/app/settings/integrations']");
    expect(switchLink?.textContent).toMatch(/Switch to Prod/i);
  });

  it("does not show the dev-mode banner when appMode is prod", async () => {
    const { container } = renderWithRouter(App, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("s-app-nav")).toBeTruthy();
    });
    expect(container.textContent).not.toMatch(/Dev mode/i);
  });
});
