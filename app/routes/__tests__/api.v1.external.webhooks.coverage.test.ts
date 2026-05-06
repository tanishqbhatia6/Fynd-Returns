/**
 * Extra coverage for /api/v1/external/webhooks beyond the existing
 * api.external.webhooks.test.ts and api.v1.external.webhooks.test.ts files.
 *
 * Focus areas:
 *  - List subscriptions (multi-event, ordering, empty, auth/per-key rate limit)
 *  - Create with each WEBHOOK_EVENTS event individually (parametrized)
 *  - SSRF rejection cases (loopback, private RFC1918, AWS IMDS, IPv6 loopback,
 *    plain http, invalid URL) — generic error, no internal reason leaked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
  isSafeOutboundUrlMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  isSafeOutboundUrlMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/url-safety.server", () => ({ isSafeOutboundUrl: isSafeOutboundUrlMock }));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});

import { loader, action } from "../api.v1.external.webhooks";
import { WEBHOOK_EVENTS } from "../../lib/api-docs-data";

const VALID_EVENTS = [...WEBHOOK_EVENTS];

function mkReq(method: string = "GET", body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://app.example/api/v1/external/webhooks", init);
}

function okAuth() {
  authenticateApiKeyMock.mockResolvedValueOnce({
    ok: true,
    keyId: "key-1",
    shopId: "shop-1",
    shopDomain: "test.myshopify.com",
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// LIST (loader)
// ───────────────────────────────────────────────────────────────────────────
describe("GET /api/v1/external/webhooks — list (extra coverage)", () => {
  it("returns an empty array when no subscriptions exist", async () => {
    okAuth();
    prismaMock.webhookSubscription.findMany.mockResolvedValueOnce([]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.errors).toEqual([]);
  });

  it("parses multi-event JSON arrays per subscription", async () => {
    okAuth();
    const created = new Date("2026-01-15T00:00:00Z");
    prismaMock.webhookSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub-1",
        url: "https://a.example/h",
        events: JSON.stringify(["return.created", "return.approved", "return.refunded"]),
        isActive: true,
        createdAt: created,
      },
      {
        id: "sub-2",
        url: "https://b.example/h",
        events: JSON.stringify(["return.status_changed"]),
        isActive: true,
        createdAt: created,
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].events).toEqual(["return.created", "return.approved", "return.refunded"]);
    expect(body.data[1].events).toEqual(["return.status_changed"]);
  });

  it("scopes findMany to the authenticated shop and only active subscriptions, ordered by createdAt desc", async () => {
    okAuth();
    prismaMock.webhookSubscription.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-1", isActive: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("propagates authentication failure response", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: { code: "UNAUTHORIZED", message: "no" } }, { status: 401 }),
    });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(prismaMock.webhookSubscription.findMany).not.toHaveBeenCalled();
  });

  it("returns 429 from per-key rate limiter even when global limit allows", async () => {
    okAuth();
    checkPerKeyRateLimitMock.mockResolvedValueOnce(
      Response.json({ error: { code: "RATE_LIMITED", message: "slow down" } }, { status: 429 }),
    );
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    expect(prismaMock.webhookSubscription.findMany).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CREATE — every WEBHOOK_EVENTS value validates and persists
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/v1/external/webhooks — create with each event type", () => {
  it.each(VALID_EVENTS)("accepts singleton event %s", async (eventName) => {
    okAuth();
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    prismaMock.webhookSubscription.create.mockResolvedValueOnce({
      id: `sub-${eventName}`,
      url: `https://hook.example/${eventName}`,
      createdAt: new Date(),
    });
    const res = await action({
      request: mkReq("POST", { url: `https://hook.example/${eventName}`, events: [eventName] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.events).toEqual([eventName]);
    expect(body.data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    // events column persisted as JSON-encoded array
    expect(prismaMock.webhookSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        shopId: "shop-1",
        url: `https://hook.example/${eventName}`,
        events: JSON.stringify([eventName]),
        secret: expect.stringMatching(/^whsec_[0-9a-f]{64}$/),
      }),
    });
  });

  it("accepts a subscription that fans out to ALL valid events at once", async () => {
    okAuth();
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    prismaMock.webhookSubscription.create.mockResolvedValueOnce({
      id: "sub-all",
      url: "https://hook.example/all",
      createdAt: new Date(),
    });
    const res = await action({
      request: mkReq("POST", { url: "https://hook.example/all", events: VALID_EVENTS }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.events).toEqual(VALID_EVENTS);
  });

  it("rejects an unknown event with a list of valid events in the message", async () => {
    okAuth();
    const res = await action({
      request: mkReq("POST", {
        url: "https://hook.example/x",
        events: ["return.created", "return.unknown"],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("return.unknown");
    // The valid event list is included to guide integrators
    for (const ev of VALID_EVENTS) {
      expect(body.error.message).toContain(ev);
    }
    // No DB writes for invalid input
    expect(prismaMock.webhookSubscription.create).not.toHaveBeenCalled();
  });

  it("rejects when events is not an array (e.g. string passed by mistake)", async () => {
    okAuth();
    const res = await action({
      request: mkReq("POST", { url: "https://hook.example/x", events: "return.created" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/non-empty array/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SSRF rejection cases
// ───────────────────────────────────────────────────────────────────────────
describe("POST /api/v1/external/webhooks — SSRF rejection", () => {
  // For every SSRF payload the endpoint must:
  //   - return 400 with code BAD_REQUEST
  //   - return the generic "public HTTPS endpoint" message
  //   - NOT echo the rejection reason (DNS rebinding/topology probe)
  //   - NOT call prisma.webhookSubscription.create
  it("rejects all known private/loopback/IMDS variants without leaking the reason", async () => {
    const ssrfCases: Array<{ url: string; reason: string }> = [
      { url: "https://localhost/h", reason: "private_hostname" },
      { url: "https://127.0.0.1/h", reason: "private_ipv4" },
      { url: "https://10.0.0.1/h", reason: "private_ipv4" },
      { url: "https://192.168.1.1/h", reason: "private_ipv4" },
      { url: "https://169.254.169.254/latest/meta-data/", reason: "private_ipv4" },
      { url: "https://[::1]/h", reason: "private_ipv6" },
      { url: "https://internal.corp/h", reason: "resolves_to_private_ipv4" },
    ];

    for (const { url, reason } of ssrfCases) {
      resetPrismaMock(prismaMock);
      authenticateApiKeyMock.mockReset();
      okAuth();
      isSafeOutboundUrlMock.mockReset().mockResolvedValueOnce({ ok: false, reason });

      const res = await action({
        request: mkReq("POST", { url, events: ["return.created"] }),
        params: {},
        context: {},
      } as never);
      expect(res.status, `expected 400 for ${url}`).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toBe("Webhook URL must be a public HTTPS endpoint");
      // Never echo the internal reason or raw URL — could enable enumeration
      expect(body.error.message).not.toContain(reason);
      expect(body.error.message).not.toContain(url);
      expect(prismaMock.webhookSubscription.create).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-HTTPS scheme (http://) before any DB lookup", async () => {
    okAuth();
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: "scheme_not_allowed" });
    const res = await action({
      request: mkReq("POST", { url: "http://hook.example/h", events: ["return.created"] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/public HTTPS endpoint/);
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL with the same generic message", async () => {
    okAuth();
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: "invalid_url" });
    const res = await action({
      request: mkReq("POST", { url: "not a url", events: ["return.created"] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/public HTTPS endpoint/);
  });

  it("rejects when url is the wrong type (number) before consulting url-safety", async () => {
    okAuth();
    const res = await action({
      request: mkReq("POST", { url: 12345, events: ["return.created"] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/url is required/);
    // Type guard runs first — url-safety should never be consulted
    expect(isSafeOutboundUrlMock).not.toHaveBeenCalled();
  });
});
