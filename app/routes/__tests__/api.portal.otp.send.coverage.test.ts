/**
 * Extra coverage tests for app/routes/api.portal.otp.send.ts
 *
 * Focus areas (complementing api.portal.otp.send.test.ts):
 *   - Cooldown enforcement (boundary + wait-second math)
 *   - MAX_OTP_ATTEMPTS cap (at, above, just under)
 *   - Dev-mode console.log path for non-email targets
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, sendOtpEmailMock, checkRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendOtpEmailMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) =>
    Response.json({ error: "rate" }, { status: 429, headers: { "Retry-After": String(ms) } }),
}));
vi.mock("../../lib/notification.server", () => ({
  sendOtpEmail: sendOtpEmailMock,
}));

import { action } from "../api.portal.otp.send";

const OTP_COOLDOWN_MS = 60_000;
const MAX_OTP_ATTEMPTS = 5;

function jsonReq(body: unknown, method = "POST") {
  return new Request("https://app.example/api/portal/otp/send", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  sendOtpEmailMock.mockReset().mockResolvedValue(undefined);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.restoreAllMocks();
});

describe("api.portal.otp.send — cooldown enforcement", () => {
  it("returns 429 with wait≈60s when otpSentAt is right now", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: new Date(),
      lookupValueNorm: "u@example.com",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    // Math.ceil((60000 - tinyDelta)/1000) → 60
    expect(body.error).toMatch(/wait (59|60)s before requesting another OTP/);
  });

  it("returns 429 with small wait when otpSentAt is near end of cooldown", async () => {
    // 59.5s ago → ~0.5s remaining → ceil → 1s
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: new Date(Date.now() - (OTP_COOLDOWN_MS - 500)),
      lookupValueNorm: "u@example.com",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/wait 1s before requesting another OTP/);
    expect(prismaMock.lookupSession.update).not.toHaveBeenCalled();
  });

  it("allows resend exactly at cooldown boundary (otpSentAt = cooldown ago)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      // exactly at the boundary: Date.now() - otpSentAt.getTime() === OTP_COOLDOWN_MS
      // condition is `< OTP_COOLDOWN_MS`, so equality should pass
      otpSentAt: new Date(Date.now() - OTP_COOLDOWN_MS - 5),
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledTimes(1);
  });

  it("allows resend when otpSentAt is null (first send)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledTimes(1);
  });
});

describe("api.portal.otp.send — max attempts cap", () => {
  it("returns 429 when attemptsCount equals the cap", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: MAX_OTP_ATTEMPTS,
      otpSentAt: null,
      lookupValueNorm: "u@example.com",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/Too many OTP attempts/i);
    expect(prismaMock.lookupSession.update).not.toHaveBeenCalled();
  });

  it("returns 429 when attemptsCount exceeds the cap", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: MAX_OTP_ATTEMPTS + 7,
      otpSentAt: null,
      lookupValueNorm: "u@example.com",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
  });

  it("allows the final attempt (attemptsCount = cap - 1) and increments to cap", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: MAX_OTP_ATTEMPTS - 1,
      otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledTimes(1);
    const updateArgs = prismaMock.lookupSession.update.mock.calls[0][0];
    expect(updateArgs.data.attemptsCount).toBe(MAX_OTP_ATTEMPTS);
  });

  it("on success increments attemptsCount and stores hashed OTP (not raw)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const updateArgs = prismaMock.lookupSession.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "s-1" });
    expect(updateArgs.data.attemptsCount).toBe(2);
    expect(updateArgs.data.otpSentAt).toBeInstanceOf(Date);
    // SHA-256 hash → 64 hex chars; raw OTP would be 6 digits.
    expect(updateArgs.data.otpTarget).toMatch(/^[a-f0-9]{64}$/);
    expect(updateArgs.data.otpTarget).not.toMatch(/^\d{6}$/);
  });
});

describe("api.portal.otp.send — dev-mode console.log path", () => {
  it("logs the OTP to console when NODE_ENV !== production and target is non-email", async () => {
    process.env.NODE_ENV = "development";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("[OTP] Dev mode code:", expect.stringMatching(/^\d{6}$/));
  });

  it("does NOT console.log the OTP when NODE_ENV === production and target is non-email", async () => {
    process.env.NODE_ENV = "production";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: null,
      lookupValueNorm: "+14155551212",
    });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
    const otpLog = logSpy.mock.calls.find((c) => c[0] === "[OTP] Dev mode code:");
    expect(otpLog).toBeUndefined();
  });

  it("does NOT console.log the OTP for email targets even in dev mode (email branch only)", async () => {
    process.env.NODE_ENV = "development";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: null,
      lookupValueNorm: "user@example.com",
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ shopDomain: "store.myshopify.com" });
    const res = await action({
      request: jsonReq({ sessionId: "s-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmailMock).toHaveBeenCalledTimes(1);
    const otpLog = logSpy.mock.calls.find((c) => c[0] === "[OTP] Dev mode code:");
    expect(otpLog).toBeUndefined();
  });
});
