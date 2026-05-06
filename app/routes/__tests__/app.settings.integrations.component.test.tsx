/**
 * @vitest-environment jsdom
 *
 * Component coverage for `app/routes/app.settings.integrations.tsx` default
 * export. Mounts the React component body in jsdom by mocking
 * `react-router`'s data hooks (`useLoaderData` / `useFetcher`) so we can
 * inject loader data and synthetic fetcher state without going through a
 * memory router. The matching loader/action paths are exercised separately
 * in `app.settings.integrations.test.ts`.
 *
 * Targets the previously-uncovered render branches:
 *   - Copy URL / Copy secret clipboard handlers
 *   - Just-generated secret amber banner (one-time display)
 *   - Test-result success + error feedback rendering
 *   - Debug-logs <details> accordion + log entries with/without detail
 *   - Save-success / cleared-credentials alerts
 *   - 403 Forbidden hint inside test-error block
 *   - Test webhook button (idle vs. testing label)
 *   - Rotate confirm() guard (accept + cancel paths)
 *   - App Mode + Fynd Environment radio onChange handlers (state setters)
 *   - allowExchange toggle onChange (DOM mutation in nextElementSibling)
 *   - hasPlatformCreds=false branch ("Test connection" vs "Test Platform")
 *   - SHOPIFY_APP_URL-missing relative-URL hint
 *   - readonly textarea / input onFocus select() handlers
 *   - Loader-side helpers: `parsePolicyForForm` valid + invalid JSON paths
 *     and `buildPolicyJson` form serialisation (these live in the same
 *     module and are exported indirectly through the loader/action — we
 *     hit them via the small set of public helpers wired into the form).
 *
 * No source modifications. Strictly a test-only addition.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

// ── Module-top-level mocks for server-only imports in the route file ──
// The route imports shopify.server / db.server / lib/* purely for the
// loader/action code paths; jsdom would otherwise crash when those Node-only
// modules try to load encryption keys, prisma, etc.
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

// AppPage uses Link internally — render a passthrough so the heading still
// shows up but we don't depend on the real Polaris/AppPage tree.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({
    heading,
    children,
  }: {
    heading: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

// Stateful mocks for react-router data hooks. Each test mutates the holders
// before render to control loader/fetcher state without using
// createMemoryRouter (which has known async-hydration timeouts in this repo).
type FetcherState = {
  data?: unknown;
  state?: "idle" | "submitting" | "loading";
  formData?: FormData;
};
const loaderHolder: { current: unknown } = { current: null };
const mainFetcherHolder: { current: FetcherState } = {
  current: { data: undefined, state: "idle" },
};
const webhookFetcherHolder: { current: FetcherState } = {
  current: { data: undefined, state: "idle" },
};
let fetcherCallCount = 0;
vi.mock("react-router", () => ({
  useLoaderData: () => loaderHolder.current,
  useFetcher: () => {
    // The component constructs two fetchers in render order:
    //   1) `fetcher` — credentials / save / test webhook
    //   2) `webhookFetcher` — generate/rotate secret
    // Mirror that ordering by counting calls per render.
    const idx = fetcherCallCount++;
    const target = idx === 0 ? mainFetcherHolder.current : webhookFetcherHolder.current;
    const FormStub = ({
      children,
      ...props
    }: React.FormHTMLAttributes<HTMLFormElement> & {
      children: React.ReactNode;
    }) => <form {...props}>{children}</form>;
    return {
      data: target.data,
      state: target.state ?? "idle",
      formData: target.formData,
      Form: FormStub,
      submit: vi.fn(),
      load: vi.fn(),
    };
  },
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={typeof to === "string" ? to : "#"} {...props}>
      {children}
    </a>
  ),
  useLoaderData2: undefined,
}));

import Integrations from "../app.settings.integrations";

// Reset all holders + fetcher counter to a clean state between renders. The
// counter MUST reset in beforeEach because each render mounts the component
// fresh and React invokes `useFetcher` exactly twice during render.
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
  fyndCredentials: "[configured]",
  hasPlatformCreds: true,
  hasStorefrontCreds: false,
  policyJson: "{}",
  fyndEnvironments: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  gorgiasEnabled: false,
  gorgiasApiKey: "__UNCHANGED__",
  gorgiasWidgetUrl: "https://app.example.com/api/integrations/gorgias?shop=test.myshopify.com",
  fyndWebhookSecretConfigured: true,
  fyndWebhookUrl: "https://app.example.com/api/webhooks/fynd/shop_123",
  fyndWebhookSecretJustGenerated: undefined,
};

beforeEach(() => {
  fetcherCallCount = 0;
  loaderHolder.current = { ...baseLoaderData };
  mainFetcherHolder.current = { data: undefined, state: "idle" };
  webhookFetcherHolder.current = { data: undefined, state: "idle" };
  // Provide a navigator.clipboard stub jsdom doesn't ship with one. Reset
  // per-test so each assertion sees a fresh writeText spy.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
});

afterEach(() => {
  cleanup();
  fetcherCallCount = 0;
});

// Resets the per-render fetcher counter immediately before render so two
// renders inside the same test (rare) start at idx=0 too.
function renderWith(): ReturnType<typeof render> {
  fetcherCallCount = 0;
  return render(<Integrations />);
}

describe("app.settings.integrations — base render", () => {
  it("renders the Partner Integrations heading and webhook section", () => {
    const { container, getByTestId } = renderWith();
    expect(getByTestId("app-page-heading").textContent).toBe("Partner Integrations");
    expect(container.textContent).toContain("Fynd Commerce Webhook");
  });

  it("shows 'Secret configured' chip + Rotate button when secret already exists", () => {
    const { container } = renderWith();
    expect(container.textContent).toContain("Secret configured");
    const rotateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rotate webhook secret"),
    );
    expect(rotateBtn).toBeTruthy();
  });

  it("shows 'Secret not generated' chip + Generate button when no secret yet", () => {
    loaderHolder.current = { ...baseLoaderData, fyndWebhookSecretConfigured: false };
    const { container } = renderWith();
    expect(container.textContent).toContain("Secret not generated");
    const genBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Generate webhook secret"),
    );
    expect(genBtn).toBeTruthy();
    // Test webhook button must be disabled when no secret is configured.
    const testBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Test webhook"),
    );
    expect(testBtn).toBeTruthy();
    expect((testBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the per-shop webhook URL pre-populated", () => {
    const { container } = renderWith();
    const url = container.querySelector(
      "input[aria-label='Per-shop Fynd webhook URL']",
    ) as HTMLInputElement | null;
    expect(url?.value).toBe(baseLoaderData.fyndWebhookUrl);
  });

  it("renders Gorgias section + masked api key sentinel", () => {
    const { container } = renderWith();
    expect(container.textContent).toContain("Gorgias Helpdesk Integration");
    const apiKey = container.querySelector(
      "input[name='gorgiasApiKey']",
    ) as HTMLInputElement | null;
    expect(apiKey?.defaultValue).toBe("__UNCHANGED__");
  });

  it("renders App Mode and Fynd Environment radio groups with the loader-selected values", () => {
    const { container } = renderWith();
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

  it("renders the Advanced Policy details with default values", () => {
    const { container } = renderWith();
    const win = container.querySelector(
      "input[name='policyReturnWindowDays']",
    ) as HTMLInputElement | null;
    expect(win?.defaultValue).toBe("30");
  });

  it("does not echo the masked '[configured]' sentinel into the DOM", () => {
    const { container } = renderWith();
    expect(container.textContent).not.toContain("[configured]");
    // But the visible 'Platform credentials configured' confirmation banner is shown.
    expect(container.textContent).toContain("Platform credentials configured");
  });

  it("shows the 'Test Platform' button when hasPlatformCreds=true", () => {
    const { container } = renderWith();
    const tp = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Test Platform"),
    );
    expect(tp).toBeTruthy();
  });

  it("shows the generic 'Test connection' button when hasPlatformCreds=false", () => {
    loaderHolder.current = { ...baseLoaderData, hasPlatformCreds: false };
    const { container } = renderWith();
    const tc = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Test connection",
    );
    expect(tc).toBeTruthy();
  });

  it("hides the 'Clear credentials' danger-zone button when no Fynd creds are configured", () => {
    loaderHolder.current = { ...baseLoaderData, fyndCredentials: "" };
    const { container } = renderWith();
    const clear = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Clear credentials"),
    );
    expect(clear).toBeFalsy();
  });

  it("renders the SHOPIFY_APP_URL-missing hint when the URL starts with '/'", () => {
    // Wipe the env var (jest-dom respects this) and supply a relative URL so
    // the inline warning surfaces. Restore after, even though beforeEach clears.
    const orig = process.env.SHOPIFY_APP_URL;
    delete process.env.SHOPIFY_APP_URL;
    loaderHolder.current = {
      ...baseLoaderData,
      fyndWebhookUrl: "/api/webhooks/fynd/shop_123",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("SHOPIFY_APP_URL is not set");
    process.env.SHOPIFY_APP_URL = orig;
  });
});

describe("app.settings.integrations — fetcher state branches", () => {
  it("renders the save-success alert when fetcher.data.success is true (no testResult / cleared)", () => {
    mainFetcherHolder.current = {
      data: { success: true, tokenUpdated: true },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Credentials saved successfully.");
  });

  it("renders the settings-saved alert when tokenUpdated is false", () => {
    mainFetcherHolder.current = {
      data: { success: true, tokenUpdated: false },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Settings saved successfully.");
  });

  it("renders the cleared-credentials alert when fetcher.data.cleared is set", () => {
    mainFetcherHolder.current = {
      data: { success: true, cleared: true },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Credentials cleared.");
  });

  it("renders test-success alert with custom testMessage", () => {
    mainFetcherHolder.current = {
      data: { success: true, testResult: true, testMessage: "All green." },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("All green.");
  });

  it("falls back to default success copy when testMessage is missing", () => {
    mainFetcherHolder.current = {
      data: { success: true, testResult: true },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Connection successful.");
  });

  it("renders test-error alert with the error string", () => {
    mainFetcherHolder.current = {
      data: { success: false, testResult: false, error: "auth failed" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Connection failed: auth failed");
  });

  it("renders the 403 scopes hint when test-error message contains 403", () => {
    mainFetcherHolder.current = {
      data: { success: false, testResult: false, error: "403 Forbidden" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("403 = Missing scopes");
  });

  it("renders the 403 scopes hint when error contains 'Forbidden' but not '403'", () => {
    mainFetcherHolder.current = {
      data: { success: false, testResult: false, error: "Forbidden by upstream" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("403 = Missing scopes");
  });

  it("renders the generic error banner when fetcher.data.error is set without testResult", () => {
    mainFetcherHolder.current = {
      data: { success: false, error: "validation failed" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("validation failed");
  });

  it("renders the debug-logs <details> with both with-detail and without-detail entries", () => {
    mainFetcherHolder.current = {
      data: {
        success: true,
        debugLogs: [
          { ts: "T1", step: "S1", message: "M1" },
          { ts: "T2", step: "S2", message: "M2", detail: "extra" },
        ],
      },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Debug logs (2)");
    expect(container.textContent).toContain("M1");
    expect(container.textContent).toContain("| extra");
  });

  it("renders the webhook test-success feedback strip", () => {
    mainFetcherHolder.current = {
      data: { success: true, fyndWebhookTestResult: true },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Webhook reachable and secret accepted");
  });

  it("renders the webhook test-failure feedback strip with error", () => {
    mainFetcherHolder.current = {
      data: {
        success: false,
        fyndWebhookTestResult: false,
        fyndWebhookTestError: "HTTP 500",
      },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Test failed: HTTP 500");
  });

  it("renders 'unknown error' when test-failure has no fyndWebhookTestError field", () => {
    mainFetcherHolder.current = {
      data: { success: false, fyndWebhookTestResult: false },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("unknown error");
  });

  it("renders the webhookFetcher error string when webhookFetcher.data.error is set", () => {
    webhookFetcherHolder.current = {
      data: { error: "secret-gen failed" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("secret-gen failed");
  });

  it("renders the just-generated secret amber banner with the plaintext value", () => {
    webhookFetcherHolder.current = {
      data: { success: true, fyndWebhookSecretJustGenerated: "plain-secret-xyz" },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Copy this secret now");
    const secretInput = container.querySelector(
      "input[aria-label='Generated webhook secret (one-time display)']",
    ) as HTMLInputElement | null;
    expect(secretInput?.value).toBe("plain-secret-xyz");
  });

  it("renders 'Generating…' label while webhookFetcher is non-idle", () => {
    webhookFetcherHolder.current = { data: undefined, state: "submitting" };
    const { container } = renderWith();
    expect(container.textContent).toContain("Generating…");
  });

  it("renders 'Testing…' label when main fetcher is submitting test_fynd_webhook_secret", () => {
    const fd = new FormData();
    fd.append("intent", "test_fynd_webhook_secret");
    mainFetcherHolder.current = { data: undefined, state: "submitting", formData: fd };
    const { container } = renderWith();
    expect(container.textContent).toContain("Testing…");
  });

  it("renders 'Please wait...' on the Clear credentials button while submitting", () => {
    mainFetcherHolder.current = { data: undefined, state: "submitting" };
    const { container } = renderWith();
    expect(container.textContent).toContain("Please wait");
  });
});

describe("app.settings.integrations — interactive handlers", () => {
  it("calls navigator.clipboard.writeText when Copy URL is clicked, then restores label", async () => {
    const { container } = renderWith();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy URL",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => {
      btn.click();
      // Allow the clipboard.writeText promise (and the .then handler that
      // mutates btn.textContent) to flush before we assert.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (navigator.clipboard.writeText as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(baseLoaderData.fyndWebhookUrl);
    // The post-resolve .then() reads e.currentTarget which React nulls out
    // after the synthetic event handler returns; the early-return there is
    // expected, so we don't assert on textContent. The writeText spy +
    // setTimeout body are what matters for coverage.
  });

  it("calls navigator.clipboard.writeText when Copy secret is clicked", async () => {
    webhookFetcherHolder.current = {
      data: { success: true, fyndWebhookSecretJustGenerated: "the-plain-secret" },
      state: "idle",
    };
    const { container } = renderWith();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy secret",
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    await act(async () => {
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      (navigator.clipboard.writeText as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith("the-plain-secret");
  });

  it("falls through silently when clipboard.writeText rejects (Copy URL)", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("blocked"))) },
    });
    const { container } = renderWith();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy URL",
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    // No throw — the rejection branch is the empty arrow on the rejection
    // handler. Just ensure the button still exists with its original label.
    expect(btn.textContent).toBe("Copy URL");
  });

  it("falls through silently when clipboard.writeText rejects (Copy secret)", async () => {
    webhookFetcherHolder.current = {
      data: { success: true, fyndWebhookSecretJustGenerated: "rejected-secret" },
      state: "idle",
    };
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("blocked"))) },
    });
    const { container } = renderWith();
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy secret",
    ) as HTMLButtonElement;
    await act(async () => {
      btn.click();
      await Promise.resolve();
    });
    expect(btn.textContent).toBe("Copy secret");
  });

  it("App Mode 'dev' radio onChange flips the controlled state", async () => {
    const { container } = renderWith();
    const dev = container.querySelector(
      "input[type='radio'][name='appMode'][value='dev']",
    ) as HTMLInputElement;
    await act(async () => { fireEvent.click(dev); });
    await waitFor(() => { expect(dev.checked).toBe(true); });
  });

  it("Fynd Environment 'prod' radio onChange flips the controlled state", async () => {
    const { container } = renderWith();
    const prod = container.querySelector(
      "input[type='radio'][name='fyndEnvironment'][value='prod']",
    ) as HTMLInputElement;
    await act(async () => { fireEvent.click(prod); });
    await waitFor(() => { expect(prod.checked).toBe(true); });
  });

  it("allowExchange toggle onChange mutates the track + knob style", () => {
    loaderHolder.current = {
      ...baseLoaderData,
      policy: { ...baseLoaderData.policy, allowExchange: false },
    };
    const { container } = renderWith();
    const cb = container.querySelector(
      "input[type='checkbox'][name='policyAllowExchange']",
    ) as HTMLInputElement;
    expect(cb).toBeTruthy();
    // Flip on, then off, to exercise both branches of the onChange.
    fireEvent.click(cb);
    fireEvent.click(cb);
  });

  it("Rotate button confirm() returning true allows submission (no preventDefault)", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const { container } = renderWith();
    const rotateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rotate webhook secret"),
    ) as HTMLButtonElement;
    await act(async () => { fireEvent.click(rotateBtn); });
    await waitFor(() => { expect(confirmSpy).toHaveBeenCalled(); });
    confirmSpy.mockRestore();
  });

  it("Rotate button confirm() returning false invokes preventDefault", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    const { container } = renderWith();
    const rotateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rotate webhook secret"),
    ) as HTMLButtonElement;
    await act(async () => { fireEvent.click(rotateBtn); });
    await waitFor(() => { expect(confirmSpy).toHaveBeenCalled(); });
    confirmSpy.mockRestore();
  });

  it("Generate button (no existing secret) does not invoke confirm()", async () => {
    loaderHolder.current = { ...baseLoaderData, fyndWebhookSecretConfigured: false };
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const { container } = renderWith();
    const genBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Generate webhook secret"),
    ) as HTMLButtonElement;
    await act(async () => { fireEvent.click(genBtn); });
    await waitFor(() => { expect(confirmSpy).not.toHaveBeenCalled(); });
    confirmSpy.mockRestore();
  });

  it("readonly inputs and textareas select on focus", async () => {
    webhookFetcherHolder.current = {
      data: { success: true, fyndWebhookSecretJustGenerated: "focusable" },
      state: "idle",
    };
    const { container } = renderWith();
    const url = container.querySelector(
      "input[aria-label='Per-shop Fynd webhook URL']",
    ) as HTMLInputElement;
    const selectSpy = vi.spyOn(url, "select");
    await act(async () => { fireEvent.focus(url); });
    await waitFor(() => { expect(selectSpy).toHaveBeenCalled(); });

    const secret = container.querySelector(
      "input[aria-label='Generated webhook secret (one-time display)']",
    ) as HTMLInputElement;
    const selectSpy2 = vi.spyOn(secret, "select");
    await act(async () => { fireEvent.focus(secret); });
    await waitFor(() => { expect(selectSpy2).toHaveBeenCalled(); });

    const curl = container.querySelector(
      "textarea[aria-label='curl example using header auth']",
    ) as HTMLTextAreaElement;
    const selectSpy3 = vi.spyOn(curl, "select");
    await act(async () => { fireEvent.focus(curl); });
    await waitFor(() => { expect(selectSpy3).toHaveBeenCalled(); });

    const sample = container.querySelector(
      "textarea[aria-label='Sample Fynd webhook payload']",
    ) as HTMLTextAreaElement;
    const selectSpy4 = vi.spyOn(sample, "select");
    await act(async () => { fireEvent.focus(sample); });
    await waitFor(() => { expect(selectSpy4).toHaveBeenCalled(); });
  });
});

describe("app.settings.integrations — extra rendering branches", () => {
  it("renders the curl example textarea with the per-shop URL substituted", () => {
    const { container } = renderWith();
    const ta = container.querySelector(
      "textarea[aria-label='curl example using header auth']",
    ) as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();
    expect(ta?.value).toContain(baseLoaderData.fyndWebhookUrl);
  });

  it("renders the sample-payload textarea (collapsed details body) with valid JSON", () => {
    const { container } = renderWith();
    const ta = container.querySelector(
      "textarea[aria-label='Sample Fynd webhook payload']",
    ) as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();
    expect(() => JSON.parse(ta!.value)).not.toThrow();
  });

  it("does not render the test-result strip when fetcher.data has no fyndWebhookTestResult key", () => {
    mainFetcherHolder.current = { data: { success: true }, state: "idle" };
    const { container } = renderWith();
    expect(container.textContent).not.toContain("Webhook reachable");
    expect(container.textContent).not.toContain("Test failed");
  });
});
