import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  authenticateApiKeyMock,
  checkRateLimitMock,
  rateLimitResponseMock,
  checkPerKeyRateLimitMock,
  generatePostmanMock,
} = vi.hoisted(() => ({
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  rateLimitResponseMock: vi.fn((ms: number) =>
    Response.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(ms) } },
    ),
  ),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(
    async () => null,
  ),
  generatePostmanMock: vi.fn(() => JSON.stringify({ info: { name: "RPM" }, item: [] })),
}));

vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: authenticateApiKeyMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
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
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  rateLimitResponseMock.mockClear();
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  generatePostmanMock
    .mockReset()
    .mockReturnValue(JSON.stringify({ info: { name: "RPM" }, item: [] }));
});
afterEach(() => {
  process.env = { ...origEnv };
});

const req = (url = "https://app.example/api/v1/external/postman") => new Request(url);
const ok = (keyId: string) => ({ ok: true, keyId });
const denied = (status = 401) => ({
  ok: false,
  response: Response.json({ error: "denied" }, { status }),
});

describe("api.v1.external.postman coverage", () => {
  it("propagates retryAfterMs into the IP rate-limit 429 response", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 4242 });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    expect(rateLimitResponseMock).toHaveBeenCalledWith(4242);
    expect(res.headers.get("Retry-After")).toBe("4242");
    // Permission auth must be skipped on IP rate limit.
    expect(authenticateApiKeyMock).not.toHaveBeenCalled();
    expect(generatePostmanMock).not.toHaveBeenCalled();
  });

  it("auth path 1: read_returns succeeds — only one permission attempted", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce(ok("key-rr"));
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(1);
    const firstCallPerm = authenticateApiKeyMock.mock.calls[0][1];
    expect(firstCallPerm).toBe("read_returns");
    // per-key rate limit bound to the successful keyId
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.postman",
      "key-rr",
    );
  });

  it("auth path 2: read_returns denied → read_settings succeeds — exactly two perms tried in order", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce(denied()).mockResolvedValueOnce(ok("key-rs"));
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(2);
    expect(authenticateApiKeyMock.mock.calls[0][1]).toBe("read_returns");
    expect(authenticateApiKeyMock.mock.calls[1][1]).toBe("read_settings");
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.postman",
      "key-rs",
    );
  });

  it("auth path 3: only manage_webhooks succeeds — all three perms tried in order", async () => {
    authenticateApiKeyMock
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok("key-mw"));
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(authenticateApiKeyMock).toHaveBeenCalledTimes(3);
    expect(authenticateApiKeyMock.mock.calls.map((c) => c[1])).toEqual([
      "read_returns",
      "read_settings",
      "manage_webhooks",
    ]);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.postman",
      "key-mw",
    );
  });

  it("auth path 4: all three permissions denied → returns the manage_webhooks failure response", async () => {
    const finalDenied = Response.json({ error: "manage_webhooks denied" }, { status: 403 });
    authenticateApiKeyMock
      .mockResolvedValueOnce(denied(401))
      .mockResolvedValueOnce(denied(401))
      .mockResolvedValueOnce({ ok: false, response: finalDenied });
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "manage_webhooks denied" });
    expect(checkPerKeyRateLimitMock).not.toHaveBeenCalled();
    expect(generatePostmanMock).not.toHaveBeenCalled();
  });

  it("per-key rate limit short-circuits with custom 429 body before generating collection", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce(ok("key-1"));
    const perKeyResp = Response.json(
      { error: "per-key limited", code: "RATE_LIMITED" },
      { status: 429 },
    );
    checkPerKeyRateLimitMock.mockResolvedValueOnce(perKeyResp);
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(generatePostmanMock).not.toHaveBeenCalled();
  });

  it("per-key rate limit uses keyId from the second-permission fallthrough (read_settings)", async () => {
    authenticateApiKeyMock
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok("key-fallthrough-2"));
    await loader({ request: req(), params: {}, context: {} } as never);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledTimes(1);
    const [, bucket, keyId] = checkPerKeyRateLimitMock.mock.calls[0];
    expect(bucket).toBe("external.postman");
    expect(keyId).toBe("key-fallthrough-2");
  });

  it("Content-Disposition header is exact attachment filename", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce(ok("k"));
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="ReturnProMax-API.postman_collection.json"',
    );
  });

  it("Content-Type is application/json and body is the generated collection", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce(ok("k"));
    const payload = JSON.stringify({
      info: { name: "RPM-Coverage", _postman_id: "abc" },
      item: [{ name: "X" }],
    });
    generatePostmanMock.mockReturnValueOnce(payload);
    const res = await loader({ request: req(), params: {}, context: {} } as never);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const text = await res.text();
    expect(text).toBe(payload);
    const parsed = JSON.parse(text);
    expect(parsed.info.name).toBe("RPM-Coverage");
  });

  it("derives baseUrl from request origin when SHOPIFY_APP_URL is unset", async () => {
    delete process.env.SHOPIFY_APP_URL;
    authenticateApiKeyMock.mockResolvedValueOnce(ok("k"));
    await loader({
      request: req("https://merchant.example.com/api/v1/external/postman?x=1"),
      params: {},
      context: {},
    } as never);
    expect(generatePostmanMock).toHaveBeenCalledWith("https://merchant.example.com");
  });

  it("prefers SHOPIFY_APP_URL over request origin when set", async () => {
    process.env.SHOPIFY_APP_URL = "https://canonical.shopify.app";
    authenticateApiKeyMock.mockResolvedValueOnce(ok("k"));
    await loader({
      request: req("https://other-host.example/api/v1/external/postman"),
      params: {},
      context: {},
    } as never);
    expect(generatePostmanMock).toHaveBeenCalledWith("https://canonical.shopify.app");
  });

  it("does not call generatePostmanCollection or per-key rate limit on auth failure", async () => {
    authenticateApiKeyMock
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(denied(401));
    await loader({ request: req(), params: {}, context: {} } as never);
    expect(generatePostmanMock).not.toHaveBeenCalled();
    expect(checkPerKeyRateLimitMock).not.toHaveBeenCalled();
  });
});
