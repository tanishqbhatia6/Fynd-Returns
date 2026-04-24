import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());
// Add extra models the webhook redact handlers use
const extraModels = ["fyndOrderMapping", "notificationLog"] as const;
for (const m of extraModels) {
  (prismaMock as unknown as Record<string, unknown>)[m] = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

beforeEach(() => {
  resetPrismaMock(prismaMock);
  for (const m of extraModels) {
    const model = (prismaMock as unknown as Record<string, Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>>)[m];
    Object.values(model).forEach((fn) => {
      fn.mockReset();
      if (fn === model.findMany) fn.mockResolvedValue([]);
      else fn.mockResolvedValue({ count: 0 });
    });
  }
  authenticateWebhookMock.mockReset();
});

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

describe("webhooks.app.uninstalled", () => {
  it("deletes sessions when session present", async () => {
    const { action } = await import("../webhooks.app.uninstalled");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com", session: { id: "sess-1" },
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({ where: { shop: "store.myshopify.com" } });
  });

  it("no-op when session absent", async () => {
    const { action } = await import("../webhooks.app.uninstalled");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", session: null });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors", async () => {
    const { action } = await import("../webhooks.app.uninstalled");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com", session: { id: "sess-1" },
    });
    prismaMock.session.deleteMany.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("webhooks.app.scopes_update", () => {
  it("just authenticates and returns 200", async () => {
    const { action } = await import("../webhooks.app.scopes_update");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "s" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateWebhookMock).toHaveBeenCalled();
  });
});

describe("webhooks.customers.data_request", () => {
  it("looks up return cases but does not mutate", async () => {
    const { action } = await import("../webhooks.customers.data_request");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com", id: 12345 } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1", items: [], events: [] }]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
  });

  it("skips findMany when shop not found", async () => {
    const { action } = await import("../webhooks.customers.data_request");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("skips findMany when no conditions (empty payload)", async () => {
    const { action } = await import("../webhooks.customers.data_request");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com", payload: { customer: {} },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors", async () => {
    const { action } = await import("../webhooks.customers.data_request");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("webhooks.shop.redact", () => {
  it("deletes all shop data when shop found", async () => {
    const { action } = await import("../webhooks.shop.redact");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: {} });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.delete).toHaveBeenCalled();
  });

  it("no-op when shop not found", async () => {
    const { action } = await import("../webhooks.shop.redact");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: {} });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.delete).not.toHaveBeenCalled();
  });

  it("swallows DB errors", async () => {
    const { action } = await import("../webhooks.shop.redact");
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: {} });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("webhooks.customers.redact", () => {
  it("redacts matching return cases", async () => {
    const { action } = await import("../webhooks.customers.redact");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com", id: 12345 } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalled();
  });

  it("no-op when shop not found", async () => {
    const { action } = await import("../webhooks.customers.redact");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("swallows DB errors", async () => {
    const { action } = await import("../webhooks.customers.redact");
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { email: "u@x.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
