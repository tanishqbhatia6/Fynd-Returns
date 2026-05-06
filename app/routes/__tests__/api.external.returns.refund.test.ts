import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
  dispatchWebhookEventMock,
  createRefundMock,
  createAdminClientMock,
  closeShopifyReturnMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  dispatchWebhookEventMock: vi.fn(),
  createRefundMock: vi.fn(),
  createAdminClientMock: vi.fn(() => ({})),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  createRefund: createRefundMock,
  createAdminClient: createAdminClientMock,
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
}));

import { action } from "../api.v1.external.returns.$id.refund";

function mkReq(method: string = "POST", body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://app.example/api/v1/external/returns/rc-1/refund", init);
}

function approvedReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "approved",
    refundStatus: null,
    returnRequestNo: "R-1",
    shopifyOrderId: "gid://shopify/Order/123",
    currency: "USD",
    items: [{ shopifyLineItemId: "li-1", qty: 2 }],
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  dispatchWebhookEventMock.mockClear();
  createRefundMock.mockReset();
  createAdminClientMock.mockClear();
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/v1/external/returns/:id/refund", () => {
  it("405 on non-POST", async () => {
    const res = await action({
      request: mkReq("GET"),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(405);
  });

  it("429 on IP rate-limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("401 when auth fails", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: false,
      response: Response.json({}, { status: 401 }),
    });
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("400 when id missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 for unsupported refundMethod (discount_code explicitly rejected)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    const res = await action({
      request: mkReq("POST", { refundMethod: "discount_code" }),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/discount_code/);
  });

  it("404 when return not found for shop", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("400 when return not yet approved", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn({ status: "pending" }));
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("400 when already refunded", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      approvedReturn({ refundStatus: "refunded" }),
    );
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("500 when no Shopify session", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(500);
  });

  it("400 when createRefund returns failure", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({ success: false, error: "insufficient funds" });
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("insufficient funds");
  });

  it("200 on happy path — updates return, emits event + webhook, calls close best-effort", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "store_credit",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "gid://shopify/Refund/1",
      refundAmount: "42.00",
      refundCurrency: "USD",
    });

    const res = await action({
      request: mkReq("POST", { note: "api note" }),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.refundDetails.amount).toBe("42.00");
    expect(body.data.refundDetails.method).toBe("store_credit");

    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundStatus: "refunded", status: "completed" }),
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalled();
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.refunded",
      expect.objectContaining({ returnId: "rc-1", amount: "42.00" }),
    );
    expect(closeShopifyReturnMock).toHaveBeenCalled();
  });

  it("coerces legacy discount_code stored setting to original", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "discount_code",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({ success: true, refundId: "r", refundAmount: "1.00" });

    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.refundDetails.method).toBe("original");
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      null,
      expect.objectContaining({ method: "original" }),
    );
  });

  it("500 on unexpected prisma error", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      keyId: "k-1",
      shopId: "shop-1",
      shopDomain: "s.myshopify.com",
    });
    prismaMock.returnCase.findFirst.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
