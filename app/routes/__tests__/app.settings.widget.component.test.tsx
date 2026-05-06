/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.widget.tsx ──
// The route pulls in shopify.server / db.server / lib/*.server purely for the
// loader and (transitively) module-evaluation side effects. Stub them so
// importing the component in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
    shop: { findUnique: vi.fn() },
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
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
import { waitFor, fireEvent } from "@testing-library/react";
import { DEFAULT_PORTAL_THEME, FONT_OPTIONS } from "../../lib/portal-theme.server";
import { SUPPORTED_LANGUAGES, DEFAULT_LABELS } from "../../lib/portal-i18n";
import Widget from "../app.settings.widget";

const baseLoaderData = {
  portalTheme: { ...DEFAULT_PORTAL_THEME },
  portalConfig: {
    showOrderTracking: true,
    showReturnTracking: true,
    showCreateReturnTab: true,
    defaultTab: "return" as const,
    allowMediaUploads: true,
    allowReturnCancellation: true,
  },
  fontOptions: FONT_OPTIONS,
  portalUrl: "https://test-shop.myshopify.com/apps/returns",
  portalLanguage: "en",
  portalLabelOverrides: {} as Record<string, string>,
  resolvedLabels: { ...DEFAULT_LABELS },
  labelKeys: Object.keys(DEFAULT_LABELS),
  supportedLanguages: SUPPORTED_LANGUAGES,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  brandLogoUrl: null,
  brandFaviconUrl: null,
};

describe("app.settings.widget component (default export)", () => {
  it("renders the page heading", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Assure Return Widget");
    });
  });

  it("renders the primary color picker with the default theme value", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const primary = container.querySelector(
        'input[type="color"][name="primaryColor"]',
      ) as HTMLInputElement | null;
      expect(primary).toBeTruthy();
      expect(primary?.defaultValue).toBe(DEFAULT_PORTAL_THEME.primaryColor);
    });
    // Background + surface color pickers should also exist
    expect(container.querySelector('input[type="color"][name="backgroundColor"]')).toBeTruthy();
    expect(container.querySelector('input[type="color"][name="surfaceColor"]')).toBeTruthy();
  });

  it("renders the language selector with all supported languages", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const select = container.querySelector(
        'select[name="portalLanguage"]',
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
    });
    const select = container.querySelector('select[name="portalLanguage"]') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.length).toBe(SUPPORTED_LANGUAGES.length);
    const codes = options.map((o) => o.value);
    expect(codes).toEqual(expect.arrayContaining(["en", "es", "fr", "de", "hi", "ja"]));
  });

  it("renders the font-family selector populated from FONT_OPTIONS", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const select = container.querySelector(
        'select[name="fontFamily"]',
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
    });
    const select = container.querySelector('select[name="fontFamily"]') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    expect(options.length).toBe(FONT_OPTIONS.length);
  });

  it("renders the default-tab selector with the loader-provided value", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        portalConfig: { ...baseLoaderData.portalConfig, defaultTab: "create" as const },
      },
    });
    await waitFor(() => {
      const select = container.querySelector(
        'select[name="defaultTab"]',
      ) as HTMLSelectElement | null;
      expect(select).toBeTruthy();
    });
    const select = container.querySelector('select[name="defaultTab"]') as HTMLSelectElement;
    expect(select.querySelectorAll("option").length).toBe(3);
    // Component renders defaultValue, which jsdom reflects via .value
    expect(select.value).toBe("create");
  });

  it("shows the auto-detected locale/currency/timezone banner", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        shopLocale: "fr",
        shopCurrency: "EUR",
        shopTimezone: "Europe/Paris",
      },
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Auto-detected from Shopify/i);
    });
    expect(container.textContent).toContain("fr");
    expect(container.textContent).toContain("EUR");
    expect(container.textContent).toContain("Europe/Paris");
  });

  it("toggles the custom-labels editor when the trigger is clicked", async () => {
    const { container, findByText } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    const trigger = await findByText(/Customize label text/i);
    expect(trigger).toBeTruthy();
    // Editor not yet rendered — no inputs with placeholder = a default label
    const firstKey = Object.keys(DEFAULT_LABELS)[0];
    const firstDefault = DEFAULT_LABELS[firstKey];
    expect(container.querySelector(`input[placeholder="${cssEscape(firstDefault)}"]`)).toBeFalsy();
    fireEvent.click(trigger);
    await waitFor(() => {
      const inputs = container.querySelectorAll('input[type="text"].app-input');
      expect(inputs.length).toBeGreaterThan(0);
    });
  });

  it("renders the Save / Discard / Preview portal action buttons", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const actions = container.querySelector(".app-actions");
      expect(actions).toBeTruthy();
    });
    const text = container.querySelector(".app-actions")?.textContent ?? "";
    expect(text).toMatch(/Save/);
    expect(text).toMatch(/Discard/);
    expect(text).toMatch(/Preview portal/);
    const previewLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === baseLoaderData.portalUrl,
    );
    expect(previewLink).toBeTruthy();
    expect(previewLink?.getAttribute("target")).toBe("_blank");
  });
});

/**
 * Minimal CSS.escape polyfill for attribute selectors that contain quotes,
 * commas, etc. — DEFAULT_LABELS strings can include arbitrary punctuation.
 */
function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}
