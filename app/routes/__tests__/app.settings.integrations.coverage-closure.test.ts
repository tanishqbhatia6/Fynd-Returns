/**
 * Coverage closure for app.settings.integrations.tsx server action. Targets
 * branches that the existing test suites don't reach:
 *   - line 65   buildPolicyJson refundMethodsRaw fallback path (string CSV)
 *   - line 156  test_fynd_webhook_secret when shop record is missing
 *   - line 194  test_fynd_webhook_secret when remote endpoint returns non-OK
 *   - line 217  generate_fynd_webhook_secret when shop is missing
 *   - line 245  test_platform when shop is missing → prisma.shop.create branch
 *   - line 260  buildCredsForTest returning null (no creds + no existing)
 *   - line 288  clear_token when shop is missing → prisma.shop.create branch
 *   - line 322  Save when shop is missing → prisma.shop.create branch
 *   - line 386  Outer catch with a thrown Response rethrows
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
  encryptIfNeededMock: vi.fn((s: string | null | undefined) =>
    s ? `enc(${s})` : null,
  ),
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

import { action } from "../app.settings.integrations";

function formReq(form: Record<string, string | string[]>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else fd.append(k, v);
  }
  return new Request("https://x", { method: "POST", body: fd });
}

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  prismaMock.shop.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.shop.create
    .mockReset()
    .mockImplementation(async ({ data }) => ({ id: "cmnewshop", ...data }));
  prismaMock.shopSettings.upsert
    .mockReset()
    .mockImplementation(async ({ create, where }) => ({ ...where, ...create }));
  authenticateMock
    .mockReset()
    .mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  encryptMock.mockClear();
  encryptIfNeededMock.mockClear();
  decryptIfEncryptedMock.mockClear();
  getNormalizedCredentialsFromRawMock.mockReset().mockReturnValue(null);
  testPlatformConnectionRawMock.mockReset();
  createFyndClientOrErrorMock.mockReset();
  getAppModeMock.mockReset().mockReturnValue("prod");
  sanitizeCredentialInputsMock
    .mockReset()
    .mockImplementation((v) => ({ valid: true, sanitized: v }));
  generateWebhookSecretMock.mockClear();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";
});

afterEach(() => {
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

describe("integrations action — coverage closure", () => {
  it("test_fynd_webhook_secret returns 'Shop not found' when shop record missing (line 156)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
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
    expect(res.fyndWebhookTestError).toBe("Shop not found");
  });

  it("test_fynd_webhook_secret reports HTTP error body when remote returns non-OK (line 194)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc(plain-secret)" },
    });
    // res.ok=false AND res.text() rejects → arrow handler at line 194 fires.
    const fakeRes = {
      ok: false,
      status: 401,
      text: () => Promise.reject(new Error("body stream errored")),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(fakeRes);
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
      // text() rejected → fallback "" → no `— …` suffix.
      expect(res.fyndWebhookTestError).not.toMatch(/—/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("generate_fynd_webhook_secret returns 'Shop not found' when shop missing (line 217)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "generate_fynd_webhook_secret" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("Shop not found");
    // Did not advance to upsert
    expect(prismaMock.shopSettings.upsert).not.toHaveBeenCalled();
  });

  it("test_platform creates shop record when missing (line 245) and rejects with no creds (line 260)", async () => {
    // shop.findUnique → null forces the .create branch (line 245).
    // No creds in form + no existing creds → buildCredsForTest returns null
    // (line 260) → action short-circuits with the "Enter Application ID..." error.
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "test_platform" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error?: string; testResult: boolean };
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.testResult).toBe(false);
    expect(res.error).toMatch(/Application ID/);
  });

  it("clear_token creates shop when missing (line 288) and nulls credentials", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "clear_token" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; cleared?: boolean };
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
      }),
    );
    expect(res.success).toBe(true);
    expect(res.cleared).toBe(true);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.create.fyndCredentials).toBeNull();
    expect(upsertArg.create.fyndApiType).toBeNull();
  });

  it("Save (no intent) creates shop when missing and persists empty merged creds (line 322)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ appMode: "prod", policyRefundMethods: "store_credit" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; tokenUpdated?: boolean };
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
        include: { settings: true },
      }),
    );
    expect(res.success).toBe(true);
    // No new platform creds → tokenUpdated false (covers Object.keys(merged) === 0 branch)
    expect(res.tokenUpdated).toBe(false);
  });

  it("Save also exercises buildPolicyJson refundMethods CSV branch (line 65)", async () => {
    // policyRefundMethods sent as a SINGLE comma-separated value (the
    // formData.getAll path returns a length-1 array — the branch falls
    // through to .split(",") on that single string at line 64-65).
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    // Only ONE entry under policyRefundMethods so refundMethodsAll.length===1
    // skips the >0 branch's .getAll path's filter; we still exercise line 65
    // because refundMethodsRaw becomes ["original_payment,store_credit"]
    // which has length 1 (>0) → filter runs. Plus a sanity assertion.
    const res = (await action({
      request: formReq({
        policyRefundMethods: "original_payment,store_credit",
        policyDefaultRefundMethod: "store_credit",
      }),
      params: {},
      context: {},
    } as never)) as { success: boolean };
    expect(res.success).toBe(true);
  });

  it("rethrows Response thrown from sanitizeCredentialInputs (line 386)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    sanitizeCredentialInputsMock.mockImplementationOnce(() => {
      throw redirect;
    });
    await expect(
      action({
        request: formReq({ fyndCompanyId: "2263" }),
        params: {},
        context: {},
      } as never),
    ).rejects.toBe(redirect);
  });
});
