/**
 * Final-mile branch coverage for the v1 external API surface.
 *
 * Targets the residual uncovered branches reported by v8 across:
 *   - api.v1.external.returns.$id.approve.ts (rate-limit blocked, missing keyId)
 *   - api.v1.external.returns.$id.reject.ts  (rate-limit + auth.response 401)
 *   - api.v1.external.returns.$id.refund.ts  (missing keyId; result.error falsy)
 *   - api.v1.external.returns.ts             (missing keyId)
 *   - api.v1.external.webhooks.ts            (rate-limit/auth/per-key on POST,
 *                                             missing keyId on GET)
 *   - api.v1.external.webhooks.$id.ts        (missing keyId)
 *
 * Existing coverage tests are kept intact; this file adds only the
 * specific branches v8 still reported as uncovered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ── Hoisted mocks shared across all six SUTs ──────────────────────────────
const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  rateLimitResponseMock,
  checkPerKeyRateLimitMock,
  dispatchWebhookEventMock,
  createAdminClientMock,
  closeShopifyReturnMock,
  createRefundMock,
  isSafeOutboundUrlMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 100, retryAfterMs: 0 })),
  rateLimitResponseMock: vi.fn((ms: number) =>
    Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429, headers: { "Retry-After": String(Math.ceil(ms / 1000)) } }),
  ),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  dispatchWebhookEventMock: vi.fn(),
  createAdminClientMock: vi.fn(() => ({ admin: true })),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  createRefundMock: vi.fn(),
  isSafeOutboundUrlMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
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
  createAdminClient: createAdminClientMock,
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
  createRefund: createRefundMock,
}));
vi.mock("../../lib/url-safety.server", () => ({ isSafeOutboundUrl: isSafeOutboundUrlMock }));

import { action as approveAction } from "../api.v1.external.returns.$id.approve";
import { action as rejectAction } from "../api.v1.external.returns.$id.reject";
import { action as refundAction } from "../api.v1.external.returns.$id.refund";
import { loader as listReturnsLoader } from "../api.v1.external.returns";
import { loader as listWebhooksLoader, action as createWebhookAction } from "../api.v1.external.webhooks";
import { action as deleteWebhookAction } from "../api.v1.external.webhooks.$id";

// ── Helpers ───────────────────────────────────────────────────────────────
const CTX = { context: {} as never };

function postReq(url: string, body?: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "rpm_x" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function approvedRC(o: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "approved",
    refundStatus: null,
    returnRequestNo: "R-1",
    shopifyOrderId: "gid://shopify/Order/1",
    currency: "USD",
    items: [{ shopifyLineItemId: "li-1", qty: 1 }],
    ...o,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 100, retryAfterMs: 0 });
  rateLimitResponseMock.mockClear();
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  dispatchWebhookEventMock.mockClear();
  createAdminClientMock.mockClear();
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
  createRefundMock.mockReset();
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────
// approve.ts — rate-limit blocked + missing keyId fallback
// ──────────────────────────────────────────────────────────────────────────
describe("approve.ts residual branches", () => {
  it("returns 429 from global rate limit (rl.allowed === false)", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 750 });
    const res = await approveAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/approve"),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(429);
    expect(rateLimitResponseMock).toHaveBeenCalledWith(750);
    expect(authenticateApiKeyMock).not.toHaveBeenCalled();
  });

  it("falls back to 'anon' for per-key bucket when auth.keyId is missing AND returns the per-key 429", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true, shopId: "shop-1", shopDomain: "s.myshopify.com", keyId: undefined,
    });
    const perKeyResp = Response.json({ error: { code: "TOO_MANY" } }, { status: 429 });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(perKeyResp);

    const res = await approveAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/approve"),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res).toBe(perKeyResp);
    // anon fallback used
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.returns.approve",
      "anon",
    );
    // short-circuited before DB
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// reject.ts — extra coverage of auth.response + non-trivial fall-through
// (kept here so we have a single 15-25 file budget for the whole surface)
// ──────────────────────────────────────────────────────────────────────────
describe("reject.ts residual branches", () => {
  it("returns auth.response when authenticateApiKey rejects (auth.ok === false)", async () => {
    const authResp = Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: authResp });

    const res = await rejectAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/reject", { rejectionReason: "x" }),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res).toBe(authResp);
    // Per-key check + DB never reached
    expect(checkPerKeyRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("rejects rejectionReason longer than 500 chars (boundary +1)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true, shopId: "shop-1", shopDomain: "s.myshopify.com", keyId: "k1",
    });
    const res = await rejectAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/reject", {
        rejectionReason: "x".repeat(501),
      }),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/500 characters or less/);
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// refund.ts — missing keyId + result.error falsy fallback
// ──────────────────────────────────────────────────────────────────────────
describe("refund.ts residual branches", () => {
  it("uses 'anon' for per-key bucket when auth.keyId is missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true, shopId: "shop-1", shopDomain: "s.myshopify.com", keyId: undefined,
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedRC());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true, refundId: "r", refundAmount: "1.00", refundCurrency: "USD",
    });

    const res = await refundAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/refund"),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(200);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.returns.refund",
      "anon",
    );
  });

  it("falls back to 'Refund failed' when result.success=false AND result.error is undefined", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true, shopId: "shop-1", shopDomain: "s.myshopify.com", keyId: "k1",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedRC());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Note: no `error` field on the failure result
    createRefundMock.mockResolvedValueOnce({ success: false });

    const res = await refundAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/refund"),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Refund failed");
  });

  it("legacy 'discount_code' settings value is coerced to 'original' before reaching createRefund", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true, shopId: "shop-1", shopDomain: "s.myshopify.com", keyId: "k1",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedRC());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "discount_code" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true, refundId: "r", refundAmount: "1.00", refundCurrency: "USD",
    });

    const res = await refundAction({
      request: postReq("https://x/api/v1/external/returns/rc-1/refund"),
      params: { id: "rc-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(200);
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
});

// ──────────────────────────────────────────────────────────────────────────
// returns.ts (loader) — missing keyId fallback
// ──────────────────────────────────────────────────────────────────────────
describe("returns.ts (list) residual branches", () => {
  it("uses 'anon' for per-key bucket when auth.keyId is missing on the list endpoint", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, shopId: "shop-1", keyId: undefined });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    const res = await listReturnsLoader({
      request: new Request("https://x/api/v1/external/returns"),
      params: {},
      ...CTX,
    } as never);
    expect(res.status).toBe(200);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.returns.list",
      "anon",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// webhooks.ts — both loader/action remaining branches
// ──────────────────────────────────────────────────────────────────────────
describe("webhooks.ts residual branches", () => {
  it("loader uses 'anon' for per-key when auth.keyId missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, shopId: "shop-1", keyId: undefined });
    prismaMock.webhookSubscription.findMany.mockResolvedValueOnce([]);
    const res = await listWebhooksLoader({
      request: new Request("https://x/api/v1/external/webhooks"),
      params: {},
      ...CTX,
    } as never);
    expect(res.status).toBe(200);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.webhooks",
      "anon",
    );
  });

  it("action returns 429 from global rate limit (rl.allowed === false on POST)", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1500 });
    const res = await createWebhookAction({
      request: postReq("https://x/api/v1/external/webhooks", {
        url: "https://hook.example/h",
        events: ["return.created"],
      }),
      params: {},
      ...CTX,
    } as never);
    expect(res.status).toBe(429);
    expect(rateLimitResponseMock).toHaveBeenCalledWith(1500);
    expect(authenticateApiKeyMock).not.toHaveBeenCalled();
  });

  it("action returns auth.response when auth.ok=false on POST", async () => {
    const authResp = Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: authResp });
    const res = await createWebhookAction({
      request: postReq("https://x/api/v1/external/webhooks", {
        url: "https://hook.example/h",
        events: ["return.created"],
      }),
      params: {},
      ...CTX,
    } as never);
    expect(res).toBe(authResp);
    expect(checkPerKeyRateLimitMock).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("action uses 'anon' AND propagates per-key 429 when auth.keyId is missing on POST", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, shopId: "shop-1", keyId: undefined });
    const perKeyResp = Response.json({ error: { code: "TOO_MANY" } }, { status: 429 });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(perKeyResp);

    const res = await createWebhookAction({
      request: postReq("https://x/api/v1/external/webhooks", {
        url: "https://hook.example/h",
        events: ["return.created"],
      }),
      params: {},
      ...CTX,
    } as never);
    expect(res).toBe(perKeyResp);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.webhooks",
      "anon",
    );
    // Body parsing / DB never reached
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// webhooks.$id.ts — anon keyId fallback on DELETE
// ──────────────────────────────────────────────────────────────────────────
describe("webhooks.$id.ts residual branches", () => {
  it("uses 'anon' for per-key when auth.keyId is missing on DELETE", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, shopId: "shop-1", keyId: undefined });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-1", shopId: "shop-1",
    });
    const res = await deleteWebhookAction({
      request: new Request("https://x/api/v1/external/webhooks/sub-1", { method: "DELETE" }),
      params: { id: "sub-1" },
      ...CTX,
    } as never);
    expect(res.status).toBe(200);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.webhooks",
      "anon",
    );
  });
});
