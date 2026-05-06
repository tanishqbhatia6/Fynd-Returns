import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  fetchSubscriptionSnapshotMock,
  extractAffiliateOrderIdMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  fetchSubscriptionSnapshotMock: vi.fn(),
  extractAffiliateOrderIdMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
};

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/billing.server", () => ({
  fetchSubscriptionSnapshot: fetchSubscriptionSnapshotMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const mapping = (
    prismaMock as unknown as Record<
      string,
      Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>
    >
  ).fyndOrderMapping;
  Object.values(mapping).forEach((fn) => {
    fn.mockReset();
    fn.mockResolvedValue(fn === mapping.findMany ? [] : {});
  });
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  fetchSubscriptionSnapshotMock.mockReset();
  extractAffiliateOrderIdMock.mockReset();
});

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

describe("webhooks.app-subscriptions.update", () => {
  it("caches subscription snapshot on ShopSettings", async () => {
    const { action } = await import("../webhooks.app-subscriptions.update");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com" });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: {} });
    fetchSubscriptionSnapshotMock.mockResolvedValueOnce({
      status: "ACTIVE",
      name: "ReturnProMax Pro",
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1" },
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionStatus: "ACTIVE",
          subscriptionName: "ReturnProMax Pro",
        }),
      }),
    );
  });

  it("swallows auth errors that aren't Response", async () => {
    const { action } = await import("../webhooks.app-subscriptions.update");
    authenticateWebhookMock.mockRejectedValueOnce(new Error("network"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("re-throws Response auth errors", async () => {
    const { action } = await import("../webhooks.app-subscriptions.update");
    authenticateWebhookMock.mockRejectedValueOnce(new Response("unauth", { status: 401 }));
    await expect(
      action({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBeInstanceOf(Response);
  });

  it("no-op when shop has no settings row", async () => {
    const { action } = await import("../webhooks.app-subscriptions.update");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "s" });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: {} });
    fetchSubscriptionSnapshotMock.mockResolvedValueOnce({ status: "ACTIVE", name: "Pro" });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("swallows Shopify admin init failure", async () => {
    const { action } = await import("../webhooks.app-subscriptions.update");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "s" });
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("no session"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("webhooks.draft-orders.create", () => {
  it("caches mapping when fynd affiliate present", async () => {
    const { action } = await import("../webhooks.draft-orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/DraftOrder/1",
        name: "#D1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const mapping = (
      prismaMock as unknown as Record<string, Record<string, { mock: { calls: unknown[] } }>>
    ).fyndOrderMapping;
    expect(mapping.upsert.mock.calls.length).toBeGreaterThan(0);
  });

  it("no-op when no fynd affiliate in payload", async () => {
    const { action } = await import("../webhooks.draft-orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "s",
      payload: {
        admin_graphql_api_id: "gid://x/1",
        name: "#D1001",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("no-op when payload lacks orderName or id", async () => {
    const { action } = await import("../webhooks.draft-orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "s", payload: { id: 1 } });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("swallows DB errors", async () => {
    const { action } = await import("../webhooks.draft-orders.create");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "s",
      payload: {
        admin_graphql_api_id: "gid://x/1",
        name: "#D1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
