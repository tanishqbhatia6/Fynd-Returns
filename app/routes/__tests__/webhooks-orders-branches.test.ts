/**
 * Branch-coverage push to ≥98% across webhook handlers.
 *
 * Targets remaining uncovered branches across:
 *   - webhooks.tsx (catch-all) — customers/redact catch-block error path
 *   - webhooks.draft-orders.update.tsx — completed flow with no name fallback edge
 *   - webhooks.orders.create.tsx — happy path through metafield + upsert + outer catch
 *   - webhooks.orders.fulfilled.tsx — outer non-Error catch + no-gid update path
 *   - webhooks.orders.updated.tsx — outer non-Error catch + sourceChannel backfill failure
 *   - webhooks.app-subscriptions.update.tsx — non-Error catches (auth + outer)
 *   - api.webhooks.fynd.ts — non-Error catches + Number.isFinite false branch
 *
 * No source modifications. Existing test files NOT modified.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  graphqlMock,
  extractAffiliateOrderIdMock,
  normalizeSourceChannelMock,
  fetchSubscriptionSnapshotMock,
  webhookLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  graphqlMock: vi.fn(),
  extractAffiliateOrderIdMock: vi.fn(),
  normalizeSourceChannelMock: vi.fn<(...args: unknown[]) => string | null>(() => null),
  fetchSubscriptionSnapshotMock: vi.fn(),
  webhookLoggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));
vi.mock("../../lib/billing.server", () => ({
  fetchSubscriptionSnapshot: fetchSubscriptionSnapshotMock,
}));
vi.mock("../../lib/observability/logger.server", () => ({
  webhookLogger: webhookLoggerMock,
}));

// Import all handlers AFTER mocks are registered.
import { action as catchAllAction } from "../webhooks";
import { action as draftOrdersAction } from "../webhooks.draft-orders.update";
import { action as ordersCreateAction } from "../webhooks.orders.create";
import { action as ordersFulfilledAction } from "../webhooks.orders.fulfilled";
import { action as ordersUpdatedAction } from "../webhooks.orders.updated";
import { action as appSubscriptionsAction } from "../webhooks.app-subscriptions.update";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  graphqlMock.mockReset().mockResolvedValue({});
  extractAffiliateOrderIdMock.mockReset();
  normalizeSourceChannelMock.mockReset().mockReturnValue(null);
  fetchSubscriptionSnapshotMock.mockReset();
  webhookLoggerMock.error.mockClear();
  webhookLoggerMock.warn.mockClear();
  webhookLoggerMock.info.mockClear();
  webhookLoggerMock.debug.mockClear();
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({
    admin: { graphql: graphqlMock },
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.tsx — catch-all
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.tsx — catch-all branch coverage", () => {
  it("CUSTOMERS_REDACT: try-block error is caught + logged (line 148-149 catch)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "boom@x.com" } },
    });
    // Throw inside the redact try-block (after entering the case).
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("redact db down"));
    const res = await catchAllAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "CUSTOMERS_REDACT",
        shop: "store.myshopify.com",
        err: expect.objectContaining({ message: "redact db down" }),
      }),
      "Shopify customer redact webhook failed",
    );
  });

  it("CUSTOMERS_DATA_REQUEST: try-block error is caught + logged", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "x@x.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("data req down"));
    const res = await catchAllAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "CUSTOMERS_DATA_REQUEST",
        shop: "store.myshopify.com",
        err: expect.objectContaining({ message: "data req down" }),
      }),
      "Shopify customer data request webhook failed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.draft-orders.update.tsx
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.draft-orders.update — branch coverage", () => {
  it("payload missing `name` triggers nullish-coalesce branch on line 22 + early-returns", async () => {
    // p.name is absent → orderNameRaw = "" → orderName = "" → early return BEFORE
    // the shop.findUnique try-block (covers the `?? ""` falsy branch).
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { status: "completed", order_id: 1 },
    });
    const res = await draftOrdersAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.orders.create.tsx — happy path lines 63-66 + 103-131
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.orders.create — happy path branch coverage", () => {
  it("full Fynd flow: writes metafield + upserts mapping (lines 63-66, 109-127)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/9001",
        id: 9001,
        name: "#1234",
        note_attributes: [
          { name: "fynd_order_id", value: "F-9001" },
          { name: "other", value: "noise" },
        ],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-9001");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });

    const res = await ordersCreateAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // The note_attributes array branch was taken (line 63-66 mapped).
    expect(extractAffiliateOrderIdMock).toHaveBeenCalledWith([
      { key: "fynd_order_id", value: "F-9001" },
      { key: "other", value: "noise" },
    ]);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.create.fyndOrderId).toBe("F-9001");
    expect(upsertArg.create.shopifyOrderId).toBe("gid://shopify/Order/9001");
    expect(upsertArg.update.fyndOrderId).toBe("F-9001");
  });

  it("metafield write throws → still upserts mapping (covers inner catch + outer success)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        id: 9002, // no admin_graphql_api_id → exercises orderGid ?? gid (line 75)
        name: "#1235",
        note_attributes: [{ name: "fynd_order_id", value: "F-9002" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-9002");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    graphqlMock.mockRejectedValueOnce(new Error("graphql 500"));

    const res = await ordersCreateAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.create.shopifyOrderId).toBe("gid://shopify/Order/9002");
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "ORDERS_CREATE",
        shop: "store.myshopify.com",
        orderName: "#1235",
        fyndOrderId: "F-9002",
        err: expect.objectContaining({ message: "graphql 500" }),
      }),
      "Order create metafield write failed",
    );
  });

  it("upsert throws → outer catch logs + still 200 (lines 128-132)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/9003",
        name: "#1236",
        note_attributes: [{ name: "fynd_order_id", value: "F-9003" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-9003");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.fyndOrderMapping.upsert.mockRejectedValueOnce(new Error("unique_violation"));

    const res = await ordersCreateAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "ORDERS_CREATE",
        shop: "store.myshopify.com",
        err: expect.objectContaining({ message: "unique_violation" }),
      }),
      "Order create webhook failed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.orders.fulfilled.tsx — outer catch + edge branches
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.orders.fulfilled — branch coverage", () => {
  it("outer catch: non-Error thrown deep in flow → logs String(err) (lines 137-138)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#3001",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    // Reject with non-Error from returnCase.findMany so the outer catch hits the
    // `String(err)` branch.
    prismaMock.returnCase.findMany.mockImplementationOnce(async () => {
      throw "raw-string-error";
    });

    const res = await ordersFulfilledAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "ORDERS_FULFILLED",
        shop: "store.myshopify.com",
        err: "raw-string-error",
      }),
      "Order fulfilled webhook failed",
    );
  });

  it("Fynd update path: gid present in update body via spread (line 96 truthy)", async () => {
    // Existing tests cover the create path; this test triggers the update spread
    // by ensuring upsert isn't a throw and the mapping path resolves cleanly,
    // exercising the `...(gid ? { shopifyOrderId: gid } : {})` truthy spread.
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/42",
        name: "#3002",
        note_attributes: [{ name: "fynd_order_id", value: "F-42" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-42");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await ordersFulfilledAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.update.shopifyOrderId).toBe("gid://shopify/Order/42");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.orders.updated.tsx — outer catch + sourceChannel backfill failure
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.orders.updated — branch coverage", () => {
  it("sourceChannel backfill updateMany throws → caught (lines 170-175)", async () => {
    normalizeSourceChannelMock.mockReturnValueOnce("fynd");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#4001",
        source_name: "fynd",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.updateMany.mockRejectedValueOnce(new Error("backfill failed"));

    const res = await ordersUpdatedAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "ORDERS_UPDATED",
        shop: "store.myshopify.com",
        orderName: "4001",
        err: expect.objectContaining({ message: "backfill failed" }),
      }),
      "Order updated source channel backfill failed",
    );
  });

  it("outer catch: non-Error thrown → logs stringified (lines 177-181)", async () => {
    normalizeSourceChannelMock.mockReturnValueOnce("fynd");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#4002",
        source_name: "fynd",
        cancelled_at: "2026-01-01",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockImplementationOnce(async () => {
      throw "non-error-thrown";
    });

    const res = await ordersUpdatedAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "ORDERS_UPDATED",
        shop: "store.myshopify.com",
        err: "non-error-thrown",
      }),
      "Order updated webhook failed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// webhooks.app-subscriptions.update.tsx — non-Error catches
// ─────────────────────────────────────────────────────────────────────────
describe("webhooks.app-subscriptions.update — non-Error branches", () => {
  it("auth catch: non-Error thrown → logs String(err) (lines 31-32)", async () => {
    authenticateWebhookMock.mockImplementationOnce(async () => {
      throw "auth-string-fail";
    });
    const res = await appSubscriptionsAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        err: "auth-string-fail",
      }),
      "App subscription update webhook authentication failed",
    );
  });

  it("outer catch: non-Error thrown → logs String(err) (lines 63-64)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com" });
    shopifyModuleMock.unauthenticated.admin.mockImplementationOnce(async () => {
      throw "outer-string-fail";
    });
    const res = await appSubscriptionsAction({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop: "store.myshopify.com",
        err: "outer-string-fail",
      }),
      "App subscription update failed",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// api.webhooks.fynd.ts — non-Error catches + Number.isFinite false branch
// ─────────────────────────────────────────────────────────────────────────
describe("api.webhooks.fynd — security/branch coverage", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.FYND_WEBHOOK_SECRET;
    process.env.NODE_ENV = "test";
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadFyndAction() {
    vi.doMock("../../lib/fynd-webhook.server", () => ({
      processFyndWebhook: vi.fn().mockResolvedValue({ ok: true, action: "noop" }),
      unwrapFyndWebhookPayload: (raw: string) => ({
        payload: JSON.parse(raw),
        eventType: undefined,
      }),
    }));
    vi.doMock("../../db.server", () => ({
      default: {
        fyndWebhookLog: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "log-1" }),
        },
      },
    }));
    const mod = await import("../api.webhooks.fynd");
    return mod.action;
  }

  it("non-numeric content-length header skips the cheap pre-check (Number.isFinite false branch)", async () => {
    const action = await loadFyndAction();
    const body = JSON.stringify({ shipment_id: "s1", refund_status: "refund_done" });
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": "not-a-number",
    });
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      body,
      headers,
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    // Should not reject as 413 — passes through to processing.
    expect(res.status).not.toBe(413);
  });

  it("parse error catch: non-Error thrown → still logs (line 82 String(err))", async () => {
    // Force unwrapFyndWebhookPayload to throw a non-Error value.
    vi.doMock("../../lib/fynd-webhook.server", () => ({
      processFyndWebhook: vi.fn(),
      unwrapFyndWebhookPayload: () => {
        throw "parse-string-fail";
      },
    }));
    vi.doMock("../../db.server", () => ({
      default: {
        fyndWebhookLog: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "log-1" }),
        },
      },
    }));
    const mod = await import("../api.webhooks.fynd");
    const action = mod.action;
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      body: "{}",
      headers: new Headers({ "content-type": "application/json" }),
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid JSON");
  });

  it("processFyndWebhook handler catch: non-Error thrown → logs String(err) (line 142)", async () => {
    vi.doMock("../../lib/fynd-webhook.server", () => ({
      processFyndWebhook: vi.fn().mockImplementation(() => {
        throw "handler-string-fail";
      }),
      unwrapFyndWebhookPayload: (raw: string) => ({
        payload: JSON.parse(raw),
        eventType: undefined,
      }),
    }));
    vi.doMock("../../db.server", () => ({
      default: {
        fyndWebhookLog: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "log-1" }),
        },
      },
    }));
    const mod = await import("../api.webhooks.fynd");
    const action = mod.action;
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      body: JSON.stringify({ shipment_id: "x", refund_status: "refund_done" }),
      headers: new Headers({ "content-type": "application/json" }),
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
