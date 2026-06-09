/**
 * Final-branch coverage tests for webhook routes.
 *
 * Targets specific uncovered branches in:
 *   - app/routes/api.webhooks.fynd.ts
 *   - app/routes/api.webhooks.fynd.retry.ts
 *   - app/routes/api.webhooks.fynd.$shopId.ts
 *   - app/routes/webhooks.customers.redact.tsx
 *   - app/routes/webhooks.shop.redact.tsx
 *   - app/routes/webhooks.app.uninstalled.tsx
 *   - app/routes/webhooks.draft-orders.update.tsx
 *   - app/routes/webhooks.tsx
 *
 * Each test isolates a small remaining branch missed by the existing test
 * suite. NO source modifications.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ────────────────────────────────────────────────────────────────────────
// Single shared prisma + auth mock setup. All target routes consume the
// same db.server + shopify.server modules, so one mock surface works for
// every action under test.
// ────────────────────────────────────────────────────────────────────────
const {
  prismaMock,
  authenticateWebhookMock,
  authenticateAdminMock,
  processFyndWebhookMock,
  unwrapFyndWebhookPayloadMock,
  authenticateFyndWebhookMock,
  readBoundedBodyMock,
  decryptMock,
  webhookLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  authenticateAdminMock: vi.fn(),
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
  authenticateFyndWebhookMock: vi.fn(),
  readBoundedBodyMock: vi.fn(),
  decryptMock: vi.fn(),
  webhookLoggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: {
    webhook: authenticateWebhookMock,
    admin: authenticateAdminMock,
  },
}));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  authenticateWebhook: authenticateFyndWebhookMock,
  readBoundedBody: readBoundedBodyMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));
vi.mock("../../lib/observability/logger.server", () => ({
  webhookLogger: webhookLoggerMock,
}));

import { action as fyndAction } from "../api.webhooks.fynd";
import { action as fyndRetryAction } from "../api.webhooks.fynd.retry";
import { action as fyndShopIdAction } from "../api.webhooks.fynd.$shopId";
import { action as customersRedactAction } from "../webhooks.customers.redact";
import { action as shopRedactAction } from "../webhooks.shop.redact";
import { action as appUninstalledAction } from "../webhooks.app.uninstalled";
import { action as draftUpdateAction } from "../webhooks.draft-orders.update";
import { action as catchallAction } from "../webhooks";

const origEnv = { ...process.env };

function mkPostReq(url: string, body: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

beforeEach(() => {
  process.env = { ...origEnv, NODE_ENV: "test" };
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  authenticateAdminMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  processFyndWebhookMock.mockReset().mockResolvedValue({
    ok: true,
    action: "updated",
    returnCaseId: "rc-default",
  });
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({
    payload: JSON.parse(raw),
    eventType: "shipment.updated",
  }));
  authenticateFyndWebhookMock.mockReset().mockReturnValue({ ok: true });
  readBoundedBodyMock
    .mockReset()
    .mockImplementation(async (req: Request) => ({ body: await req.text() }));
  decryptMock
    .mockReset()
    .mockImplementation((v: unknown) => (typeof v === "string" ? v.replace(/^enc:/, "") : null));
  webhookLoggerMock.error.mockClear();
  webhookLoggerMock.warn.mockClear();
  webhookLoggerMock.info.mockClear();
  webhookLoggerMock.debug.mockClear();
});

afterEach(() => {
  process.env = { ...origEnv };
});

// ════════════════════════════════════════════════════════════════════════
// api.webhooks.fynd.ts — remaining branches
// ════════════════════════════════════════════════════════════════════════
describe("api.webhooks.fynd — final branches", () => {
  it("ignores non-finite content-length header (NaN) and continues", async () => {
    // Number.isFinite("abc") → false → skips early 413, processes normally.
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "not-a-number" },
      body: JSON.stringify({ shipment_id: "SH-NF", status: "delivered" }),
    });
    const res = await fyndAction({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("logs non-Error parse failure with String(err) — fallback path on line 82", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw "string-not-error";
    });
    const res = await fyndAction({
      request: mkPostReq("https://app.example/api/webhooks/fynd", "{broken"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    // The error message in the fyndWebhookLog.create should be the String() of the thrown
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.stringContaining("string-not-error"),
        }),
      }),
    );
    errSpy.mockRestore();
  });

  it("swallows fyndWebhookLog.create failure inside parse-error catch block", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw new Error("bad json");
    });
    prismaMock.fyndWebhookLog.create.mockRejectedValueOnce(new Error("DB down"));
    const res = await fyndAction({
      request: mkPostReq("https://app.example/api/webhooks/fynd", "{broken"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    errSpy.mockRestore();
  });

  it("logs non-Error from processFyndWebhook outer catch via String(err)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processFyndWebhookMock.mockImplementationOnce(() => {
      throw { code: 99, weird: true };
    });
    const res = await fyndAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd",
        JSON.stringify({ shipment_id: "SH-X", status: "delivered" }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════
// api.webhooks.fynd.retry.ts — remaining branches
// ════════════════════════════════════════════════════════════════════════
describe("api.webhooks.fynd.retry — final branches", () => {
  it("bulk retry: skips logs whose rawPayload becomes null at iteration time (defensive guard)", async () => {
    // The findMany already filters null rawPayload, but the in-loop `if (!log.rawPayload)`
    // is a defensive guard. Simulate it by returning a log with explicit null.
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([{ id: "n-1", rawPayload: null }]);
    const res = await fyndRetryAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/retry",
        JSON.stringify({ action: "retry_all_ignored" }),
      ),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.failed).toBe(1);
    expect(body.succeeded).toBe(0);
    // Should NOT have invoked processFyndWebhook for the null-payload log
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("single retry: stringifies non-Error throws into 500 body via String(err)", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-NE",
      action: "ignored",
      rawPayload: JSON.stringify({}),
    });
    processFyndWebhookMock.mockImplementationOnce(() => {
      throw 12345;
    });
    const res = await fyndRetryAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/retry",
        JSON.stringify({ logId: "log-NE" }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("12345");
  });
});

// ════════════════════════════════════════════════════════════════════════
// api.webhooks.fynd.$shopId.ts — remaining branches
// ════════════════════════════════════════════════════════════════════════
describe("api.webhooks.fynd.$shopId — final branches", () => {
  it("logs parse error then swallows fyndWebhookLog.create failure (non-fatal create)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw new Error("malformed");
    });
    prismaMock.fyndWebhookLog.create.mockRejectedValueOnce(new Error("DB"));
    const res = await fyndShopIdAction({
      request: mkPostReq("https://app.example/api/webhooks/fynd/shop-1", "{broken"),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(400);
    errSpy.mockRestore();
  });

  it("dedup findFirst throws → swallowed (non-fatal), still proceeds to processFyndWebhook", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    prismaMock.fyndWebhookLog.findFirst.mockRejectedValueOnce(new Error("dedup err"));
    const res = await fyndShopIdAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/shop-1",
        JSON.stringify({ shipment_id: "SH-D", status: "delivered" }),
      ),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("recent timestamp within 5min window passes through to processing (line 86 truthy branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    const recent = new Date(Date.now() - 60_000).toISOString();
    const res = await fyndShopIdAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/shop-1",
        JSON.stringify({ shipment_id: "SH-RECENT", status: "delivered" }),
        { "x-fynd-timestamp": recent },
      ),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("dedup uses payload.id fallback when shipment_id and shipmentId both missing (line 119 path)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    await fyndShopIdAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/shop-1",
        JSON.stringify({ id: "ID-FALL", status: "delivered" }),
      ),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shipmentId: "ID-FALL" }),
      }),
    );
  });

  it("non-Error parse failure stringified into log entry (line 98 path)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw "raw-string-thrown";
    });
    const res = await fyndShopIdAction({
      request: mkPostReq("https://app.example/api/webhooks/fynd/shop-1", "{garbage"),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(400);
    // The String(err) path produced a log entry whose error contains the raw string
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.stringContaining("raw-string-thrown"),
        }),
      }),
    );
    errSpy.mockRestore();
  });

  it("outer catch path: non-Error thrown from processFyndWebhook → 500 with String(err)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    processFyndWebhookMock.mockImplementationOnce(() => {
      throw "weird-string";
    });
    const res = await fyndShopIdAction({
      request: mkPostReq(
        "https://app.example/api/webhooks/fynd/shop-1",
        JSON.stringify({ shipment_id: "SH-X", status: "delivered" }),
      ),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

// ════════════════════════════════════════════════════════════════════════
// webhooks.customers.redact.tsx — remaining branches
// ════════════════════════════════════════════════════════════════════════
describe("webhooks.customers.redact — final branches", () => {
  it("payload with no customer object at all → both customerId and email/phone fall back to defaults", async () => {
    // Exercises the `payload.customer?.id?.toString() ?? ""` and email fallback
    // when payload.customer is entirely undefined.
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await customersRedactAction({
      request: mkPostReq("https://app.example/webhooks/customers.redact", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // No identifiers extracted → returnCase.findMany not called
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// webhooks.shop.redact.tsx — happy path full deletion (lines 45-110)
// ════════════════════════════════════════════════════════════════════════
describe("webhooks.shop.redact — final branches", () => {
  it("deletes all data for the shop in dependency-safe order (covers full happy path)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { shop_id: 12345 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }, { id: "rc-2" }]);
    const res = await shopRedactAction({
      request: mkPostReq("https://app.example/webhooks/shop.redact", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnItem.deleteMany).toHaveBeenCalledWith({
      where: { returnCaseId: { in: ["rc-1", "rc-2"] } },
    });
    expect(prismaMock.returnEvent.deleteMany).toHaveBeenCalled();
    expect(prismaMock.returnCase.deleteMany).toHaveBeenCalled();
    expect(prismaMock.fyndOrderMapping.deleteMany).toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.deleteMany).toHaveBeenCalled();
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalled();
    expect(prismaMock.apiKey.deleteMany).toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.deleteMany).toHaveBeenCalled();
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalled();
    expect(prismaMock.shopSettings.deleteMany).toHaveBeenCalled();
    expect(prismaMock.session.deleteMany).toHaveBeenCalled();
    expect(prismaMock.shop.delete).toHaveBeenCalledWith({
      where: { id: "shop-1" },
    });
  });

  it("shop found but with zero return cases → skips return-scoped deletes but still tears down everything else", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { shop_id: 1 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-z",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await shopRedactAction({
      request: mkPostReq("https://app.example/webhooks/shop.redact", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.shop.delete).toHaveBeenCalled();
  });

  it("auth threw a non-Error value → String(err) fallback used (line 20 false branch)", async () => {
    authenticateWebhookMock.mockImplementationOnce(() => {
      throw "auth-string-error";
    });
    const res = await shopRedactAction({
      request: mkPostReq("https://app.example/webhooks/shop.redact", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "SHOP_REDACT", err: "auth-string-error" }),
      "Shop redact webhook authentication failed",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// webhooks.app.uninstalled.tsx — branches
// ════════════════════════════════════════════════════════════════════════
describe("webhooks.app.uninstalled — final branches", () => {
  it("session present + delete succeeds: returns 200, deletes correct shop", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "uninstall-test.myshopify.com",
      session: { id: "offline_x" },
    });
    prismaMock.session.deleteMany.mockResolvedValueOnce({ count: 3 });
    const res = await appUninstalledAction({
      request: mkPostReq("https://app.example/webhooks/app.uninstalled", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "uninstall-test.myshopify.com" },
    });
  });
});

// ════════════════════════════════════════════════════════════════════════
// webhooks.draft-orders.update.tsx — branches
// ════════════════════════════════════════════════════════════════════════
describe("webhooks.draft-orders.update — final branches", () => {
  it("payload missing entirely → returns 200 without DB hit", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: null,
    });
    const res = await draftUpdateAction({
      request: mkPostReq("https://app.example/webhooks/draft-orders.update", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("orderName empty after trim/hash strip → returns 200 without DB hit", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#", status: "completed" },
    });
    const res = await draftUpdateAction({
      request: mkPostReq("https://app.example/webhooks/draft-orders.update", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("payload is a string (typeof !== 'object') → early returns 200 without DB hit (line 22)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: "not-an-object" as unknown,
    });
    const res = await draftUpdateAction({
      request: mkPostReq("https://app.example/webhooks/draft-orders.update", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("payload with no status field → status defaults to empty string, falls into else-if (cancellation) branch (line 24)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-NO-STATUS" }, // no status field — exercises ?? "" nullish branch
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await draftUpdateAction({
      request: mkPostReq("https://app.example/webhooks/draft-orders.update", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // status is "" so neither "completed" nor "open"/"invoiced" — falls into cancellation
    expect(prismaMock.returnCase.findMany).toHaveBeenCalled();
  });

  it("shop not found → early returns 200 without further DB calls", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: { name: "#D-1", status: "completed", order_id: 1 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await draftUpdateAction({
      request: mkPostReq("https://app.example/webhooks/draft-orders.update", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.updateMany).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// webhooks.tsx — remaining branches (CUSTOMERS_REDACT lookupSession edge)
// ════════════════════════════════════════════════════════════════════════
describe("webhooks.tsx (catchall) — final branches", () => {
  it("CUSTOMERS_REDACT with caseIds matched but fyndWebhookLog.findMany returns [] AND no email → does not delete fynd logs", async () => {
    // Target line 109 area: `if (lookupValues.length > 0)` and the fynd OR clause's
    // conditional spread when customerEmail is empty. webhooks.tsx uses email-only
    // for catchall, so we still hit the email-truthy branch here; the goal is to
    // hit the fynd findMany returning [] branch (skipping the updateMany).
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "edge@example.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-edge" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-edge" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    const res = await catchallAction({
      request: mkPostReq("https://app.example/webhooks", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndWebhookLog.updateMany).not.toHaveBeenCalled();
    // notificationLog still cleared even when fynd is empty
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT: returnCases matched but customerEmail empty (after trim)? path covers OR-clause spread without customerEmail", async () => {
    // Email becomes "" after `?.toLowerCase().trim() ?? ""`; conditions empty
    // means findMany never runs, so this primarily exercises the empty-email
    // skip path on line 104 inside the catch-all redact branch.
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-empty-email" });
    const res = await catchallAction({
      request: mkPostReq("https://app.example/webhooks", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // No conditions → no findMany / updateMany / deleteMany
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(prismaMock.lookupSession.deleteMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT redacts return cases AND cascades to fyndWebhookLog when both match", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "Cust@Example.COM" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-a" }, { id: "rc-b" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([{ id: "fl-1" }]);

    const res = await catchallAction({
      request: mkPostReq("https://app.example/webhooks", "{}"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndWebhookLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["fl-1"] } },
        data: { customerName: null, customerEmail: null, customerPhone: null },
      }),
    );
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", lookupValueNorm: "cust@example.com" },
    });
  });
});
