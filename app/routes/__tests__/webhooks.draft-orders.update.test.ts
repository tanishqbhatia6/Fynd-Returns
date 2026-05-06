/**
 * Tests for webhooks.draft-orders.update.tsx — handles draft-order
 * completion (mapping update) and cancellation (auto-cancel return cases).
 * Source does NOT wrap authenticate.webhook in try/catch — non-Response
 * auth errors propagate. Downstream errors ARE swallowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
});

describe("webhooks.draft-orders.update", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(
      resp401,
    );
  });

  it("propagates non-Response auth errors (no try/catch around authenticate)", async () => {
    const err = new Error("auth backend down");
    authenticateWebhookMock.mockRejectedValueOnce(err);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(err);
  });

  it("returns 200 when payload is missing/null", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: null,
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 when order name is empty (no DB lookup)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "", status: "completed" },
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 on shop not found (no upsert / cancel)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: { name: "#D-1", status: "completed", order_id: 99 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.updateMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors and still returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { name: "#D-1", status: "cancelled" },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db blew up"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
