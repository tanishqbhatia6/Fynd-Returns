// @vitest-environment jsdom
/**
 * @vitest-environment jsdom
 *
 * Coverage closure for app.settings.auto-rules.tsx — covers the rule-row
 * "Remove" click handler (lines 151 + 233) which the existing component
 * tests have skipped.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: { shopSettings: { upsert: vi.fn() } },
}));
vi.mock("../../db.server", () => ({
  default: { shopSettings: { upsert: vi.fn() } },
}));
vi.mock("../lib/shop.server", () => ({ findOrCreateShop: vi.fn() }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: vi.fn() }));
vi.mock("../lib/auto-approve.server", () => ({
  parseAutoApproveRules: vi.fn(() => []),
}));
vi.mock("../../lib/auto-approve.server", () => ({
  parseAutoApproveRules: vi.fn(() => []),
}));

const mockLoaderState: { value: unknown } = { value: undefined };
type MockFetcherState = {
  state: "idle" | "loading" | "submitting";
  data: { success?: boolean; error?: string } | undefined;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>>;
};
const mockFetcher: MockFetcherState = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
  load: vi.fn(),
  Form: ({ children, ...props }) => <form {...props}>{children}</form>,
};
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => mockLoaderState.value,
    useFetcher: () => mockFetcher,
  };
});

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

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent } from "@testing-library/react";
import AutoApproveRulesSettings from "../app.settings.auto-rules";

const populatedLoader = {
  rules: [
    { field: "orderValue", operator: "lte", value: "50", action: "approve" },
    {
      field: "fraudRiskScore",
      operator: "gte",
      value: "80",
      action: "manual_review",
    },
  ],
  autoApproveEnabled: true,
};

beforeEach(() => {
  mockLoaderState.value = populatedLoader;
  mockFetcher.state = "idle";
  mockFetcher.data = undefined;
  mockFetcher.submit.mockReset();
  mockFetcher.load.mockReset();
});

describe("app.settings.auto-rules — coverage closure", () => {
  it("removes a rule when its 'Remove' button is clicked (lines 151, 233)", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
    // Only one Remove button should remain after removal.
    const remaining = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(remaining.length).toBe(1);
  });
});
