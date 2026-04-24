import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateApiKeyMock, checkRateLimitMock, checkPerKeyRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn(async () => null),
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

import { loader } from "../api.v1.external.settings";

const mkReq = () => new Request("https://app.example/api/v1/external/settings");

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("GET /api/v1/external/settings", () => {
  it("429 on IP rate-limit", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("401 when auth fails", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("429 on per-key limit", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(Response.json({}, { status: 429 }));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("404 when settings missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("200 with sanitized settings", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ shopId: "shop-1", portalLanguage: "en" });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    // sanitized response must NOT include secret fields (e.g. fyndCredentials)
    expect(body.data.fyndCredentials).toBe(undefined);
  });

  it("500 on prisma error", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.shopSettings.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
