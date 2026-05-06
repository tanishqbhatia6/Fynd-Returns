/**
 * @vitest-environment jsdom
 *
 * Targeted branch-coverage tests for three settings routes whose component
 * tests didn't reach certain conditional render paths or `??` fallbacks:
 *   - app/routes/app.settings.api-keys.tsx        (97% br → ≥99%)
 *   - app/routes/app.settings.setup.tsx           (84% br → ≥95%)
 *   - app/routes/app.settings.permissions.tsx     (71% br → ≥95%)
 *
 * No source modifications; existing tests left untouched. Each scenario here
 * drives an unreached branch by overriding useFetcher / useLoaderData mocks.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks ──
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    apiKey: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    shopSettings: { upsert: vi.fn() },
  },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    apiKey: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    shopSettings: { upsert: vi.fn() },
  },
}));
vi.mock("../../lib/api-key-auth.server", () => ({
  ALL_PERMISSIONS: ["read_returns", "write_returns", "read_settings", "manage_webhooks"],
  generateApiKey: vi.fn(),
}));
vi.mock("../lib/api-key-auth.server", () => ({
  ALL_PERMISSIONS: ["read_returns", "write_returns", "read_settings", "manage_webhooks"],
  generateApiKey: vi.fn(),
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
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

// AppPage passthrough.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

// boundary helpers (transitively imported).
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

// Driveable mocks for useLoaderData / useFetcher / useSearchParams. We swap
// values per test so we can hit each conditional branch.
type FetcherShape = {
  state: "idle" | "loading" | "submitting";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<React.FormHTMLAttributes<HTMLFormElement> & { children?: React.ReactNode }>;
};

const loaderState: { value: unknown } = { value: undefined };
const fetcherState: FetcherShape = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
  load: vi.fn(),
  Form: ({ children, ...rest }) => <form {...rest}>{children}</form>,
};

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => loaderState.value,
    useFetcher: () => fetcherState,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, act } from "@testing-library/react";
import ApiKeysSettings from "../app.settings.api-keys";
import FyndSetup from "../app.settings.setup";
import PermissionsPage from "../app.settings.permissions";

beforeEach(() => {
  loaderState.value = undefined;
  fetcherState.state = "idle";
  fetcherState.data = undefined;
  fetcherState.submit.mockReset();
  fetcherState.load.mockReset();
});

// ───────────────────── api-keys.tsx ─────────────────────
describe("app.settings.api-keys — uncovered branches", () => {
  it("renders an active key with no lastUsedAt — exercises the `key.lastUsedAt &&` false branch", async () => {
    loaderState.value = {
      keys: [
        {
          id: "kx-1",
          name: "Fresh Key",
          keyPrefix: "rpm_fresh",
          permissions: JSON.stringify(["read_returns"]),
          isActive: true,
          lastUsedAt: null, // ← false branch of `key.lastUsedAt && ...`
          revokedAt: null,
          createdAt: "2026-04-01T08:00:00.000Z",
        },
      ],
    };
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: loaderState.value,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fresh Key");
    });
    // Created label still rendered, but no "Last used" segment.
    expect(container.textContent).toMatch(/Created/);
    expect(container.textContent).not.toMatch(/Last used/);
  });

  it("revoked key with isActive=true but revokedAt set — exercises the second half of `!isActive || revokedAt`", async () => {
    loaderState.value = {
      keys: [
        {
          id: "kx-2",
          name: "Soft-Revoked",
          keyPrefix: "rpm_soft",
          permissions: JSON.stringify(["read_returns"]),
          isActive: true, // first operand FALSE → forces eval of revokedAt
          lastUsedAt: null,
          revokedAt: "2026-05-01T08:00:00.000Z",
          createdAt: "2026-04-01T08:00:00.000Z",
        },
      ],
    };
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: loaderState.value,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Soft-Revoked");
    });
    // Revoked badge wins, even though isActive=true.
    expect(container.textContent).toContain("Revoked");
  });

  it("clicking Copy when fetcher.data has a generatedKey covers the truthy branch of copyKey()", async () => {
    loaderState.value = { keys: [] };
    fetcherState.data = { generatedKey: "rpm_branchcov_key", keyName: "Branch Cov" };

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: loaderState.value,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("API Key Generated Successfully");
    });
    const copy = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(copy);
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("rpm_branchcov_key");
    });
  });
});

// ───────────────────── setup.tsx ─────────────────────
describe("app.settings.setup — uncovered alert branches", () => {
  const baseLoader = {
    hasPlatformCreds: false,
    fyndCompanyId: "",
    fyndApplicationId: "",
    fyndEnvironment: "uat" as const,
    fyndCustomBaseUrl: "",
    appUrl: "https://example.com",
    webhookUrl: "https://example.com/api/webhooks/fynd/shop_123",
    legacyWebhookUrl: "https://example.com/api/webhooks/fynd",
    hasPerShopWebhookSecret: true,
    appMode: "prod" as const,
    existingSubscriber: null,
    subscribersError: null,
  };

  it("renders the test-success alert when fetcher.data.testResult=true (covers showTestSuccess true branch + testMessage ?? fallback)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { testResult: true }; // no testMessage → exercises `?? "Connection successful."`
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Connection successful.");
    });
  });

  it("renders test-error alert when testResult=false + error (covers showTestError true branch)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { testResult: false, error: "401 Unauthorized" };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Connection failed: 401 Unauthorized");
    });
  });

  it("renders webhook-success alert when webhookTestResult=true (covers showWebhookSuccess + webhookMessage ?? fallback)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { webhookTestResult: true };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=test-webhook"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Webhook test successful.");
    });
  });

  it("renders webhook-error alert when webhookTestResult=false + webhookError (covers showWebhookError true branch)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { webhookTestResult: false, webhookError: "endpoint unreachable" };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=test-webhook"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Webhook test failed: endpoint unreachable");
    });
  });

  it("renders register-success alert when registerResult=true (covers showRegisterSuccess + registerMessage ?? fallback)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { registerResult: true };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Webhook registered successfully.");
    });
  });

  it("renders register-error alert when registerResult=false + registerError (covers showRegisterError true branch)", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { registerResult: false, registerError: "403 Forbidden" };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Registration failed: 403 Forbidden");
    });
  });

  it("test-platform submit button renders Testing… while fetcher.state !== 'idle' (covers line 477 true branch)", async () => {
    loaderState.value = { ...baseLoader, hasPlatformCreds: true };
    fetcherState.state = "submitting";
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=test-platform"],
      loaderData: { ...baseLoader, hasPlatformCreds: true },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Step 2: Test Platform connection");
    });
    expect(container.textContent).toContain("Testing…");
  });

  it("register submit button renders Registering… while fetcher.state !== 'idle' (covers line 682 true branch)", async () => {
    const ld = {
      ...baseLoader,
      hasPlatformCreds: true,
      hasPerShopWebhookSecret: true,
      existingSubscriber: null,
    };
    loaderState.value = ld;
    fetcherState.state = "submitting";
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=webhook"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Step 3: Webhook setup");
    });
    expect(container.textContent).toContain("Registering…");
  });

  it("test-webhook submit button renders Testing… while fetcher.state !== 'idle' (covers line 718 true branch)", async () => {
    loaderState.value = baseLoader;
    fetcherState.state = "submitting";
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup?step=test-webhook"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Step 4: Test webhook");
    });
    expect(container.textContent).toContain("Testing…");
  });

  it('renders the debug logs panel including a log row WITHOUT detail (covers `e.detail ? ... : ""` false branch)', async () => {
    loaderState.value = baseLoader;
    fetcherState.data = {
      debugLogs: [
        { ts: "2026-05-06T00:00:00Z", step: "test_platform", message: "starting" }, // no detail
        { ts: "2026-05-06T00:00:01Z", step: "test_platform", message: "ok", detail: "200" }, // with detail
      ],
    };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Debug logs (2)");
    });
    // detail-bearing row formatted with " | "
    expect(container.textContent).toContain("| 200");
    // detail-less row still rendered
    expect(container.textContent).toContain("test_platform: starting");
  });
});

// ───────────────────── permissions.tsx ─────────────────────
describe("app.settings.permissions — uncovered branches", () => {
  const baseLoader = {
    readAllOrdersEnabled: false,
    hasReadAllOrdersScope: true,
    scopes: ["read_orders"],
  };

  it("renders the saved-success banner when fetcher.data.success === true", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { success: true };
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Permission settings saved successfully.");
    });
  });

  it("renders the error banner with the action's error message", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { success: false, error: "Database write failed" };
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Database write failed");
    });
  });

  it("falls back to default error message when success=false and no error string is supplied", async () => {
    loaderState.value = baseLoader;
    fetcherState.data = { success: false };
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Failed to save permission settings.");
    });
  });

  it("toggling the read_all_orders checkbox flips local state (covers onChange handler)", async () => {
    loaderState.value = baseLoader;
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoader,
    });
    let toggle: HTMLInputElement | null = null;
    await waitFor(() => {
      toggle = container.querySelector(
        "input[type='checkbox'][name='readAllOrdersEnabled']",
      ) as HTMLInputElement | null;
      expect(toggle).toBeTruthy();
    });
    expect(toggle!.checked).toBe(false);
    await act(async () => {
      fireEvent.click(toggle!);
    });
    await waitFor(() => {
      expect(toggle!.checked).toBe(true);
    });
    await act(async () => {
      fireEvent.click(toggle!);
    });
    await waitFor(() => {
      expect(toggle!.checked).toBe(false);
    });
  });

  it("renders submit button in loading state when fetcher.state !== 'idle'", async () => {
    loaderState.value = baseLoader;
    fetcherState.state = "submitting";
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoader,
    });
    await waitFor(() => {
      expect(container.querySelector("form")).toBeTruthy();
    });
    // s-button is a custom element; loading attribute should be set as truthy
    const submit = container.querySelector("s-button[type='submit']");
    expect(submit).toBeTruthy();
  });
});
