/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.portal.tsx ──
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
import PortalInfo from "../app.portal";
import { DEFAULT_PORTAL_THEME } from "../../lib/portal-theme.server";

const defaultTheme = { ...DEFAULT_PORTAL_THEME };
const defaultConfig = {
  showOrderTracking: true,
  showReturnTracking: true,
  showCreateReturnTab: true,
  defaultTab: "return" as const,
  allowMediaUploads: true,
  allowReturnCancellation: true,
};

const baseLoaderData = {
  portalUrl: "https://test-shop.myshopify.com/apps/returns",
  storeName: "test-shop",
  hasTheme: true,
  theme: defaultTheme,
  config: defaultConfig,
  totalReturns: 12,
  activeReturns: 3,
};

describe("App portal (default export)", () => {
  it("renders the page heading 'Customer Portal'", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-page-title")?.textContent).toBe(
        "Customer Portal",
      );
    });
  });

  it("renders the portal URL from loader data", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "https://test-shop.myshopify.com/apps/returns",
      );
    });
  });

  it("renders an 'Open portal' anchor pointing to the portal URL", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const anchors = Array.from(container.querySelectorAll("a"));
      const openLink = anchors.find(
        (a) => a.getAttribute("href") === baseLoaderData.portalUrl,
      );
      expect(openLink).toBeTruthy();
      expect(openLink?.getAttribute("target")).toBe("_blank");
    });
  });

  it("renders the active and total returns counts", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Active returns");
      expect(container.textContent).toContain("Total returns");
      // active count
      expect(container.textContent).toMatch(/3/);
      // total count
      expect(container.textContent).toMatch(/12/);
    });
  });

  it("renders the portal preview block with the heading 'Returns & Exchanges'", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Portal preview");
      expect(container.textContent).toContain("Returns & Exchanges");
    });
  });

  it("lists the enabled sections from config (Order tracking / Return tracking / Create return)", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Order tracking");
      expect(container.textContent).toContain("Return tracking");
      expect(container.textContent).toContain("Create return");
    });
  });

  it("shows 'No sections enabled' when config disables every tab", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: {
        ...baseLoaderData,
        config: {
          ...defaultConfig,
          showOrderTracking: false,
          showReturnTracking: false,
          showCreateReturnTab: false,
        },
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No sections enabled");
    });
  });

  it("renders the Setup checklist with the right completion ratio when hasTheme is false", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: { ...baseLoaderData, hasTheme: false },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Setup checklist");
      // hasTheme=false → 2 of 3 done (return reasons + sections enabled).
      expect(container.textContent).toContain("2/3");
    });
  });
});
