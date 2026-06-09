/**
 * Tests for webhooks.app.uninstalled.tsx — deletes the offline session row
 * for an uninstalled shop. Source does NOT wrap authenticate in try/catch,
 * so non-Response errors propagate (Shopify will retry the uninstall).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock, webhookLoggerMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  webhookLoggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));
vi.mock("../../lib/observability/logger.server", () => ({
  webhookLogger: webhookLoggerMock,
}));

import { action } from "../webhooks.app.uninstalled";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  webhookLoggerMock.error.mockClear();
  webhookLoggerMock.warn.mockClear();
  webhookLoggerMock.info.mockClear();
  webhookLoggerMock.debug.mockClear();
});

describe("webhooks.app.uninstalled", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(
      resp401,
    );
  });

  it("propagates non-Response auth errors (no try/catch in source)", async () => {
    const err = new Error("auth backend down");
    authenticateWebhookMock.mockRejectedValueOnce(err);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(err);
  });

  it("returns 200 with no session — does not touch DB", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      session: null,
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes sessions for the shop and returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      session: { id: "offline_x" },
    });
    prismaMock.session.deleteMany.mockResolvedValueOnce({ count: 1 });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { shop: "store.myshopify.com" },
    });
  });

  it("swallows session-delete DB errors and still returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      session: { id: "offline_x" },
    });
    prismaMock.session.deleteMany.mockRejectedValueOnce(new Error("DB down"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(webhookLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "APP_UNINSTALLED",
        shop: "store.myshopify.com",
        err: expect.objectContaining({ message: "DB down" }),
      }),
      "Failed to delete sessions",
    );
  });
});
