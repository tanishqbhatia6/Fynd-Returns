/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.permissions.tsx ──
// The route imports shopify.server / db.server / lib/shop.server purely for
// the loader/action. Stub them so importing the component in jsdom doesn't
// crash on Node-only deps.
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
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
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
import PermissionsPage from "../app.settings.permissions";

const baseLoaderData = {
  readAllOrdersEnabled: false,
  hasReadAllOrdersScope: true,
  scopes: ["read_orders", "read_all_orders"],
};

describe("Permissions page (default export)", () => {
  it("renders the page heading", async () => {
    const { findByText } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Permissions")).toBeTruthy();
  });

  it("renders the read_all_orders toggle as a checkbox", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[type='checkbox'][name='readAllOrdersEnabled']"),
      ).toBeTruthy();
    });
    const toggle = container.querySelector(
      "input[type='checkbox'][name='readAllOrdersEnabled']",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("starts the toggle in the checked state when readAllOrdersEnabled=true", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: { ...baseLoaderData, readAllOrdersEnabled: true },
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[type='checkbox'][name='readAllOrdersEnabled']"),
      ).toBeTruthy();
    });
    const toggle = container.querySelector(
      "input[type='checkbox'][name='readAllOrdersEnabled']",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("shows the success scope status when hasReadAllOrdersScope=true", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Scope is configured in your app environment/i);
    });
    expect(container.textContent).not.toMatch(
      /Add .*read_all_orders.* to your SCOPES environment variable/i,
    );
  });

  it("shows the warning banner when hasReadAllOrdersScope=false", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: { ...baseLoaderData, hasReadAllOrdersScope: false },
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(
        /Add .*read_all_orders.* to your SCOPES environment variable/i,
      );
    });
    expect(container.textContent).not.toMatch(/Scope is configured in your app environment/i);
  });

  it("renders the explanatory copy describing why broader access is needed", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Extended return windows/i);
    });
    expect(container.textContent).toMatch(/Historical analytics/i);
    expect(container.textContent).toMatch(/Retroactive policy changes/i);
  });

  it("renders Save and Discard actions, with Discard linking back to settings", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("form")).toBeTruthy();
    });
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");

    const discardLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings",
    );
    expect(discardLink).toBeTruthy();
  });
});
