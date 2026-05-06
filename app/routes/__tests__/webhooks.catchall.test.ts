import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());
// Models used by redact paths that aren't in base factory
const extraModels = ["notificationLog", "fyndOrderMapping"] as const;
for (const m of extraModels) {
  (prismaMock as unknown as Record<string, unknown>)[m] = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  };
}

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

import { action } from "../webhooks";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  for (const m of extraModels) {
    const model = (
      prismaMock as unknown as Record<
        string,
        Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>
      >
    )[m];
    Object.values(model).forEach((fn) => {
      fn.mockReset();
      if (fn === model.findMany) fn.mockResolvedValue([]);
      else fn.mockResolvedValue({ count: 0 });
    });
  }
  authenticateWebhookMock.mockReset();
});

function mkReq() {
  return new Request("https://app.example/webhooks", { method: "POST" });
}

describe("GDPR catch-all webhook handler", () => {
  it("CUSTOMERS_DATA_REQUEST: logs without mutating data", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "Jane@X.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1", items: [], events: [] }]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_DATA_REQUEST: skips DB lookup when shop not found", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "x@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_DATA_REQUEST: swallows DB errors", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "x@x.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("CUSTOMERS_REDACT: redacts PII on matching return cases + cascades to logs", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "jane@x.com", id: 12345 } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }, { id: "rc-2" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([{ id: "log-1" }]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerName: "[redacted]" }),
      }),
    );
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customerEmail: null }),
      }),
    );
  });

  it("CUSTOMERS_REDACT: skips when no matching conditions (no email + no id)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: {} },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT: swallows DB errors", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "x@x.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("SHOP_REDACT: cascades delete across all shop models", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnItem.deleteMany).toHaveBeenCalled();
    expect(prismaMock.returnEvent.deleteMany).toHaveBeenCalled();
    expect(prismaMock.returnCase.deleteMany).toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.deleteMany).toHaveBeenCalled();
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalled();
    expect(prismaMock.apiKey.deleteMany).toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.deleteMany).toHaveBeenCalled();
    expect(prismaMock.shopSettings.deleteMany).toHaveBeenCalled();
    expect(prismaMock.session.deleteMany).toHaveBeenCalled();
    expect(prismaMock.shop.delete).toHaveBeenCalled();
  });

  it("SHOP_REDACT: skips return-scoped deletes when shop has no return cases", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnItem.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.shop.delete).toHaveBeenCalled();
  });

  it("SHOP_REDACT: swallows DB errors", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("unknown topic: logs + returns empty 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "PRODUCTS_CREATE",
      shop: "store.myshopify.com",
      payload: {},
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });
});
