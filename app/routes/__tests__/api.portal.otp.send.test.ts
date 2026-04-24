import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, sendOtpEmailMock, checkRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendOtpEmailMock: vi.fn(),
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) => Response.json({ error: "rate" }, { status: 429, headers: { "Retry-After": String(ms) } }),
}));
vi.mock("../../lib/notification.server", () => ({
  sendOtpEmail: sendOtpEmailMock,
}));

import { loader, action } from "../api.portal.otp.send";

function jsonReq(body: unknown, method = "POST") {
  return new Request("https://app.example/api/portal/otp/send", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  sendOtpEmailMock.mockReset().mockResolvedValue(undefined);
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
});

describe("loader /api/portal/otp/send", () => {
  it("204 for OPTIONS", async () => {
    const res = await loader({ request: new Request("https://a/x", { method: "OPTIONS" }), params: {}, context: {} } as never);
    expect(res?.status).toBe(204);
  });

  it("null for other methods", async () => {
    const res = await loader({ request: new Request("https://a/x"), params: {}, context: {} } as never);
    expect(res).toBe(null);
  });
});

describe("action /api/portal/otp/send", () => {
  it("405 for non-POST", async () => {
    const res = await action({ request: jsonReq({}, "PUT"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when sessionId missing", async () => {
    const res = await action({ request: jsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when session not found", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: jsonReq({ sessionId: "missing" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when session expired", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", expiresAt: new Date(Date.now() - 1000), attemptsCount: 0, otpSentAt: null,
    });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("429 when attemptsCount at cap", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", expiresAt: new Date(Date.now() + 60_000), attemptsCount: 5, otpSentAt: null,
    });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("429 when within cooldown window", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", expiresAt: new Date(Date.now() + 60_000), attemptsCount: 0,
      otpSentAt: new Date(Date.now() - 10_000),
    });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/wait \d+s/);
  });

  it("success: sends email when lookupValue contains @", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0, otpSentAt: null,
      lookupValueNorm: "user@example.com",
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ shopDomain: "store.myshopify.com" });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      shopDomain: "store.myshopify.com",
      to: "user@example.com",
    }));
  });

  it("swallows email send failures without failing the request", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0, otpSentAt: null,
      lookupValueNorm: "user@example.com",
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ shopDomain: "store.myshopify.com" });
    sendOtpEmailMock.mockRejectedValueOnce(new Error("smtp"));
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("skips email when lookup value is a phone (non-@)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1", shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0, otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({ request: jsonReq({ sessionId: "s-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
  });

  it("500 when JSON parsing throws", async () => {
    const badReq = new Request("https://app.example/api/portal/otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await action({ request: badReq, params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
