import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, createPortalTokenMock, checkRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createPortalTokenMock: vi.fn(() => "jwt-token"),
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
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
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalToken: createPortalTokenMock,
}));

import { loader, action } from "../api.portal.otp.verify";

function jsonReq(body: unknown, method = "POST") {
  return new Request("https://app.example/api/portal/otp/verify", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mkValidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "s-1",
    shopId: "shop-1",
    expiresAt: new Date(Date.now() + 60_000),
    attemptsCount: 0,
    otpSentAt: new Date(Date.now() - 1000),
    otpTarget: null as string | null,
    lookupValueHash: "lookup-hash",
    lookupType: "email",
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createPortalTokenMock.mockClear();
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
});

describe("loader /api/portal/otp/verify", () => {
  it("204 for OPTIONS", async () => {
    const res = await loader({ request: new Request("https://a/x", { method: "OPTIONS" }), params: {}, context: {} } as never);
    expect(res?.status).toBe(204);
  });
});

describe("action /api/portal/otp/verify", () => {
  it("405 for non-POST", async () => {
    const res = await action({ request: jsonReq({}, "PUT"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: jsonReq({ sessionId: "s", otp: "000000" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when sessionId or otp missing", async () => {
    const res1 = await action({ request: jsonReq({ otp: "123456" }), params: {}, context: {} } as never);
    expect(res1.status).toBe(400);
    const res2 = await action({ request: jsonReq({ sessionId: "s" }), params: {}, context: {} } as never);
    expect(res2.status).toBe(400);
  });

  it("400 when session missing", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: jsonReq({ sessionId: "missing", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when session expired", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ expiresAt: new Date(Date.now() - 1000) }));
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("429 when session attempts at cap", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ attemptsCount: 5 }));
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("429 with accountLocked=true when account-level failure cap exceeded", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession());
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([
      { attemptsCount: 5, verifiedAt: null },
      { attemptsCount: 5, verifiedAt: null },
      { attemptsCount: 5, verifiedAt: null },
    ]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.accountLocked).toBe(true);
  });

  it("400 when OTP not sent yet (no otpSentAt)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpSentAt: null }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/expired/i);
  });

  it("400 when OTP is older than TTL", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({
      otpSentAt: new Date(Date.now() - 11 * 60_000), // older than 10 min TTL
      otpTarget: "x".repeat(60), // bcrypt-ish
    }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when otpTarget missing (no code issued)", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: null }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "123456" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("success: bcrypt match returns portalToken and updates session", async () => {
    const otp = "123456";
    const hash = await bcrypt.hash(otp, 4); // fast cost for test
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: hash }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.portalToken).toBe("jwt-token");
    expect(createPortalTokenMock).toHaveBeenCalled();
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ portalToken: "jwt-token", otpTarget: null }),
    }));
  });

  it("400 with attemptsRemaining on invalid bcrypt OTP", async () => {
    const hash = await bcrypt.hash("realotp", 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: hash, attemptsCount: 0 }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "wrongotp" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.attemptsRemaining).toBe(4);
  });

  it("429 locked when wrong OTP exhausts attempts", async () => {
    const hash = await bcrypt.hash("realotp", 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: hash, attemptsCount: 4 }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 5 });

    const res = await action({ request: jsonReq({ sessionId: "s-1", otp: "bad" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.locked).toBe(true);
  });

  it("legacy sha256 path: success when hash matches", async () => {
    const otp = "654321";
    const legacyHash = crypto.createHash("sha256").update(otp).digest("hex");
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: legacyHash }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: jsonReq({ sessionId: "s-1", otp }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("500 on JSON parse error", async () => {
    const bad = new Request("https://a/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    const res = await action({ request: bad, params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
