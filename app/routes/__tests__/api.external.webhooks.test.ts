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

function mkReq(method: string = "GET", body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://app.example/api/v1/external/webhooks", init);
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

describe("GET /api/v1/external/webhooks (loader)", () => {
  it("429 on rate limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("returns active subscriptions for the shop", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findMany.mockResolvedValueOnce([
      {
        id: "sub-1",
        url: "https://hook.example",
        events: JSON.stringify(["return.created"]),
        isActive: true,
        createdAt: new Date(),
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].events).toEqual(["return.created"]);
  });

  it("500 on prisma error", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findMany.mockRejectedValueOnce(new Error("db"));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/v1/external/webhooks (action)", () => {
  const happy = { url: "https://hook.example/rpm", events: ["return.created"] };

  it("405 on non-POST", async () => {
    const res = await action({ request: mkReq("PATCH"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("400 on invalid JSON body", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const req = new Request("https://app.example/api/v1/external/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when url missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await action({
      request: mkReq("POST", { events: ["return.created"] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 on SSRF-unsafe URL", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: "private_ip" });
    const res = await action({
      request: mkReq("POST", { url: "http://169.254.169.254/", events: ["return.created"] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/public HTTPS/);
    // rejection reason must NOT be echoed back
    expect(body.error.message).not.toContain("private_ip");
  });

  it("400 when events missing/empty", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await action({
      request: mkReq("POST", { url: "https://ok.example", events: [] }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when events contain invalid values", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await action({
      request: mkReq("POST", {
        url: "https://ok.example",
        events: ["return.created", "return.explode"],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/return\.explode/);
  });

  it("400 when a subscription for the same URL exists", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({ id: "sub-existing" });
    const res = await action({ request: mkReq("POST", happy), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("201 on happy path with generated secret", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    prismaMock.webhookSubscription.create.mockResolvedValueOnce({
      id: "sub-new",
      url: happy.url,
      createdAt: new Date(),
    });
    const res = await action({ request: mkReq("POST", happy), params: {}, context: {} } as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe("sub-new");
    expect(body.data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it("500 on prisma error during create", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    prismaMock.webhookSubscription.create.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: mkReq("POST", happy), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
