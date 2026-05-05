/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.integrations.tsx ──
// The component pulls in shopify.server / db.server / lib/* purely for the
// loader/action; stub them so importing the component in jsdom doesn't crash
// on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    shopSettings: { upsert: vi.fn() },
  },
}));
vi.mock("../lib/encryption.server", () => ({
  encrypt: vi.fn((s: string) => s),
  decryptIfEncrypted: vi.fn((s: string) => s),
  encryptIfNeeded: vi.fn((s: string) => s),
}));
vi.mock("../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
  getNormalizedCredentialsFromRaw: vi.fn(() => null),
  testPlatformConnectionRaw: vi.fn(),
}));
vi.mock("../lib/fynd-logger.server", () => ({
  createFyndLogger: vi.fn(() => ({ logs: [], log: vi.fn() })),
}));
vi.mock("../lib/fynd-config.server", () => ({
  FYND_ENVIRONMENTS: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../lib/credential-validation.server", () => ({
  sanitizeCredentialInputs: vi.fn(() => ({ valid: true, sanitized: {} })),
}));

// boundary helpers from the server entry are used by ErrorBoundary/headers,
// not the default-exported component, but they're hoisted at module load.
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
import Integrations from "../app.settings.integrations";

const baseLoaderData = {
  fyndApiType: "platform",
  fyndEnvironment: "uat",
  policy: {
    returnWindowDays: 30,
    allowExchange: false,
    minOrderValue: 0,
    refundMethods: ["original_payment", "store_credit"],
    defaultRefundMethod: "original_payment",
    excludedTags: [],
    allowedCategories: [],
    restockFeePercent: 0,
  },
  fyndCustomBaseUrl: "",
  appMode: "prod" as const,
  fyndCompanyId: "2263",
  fyndApplicationId: "67a09b70c8ea7c9123f00fab",
  // Masked credentials sentinel — never echo plaintext to the client.
  fyndCredentials: "[configured]",
  hasPlatformCreds: true,
  hasStorefrontCreds: false,
  policyJson: "{}",
  fyndEnvironments: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  gorgiasEnabled: false,
  // Masked sentinel — real value never sent down.
  gorgiasApiKey: "__UNCHANGED__",
  gorgiasWidgetUrl: "https://app.example.com/api/integrations/gorgias?shop=test-shop.myshopify.com",
  fyndWebhookSecretConfigured: true,
  fyndWebhookUrl: "https://app.example.com/api/webhooks/fynd/shop_123",
  fyndWebhookSecretJustGenerated: undefined,
};

describe("Integrations settings (default export)", () => {
  it("renders the 'Partner Integrations' heading", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Partner Integrations");
    });
  });

  it("renders the Fynd Commerce Webhook section with the per-shop URL", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Commerce Webhook");
    });
    const urlInput = container.querySelector(
      "input[aria-label='Per-shop Fynd webhook URL']",
    ) as HTMLInputElement | null;
    expect(urlInput).toBeTruthy();
    expect(urlInput?.value).toBe(baseLoaderData.fyndWebhookUrl);
  });

  it("shows 'Secret configured' status when fyndWebhookSecretConfigured is true", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Commerce Webhook");
    });
    expect(container.textContent).toContain("Secret configured");
    // The action button switches to 'Rotate' when a secret is already configured.
    const rotateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rotate webhook secret"),
    );
    expect(rotateBtn).toBeTruthy();
  });

  it("shows 'Secret not generated' and a Generate button when no secret is configured", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: { ...baseLoaderData, fyndWebhookSecretConfigured: false },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fynd Commerce Webhook");
    });
    expect(container.textContent).toContain("Secret not generated");
    const generateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Generate webhook secret"),
    );
    expect(generateBtn).toBeTruthy();
  });

  it("renders the configured-credentials confirmation when fyndCredentials is the masked sentinel", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Platform credentials configured");
    });
    // The plaintext "[configured]" sentinel itself never appears to the user.
    expect(container.textContent).not.toContain("[configured]");
    // Pre-filled non-secret identifiers do appear.
    const companyInput = container.querySelector(
      "input[name='fyndCompanyId']",
    ) as HTMLInputElement | null;
    expect(companyInput?.defaultValue ?? companyInput?.value).toBe("2263");
    // Client Secret field is rendered but always blank — never populated from state.
    const secretInput = container.querySelector(
      "input[name='fyndClientSecret']",
    ) as HTMLInputElement | null;
    expect(secretInput).toBeTruthy();
    expect(secretInput?.getAttribute("type")).toBe("password");
    expect(secretInput?.value).toBe("");
  });

  it("renders the Gorgias integration section with the masked api-key sentinel and widget URL", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Gorgias Helpdesk Integration");
    });
    const apiKeyInput = container.querySelector(
      "input[name='gorgiasApiKey']",
    ) as HTMLInputElement | null;
    expect(apiKeyInput).toBeTruthy();
    expect(apiKeyInput?.defaultValue ?? apiKeyInput?.value).toBe("__UNCHANGED__");
    // Widget URL is shown as a readonly input pre-populated from the loader.
    const widgetUrlInput = Array.from(
      container.querySelectorAll("input[readonly]"),
    ).find(
      (el) => (el as HTMLInputElement).value === baseLoaderData.gorgiasWidgetUrl,
    ) as HTMLInputElement | undefined;
    expect(widgetUrlInput).toBeTruthy();
  });

  it("renders the App Mode and Fynd Environment radio groups", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll("input[type='radio'][name='appMode']").length,
      ).toBe(2);
    });
    const appModeRadios = container.querySelectorAll(
      "input[type='radio'][name='appMode']",
    );
    expect(appModeRadios.length).toBe(2);
    const envRadios = container.querySelectorAll(
      "input[type='radio'][name='fyndEnvironment']",
    );
    expect(envRadios.length).toBe(2);
    // Loader sets appMode=prod, fyndEnvironment=uat — the matching radios are checked.
    expect(
      (container.querySelector(
        "input[type='radio'][name='appMode'][value='prod']",
      ) as HTMLInputElement | null)?.checked,
    ).toBe(true);
    expect(
      (container.querySelector(
        "input[type='radio'][name='fyndEnvironment'][value='uat']",
      ) as HTMLInputElement | null)?.checked,
    ).toBe(true);
  });

  it("renders the policy defaults inside the Advanced Policy details", async () => {
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[name='policyReturnWindowDays']")).toBeTruthy();
    });
    const windowInput = container.querySelector(
      "input[name='policyReturnWindowDays']",
    ) as HTMLInputElement | null;
    expect(windowInput?.defaultValue ?? windowInput?.value).toBe("30");
    const restockInput = container.querySelector(
      "input[name='policyRestockFeePercent']",
    ) as HTMLInputElement | null;
    expect(restockInput?.defaultValue ?? restockInput?.value).toBe("0");
  });
});
