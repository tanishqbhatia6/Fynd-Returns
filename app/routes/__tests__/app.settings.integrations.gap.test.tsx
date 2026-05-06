/**
 * @vitest-environment jsdom
 *
 * Gap coverage for `app/routes/app.settings.integrations.tsx`.
 *
 * Covers the lines the existing component + action tests miss:
 *   - parsePolicyForForm: trim-empty / valid / invalid-JSON branches
 *     exercised through `loader()` (lines 41-55).
 *   - action `test_fynd_webhook_secret`: missing-plaintext + missing
 *     SHOPIFY_APP_URL + non-2xx HTTP + thrown-fetch branches
 *     (lines 164, 168, 194-195, 202).
 *   - action `test_platform`: re-using existing platform creds when no
 *     new client id/secret is submitted (lines 257-258).
 *   - action save: preserving existingNormalized.platform when no new
 *     creds are submitted (line 329).
 *   - Copy URL / Copy secret onClick: the post-clipboard-write `.then`
 *     body that sets textContent and arms the restore-setTimeout
 *     (lines 544-546, 597-599).
 *   - App Mode `prod` and Fynd Environment `uat` radio onChange
 *     handlers — the existing test only flips the *other* radio in
 *     each pair, so the chosen-default's setter callback is never run
 *     (lines 828, 855).
 *
 * Strictly test-only — no source modifications.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ── Hoisted module mocks for server-side imports ─────────────────────────
const {
  prismaMock,
  authenticateMock,
  encryptMock,
  encryptIfNeededMock,
  decryptIfEncryptedMock,
  getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRawMock,
  createFyndClientOrErrorMock,
  getAppModeMock,
  sanitizeCredentialInputsMock,
  generateWebhookSecretMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  encryptMock: vi.fn((s: string) => `enc(${s})`),
  encryptIfNeededMock: vi.fn((s: string | null | undefined) => (s ? `enc(${s})` : null)),
  decryptIfEncryptedMock: vi.fn((s: string | null | undefined) =>
    s ? String(s).replace(/^enc\(|\)$/g, "") : null,
  ),
  getNormalizedCredentialsFromRawMock: vi.fn(),
  testPlatformConnectionRawMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn(),
  getAppModeMock: vi.fn(() => "prod"),
  sanitizeCredentialInputsMock: vi.fn(),
  generateWebhookSecretMock: vi.fn(() => "generated-secret-xyz"),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/encryption.server", () => ({
  encrypt: encryptMock,
  encryptIfNeeded: encryptIfNeededMock,
  decryptIfEncrypted: decryptIfEncryptedMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
  getNormalizedCredentialsFromRaw: getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRaw: testPlatformConnectionRawMock,
}));
vi.mock("../../lib/fynd-logger.server", () => ({
  createFyndLogger: () => ({ logs: [], log: vi.fn() }),
}));
vi.mock("../../lib/fynd-config.server", () => ({
  FYND_ENVIRONMENTS: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  getAppMode: getAppModeMock,
}));
vi.mock("../../lib/credential-validation.server", () => ({
  sanitizeCredentialInputs: sanitizeCredentialInputsMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  generateWebhookSecret: generateWebhookSecretMock,
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

// AppPage passthrough so jsdom doesn't try to load Polaris.
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

// react-router data-hook mocks (mirrors the existing component test
// pattern — two fetcher slots returned in the order the component
// constructs them).
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
}));

// IMPORTANT: import after mocks so the route module picks up our doubles.
import Integrations, { loader, action } from "../app.settings.integrations";

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

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  fetcherCallCount = 0;
  loaderHolder.current = { ...baseLoaderData };
  mainFetcherHolder.current = { data: undefined, state: "idle" };
  webhookFetcherHolder.current = { data: undefined, state: "idle" };

  resetPrismaMock(prismaMock);
  prismaMock.shop.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.shop.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cmmock",
      ...data,
    }));
  prismaMock.shopSettings.upsert
    .mockReset()
    .mockImplementation(async ({ create, where }: { create: object; where: object }) => ({
      ...where,
      ...create,
    }));
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  encryptMock.mockClear();
  encryptIfNeededMock.mockClear();
  decryptIfEncryptedMock.mockReset().mockImplementation((s: string | null | undefined) =>
    s ? String(s).replace(/^enc\(|\)$/g, "") : null,
  );
  getNormalizedCredentialsFromRawMock.mockReset().mockReturnValue(null);
  testPlatformConnectionRawMock.mockReset();
  createFyndClientOrErrorMock.mockReset();
  getAppModeMock.mockReset().mockReturnValue("prod");
  sanitizeCredentialInputsMock
    .mockReset()
    .mockImplementation((v: object) => ({ valid: true, sanitized: v }));
  generateWebhookSecretMock.mockClear();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";

  // Default clipboard stub — individual tests can override.
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
});

afterEach(() => {
  cleanup();
  fetcherCallCount = 0;
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

function renderWith(): ReturnType<typeof render> {
  fetcherCallCount = 0;
  return render(<Integrations />);
}

describe("loader — parsePolicyForForm branches", () => {
  it("returns defaults when policyJson is empty/whitespace", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { policyJson: "   " },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    // Whitespace-only string takes the `!json.trim()` short-circuit branch.
    expect(data.policy.returnWindowDays).toBe(30);
    expect(data.policy.allowExchange).toBe(false);
  });

  it("parses a fully populated valid policyJson and clamps + filters values", async () => {
    const policyJson = JSON.stringify({
      returnWindowDays: 9999, // clamps to 365
      allowExchange: true,
      minOrderValue: 25,
      refundMethods: ["store_credit", "exchange", "bogus_value"],
      defaultRefundMethod: "exchange",
      excludedTags: ["final-sale", "no-return", 42],
      allowedCategories: ["Apparel", null, "Footwear"],
      restockFeePercent: 250, // clamps to 100
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { policyJson },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.policy.returnWindowDays).toBe(365);
    expect(data.policy.allowExchange).toBe(true);
    expect(data.policy.minOrderValue).toBe(25);
    // Bogus value is filtered out; non-string entries are dropped.
    expect(data.policy.refundMethods).toEqual(["store_credit", "exchange"]);
    expect(data.policy.defaultRefundMethod).toBe("exchange");
    expect(data.policy.excludedTags).toEqual(["final-sale", "no-return"]);
    expect(data.policy.allowedCategories).toEqual(["Apparel", "Footwear"]);
    expect(data.policy.restockFeePercent).toBe(100);
  });

  it("falls back to defaults when policyJson is invalid JSON (catch branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { policyJson: "{ this is not valid json" },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    // JSON.parse throws → catch{} returns defaults.
    expect(data.policy.returnWindowDays).toBe(30);
    expect(data.policy.refundMethods).toEqual(["original_payment", "store_credit"]);
  });
});

describe("action — test_fynd_webhook_secret error branches", () => {
  it("returns 'Could not decrypt' when decryptIfEncrypted yields null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(unknown)" },
    });
    decryptIfEncryptedMock.mockReturnValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "test_fynd_webhook_secret" }),
      params: {},
      context: {},
    } as never)) as {
      success: boolean;
      fyndWebhookTestResult: boolean;
      fyndWebhookTestError?: string;
    };
    expect(res.success).toBe(false);
    expect(res.fyndWebhookTestResult).toBe(false);
    expect(res.fyndWebhookTestError).toMatch(/Could not decrypt/);
  });

  it("returns 'SHOPIFY_APP_URL is not set' when env var is missing", async () => {
    delete process.env.SHOPIFY_APP_URL;
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(plain-secret)" },
    });
    const res = (await action({
      request: formReq({ intent: "test_fynd_webhook_secret" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; fyndWebhookTestError?: string };
    expect(res.success).toBe(false);
    expect(res.fyndWebhookTestError).toMatch(/SHOPIFY_APP_URL is not set/);
  });

  it("reports HTTP status + body when endpoint responds non-2xx", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(plain-secret)" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream rejected", { status: 401, statusText: "Unauthorized" }) as Response,
    );
    try {
      const res = (await action({
        request: formReq({ intent: "test_fynd_webhook_secret" }),
        params: {},
        context: {},
      } as never)) as {
        success: boolean;
        fyndWebhookTestResult: boolean;
        fyndWebhookTestError?: string;
      };
      expect(res.success).toBe(false);
      expect(res.fyndWebhookTestResult).toBe(false);
      expect(res.fyndWebhookTestError).toMatch(/HTTP 401/);
      expect(res.fyndWebhookTestError).toMatch(/upstream rejected/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("captures Error.message when fetch throws (network error branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(plain-secret)" },
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network down"));
    try {
      const res = (await action({
        request: formReq({ intent: "test_fynd_webhook_secret" }),
        params: {},
        context: {},
      } as never)) as { success: boolean; fyndWebhookTestError?: string };
      expect(res.success).toBe(false);
      expect(res.fyndWebhookTestError).toBe("network down");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("action — test_platform credential reuse branch", () => {
  it("reuses existing platform creds when no new clientId/clientSecret submitted (line 257-258)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        fyndCredentials: "enc(stored)",
        fyndApplicationId: "stored-app-id",
        fyndCompanyId: "stored-company",
      },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({
      platform: { clientId: "stored-cid", clientSecret: "stored-secret" },
    });
    testPlatformConnectionRawMock.mockResolvedValueOnce({ ok: true, warning: "stale token" });

    const res = (await action({
      request: formReq({
        intent: "test_platform",
        // No fyndClientId / fyndClientSecret — forces the "reuse existing"
        // branch in buildCredsForTest.
        fyndApplicationId: "appid",
      }),
      params: {},
      context: {},
    } as never)) as { success: boolean; testResult: boolean; testMessage?: string };

    expect(res.success).toBe(true);
    expect(res.testResult).toBe(true);
    // Warning suffix must thread through.
    expect(res.testMessage).toMatch(/stale token/);
    expect(testPlatformConnectionRawMock).toHaveBeenCalled();
  });
});

describe("action — save preserves existing creds when none submitted (line 329)", () => {
  it("keeps existingNormalized.platform when form omits clientId/clientSecret", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        fyndCredentials: "enc(stored)",
        fyndCompanyId: "stored-co",
        fyndApplicationId: "stored-app",
      },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({
      platform: { clientId: "stored-cid", clientSecret: "stored-secret" },
    });
    const res = (await action({
      request: formReq({
        // No clientId/clientSecret submitted — branch reuses existing.
        fyndCompanyId: "new-co",
        fyndApplicationId: "new-app",
        appMode: "prod",
      }),
      params: {},
      context: {},
    } as never)) as { success: boolean; tokenUpdated?: boolean };
    expect(res.success).toBe(true);
    // tokenUpdated stays true because merged.platform was set from existing creds.
    expect(res.tokenUpdated).toBe(true);
    // The encrypt call should serialise the *existing* clientId/clientSecret.
    expect(encryptMock).toHaveBeenCalledWith(
      expect.stringContaining("stored-cid"),
    );
  });
});

describe("component — copy-to-clipboard buttons (.then body)", () => {
  // Replace clipboard.writeText with a thenable that invokes the
  // onFulfilled callback synchronously *while the React click handler
  // is still on the call stack*. This is the only way to keep
  // `e.currentTarget` non-null when the .then body inspects it —
  // otherwise React clears it before the microtask fires.
  function installSyncClipboard(): void {
    const writeText = vi.fn(() => ({
      then(onFulfilled: () => unknown): unknown {
        try {
          onFulfilled();
        } catch {
          /* swallow — matches real Promise semantics for tests */
        }
        return { then: () => undefined };
      },
    }));
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      // Synchronous thenable stub for jsdom — keeps `e.currentTarget`
      // valid through the .then() body so coverage actually visits it.
      value: { writeText } as unknown as Clipboard,
    });
  }

  it("Copy URL button updates label to 'Copied' and arms the restore timer", () => {
    vi.useFakeTimers();
    try {
      installSyncClipboard();
      const { container } = renderWith();
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Copy URL",
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      // The synchronous-thenable mock means lines 544-546 ran in the
      // same tick — the button text now shows the success label.
      expect(btn.textContent).toContain("Copied");
      // Drain the 1800 ms restore timer; the textContent reverts.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(btn.textContent).toBe("Copy URL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy secret button updates label to 'Copied' and arms the restore timer", () => {
    vi.useFakeTimers();
    try {
      installSyncClipboard();
      webhookFetcherHolder.current = {
        data: { success: true, fyndWebhookSecretJustGenerated: "the-plain-secret" },
        state: "idle",
      };
      const { container } = renderWith();
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === "Copy secret",
      ) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      expect(btn.textContent).toContain("Copied");
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(btn.textContent).toBe("Copy secret");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("component — radio onChange handlers for the chosen default", () => {
  it("clicking 'prod' radio when initial appMode is 'dev' fires setAppMode (line 828)", () => {
    loaderHolder.current = { ...baseLoaderData, appMode: "dev" as const };
    const { container } = renderWith();
    const prod = container.querySelector(
      "input[type='radio'][name='appMode'][value='prod']",
    ) as HTMLInputElement;
    expect(prod.checked).toBe(false);
    fireEvent.click(prod);
    expect(prod.checked).toBe(true);
  });

  it("clicking 'uat' radio when initial fyndEnvironment is 'prod' fires setFyndEnvironment (line 855)", () => {
    loaderHolder.current = { ...baseLoaderData, fyndEnvironment: "prod" };
    const { container } = renderWith();
    const uat = container.querySelector(
      "input[type='radio'][name='fyndEnvironment'][value='uat']",
    ) as HTMLInputElement;
    expect(uat.checked).toBe(false);
    fireEvent.click(uat);
    expect(uat.checked).toBe(true);
  });
});

describe("component — Gorgias toggle + API key + webhook rotation feedback", () => {
  it("renders Gorgias toggle in disabled (unchecked) state by default", () => {
    const { container } = renderWith();
    const toggle = container.querySelector(
      "input[type='checkbox'][name='gorgiasEnabled']",
    ) as HTMLInputElement;
    expect(toggle).toBeTruthy();
    expect(toggle.defaultChecked).toBe(false);
  });

  it("renders Gorgias toggle in enabled (checked) state when loader signals enabled=true", () => {
    loaderHolder.current = { ...baseLoaderData, gorgiasEnabled: true };
    const { container } = renderWith();
    const toggle = container.querySelector(
      "input[type='checkbox'][name='gorgiasEnabled']",
    ) as HTMLInputElement;
    expect(toggle.defaultChecked).toBe(true);
  });

  it("renders the Gorgias widget URL field with the loader-supplied value", () => {
    const { container } = renderWith();
    const inputs = Array.from(container.querySelectorAll("input[type='text']"));
    const widget = inputs.find(
      (i) => (i as HTMLInputElement).value === baseLoaderData.gorgiasWidgetUrl,
    );
    expect(widget).toBeTruthy();
  });

  it("renders the rotate-confirm dialog text in the Rotate button onClick path", () => {
    // Spy a confirm that records the message and accepts the dialog.
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockImplementation((msg) => {
      expect(typeof msg).toBe("string");
      expect(String(msg)).toMatch(/Rotate the webhook secret/);
      return true;
    });
    const { container } = renderWith();
    const rotateBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Rotate webhook secret"),
    ) as HTMLButtonElement;
    fireEvent.click(rotateBtn);
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("component — credential save + test feedback rendering", () => {
  it("renders both the test-error AND debug logs accordion (open) when a test fails", () => {
    mainFetcherHolder.current = {
      data: {
        success: false,
        testResult: false,
        error: "scope error",
        debugLogs: [{ ts: "T", step: "auth", message: "rejected", detail: "403" }],
      },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Connection failed: scope error");
    // The debug-logs <details> opens automatically when there is a test error.
    const details = container.querySelector("details.app-details");
    expect(details).toBeTruthy();
    expect((details as HTMLDetailsElement).open).toBe(true);
    expect(container.textContent).toContain("rejected");
  });

  it("renders only the credentials-saved alert (not testResult) on a plain successful save", () => {
    mainFetcherHolder.current = {
      data: { success: true, tokenUpdated: true },
      state: "idle",
    };
    const { container } = renderWith();
    expect(container.textContent).toContain("Credentials saved successfully.");
    expect(container.textContent).not.toContain("Connection successful.");
    expect(container.textContent).not.toContain("Test failed");
  });
});
