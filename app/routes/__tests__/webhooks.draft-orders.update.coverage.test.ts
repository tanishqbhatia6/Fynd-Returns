/**
 * Coverage-focused tests for webhooks.draft-orders.update.tsx.
 *
 * Targets the previously uncovered branches (lines 32-80 in source):
 *   - status === "completed" → fyndOrderMapping.updateMany + returnCase.updateMany
 *   - status === "completed" without order_id (no mapping update)
 *   - status === "completed" with mapping updateMany throwing (caught & swallowed)
 *   - status === "completed" with returnCase backfill throwing (caught & swallowed)
 *   - status === "open" → no-op (skipped completion + cancellation branches)
 *   - status === "invoiced" → no-op
 *   - status === "cancelled" → cancel pending/initiated returns + emit return events
 *   - status === "cancelled" with already-cancelled rc skipped via continue
 *   - status === "cancelled" preserves existing sourceChannel (no override)
 *   - non-Error thrown by prisma → console.error stringifies the value
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

import { action } from "../webhooks.draft-orders.update";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("webhooks.draft-orders.update — coverage", () => {
  it("completed: updates fyndOrderMapping with realOrderGid + backfills sourceChannel", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-100", status: "completed", order_id: 555 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "store.myshopify.com",
    });
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.updateMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1", shopifyOrderName: "#D-100" },
      data: {
        shopifyOrderId: "gid://shopify/Order/555",
        searchStrategy: "draft_order_completed",
      },
    });
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_1",
        shopifyOrderName: { contains: "D-100" },
        sourceChannel: null,
      },
      data: { sourceChannel: "draft_order" },
    });
  });

  it("completed: links exchange return from draft order gid to real order gid", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        id: 1234,
        admin_graphql_api_id: "gid://shopify/DraftOrder/1234",
        name: "#D-EX",
        status: "completed",
        order_id: 9876,
        order_name: "#EX-9876",
      },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_exchange",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc_exchange", exchangeOrderId: "gid://shopify/DraftOrder/1234" },
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);

    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc_exchange" },
      data: {
        exchangeOrderId: "gid://shopify/Order/9876",
        exchangeOrderName: "#EX-9876",
      },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        returnCaseId: "rc_exchange",
        eventType: "exchange_order_completed",
      }),
    });
  });

  it("completed: no order_id → skips mapping update but still backfills sourceChannel", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "D-200", status: "completed" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_2",
      shopDomain: "store.myshopify.com",
    });
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.updateMany).not.toHaveBeenCalled();
    // orderNameRaw was "D-200" (no leading #) → falsy guard uses `#${orderName}`
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalled();
  });

  it("completed: orderNameRaw empty after trim, but order_id exists → still uses #orderName fallback when raw is falsy", async () => {
    // Edge case: orderNameRaw = "#X" → orderName = "X", so falsy fallback path
    // for shopifyOrderName isn't used (orderNameRaw is truthy). To exercise the
    // `|| \`#${orderName}\`` fallback, raw must be falsy. With `name: "#"`, raw
    // becomes "#" → orderName = "". Then early return triggers. So the fallback
    // is effectively defensive — exercise via name without leading hash.
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "DRAFT-9", status: "completed", order_id: "777" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_3",
      shopDomain: "store.myshopify.com",
    });
    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.fyndOrderMapping.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop_3", shopifyOrderName: "DRAFT-9" },
        data: expect.objectContaining({
          shopifyOrderId: "gid://shopify/Order/777",
        }),
      }),
    );
  });

  it("completed: fyndOrderMapping.updateMany throws → swallowed, returnCase backfill still runs", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-300", status: "completed", order_id: 1 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_4",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.fyndOrderMapping.updateMany.mockRejectedValueOnce(new Error("fk violation"));
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalled();
  });

  it("completed: returnCase.updateMany throws → swallowed, still 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-400", status: "completed", order_id: 2 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_5",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.updateMany.mockRejectedValueOnce(new Error("return backfill fail"));
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("status=open → skips both completed + cancellation branches", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-500", status: "open" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_6",
      shopDomain: "store.myshopify.com",
    });
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("status=invoiced → skips cancellation branch", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-600", status: "invoiced" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_7",
      shopDomain: "store.myshopify.com",
    });
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("status=cancelled → cancels pending/initiated returns + emits return events", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-700", status: "cancelled" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_8",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc_1", status: "pending", sourceChannel: null },
      { id: "rc_2", status: "initiated", sourceChannel: "manual" },
    ]);
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop_8",
        shopifyOrderName: { contains: "D-700" },
        status: { in: ["pending", "initiated"] },
      },
    });
    // First rc had no sourceChannel → set to "draft_order"
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc_1" },
      data: {
        status: "cancelled",
        adminNotes: "Auto-cancelled: draft order cancelled on Shopify",
        sourceChannel: "draft_order",
      },
    });
    // Second rc had existing sourceChannel "manual" → preserved (no override)
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc_2" },
      data: {
        status: "cancelled",
        adminNotes: "Auto-cancelled: draft order cancelled on Shopify",
      },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(2);
    const callArgs = prismaMock.returnEvent.create.mock.calls[0][0];
    expect(callArgs.data.returnCaseId).toBe("rc_1");
    expect(callArgs.data.source).toBe("shopify_webhook");
    expect(callArgs.data.eventType).toBe("auto_cancelled");
    const parsed = JSON.parse(callArgs.data.payloadJson);
    expect(parsed.reason).toBe("draft_order_cancelled");
    expect(parsed.order_name).toBe("D-700");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("status=cancelled → already-cancelled rc is skipped via `continue`", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-800", status: "deleted" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_9",
      shopDomain: "store.myshopify.com",
    });
    // Even though findMany filters out cancelled, the in-loop guard adds
    // defensive coverage. Simulate it being returned anyway.
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc_skip", status: "cancelled", sourceChannel: "draft_order" },
      { id: "rc_keep", status: "pending", sourceChannel: null },
    ]);
    await action({ request: mkReq(), params: {}, context: {} } as never);
    // Only rc_keep should be updated
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "rc_keep" } }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(1);
  });

  it("non-Error thrown by prisma → console.error logs raw value (Error branch false)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-900", status: "cancelled" },
    });
    // Throw a plain string (non-Error) from inside the try block.
    prismaMock.shop.findUnique.mockImplementationOnce(async () => {
      throw "string-thrown";
    });
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith("[webhook:draft_orders/update]", "string-thrown");
  });

  it("non-string non-Error thrown → console.error logs raw object", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-901", status: "cancelled" },
    });
    const weird = { code: 42 };
    prismaMock.shop.findUnique.mockImplementationOnce(async () => {
      throw weird;
    });
    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(errorSpy).toHaveBeenCalledWith("[webhook:draft_orders/update]", weird);
  });

  it("Error thrown deep inside cancellation loop → caught at outer try, logs message", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-902", status: "cancelled" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_x",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("findMany boom"));
    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith("[webhook:draft_orders/update]", "findMany boom");
  });
});
