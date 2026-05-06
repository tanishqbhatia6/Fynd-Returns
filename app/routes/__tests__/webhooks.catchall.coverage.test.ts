import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

// Models used by redact paths that aren't in the base PRISMA_MODELS exposed by
// the factory in older usage patterns. The factory already includes these now,
// but we still register fresh fns here so each test can assert / reset them
// without leaning on factory internals.
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

function callAction() {
  return action({ request: mkReq(), params: {}, context: {} } as never);
}

describe("webhooks catch-all — switch coverage", () => {
  // ───────────────────────── CUSTOMERS_DATA_REQUEST ─────────────────────────

  it("CUSTOMERS_DATA_REQUEST: normalises email to lowercase + trim before query", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "  Mixed@Case.COM  " } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shopId: "shop-1",
          OR: [{ customerEmailNorm: "mixed@case.com" }],
        }),
      }),
    );
  });

  it("CUSTOMERS_DATA_REQUEST: with missing email skips findMany (empty conditions)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: {} },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_DATA_REQUEST: with no customer object at all still returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  // ───────────────────────────── CUSTOMERS_REDACT ────────────────────────────

  it("CUSTOMERS_REDACT: shop not found short-circuits without any mutations", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "x@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT: matched shop but no return cases skips notificationLog delete", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "ghost@example.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]); // nobody to redact

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.lookupSession.deleteMany).not.toHaveBeenCalled();
    // notificationLog.deleteMany must NOT fire — branch exercised
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT: notificationLog delete fires with correct caseIds + shopId", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "jane@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1" },
      { id: "rc-2" },
      { id: "rc-3" },
    ]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    await callAction();
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        returnCaseId: { in: ["rc-1", "rc-2", "rc-3"] },
      },
    });
  });

  it("CUSTOMERS_REDACT: skips fyndWebhookLog.updateMany when findMany returns empty", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "jane@x.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]); // no fynd logs

    await callAction();
    expect(prismaMock.fyndWebhookLog.updateMany).not.toHaveBeenCalled();
    // notificationLog still deleted
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalled();
  });

  it("CUSTOMERS_REDACT: lookupSession.deleteMany only fires when email present", async () => {
    // Email is present here — covers the truthy branch alongside a returnCase match.
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_REDACT",
      shop: "store.myshopify.com",
      payload: { customer: { email: "Jane@X.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    await callAction();
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", lookupValueNorm: "jane@x.com" },
    });
  });

  // ─────────────────────────────── SHOP_REDACT ───────────────────────────────

  it("SHOP_REDACT: returns 200 and skips deletes when shop not found", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.shop.delete).not.toHaveBeenCalled();
  });

  it("SHOP_REDACT: notificationLog.deleteMany fires once with the shop id", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-42" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);

    await callAction();
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-42" },
    });
  });

  it("SHOP_REDACT: still deletes notification log + shop even when returnCases is empty", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-7" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await callAction();
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-7" },
    });
    // The early branch also covers fyndOrderMapping deleteMany
    expect(prismaMock.fyndOrderMapping.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop-7" },
    });
    expect(prismaMock.shop.delete).toHaveBeenCalled();
  });

  it("SHOP_REDACT: deletes happen in dependency-safe order (items+events before cases)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_REDACT",
      shop: "store.myshopify.com",
      payload: {},
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-9" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);

    await callAction();
    const itemsOrder = prismaMock.returnItem.deleteMany.mock.invocationCallOrder[0];
    const eventsOrder = prismaMock.returnEvent.deleteMany.mock.invocationCallOrder[0];
    const casesOrder = prismaMock.returnCase.deleteMany.mock.invocationCallOrder[0];
    expect(itemsOrder).toBeLessThan(casesOrder);
    expect(eventsOrder).toBeLessThan(casesOrder);
  });

  // ──────────────────────────────── default ───────────────────────────────────

  it("default branch: SHOP_UPDATE topic falls through with no DB ops", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "SHOP_UPDATE",
      shop: "store.myshopify.com",
      payload: { id: 1 },
    });

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("default branch: empty/undefined topic still returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: undefined,
      shop: "store.myshopify.com",
      payload: {},
    });

    const res = await callAction();
    expect(res.status).toBe(200);
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("default branch: response body is empty (per Shopify spec)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "BULK_OPERATIONS_FINISH",
      shop: "store.myshopify.com",
      payload: {},
    });
    const res = await callAction();
    const text = await res.text();
    expect(text).toBe("");
  });

  // ─────────────────────────── notification log delete ────────────────────────

  it("notification log delete: not invoked on unknown topic", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "PRODUCTS_UPDATE",
      shop: "store.myshopify.com",
      payload: {},
    });
    await callAction();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });

  it("notification log delete: not invoked on CUSTOMERS_DATA_REQUEST (read-only path)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      topic: "CUSTOMERS_DATA_REQUEST",
      shop: "store.myshopify.com",
      payload: { customer: { email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1", items: [], events: [] }]);

    await callAction();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
  });
});
