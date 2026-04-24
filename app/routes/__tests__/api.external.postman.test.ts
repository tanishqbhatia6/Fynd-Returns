import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
  generatePostmanMock,
} = vi.hoisted(() => ({
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn(async () => null),
  generatePostmanMock: vi.fn(() => JSON.stringify({ info: { name: "RPM" } })),
}));

vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: authenticateApiKeyMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) => Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(ms) } }),
}));
vi.mock("../../lib/external-api-helpers.server", () => ({
  checkPerKeyRateLimit: checkPerKeyRateLimitMock,
}));
vi.mock("../../lib/postman-collection.server", () => ({
  generatePostmanCollection: generatePostmanMock,
}));

import { loader } from "../api.v1.external.postman";

const origEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...origEnv };
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  generatePostmanMock.mockClear();
});
afterEach(() => {
  process.env = { ...origEnv };
});

const req = () => new Request("https://app.example/api/v1/external/postman");

describe("GET /api/v1/external/postman", () => {
  it("429 when IP rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("returns collection when read_returns auth succeeds on first try", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "key-1" });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Content-Disposition")).toContain(".postman_collection.json");
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to read_settings when read_returns denied", async () => {
    authenticateApiKeyMock
      .mockResolvedValueOnce({ ok: false, response: Response.json({ e: "denied" }, { status: 401 }) })
      .mockResolvedValueOnce({ ok: true, keyId: "key-2" });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(2);
  });

  it("falls through to manage_webhooks when both prior permissions denied", async () => {
    authenticateApiKeyMock
      .mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) })
      .mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) })
      .mockResolvedValueOnce({ ok: true, keyId: "key-3" });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(3);
  });

  it("returns the last auth failure response when all three permissions denied", async () => {
    const deniedResponse = Response.json({ error: "no access" }, { status: 401 });
    authenticateApiKeyMock
      .mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) })
      .mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 401 }) })
      .mockResolvedValueOnce({ ok: false, response: deniedResponse });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(generatePostmanMock).not.toHaveBeenCalled();
  });

  it("honours per-key rate limit when exceeded", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "key-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(Response.json({ error: "per-key limited" }, { status: 429 }));
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    expect(generatePostmanMock).not.toHaveBeenCalled();
  });

  it("uses SHOPIFY_APP_URL when set, otherwise derives from request origin", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k" });
    process.env.SHOPIFY_APP_URL = "https://shopify.app.example";
    await loader({ request: req(), params: {}, context: {} } as never);
    expect(generatePostmanMock).toHaveBeenCalledWith("https://shopify.app.example");

    generatePostmanMock.mockClear();
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k" });
    delete process.env.SHOPIFY_APP_URL;
    await loader({ request: req(), params: {}, context: {} } as never);
    expect(generatePostmanMock).toHaveBeenCalledWith("https://app.example");
  });
});
