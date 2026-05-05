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

import { loader } from "../api.v1.external.returns.$id";

const mkReq = () => new Request("https://app.example/api/v1/external/returns/rc-1");

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("GET /api/v1/external/returns/:id", () => {
  it("429 when IP rate-limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("401 when auth fails", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) });
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("429 from per-key limit", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when id missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("404 when return not found for shop", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("200 with sanitized detail on hit", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopId: "shop-1",
      status: "approved",
      items: [{ id: "it-1" }],
      events: [{ id: "ev-1" }],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("rc-1");
  });

  it("500 on prisma error", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.returnCase.findFirst.mockRejectedValueOnce(new Error("db"));
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
