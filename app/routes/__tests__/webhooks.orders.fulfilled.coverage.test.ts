/**
 * Coverage-completion tests for webhooks.orders.fulfilled.tsx.
 *
 * Targets the previously-uncovered branches (lines 63-122):
 *   - Fynd metafield write path (with admin_graphql_api_id, with bare id, no gid).
 *   - GraphQL mutation throwing → caught error log path.
 *   - fyndOrderMapping.upsert success + thrown-error catch.
 *   - returnCase.findMany loop with: empty list, idempotent skip via recent
 *     event, and successful returnEvent.create for fresh returns.
 *   - fulfillment_status defaulting branch (missing field → "fulfilled").
 *
 * Companion to webhooks.orders.fulfilled.test.ts (which covers the auth +
 * early-return guard rails). Together these push statement coverage ≥95%.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  extractAffiliateOrderIdMock,
  graphqlMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  extractAffiliateOrderIdMock: vi.fn(),
  graphqlMock: vi.fn(),
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

import { action } from "../webhooks.orders.fulfilled";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

function callAction() {
  return action({ request: mkReq(), params: {}, context: {} } as never);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  extractAffiliateOrderIdMock.mockReset();
  graphqlMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({
    admin: { graphql: graphqlMock },
  });
  graphqlMock.mockResolvedValue({});
});

describe("webhooks.orders.fulfilled — Fynd metafield + mapping backfill", () => {
  it("writes metafield via admin_graphql_api_id and upserts mapping", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/999",
        id: 999,
        name: "#1001",
        fulfillment_status: "fulfilled",
        note_attributes: [{ name: "fynd_order_id", value: "F-OK" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-OK");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await callAction();
    expect(res.status).toBe(200);

    expect(shopifyModuleMock.unauthenticated.admin).toHaveBeenCalledWith("shop.myshopify.com");
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const [, options] = graphqlMock.mock.calls[0]!;
    expect(options.variables.input.id).toBe("gid://shopify/Order/999");
    expect(options.variables.input.metafields[0].value).toBe("F-OK");

    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.create.shopId).toBe("shop_1");
    expect(upsertArg.create.fyndOrderId).toBe("F-OK");
    expect(upsertArg.create.shopifyOrderId).toBe("gid://shopify/Order/999");
  });

  it("falls back to numeric id → constructed gid when admin_graphql_api_id missing", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        id: 555,
        name: "#1002",
        note_attributes: [{ name: "fynd_order_id", value: "F-2" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-2");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await callAction();
    const [, options] = graphqlMock.mock.calls[0]!;
    expect(options.variables.input.id).toBe("gid://shopify/Order/555");
  });

  it("skips metafield write entirely when neither admin_graphql_api_id nor id is present", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        name: "#1003",
        note_attributes: [{ name: "fynd_order_id", value: "F-3" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-3");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await callAction();
    expect(shopifyModuleMock.unauthenticated.admin).not.toHaveBeenCalled();
    // Mapping upsert still runs (without shopifyOrderId).
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.create.shopifyOrderId).toBeUndefined();
  });

  it("swallows GraphQL mutation errors and still upserts mapping", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/777",
        name: "#1004",
        note_attributes: [{ name: "fynd_order_id", value: "F-4" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-4");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    graphqlMock.mockRejectedValueOnce(new Error("graphql 500"));

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[webhook:orders/fulfilled] metafield write failed",
      expect.objectContaining({ fyndOrderId: "F-4" }),
    );
    errSpy.mockRestore();
  });

  it("swallows mapping upsert errors and continues to returnCase loop", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/888",
        name: "#1005",
        note_attributes: [{ name: "fynd_order_id", value: "F-5" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-5");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.fyndOrderMapping.upsert.mockRejectedValueOnce(new Error("unique violation"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalledWith(
      "[webhook:orders/fulfilled] mapping upsert failed",
      expect.objectContaining({ fyndOrderId: "F-5" }),
    );
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });

  it("uses synthesized #orderName when raw name is empty after trimming '#'", async () => {
    // p.name = "1006" (no #), so orderNameRaw === orderNameClean. The
    // upsert key uses `orderNameRaw || #orderNameClean` — the truthy
    // branch. Then with name="", order_number=2007 → orderNameRaw="2007".
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/2",
        order_number: 2007,
        note_attributes: [{ name: "fynd_order_id", value: "F-7" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-7");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await callAction();
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0]![0];
    expect(upsertArg.where.shopId_shopifyOrderName.shopifyOrderName).toBe("2007");
  });
});

describe("webhooks.orders.fulfilled — returnCase event loop", () => {
  it("creates a returnEvent for each ReturnCase when no recent event exists", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#2001",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc_1" }, { id: "rc_2" }]);
    prismaMock.returnEvent.findFirst.mockResolvedValue(null);

    await callAction();
    expect(prismaMock.returnEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(2);

    const created = prismaMock.returnEvent.create.mock.calls[0]![0];
    expect(created.data.eventType).toBe("order_fulfilled");
    expect(created.data.source).toBe("shopify_webhook");
    const parsed = JSON.parse(created.data.payloadJson);
    expect(parsed.fulfillment_status).toBe("fulfilled");
    expect(parsed.order_name).toBe("2001");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("marks a matching exchange return completed when the exchange order is fulfilled", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/9001",
        name: "#EX-9001",
        fulfillment_status: "fulfilled",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "rc_exchange" }]);

    await callAction();

    expect(prismaMock.returnCase.findMany.mock.calls[1]![0]).toEqual({
      where: {
        shopId: "shop_1",
        resolutionType: "exchange",
        exchangeOrderId: "gid://shopify/Order/9001",
        OR: [{ refundStatus: null }, { refundStatus: { notIn: ["exchanged", "refunded"] } }],
      },
      select: { id: true },
    });
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc_exchange" },
      data: { status: "completed", refundStatus: "exchanged" },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        returnCaseId: "rc_exchange",
        eventType: "exchange_completed",
        source: "shopify_webhook",
      }),
    });
  });

  it("idempotency: skips returnEvent.create when a recent event exists", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#2002",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc_1" }, { id: "rc_2" }]);
    // First case: recent dup → skip. Second: no dup → create.
    prismaMock.returnEvent.findFirst
      .mockResolvedValueOnce({ id: "ev_recent" })
      .mockResolvedValueOnce(null);

    await callAction();
    expect(prismaMock.returnEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(1);
  });

  it("respects custom fulfillment_status from payload (e.g. 'partial')", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#2003",
        fulfillment_status: "PARTIAL",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc_1" }]);
    prismaMock.returnEvent.findFirst.mockResolvedValueOnce(null);

    await callAction();
    const parsed = JSON.parse(prismaMock.returnEvent.create.mock.calls[0]![0].data.payloadJson);
    expect(parsed.fulfillment_status).toBe("partial");
  });

  it("handles non-array note_attributes by treating it as empty", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#2004",
        note_attributes: "not-an-array",
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(extractAffiliateOrderIdMock).toHaveBeenCalledWith([]);
  });

  it("logs and swallows errors thrown inside the event loop", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "shop.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#2005",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop_1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc_1" }]);
    prismaMock.returnEvent.findFirst.mockRejectedValueOnce(new Error("findFirst exploded"));

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(errSpy).toHaveBeenCalledWith(
      "[webhook:orders/fulfilled]",
      expect.objectContaining({ error: "findFirst exploded" }),
    );
    errSpy.mockRestore();
  });
});
