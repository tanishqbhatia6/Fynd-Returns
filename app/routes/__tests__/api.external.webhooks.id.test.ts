import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateApiKeyMock, checkRateLimitMock, checkPerKeyRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null),
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

import { action } from "../api.v1.external.webhooks.$id";

const mkReq = (method: string = "DELETE") =>
  new Request("https://app.example/api/v1/external/webhooks/sub-1", { method });

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("DELETE /api/v1/external/webhooks/:id", () => {
  it("405 on non-DELETE method", async () => {
    const res = await action({ request: mkReq("PUT"), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 on IP rate limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("401 when auth fails", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("429 on per-key limit", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when id missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("404 when subscription not found for shop", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("200 soft-deletes (isActive=false) on happy path", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({ id: "sub-1", shopId: "shop-1" });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.webhookSubscription.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sub-1" },
      data: { isActive: false },
    }));
  });

  it("500 when prisma throws", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
