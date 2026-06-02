/**
 * Coverage-focused tests for webhooks.orders.updated.tsx — drives lines
 * 79-171 of the action handler that the existing fast-path test file
 * doesn't reach. Specifically:
 *
 *   • Fynd order id branch — gid resolution from `admin_graphql_api_id`,
 *     fallback to `p.id`, and the no-id case.
 *   • Metafield mutation success + failure (best-effort try/catch).
 *   • fyndOrderMapping.upsert success + failure paths.
 *   • Cancellation processing for cancelled_at, financial_status=refunded,
 *     and financial_status=voided.
 *   • returnCase iteration: idempotency skip when already cancelled,
 *     sourceChannel backfill on update.
 *   • Non-cancellation sourceChannel backfill via updateMany — success
 *     and the inner-catch failure path.
 *   • Top-level catch around the whole processing block.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  graphqlMock,
  extractAffiliateOrderIdMock,
  normalizeSourceChannelMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  graphqlMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  extractAffiliateOrderIdMock: vi.fn(),
  normalizeSourceChannelMock: vi.fn<(...args: unknown[]) => string | null>(() => null),
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

import { action } from "../webhooks.orders.updated";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  graphqlMock
    .mockReset()
    .mockResolvedValue({ data: { orderUpdate: { order: { id: "gid://x" } } } });
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({ admin: { graphql: graphqlMock } });
  extractAffiliateOrderIdMock.mockReset();
  normalizeSourceChannelMock.mockReset().mockReturnValue(null);
});

describe("webhooks.orders.updated coverage", () => {
  it("fynd id with admin_graphql_api_id: writes metafield + upserts mapping", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/123",
        id: 123,
        name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(shopifyModuleMock.unauthenticated.admin).toHaveBeenCalledWith("store.myshopify.com");
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0][0];
    expect(upsertArg.create.shopifyOrderId).toBe("gid://shopify/Order/123");
    expect(upsertArg.update).toMatchObject({
      fyndOrderId: "F-1",
      shopifyOrderId: "gid://shopify/Order/123",
    });
  });

  it("fynd id falls back to p.id when admin_graphql_api_id missing", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        id: 999,
        name: "1002",
        note_attributes: [{ name: "fynd_order_id", value: "F-2" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-2");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const variables = graphqlMock.mock.calls[0][1].variables;
    expect(variables.input.id).toBe("gid://shopify/Order/999");
  });

  it("fynd id with no admin id and no p.id: skips metafield, still upserts mapping", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#1003",
        note_attributes: [{ name: "fynd_order_id", value: "F-3" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-3");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(graphqlMock).not.toHaveBeenCalled();
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.fyndOrderMapping.upsert.mock.calls[0][0];
    expect(upsertArg.create.shopifyOrderId).toBeUndefined();
    expect(upsertArg.update).toEqual({ fyndOrderId: "F-3" });
  });

  it("metafield mutation failure is swallowed and upsert still runs", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/123",
        name: "#1004",
        note_attributes: [{ name: "fynd_order_id", value: "F-4" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-4");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    graphqlMock.mockRejectedValueOnce(new Error("graphql down"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
  });

  it("upsert failure is swallowed (caught + logged)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/55",
        name: "#1005",
        note_attributes: [{ name: "fynd_order_id", value: "F-5" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-5");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.fyndOrderMapping.upsert.mockRejectedValueOnce(new Error("unique violation"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("cancelled_at: cancels matching pending/initiated returns and writes events", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#2001",
        cancelled_at: "2026-05-01T00:00:00Z",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", sourceChannel: null },
      { id: "rc-2", status: "initiated", sourceChannel: "shopify" },
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(2);
    const firstUpdateData = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(firstUpdateData.status).toBe("cancelled");
    expect(firstUpdateData.adminNotes).toContain("cancelled");
  });

  it("financial_status=refunded: cancels with refunded reason, applies sourceChannel backfill", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#2002",
        financial_status: "refunded",
        source_name: "web",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce("shopify");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-3", status: "pending", sourceChannel: null },
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.adminNotes).toContain("refunded");
    expect(data.sourceChannel).toBe("shopify");
    const evtPayload = JSON.parse(prismaMock.returnEvent.create.mock.calls[0][0].data.payloadJson);
    expect(evtPayload.reason).toBe("order_refunded");
  });

  it("financial_status=voided: triggers cancellation path", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#2003",
        financial_status: "voided",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-4", status: "pending", sourceChannel: null },
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    const evtPayload = JSON.parse(prismaMock.returnEvent.create.mock.calls[0][0].data.payloadJson);
    expect(evtPayload.reason).toBe("order_voided");
  });

  it("idempotency: already-cancelled returns are skipped", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#2004",
        cancelled_at: "2026-05-01T00:00:00Z",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-x", status: "cancelled", sourceChannel: null },
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
  });

  it("non-cancellation sourceChannel backfill: calls updateMany when only sourceChannel present", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#3001",
        financial_status: "paid",
        source_name: "web",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce("shopify");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.returnCase.updateMany.mock.calls[0][0];
    expect(arg.data).toEqual({ sourceChannel: "shopify" });
  });

  it("fulfilled exchange order update completes the matching exchange return", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/7777",
        name: "#EX-7777",
        fulfillment_status: "fulfilled",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-exchange" }]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);

    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-exchange" },
      data: { status: "completed", refundStatus: "exchanged" },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        returnCaseId: "rc-exchange",
        eventType: "exchange_completed",
      }),
    });
  });

  it("non-cancellation sourceChannel backfill: updateMany failure is swallowed", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#3002",
        financial_status: "paid",
        source_name: "web",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce("shopify");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.updateMany.mockRejectedValueOnce(new Error("db oops"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("top-level catch: returnCase.findMany throws during cancellation processing", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#4001",
        cancelled_at: "2026-05-01T00:00:00Z",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("findMany failed"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("name normalization: strips leading # and uses order_number fallback", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        order_number: 5001,
        cancelled_at: "2026-05-01T00:00:00Z",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(where.shopifyOrderName.contains).toBe("5001");
  });

  it("empty/whitespace order name short-circuits before DB", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "   ",
        order_number: "",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });
});
