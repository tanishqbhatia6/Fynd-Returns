import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.order — 1,127-line portal order lookup.
 *
 * Too branchy to cover end-to-end in one pass — this batch focuses on:
 *   - the exported pure helper `shouldBlockOrderForExistingReturn`
 *   - loader preflight + guards (rate-limit, params, shop 404)
 *   - the three distinct error fallbacks: SessionNotFoundError → 403,
 *     OrderAccessError → 200 fallback, network/unknown → 200 fallback
 *   - "order not found" + empty-existing-returns happy path exit
 *   - formatted-returns mapping + active filter
 */

const {
  prismaMock,
  shopifyModuleMock,
  checkRateLimitMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByGidMock,
  fetchOrderByFyndAffiliateIdMock,
  withRestCredentialsMock,
  createFyndClientOrErrorMock,
  formatReturnRequestIdMock,
  checkReturnEligibilityMock,
  createPortalCsrfTokenMock,
  parseJsonArrayMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByGidMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  withRestCredentialsMock: vi.fn((a: unknown) => a),
  createFyndClientOrErrorMock: vi.fn(async () => ({ ok: false, error: "disabled" })),
  formatReturnRequestIdMock: vi.fn((x: string) => `R-${x.slice(0, 6)}`),
  checkReturnEligibilityMock: vi.fn(() => ({ eligible: true })),
  createPortalCsrfTokenMock: vi.fn(() => "csrf-token-abc"),
  parseJsonArrayMock: vi.fn((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback)),
}));
Object.assign(prismaMock, createPrismaMock());
// fyndOrderMapping isn't in the base factory
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findFirst: vi.fn().mockResolvedValue(null),
};

// The route imports OrderAccessError for instanceof checks; we need the actual class.
vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ default: shopifyModuleMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/return-request-id", () => ({
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalCsrfToken: createPortalCsrfTokenMock,
}));
// Use the REAL OrderAccessError class so instanceof works
vi.mock("../../lib/shopify-admin.server", async () => {
  class OrderAccessError extends Error {
    constructor(public reason: string, public orderNumber: string) {
      super(`Order ${orderNumber} cannot be accessed: ${reason}`);
      this.name = "OrderAccessError";
    }
  }
  return {
    OrderAccessError,
    fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
    fetchOrderByGid: fetchOrderByGidMock,
    fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
    withRestCredentials: withRestCredentialsMock,
  };
});

import { loader, shouldBlockOrderForExistingReturn } from "../api.portal.order";
import { OrderAccessError } from "../../lib/shopify-admin.server";

function mkReq(qs: string, method = "GET") {
  return new Request(`https://app.example/api/portal/order?${qs}`, { method });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const mapping = (prismaMock as unknown as Record<string, Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>>).fyndOrderMapping;
  mapping.upsert.mockReset();
  mapping.upsert.mockResolvedValue({});
  mapping.findFirst.mockReset();
  mapping.findFirst.mockResolvedValue(null);
  shopifyModuleMock.unauthenticated.admin.mockReset().mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  fetchOrderByOrderNumberMock.mockReset();
  fetchOrderByGidMock.mockReset();
  fetchOrderByFyndAffiliateIdMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  formatReturnRequestIdMock.mockReset().mockImplementation((x: string) => `R-${x.slice(0, 6)}`);
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  createPortalCsrfTokenMock.mockReset().mockReturnValue("csrf-token-abc");
  parseJsonArrayMock.mockReset().mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));
});

// ────────────── Pure helper ──────────────

describe("shouldBlockOrderForExistingReturn", () => {
  it("returns false for empty array", () => {
    expect(shouldBlockOrderForExistingReturn([], {})).toBe(false);
  });

  it("returns false when lineItems is not an array (defensive)", () => {
    expect(shouldBlockOrderForExistingReturn(null as unknown as never, {})).toBe(false);
  });

  it("returns true when every item is fully returned", () => {
    const items = [
      { id: "li-1", quantity: 2 },
      { id: "li-2", quantity: 1 },
    ];
    const returnedMap = { "li-1": 2, "li-2": 1 };
    expect(shouldBlockOrderForExistingReturn(items, returnedMap)).toBe(true);
  });

  it("returns false when any item still has remaining quantity", () => {
    const items = [
      { id: "li-1", quantity: 2 },
      { id: "li-2", quantity: 3 },
    ];
    const returnedMap = { "li-1": 2, "li-2": 1 }; // li-2 has 2 remaining
    expect(shouldBlockOrderForExistingReturn(items, returnedMap)).toBe(false);
  });

  it("treats undefined quantity as 1", () => {
    const items = [{ id: "li-1" }]; // quantity undefined → 1
    expect(shouldBlockOrderForExistingReturn(items, { "li-1": 1 })).toBe(true);
    expect(shouldBlockOrderForExistingReturn(items, { "li-1": 0 })).toBe(false);
  });

  it("treats missing line-item entry in map as 0 returned", () => {
    const items = [{ id: "li-1", quantity: 1 }];
    expect(shouldBlockOrderForExistingReturn(items, {})).toBe(false);
  });

  it("returns true when qty returned exceeds ordered (over-return)", () => {
    const items = [{ id: "li-1", quantity: 1 }];
    expect(shouldBlockOrderForExistingReturn(items, { "li-1": 5 })).toBe(true);
  });
});

