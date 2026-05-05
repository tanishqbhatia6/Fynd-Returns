/**
 * Loader + action tests for app.settings.setup.tsx — guided Fynd onboarding
 * wizard. Loader returns checklist progress (creds, webhook URL, existing
 * subscriber). Action handles test_platform / test_webhook / register_webhook
 * intents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRawMock,
  createFyndLoggerMock,
  getAppModeMock,
  processFyndWebhookMock,
  listFyndWebhookSubscribersMock,
  findSubscriberWithUrlMock,
  registerFyndWebhookMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  getNormalizedCredentialsFromRawMock: vi.fn(),
  testPlatformConnectionRawMock: vi.fn(),
  createFyndLoggerMock: vi.fn(),
  getAppModeMock: vi.fn(),
  processFyndWebhookMock: vi.fn(),
  listFyndWebhookSubscribersMock: vi.fn(),
  findSubscriberWithUrlMock: vi.fn(),
  registerFyndWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd.server", () => ({
  getNormalizedCredentialsFromRaw: getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRaw: testPlatformConnectionRawMock,
}));
vi.mock("../../lib/fynd-logger.server", () => ({
  createFyndLogger: createFyndLoggerMock,
}));
vi.mock("../../lib/fynd-config.server", () => ({
  getAppMode: getAppModeMock,
}));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
}));
vi.mock("../../lib/fynd-webhook-api.server", () => ({
  listFyndWebhookSubscribers: listFyndWebhookSubscribersMock,
  findSubscriberWithUrl: findSubscriberWithUrlMock,
  registerFyndWebhook: registerFyndWebhookMock,
}));
// AppPage component is imported by route module but not exercised by
// loader/action — stub to a no-op so importing the route doesn't pull in
// React-tree-only deps.
vi.mock("../../components/AppPage", () => ({ AppPage: () => null }));

import { loader, action } from "../app.settings.setup";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
  });
  getNormalizedCredentialsFromRawMock.mockReset().mockReturnValue(null);
  testPlatformConnectionRawMock.mockReset();
  createFyndLoggerMock.mockReset().mockReturnValue({
    logs: [],
    log: vi.fn(),
  });
  getAppModeMock.mockReset().mockReturnValue("test");
  processFyndWebhookMock.mockReset();
  listFyndWebhookSubscribersMock.mockReset();
  findSubscriberWithUrlMock.mockReset().mockReturnValue(null);
  registerFyndWebhookMock.mockReset();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";
});

afterEach(() => {
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

describe("loader", () => {
  it("creates shop record if not found and returns defaults", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce({
      id: "shop-new",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.shop.create).toHaveBeenCalled();
    expect(data.hasPlatformCreds).toBe(false);
    expect(data.fyndCompanyId).toBe("");
    expect(data.fyndApplicationId).toBe("");
    expect(data.fyndEnvironment).toBe("uat");
    expect(data.hasPerShopWebhookSecret).toBe(false);
  });

  it("builds per-shop and legacy webhook URLs from SHOPIFY_APP_URL", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndWebhookSecret: "sec" },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.webhookUrl).toBe("https://app.example.com/api/webhooks/fynd/shop-1");
    expect(data.legacyWebhookUrl).toBe("https://app.example.com/api/webhooks/fynd");
    expect(data.hasPerShopWebhookSecret).toBe(true);
  });

  it("returns empty webhook URLs when SHOPIFY_APP_URL is unset", async () => {
    delete process.env.SHOPIFY_APP_URL;
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: null,
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.webhookUrl).toBe("");
    expect(data.legacyWebhookUrl).toBe("");
    expect(data.appUrl).toBe("");
  });

  it("hasPlatformCreds is true when normalized credentials exist", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndCredentials: "{}", fyndCompanyId: "c1", fyndApplicationId: "a1" },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({ platform: { clientId: "x" } });
    listFyndWebhookSubscribersMock.mockResolvedValueOnce({ ok: true, subscribers: [] });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.hasPlatformCreds).toBe(true);
  });

  it("returns existingSubscriber when one matches the per-shop URL", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndCredentials: "{}", fyndCompanyId: "c1", fyndApplicationId: "a1" },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({ platform: { clientId: "x" } });
    listFyndWebhookSubscribersMock.mockResolvedValueOnce({
      ok: true,
      subscribers: [{ name: "Fynd Returns", webhook_url: "https://app.example.com/api/webhooks/fynd/shop-1" }],
    });
    findSubscriberWithUrlMock.mockReturnValueOnce({
      name: "Fynd Returns",
      webhook_url: "https://app.example.com/api/webhooks/fynd/shop-1",
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.existingSubscriber).toEqual({
      name: "Fynd Returns",
      webhook_url: "https://app.example.com/api/webhooks/fynd/shop-1",
    });
    expect(data.subscribersError).toBeNull();
  });

  it("surfaces subscribersError when listFyndWebhookSubscribers fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndCredentials: "{}", fyndCompanyId: "c1", fyndApplicationId: "a1" },
    });
    getNormalizedCredentialsFromRawMock.mockReturnValueOnce({ platform: { clientId: "x" } });
    listFyndWebhookSubscribersMock.mockResolvedValueOnce({ ok: false, error: "Forbidden" });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.existingSubscriber).toBeNull();
    expect(data.subscribersError).toBe("Forbidden");
  });

  it("skips subscriber lookup when no platform creds or company id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: null,
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(listFyndWebhookSubscribersMock).not.toHaveBeenCalled();
    expect(data.existingSubscriber).toBeNull();
  });
});

describe("action — test_platform", () => {
  it("returns success when platform connection works", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
      },
    });
    testPlatformConnectionRawMock.mockResolvedValueOnce({ ok: true });
    const res = (await action({
      request: formReq({ intent: "test_platform" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; testResult: boolean; testMessage: string };
    expect(res.success).toBe(true);
    expect(res.testResult).toBe(true);
    expect(res.testMessage).toMatch(/successful/i);
  });

  it("returns success:false when credentials are not yet saved", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: null,
    });
    const res = (await action({
      request: formReq({ intent: "test_platform" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Save credentials/i);
    expect(testPlatformConnectionRawMock).not.toHaveBeenCalled();
  });

  it("returns the error from testPlatformConnectionRaw on failure", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
      },
    });
    testPlatformConnectionRawMock.mockResolvedValueOnce({ ok: false, error: "401 Unauthorized" });
    const res = (await action({
      request: formReq({ intent: "test_platform" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error: string; testResult: boolean };
    expect(res.success).toBe(false);
    expect(res.error).toBe("401 Unauthorized");
    expect(res.testResult).toBe(false);
  });
});

describe("action — test_webhook", () => {
  it("returns success when processFyndWebhook returns an action", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = (await action({
      request: formReq({ intent: "test_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; webhookTestResult: boolean; webhookAction: string };
    expect(res.success).toBe(true);
    expect(res.webhookTestResult).toBe(true);
    expect(res.webhookAction).toBe("ignored");
  });

  it("returns success:false when processFyndWebhook returns ok:false", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const res = (await action({
      request: formReq({ intent: "test_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; webhookError: string; webhookTestResult: boolean };
    expect(res.success).toBe(false);
    expect(res.webhookError).toBe("boom");
    expect(res.webhookTestResult).toBe(false);
  });
});

describe("action — register_webhook", () => {
  it("rejects when credentials are missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: null,
    });
    const res = (await action({
      request: formReq({ intent: "register_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; registerError: string };
    expect(res.success).toBe(false);
    expect(res.registerError).toMatch(/Save credentials/i);
    expect(registerFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects when SHOPIFY_APP_URL is not set", async () => {
    delete process.env.SHOPIFY_APP_URL;
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
        fyndWebhookSecret: "sec",
      },
    });
    const res = (await action({
      request: formReq({ intent: "register_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; registerError: string };
    expect(res.success).toBe(false);
    expect(res.registerError).toMatch(/SHOPIFY_APP_URL/i);
  });

  it("rejects when per-shop webhook secret has not been generated yet", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
        fyndWebhookSecret: null,
      },
    });
    const res = (await action({
      request: formReq({ intent: "register_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; registerError: string };
    expect(res.success).toBe(false);
    expect(res.registerError).toMatch(/Generate a per-shop webhook secret/i);
    expect(registerFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("returns the error when registerFyndWebhook fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
        fyndWebhookSecret: "sec",
      },
    });
    registerFyndWebhookMock.mockResolvedValueOnce({ ok: false, error: "403 Forbidden" });
    const res = (await action({
      request: formReq({ intent: "register_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; registerError: string };
    expect(res.success).toBe(false);
    expect(res.registerError).toBe("403 Forbidden");
  });

  it("returns success after registerFyndWebhook + endpoint verification succeed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        fyndCredentials: "{}",
        fyndCompanyId: "c1",
        fyndApplicationId: "a1",
        fyndWebhookSecret: "sec",
      },
    });
    registerFyndWebhookMock.mockResolvedValueOnce({ ok: true, message: "Registered" });
    const rawSpy = vi.spyOn(globalThis, "fetch" as never) as unknown as {
      mockResolvedValueOnce: (v: unknown) => unknown;
      mockRestore: () => void;
    };
    rawSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "ok",
    });
    const fetchSpy = rawSpy;
    try {
      const res = (await action({
        request: formReq({
          intent: "register_webhook",
          subscriberName: "Fynd Returns",
          notificationEmail: "ops@example.com",
        }),
        params: {},
        context: {},
      } as never)) as { success: boolean; registerResult: boolean; registerMessage: string };
      expect(res.success).toBe(true);
      expect(res.registerResult).toBe(true);
      expect(res.registerMessage).toBe("Registered");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("action — unknown / errors", () => {
  it("returns 'Unknown action' for an unrecognized intent", async () => {
    const res = (await action({
      request: formReq({ intent: "definitely_not_a_real_intent" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error: string };
    expect(res.success).toBe(false);
    expect(res.error).toBe("Unknown action");
  });
});
