import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  extractAffiliateOrderIdMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  extractAffiliateOrderIdMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const mapping = (prismaMock as unknown as Record<string, Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>>).fyndOrderMapping;
  Object.values(mapping).forEach((fn) => {
    fn.mockReset();
    fn.mockResolvedValue(fn === mapping.findMany ? [] : {});
  });
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  extractAffiliateOrderIdMock.mockReset();
});

function mkReq() {
  return new Request("https://app.example/webhooks/orders/create", { method: "POST" });
}

describe("webhooks.orders.create", () => {
  it("200 + no-op on authentication Response (HMAC failure re-thrown)", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockRejectedValueOnce(new Response("unauthorised", { status: 401 }));
    await expect(action({ request: mkReq(), params: {}, context: {} } as never))
      .rejects.toBeInstanceOf(Response);
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockRejectedValueOnce(new Error("network"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("no-op when payload missing required fields", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "s", payload: { id: 1 } });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(extractAffiliateOrderIdMock).not.toHaveBeenCalled();
  });

  it("fast path: skips everything when no Fynd affiliate ID", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "s",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#1001",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("happy path: writes metafield + upserts FyndOrderMapping", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    const graphqlMock = vi.fn().mockResolvedValue({});
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: { graphql: graphqlMock } });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(graphqlMock).toHaveBeenCalled();
    const mapping = (prismaMock as unknown as Record<string, Record<string, { mock: { calls: unknown[] } }>>).fyndOrderMapping;
    expect(mapping.upsert.mock.calls.length).toBeGreaterThan(0);
  });

  it("still upserts mapping when metafield GraphQL write throws", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("shopify down"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const mapping = (prismaMock as unknown as Record<string, Record<string, { mock: { calls: unknown[] } }>>).fyndOrderMapping;
    expect(mapping.upsert.mock.calls.length).toBeGreaterThan(0);
  });

  it("constructs GID from numeric id when admin_graphql_api_id missing", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "s",
      payload: {
        id: 123, name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const graphqlMock = vi.fn().mockResolvedValue({});
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: { graphql: graphqlMock } });

    await action({ request: mkReq(), params: {}, context: {} } as never);
    const call = graphqlMock.mock.calls[0][1];
    expect(call.variables.input.id).toBe("gid://shopify/Order/123");
  });

  it("swallows outer DB error and returns 200", async () => {
    const { action } = await import("../webhooks.orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "s",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1", name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