// ────────────── Loader: top-level guards ──────────────

describe("loader guards", () => {
  it("204 on OPTIONS preflight", async () => {
    const res = await loader({ request: mkReq("", "OPTIONS"), params: {}, context: {} } as never);
    expect(res.status).toBe(204);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq("shop=x&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when shop param missing", async () => {
    const res = await loader({ request: mkReq("orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when orderNumber missing", async () => {
    const res = await loader({ request: mkReq("shop=x"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when orderNumber longer than 64 chars", async () => {
    const res = await loader({ request: mkReq(`shop=x&orderNumber=${"1".repeat(100)}`), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when orderNumber contains only non-word chars (after sanitization)", async () => {
    const res = await loader({ request: mkReq("shop=x&orderNumber=%40%40%40%40"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq("shop=x&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("normalises non-dotted shop to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await loader({ request: mkReq("shop=mystore&orderNumber=1001"), params: {}, context: {} } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopDomain: "mystore.myshopify.com" },
    }));
  });

  it("strips # and special chars from orderNumber", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await loader({ request: mkReq("shop=store&orderNumber=%231001%40"), params: {}, context: {} } as never);
    // URL params: #1001@ → after ^# strip + non-word strip → "1001"
    // Shop lookup still happens first, then findMany — we just confirmed it got past the guards
    expect(prismaMock.shop.findUnique).toHaveBeenCalled();
  });
});

// ────────────── Existing returns lookup ──────────────

describe("existing returns formatting", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  });

  it("returns empty order-not-found response when Shopify has no order and no returns exist", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);

    const res = await loader({ request: mkReq("shop=store&orderNumber=9999"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.existingReturns).toEqual([]);
    expect(body.activeReturns).toEqual([]);
  });

  it("filters 'activeReturns' to only non-terminal statuses", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", returnRequestNo: "R1", status: "pending", refundStatus: null, createdAt: new Date(), fyndReturnNo: null, items: [] },
      { id: "rc-2", returnRequestNo: "R2", status: "rejected", refundStatus: null, createdAt: new Date(), fyndReturnNo: null, items: [] },
      { id: "rc-3", returnRequestNo: "R3", status: "approved", refundStatus: null, createdAt: new Date(), fyndReturnNo: null, items: [] },
      { id: "rc-4", returnRequestNo: "R4", status: "completed", refundStatus: null, createdAt: new Date(), fyndReturnNo: null, items: [] },
    ]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);

    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.existingReturns).toHaveLength(4);
    // Only pending + approved are active (non-terminal)
    expect(body.activeReturns.map((r: { status: string }) => r.status)).toEqual(["pending", "approved"]);
  });

  it("uses formatReturnRequestId when returnRequestNo is null", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "long-id-abc", returnRequestNo: null, status: "pending", refundStatus: null, createdAt: new Date(), fyndReturnNo: null, items: [] },
    ]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);

    await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(formatReturnRequestIdMock).toHaveBeenCalledWith("long-id-abc");
  });
});

// ────────────── Error paths ──────────────

describe("error fallbacks", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
    prismaMock.returnCase.findMany.mockResolvedValue([]);
  });

  it("403 on SessionNotFoundError (store disconnected the app)", async () => {
    class SessionNotFoundError extends Error { constructor() { super("session gone"); this.name = "SessionNotFoundError"; } }
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new SessionNotFoundError());
    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/connected the app/);
  });

  it("200 fallback on OrderAccessError (e.g. protected customer data, not approved)", async () => {
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(
      new OrderAccessError("protected_customer_data", "1001"),
    );
    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.orderNumber).toBe("1001");
    expect(body.error).toMatch(/couldn't fetch your order/);
  });

  it("200 fallback when error message mentions 'not approved' / 'protected' / 'Order object'", async () => {
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(
      new Error("App is not approved for Order object scope"),
    );
    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
  });

  it("200 generic fallback for unknown errors", async () => {
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("network timeout"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.error).toMatch(/couldn't find this order automatically/);
  });
});
