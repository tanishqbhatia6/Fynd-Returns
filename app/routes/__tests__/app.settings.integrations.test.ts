/**
 * Loader + action tests for app.settings.integrations.tsx — Fynd
 * partner credentials, per-shop webhook secret + URL, and Gorgias
 * helpdesk integration. Verifies credentials are masked on the wire
 * (never echoed back), generated webhook secrets are returned ONCE,
 * and malformed input is rejected with `success:false`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

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
  decryptIfEncryptedMock: vi.fn((s: string | null | undefined) => (s ? String(s).replace(/^enc\(|\)$/g, "") : null)),
  getNormalizedCredentialsFromRawMock: vi.fn(),
  testPlatformConnectionRawMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn(),
  getAppModeMock: vi.fn(() => "prod"),
  sanitizeCredentialInputsMock: vi.fn(),
  generateWebhookSecretMock: vi.fn(() => "generated-secret-xyz"),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
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
  FYND_ENVIRONMENTS: { uat: "https://api.uat.fyndx1.de", prod: "https://api.fynd.com" },
  getAppMode: getAppModeMock,
}));
vi.mock("../../lib/credential-validation.server", () => ({
  sanitizeCredentialInputs: sanitizeCredentialInputsMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  generateWebhookSecret: generateWebhookSecretMock,
}));

import { loader, action } from "../app.settings.integrations";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  // resetPrismaMock only does mockClear(), which preserves queued
  // mockResolvedValueOnce values. If a test sets one but the SUT short-
  // circuits before consuming it, the queued value leaks into the next
  // test. Fully reset the mocks the integrations action touches.
  prismaMock.shop.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.shop.create.mockReset().mockImplementation(async ({ data }) => ({ id: "cmmock", ...data }));
  prismaMock.shopSettings.upsert.mockReset().mockImplementation(async ({ create, where }) => ({ ...where, ...create }));
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  encryptMock.mockClear();
  encryptIfNeededMock.mockClear();
  decryptIfEncryptedMock.mockClear();
  getNormalizedCredentialsFromRawMock.mockReset().mockReturnValue(null);
  testPlatformConnectionRawMock.mockReset();
  createFyndClientOrErrorMock.mockReset();
  getAppModeMock.mockReset().mockReturnValue("prod");
  sanitizeCredentialInputsMock.mockReset().mockImplementation((v) => ({ valid: true, sanitized: v }));
  generateWebhookSecretMock.mockClear();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";
});

afterEach(() => {
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

describe("loader", () => {
  it("masks Fynd credentials with [configured] sentinel and never echoes raw value", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        fyndCredentials: "ENCRYPTED-BLOB-DO-NOT-LEAK",
        fyndCompanyId: "2263",
        fyndApplicationId: "appid",
        fyndApiType: "platform",
        fyndEnvironment: "uat",
      },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({ platform: { clientId: "ci", clientSecret: "cs" } });

    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);

    expect(data.fyndCredentials).toBe("[configured]");
    expect(JSON.stringify(data)).not.toContain("ENCRYPTED-BLOB-DO-NOT-LEAK");
    expect(data.hasPlatformCreds).toBe(true);
    expect(data.fyndCompanyId).toBe("2263");
  });

  it("returns empty fyndCredentials sentinel + hasPlatformCreds=false when nothing stored", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.fyndCredentials).toBe("");
    expect(data.hasPlatformCreds).toBe(false);
    expect(data.hasStorefrontCreds).toBe(false);
  });

  it("creates the shop row when missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce({
      id: "shop-new",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(prismaMock.shop.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { shopDomain: "store.myshopify.com" },
    }));
    expect(data.fyndWebhookUrl).toBe("https://app.example.com/api/webhooks/fynd/shop-new");
  });

  it("masks Gorgias API key with __UNCHANGED__ sentinel when configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { gorgiasApiKey: "REAL-SECRET-KEY", gorgiasEnabled: true },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.gorgiasApiKey).toBe("__UNCHANGED__");
    expect(JSON.stringify(data)).not.toContain("REAL-SECRET-KEY");
    expect(data.gorgiasEnabled).toBe(true);
  });

  it("signals fyndWebhookSecretConfigured=true when secret stored", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(secret)" },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.fyndWebhookSecretConfigured).toBe(true);
    expect(data.fyndWebhookUrl).toBe("https://app.example.com/api/webhooks/fynd/shop-1");
    // Loader never includes the secret value itself.
    expect(JSON.stringify(data)).not.toContain("enc(secret)");
  });
});

describe("action — webhook secret generation", () => {
  it("generate_fynd_webhook_secret returns plaintext ONCE and persists encrypted", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const res = await action({
      request: formReq({ intent: "generate_fynd_webhook_secret" }),
      params: {}, context: {},
    } as never) as { success: boolean; fyndWebhookSecretJustGenerated?: string; fyndWebhookUrl?: string };

    expect(res.success).toBe(true);
    expect(res.fyndWebhookSecretJustGenerated).toBe("generated-secret-xyz");
    expect(res.fyndWebhookUrl).toBe("https://app.example.com/api/webhooks/fynd/shop-1");
    expect(generateWebhookSecretMock).toHaveBeenCalled();
    expect(encryptIfNeededMock).toHaveBeenCalledWith("generated-secret-xyz");
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.create.fyndWebhookSecret).toBe("enc(generated-secret-xyz)");
    expect(upsertArg.update.fyndWebhookSecret).toBe("enc(generated-secret-xyz)");
  });

  it("rotate_fynd_webhook_secret behaves like generate (replaces stored secret)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(old)" },
    });
    const res = await action({
      request: formReq({ intent: "rotate_fynd_webhook_secret" }),
      params: {}, context: {},
    } as never) as { success: boolean; fyndWebhookSecretJustGenerated?: string };
    expect(res.success).toBe(true);
    expect(res.fyndWebhookSecretJustGenerated).toBe("generated-secret-xyz");
  });

  it("test_fynd_webhook_secret returns error when no secret configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const res = await action({
      request: formReq({ intent: "test_fynd_webhook_secret" }),
      params: {}, context: {},
    } as never) as { success: boolean; fyndWebhookTestResult: boolean; fyndWebhookTestError?: string };
    expect(res.success).toBe(false);
    expect(res.fyndWebhookTestResult).toBe(false);
    expect(res.fyndWebhookTestError).toMatch(/No webhook secret configured/);
  });

  it("test_fynd_webhook_secret POSTs synthetic payload + secret header to per-shop URL", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(plain-secret)" },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, statusText: "OK" }) as Response,
    );
    try {
      const res = await action({
        request: formReq({ intent: "test_fynd_webhook_secret" }),
        params: {}, context: {},
      } as never) as { success: boolean; fyndWebhookTestResult: boolean };
      expect(res.success).toBe(true);
      expect(res.fyndWebhookTestResult).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.example.com/api/webhooks/fynd/shop-1",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            "X-Shop-Secret": "plain-secret",
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("action — test connection", () => {
  it("test_platform with valid creds returns testResult:true", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    testPlatformConnectionRawMock.mockResolvedValueOnce({ ok: true });
    const res = await action({
      request: formReq({
        intent: "test_platform",
        fyndEnvironment: "uat",
        fyndCompanyId: "2263",
        fyndApplicationId: "67a09b70c8ea7c9123f00fab",
        fyndClientId: "client-id",
        fyndClientSecret: "client-secret",
      }),
      params: {}, context: {},
    } as never) as { success: boolean; testResult: boolean; testMessage?: string };
    expect(res.success).toBe(true);
    expect(res.testResult).toBe(true);
    expect(res.testMessage).toMatch(/Platform API connection successful/);
    expect(testPlatformConnectionRawMock).toHaveBeenCalled();
  });

  it("test_platform without applicationId returns clear error", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const res = await action({
      request: formReq({
        intent: "test_platform",
        fyndCompanyId: "2263",
        fyndClientId: "ci",
        fyndClientSecret: "cs",
      }),
      params: {}, context: {},
    } as never) as { success: boolean; error?: string; testResult: boolean };
    expect(res.success).toBe(false);
    expect(res.testResult).toBe(false);
    expect(res.error).toMatch(/Application ID/);
  });

  it("test_platform forwards downstream error verbatim", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    testPlatformConnectionRawMock.mockResolvedValueOnce({ ok: false, error: "403 Forbidden — missing scope" });
    const res = await action({
      request: formReq({
        intent: "test_platform",
        fyndApplicationId: "appid",
        fyndCompanyId: "2263",
        fyndClientId: "ci",
        fyndClientSecret: "cs",
      }),
      params: {}, context: {},
    } as never) as { success: boolean; error?: string; testResult: boolean };
    expect(res.success).toBe(false);
    expect(res.testResult).toBe(false);
    expect(res.error).toBe("403 Forbidden — missing scope");
  });
});

describe("action — save credentials", () => {
  it("encrypts new platform creds + persists settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const res = await action({
      request: formReq({
        fyndEnvironment: "prod",
        fyndCompanyId: "2263",
        fyndApplicationId: "appid",
        fyndClientId: "client-id-new",
        fyndClientSecret: "client-secret-new",
        appMode: "prod",
      }),
      params: {}, context: {},
    } as never) as { success: boolean; tokenUpdated?: boolean };
    expect(res.success).toBe(true);
    expect(res.tokenUpdated).toBe(true);
    expect(encryptMock).toHaveBeenCalledWith(
      JSON.stringify({ platform: { clientId: "client-id-new", clientSecret: "client-secret-new" } }),
    );
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.create.fyndApiType).toBe("platform");
    expect(upsertArg.create.fyndCompanyId).toBe("2263");
    expect(upsertArg.create.fyndApplicationId).toBe("appid");
    expect(upsertArg.create.appMode).toBe("prod");
  });

  it("rejects malformed input from sanitizeCredentialInputs with success:false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    sanitizeCredentialInputsMock.mockReturnValueOnce({ valid: false, error: "Invalid Company ID format" });
    const res = await action({
      request: formReq({
        fyndCompanyId: "<script>",
        fyndApplicationId: "appid",
      }),
      params: {}, context: {},
    } as never) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("Invalid Company ID format");
    expect(prismaMock.shopSettings.upsert).not.toHaveBeenCalled();
  });

  it("clear_token nulls fyndCredentials + fyndApiType", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
    });
    const res = await action({
      request: formReq({ intent: "clear_token" }),
      params: {}, context: {},
    } as never) as { success: boolean; cleared?: boolean };
    expect(res.success).toBe(true);
    expect(res.cleared).toBe(true);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.update.fyndCredentials).toBeNull();
    expect(upsertArg.update.fyndApiType).toBeNull();
  });

  it("preserves existing Gorgias key when form sends __UNCHANGED__ sentinel", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { gorgiasApiKey: "stored-encrypted-key" },
    });
    const res = await action({
      request: formReq({
        gorgiasApiKey: "__UNCHANGED__",
        gorgiasEnabled: "on",
        fyndApplicationId: "appid",
      }),
      params: {}, context: {},
    } as never) as { success: boolean };
    expect(res.success).toBe(true);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.create.gorgiasApiKey).toBe("stored-encrypted-key");
    expect(upsertArg.create.gorgiasEnabled).toBe(true);
  });

  it("returns success:false with error message when DB upsert throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({
      request: formReq({ fyndApplicationId: "appid" }),
      params: {}, context: {},
    } as never) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("DB unavailable");
  });
});
