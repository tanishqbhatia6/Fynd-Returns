import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn(async () => null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: authenticateApiKeyMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) => Response.json({ error: "rate limited" }, { status: 429 }),
}));
// Use real helpers for apiSuccess/apiError/parsePagination/buildMeta/sanitize, but
// mock the per-key rate limit dependency.
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});

import { loader } from "../api.v1.external.returns";

function mkReq(qs = "") {
  return new Request(`https://app.example/api/v1/external/returns${qs ? "?" + qs : ""}`);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("GET /api/v1/external/returns", () => {
  it("429 when IP rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("401 when auth fails", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: Response.json({ error: "no key" }, { status: 401 }) });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("429 from per-key rate limit", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(Response.json({ error: "per-key" }, { status: 429 }));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 on invalid status enum value", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await loader({ request: mkReq("status=bogus"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("accepts whitelisted status", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    const res = await loader({ request: mkReq("status=approved"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "approved", shopId: "shop-1" }),
    }));
  });

  it("applies createdAfter / createdBefore filters when valid dates", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    await loader({ request: mkReq("createdAfter=2025-01-01&createdBefore=2025-12-31"), params: {}, context: {} } as never);
    const whereArg = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date);
  });

  it("silently ignores invalid createdAfter date", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    await loader({ request: mkReq("createdAfter=not-a-date"), params: {}, context: {} } as never);
    const whereArg = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt).toBe(undefined);
  });

  it("uses cursor pagination when cursor param provided", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1", items: [] }]);
    const res = await loader({ request: mkReq("cursor=rc-prev&pageSize=1"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
      cursor: { id: "rc-prev" },
      skip: 1,
    }));
  });

  it("returns offset pagination data + meta", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "approved", items: [], createdAt: new Date() },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.data.length).toBe(1);
    expect(body.meta.totalCount).toBe(1);
  });

  it("500 when prisma throws", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });

  it("filters by orderName + customerEmail substrings", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    await loader({ request: mkReq("orderName=1001&customerEmail=User%40Example.COM"), params: {}, context: {} } as never);
    const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(where.shopifyOrderName).toEqual({ contains: "1001", mode: "insensitive" });
    expect(where.customerEmailNorm).toEqual({ contains: "user@example.com" });
  });
});
