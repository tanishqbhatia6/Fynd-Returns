/**
 * Tests for webhooks.customers.redact.tsx — GDPR customer redaction handler.
 * Source does NOT wrap authenticate.webhook in try/catch, so non-Response
 * auth errors propagate. Downstream DB work IS wrapped, so DB errors are
 * swallowed and the handler returns 200.
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

import { action } from "../webhooks.customers.redact";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
});

describe("webhooks.customers.redact", () => {
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

  it("returns 200 on shop not found — nothing to redact", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: { customer: { id: 1, email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("returns 200 with no email and no phone (no identifiers, skip)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { id: 1 } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors during redaction and returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { id: 1, email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db blew up"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 when customer has identifiers but no matching cases", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { id: 1, email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
  });
});
