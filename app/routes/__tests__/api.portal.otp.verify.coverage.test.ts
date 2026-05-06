/**
 * Extra coverage for /api/portal/otp/verify focused on:
 *   1. bcrypt vs SHA-256 legacy hash discrimination (and crossed-wires cases)
 *   2. attempts counter decrement / advancement on miss
 *   3. verifiedAt timestamp + portalToken persistence on success
 *
 * Complements api.portal.otp.verify.test.ts; does not duplicate its scenarios.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, createPortalTokenMock, checkRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createPortalTokenMock: vi.fn(() => "jwt-token"),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
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
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalToken: createPortalTokenMock,
}));

import { action } from "../api.portal.otp.verify";

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
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
});

describe("api.portal.otp.verify — bcrypt vs SHA-256 legacy detection", () => {
  it("legacy SHA-256 hash takes the SHA branch (mismatched OTP fails)", async () => {
    // legacyHash is hex of "trueotp"; submitting a different OTP must fail
    // through the SHA branch — *not* via bcrypt.compare.
    const legacyHash = crypto.createHash("sha256").update("trueotp").digest("hex");
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: legacyHash, attemptsCount: 0 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const bcryptSpy = vi.spyOn(bcrypt, "compare");
    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrongotp" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(bcryptSpy).not.toHaveBeenCalled();
    bcryptSpy.mockRestore();
  });

  it("bcrypt hash never falls through to SHA-256 path even on miss", async () => {
    // bcrypt hashes contain non-hex chars ($, /, .) so isLegacySha256 must reject them.
    const hash = await bcrypt.hash("realotp", 4);
    expect(/^[0-9a-f]{64}$/i.test(hash)).toBe(false);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 0 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const bcryptSpy = vi.spyOn(bcrypt, "compare");
    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrongotp" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(bcryptSpy).toHaveBeenCalledTimes(1);
    bcryptSpy.mockRestore();
  });

  it("hex string of 63 chars (NOT 64) routes through bcrypt branch", async () => {
    // Edge: legacy detection requires *exactly* 64 hex chars. A 63-char hex
    // string must be treated as bcrypt input (which will reject it).
    const notLegacy = "a".repeat(63);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: notLegacy }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const bcryptSpy = vi.spyOn(bcrypt, "compare");
    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "any" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(bcryptSpy).toHaveBeenCalled();
    bcryptSpy.mockRestore();
  });

  it("uppercase 64-char hex still detected as legacy SHA-256", async () => {
    // Regex is /i so uppercase hex must also match the legacy branch.
    const otp = "aabbcc";
    const legacyHash = crypto.createHash("sha256").update(otp).digest("hex").toUpperCase();
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: legacyHash }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
  });

  it("bcrypt.compare throwing is caught and counted as a miss", async () => {
    // Defensive: malformed bcrypt hash should NOT crash the action.
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: "$2a$totally-broken-hash" }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "123456" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(prismaMock.lookupSession.update).toHaveBeenCalled();
  });
});

describe("api.portal.otp.verify — attempts decrement (counter advancement) on miss", () => {
  it("increments attemptsCount by exactly 1 on a wrong bcrypt OTP", async () => {
    const hash = await bcrypt.hash("realotp", 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 1 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 2 });

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrong" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s-1" },
        data: { attemptsCount: 2 },
      }),
    );
  });

  it("attemptsRemaining strictly decreases as attemptsCount climbs", async () => {
    const hash = await bcrypt.hash("realotp", 4);

    // attemptsCount: 0 -> 1 (remaining 4)
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 0 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });
    const r1 = await action({
      request: jsonReq({ sessionId: "s-1", otp: "x" }),
      params: {},
      context: {},
    } as never);
    expect((await r1.json()).attemptsRemaining).toBe(4);

    // attemptsCount: 2 -> 3 (remaining 2)
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 2 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 3 });
    const r2 = await action({
      request: jsonReq({ sessionId: "s-1", otp: "x" }),
      params: {},
      context: {},
    } as never);
    expect((await r2.json()).attemptsRemaining).toBe(2);
  });

  it("legacy SHA-256 miss also bumps attemptsCount via the same update path", async () => {
    const legacyHash = crypto.createHash("sha256").update("realotp").digest("hex");
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: legacyHash, attemptsCount: 2 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 3 });

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrongotp" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attemptsCount: 3 } }),
    );
    const body = await res.json();
    expect(body.attemptsRemaining).toBe(2);
  });

  it("on miss does NOT clear otpTarget (so user can retry with the same code)", async () => {
    const hash = await bcrypt.hash("realotp", 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 0 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrong" }),
      params: {},
      context: {},
    } as never);

    const updateCall = prismaMock.lookupSession.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).not.toHaveProperty("otpTarget");
    expect(updateCall.data).not.toHaveProperty("verifiedAt");
    expect(updateCall.data).not.toHaveProperty("portalToken");
  });

  it("attemptsRemaining never goes negative (clamped at 0) when DB returns >MAX", async () => {
    // Belt-and-braces: even if the DB somehow returns attemptsCount > 5, the
    // response surfaces 0 rather than a negative number.
    const hash = await bcrypt.hash("realotp", 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 4 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 99 });

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "wrong" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.attemptsRemaining).toBe(0);
    expect(body.locked).toBe(true);
  });
});

describe("api.portal.otp.verify — verifiedAt write on success", () => {
  it("writes verifiedAt as a Date close to now on bcrypt success", async () => {
    const otp = "112233";
    const hash = await bcrypt.hash(otp, 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: hash }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const before = Date.now();
    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp }),
      params: {},
      context: {},
    } as never);
    const after = Date.now();

    expect(res.status).toBe(200);
    const updateCall = prismaMock.lookupSession.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { verifiedAt: Date; portalToken: string; otpTarget: null };
    };
    expect(updateCall.where).toEqual({ id: "s-1" });
    expect(updateCall.data.verifiedAt).toBeInstanceOf(Date);
    const ts = updateCall.data.verifiedAt.getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("writes portalToken AND clears otpTarget atomically on success", async () => {
    const otp = "445566";
    const hash = await bcrypt.hash(otp, 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkValidSession({ otpTarget: hash }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const updateCall = prismaMock.lookupSession.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.portalToken).toBe("jwt-token");
    expect(updateCall.data.otpTarget).toBeNull();
    expect(updateCall.data.verifiedAt).toBeInstanceOf(Date);
  });

  it("does NOT bump attemptsCount when verifying successfully", async () => {
    const otp = "778899";
    const hash = await bcrypt.hash(otp, 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: hash, attemptsCount: 3 }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    // Only one update call — the success-path write — and attemptsCount is untouched.
    expect(prismaMock.lookupSession.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.lookupSession.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data).not.toHaveProperty("attemptsCount");
  });

  it("legacy SHA-256 success ALSO writes verifiedAt + portalToken + clears otpTarget", async () => {
    // Successful legacy verification should produce the same persistence side effects
    // as the bcrypt path (this is what transparently migrates users off SHA).
    const otp = "998877";
    const legacyHash = crypto.createHash("sha256").update(otp).digest("hex");
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({ otpTarget: legacyHash }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const updateCall = prismaMock.lookupSession.update.mock.calls[0]?.[0] as {
      data: { verifiedAt: Date; portalToken: string; otpTarget: null };
    };
    expect(updateCall.data.verifiedAt).toBeInstanceOf(Date);
    expect(updateCall.data.portalToken).toBe("jwt-token");
    expect(updateCall.data.otpTarget).toBeNull();
  });

  it("createPortalToken receives session metadata for the JWT claims", async () => {
    const otp = "121212";
    const hash = await bcrypt.hash(otp, 4);
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkValidSession({
        id: "session-XYZ",
        shopId: "shop-XYZ",
        otpTarget: hash,
        lookupType: "phone",
        lookupValueHash: "phone-hash-abc",
      }),
    );
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ sessionId: "session-XYZ", otp }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(createPortalTokenMock).toHaveBeenCalledWith({
      sessionId: "session-XYZ",
      shopId: "shop-XYZ",
      lookupType: "phone",
      lookupValueHash: "phone-hash-abc",
    });
  });
});
