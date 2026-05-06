import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for api.portal.otp.verify:
 *   - line 30: loader `return null` (non-OPTIONS GET)
 *   - line 105: bcrypt.compare throws → caught, isValid stays false
 */

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
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalToken: createPortalTokenMock,
}));
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => {
      throw new Error("bcrypt blew up");
    }),
  },
}));

import { loader, action } from "../api.portal.otp.verify";

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
});

describe("api.portal.otp.verify — coverage closure", () => {
  it("loader returns null for non-OPTIONS requests (line 30)", async () => {
    const res = await loader({
      request: new Request("https://a/x", { method: "GET" }),
      params: {},
      context: {},
    } as never);
    expect(res).toBeNull();
  });

  it("bcrypt.compare throwing is swallowed → isValid=false → 400 invalid code (line 105)", async () => {
    // Stored hash that is NOT 64-hex (so legacy-SHA path is skipped) but passes
    // through to bcrypt.compare, which we mocked to throw.
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: new Date(Date.now() - 1000),
      otpTarget: "$2b$10$abcdefghijklmnopqrstuv", // bcrypt-shaped, not 64-hex
      lookupValueHash: "lookup-hash",
      lookupType: "email",
    });
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const res = await action({
      request: jsonReq({ sessionId: "s-1", otp: "123456" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid verification code");
    expect(body.attemptsRemaining).toBe(4);
  });
});
