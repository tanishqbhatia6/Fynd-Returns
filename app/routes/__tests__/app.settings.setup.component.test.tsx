/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.setup.tsx ──
// The route pulls in shopify.server / db.server / lib/* purely for the
// loader/action. Stub them so importing the component in jsdom doesn't crash
// on Node-only deps.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));
vi.mock("../../lib/fynd.server", () => ({
  getNormalizedCredentialsFromRaw: vi.fn(() => null),
  testPlatformConnectionRaw: vi.fn(),
}));
vi.mock("../../lib/fynd-logger.server", () => ({
  createFyndLogger: vi.fn(() => ({ logs: [], log: vi.fn() })),
}));
vi.mock("../../lib/fynd-config.server", () => ({
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: vi.fn(),
}));
vi.mock("../../lib/fynd-webhook-api.server", () => ({
  listFyndWebhookSubscribers: vi.fn(),
  findSubscriberWithUrl: vi.fn(),
  registerFyndWebhook: vi.fn(),
}));

// AppPage shouldn't pull in embedded-Shopify host machinery during test —
// passthrough render the heading + children.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({
    heading,
    children,
  }: {
    heading: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import FyndSetup from "../app.settings.setup";

const baseLoaderData = {
  hasPlatformCreds: false,
  fyndCompanyId: "",
  fyndApplicationId: "",
  fyndEnvironment: "uat" as const,
  fyndCustomBaseUrl: "",
  appUrl: "https://example.com",
  webhookUrl: "https://example.com/api/webhooks/fynd/shop_123",
  legacyWebhookUrl: "https://example.com/api/webhooks/fynd",
  hasPerShopWebhookSecret: false,
  appMode: "prod" as const,
  existingSubscriber: null,
  subscribersError: null,
};

describe("FyndSetup (default export) — guided setup wizard", () => {
  it("renders inside the AppPage wrapper with the Fynd Setup heading", async () => {
    const { findByTestId } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("Fynd Setup");
  });

  it("renders all five step indicator buttons", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim() ?? "");
    expect(labels.some((l) => l.includes("Fynd credentials"))).toBe(true);
    expect(labels.some((l) => l.includes("Test connection"))).toBe(true);
    expect(labels.some((l) => l.includes("Webhook setup"))).toBe(true);
    expect(labels.some((l) => l.includes("Test webhook"))).toBe(true);
    expect(labels.some((l) => l.includes("All set"))).toBe(true);
  });

  it("defaults to the credentials step and renders its documentation", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Step 1: Fynd credentials");
    });
    expect(container.textContent).toContain("Company ID");
    expect(container.textContent).toContain("Application ID");
    expect(container.textContent).toContain("Client ID");
  });

  it("shows the credentials-configured confirmation when hasPlatformCreds is true", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: { ...baseLoaderData, hasPlatformCreds: true },
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Credentials configured. Continue to Step 2.",
      );
    });
  });

  it("renders the per-shop webhook URL on the webhook step", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: { ...baseLoaderData, hasPerShopWebhookSecret: true },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Step 3: Webhook setup");
    });
    expect(container.textContent).toContain(
      "https://example.com/api/webhooks/fynd/shop_123",
    );
  });

  it("warns the merchant to generate a per-shop webhook secret first", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: { ...baseLoaderData, hasPerShopWebhookSecret: false },
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "You need to generate a webhook signing secret first.",
      );
    });
  });

  it("surfaces an existing webhook subscriber when one is detected", async () => {
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: {
        ...baseLoaderData,
        hasPerShopWebhookSecret: true,
        existingSubscriber: {
          name: "Fynd Returns",
          webhook_url: "https://example.com/api/webhooks/fynd/shop_123",
        },
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Webhook already subscribed");
    });
    expect(container.textContent).toContain("Fynd Returns");
  });

  it("renders the test-webhook step and the setup-complete step on demand", async () => {
    const { container: testWebhookContainer } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=test-webhook"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(testWebhookContainer.textContent).toContain(
        "Step 4: Test webhook",
      );
    });

    const { container: doneContainer } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=done"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(doneContainer.textContent).toContain("Setup complete");
    });
    expect(doneContainer.textContent).toContain(
      "Fynd integration is ready",
    );
  });
});
