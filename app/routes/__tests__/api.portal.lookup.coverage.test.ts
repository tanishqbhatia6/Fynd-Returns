import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.lookup — extra coverage for the OTP gate state machine.
 *
 * Complements the main test file by covering branches not exercised there:
 *   - Phone OTP fail-closed gate (counterpart to email OTP coverage above).
 *   - Verified portalToken happy path that flows past the OTP gate to the
 *     full result payload (orders, returns, csrf token, matchedReturnIds
 *     persistence).
 *   - sessionExpired branch when sessionId is missing or stale, including
 *     the `sessionExpired: true` body flag.
 *   - Account-lockout boundary conditions: verified sessions excluded,
 *     non-OTP lookup types unaffected, exactly-15 vs exactly-14 failures.
 *   - Resend semantics when the existing session is at MAX_OTP_ATTEMPTS.
 *   - sendOtpEmail failure fails closed with an actionable error.
 *   - lookupValueHash is the SHA-256 of the lowercase-trimmed contact, so
 *     case variants share the same lockout bucket.
 *   - OTP gate skipped when email OTP is explicitly disabled by the merchant.
 *
 * No assertions overlap with the existing api.portal.lookup.test.ts file
 * — these specifically target the states the original tests left
 * untouched.
 */

const {
  prismaMock,
  checkRateLimitMock,
  sendOtpEmailMock,
  fetchOrdersByFilterMock,
  fetchOrderByOrderNumberMock,
  withRestCredentialsMock,
  shopifyModuleMock,
  getPortalLabelsMock,
  getTrackingInfoMock,
  extractJourneyMock,
  getPickupAddressMock,
  createPortalCsrfTokenMock,
  verifyPortalSessionMock,
  hashLookupValueMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  sendOtpEmailMock: vi.fn(async () => ({ success: true })),
  fetchOrdersByFilterMock: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  getPortalLabelsMock: vi.fn(() => ({ heading: "Your Returns" })),
  getTrackingInfoMock: vi.fn(() => null),
  extractJourneyMock: vi.fn(() => []),
  getPickupAddressMock: vi.fn(() => null),
  createPortalCsrfTokenMock: vi.fn(() => "test-csrf-token"),
  verifyPortalSessionMock: vi.fn(async () => ({
    id: "session-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "shopper@example.com",
    matchedReturnIds: null,
  })),
  hashLookupValueMock: vi.fn<(value: unknown) => string>(() => "hash"),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ default: shopifyModuleMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/notification.server", () => ({
  sendOtpEmail: sendOtpEmailMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrdersByFilter: fetchOrdersByFilterMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByGid: vi.fn(),
  fetchOrderByFyndAffiliateId: vi.fn(),
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(async () => ({ ok: false, error: "disabled" })),
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  getTrackingInfoFromFyndPayload: getTrackingInfoMock,
  extractFyndJourney: extractJourneyMock,
  getPickupAddressFromFyndPayload: getPickupAddressMock,
  parseFyndOrderDetailsForTab: vi.fn(() => null),
}));
vi.mock("../../lib/portal-i18n", () => ({
  getPortalLabels: getPortalLabelsMock,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalCsrfToken: createPortalCsrfTokenMock,
  verifyPortalSession: verifyPortalSessionMock,
  hashLookupValue: hashLookupValueMock,
}));

import { action } from "../api.portal.lookup";

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseShop(settings: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: { id: "s-1", ...settings },
  };
}

function sha256Lower(value: string): string {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  sendOtpEmailMock.mockReset().mockResolvedValue({ success: true });
  fetchOrdersByFilterMock.mockReset().mockResolvedValue([]);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  shopifyModuleMock.unauthenticated.admin
    .mockReset()
    .mockResolvedValue({ admin: { graphql: vi.fn() } });
  getPortalLabelsMock.mockReset().mockReturnValue({ heading: "Your Returns" });
  getTrackingInfoMock.mockReset().mockReturnValue(null);
  extractJourneyMock.mockReset().mockReturnValue([]);
  getPickupAddressMock.mockReset().mockReturnValue(null);
  createPortalCsrfTokenMock.mockReset().mockReturnValue("test-csrf-token");
  hashLookupValueMock
    .mockReset()
    .mockImplementation((value: unknown) => sha256Lower(String(value)));
  verifyPortalSessionMock.mockReset().mockResolvedValue({
    id: "session-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: sha256Lower("user@x.com"),
    lookupValueNorm: "shopper@example.com",
    matchedReturnIds: null,
  });
});

// ───────────────────── Phone OTP gate ─────────────────────

describe("OTP gate (phone / SMS channel)", () => {
  it("fails closed when phone OTP delivery is not configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpSmsEnabled: true }));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "phone", lookupValue: "+15551231234" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.phoneVerificationUnavailable).toBe(true);
    expect(prismaMock.lookupSession.create).not.toHaveBeenCalled();
  });

  it("normalises mobile → phone and fails closed without phone OTP delivery", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpSmsEnabled: true }));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "mobile", lookupValue: "+15551239999" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.phoneVerificationUnavailable).toBe(true);
    expect(prismaMock.lookupSession.create).not.toHaveBeenCalled();
  });

  it("skips the email OTP gate when the merchant disables email verification", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(
      baseShop({ portalOtpSmsEnabled: true, portalOtpEmailEnabled: false }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValue({ portalLanguage: "en" });
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBeUndefined();
    expect(body.sessionId).toBeUndefined();
    expect(prismaMock.lookupSession.create).not.toHaveBeenCalled();
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
  });

  it("does NOT gate non-OTP lookup types (order_no) even with email gate on", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.shopSettings.findUnique.mockResolvedValue({ portalLanguage: "en" });
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1001" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBeUndefined();
    expect(prismaMock.lookupSession.create).not.toHaveBeenCalled();
  });
});

// ───────────────────── portalToken verified happy path ─────────────────────

describe("OTP gate verified portalToken — happy path", () => {
  beforeEach(() => {
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: null,
    });
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  });

  it("verified session + matching token → returns results envelope (orders, returns, csrf)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-vp",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("user@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "valid-tok",
    });
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        sessionId: "sess-vp",
        portalToken: "valid-tok",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBeUndefined();
    expect(body.portalCsrfToken).toBe("test-csrf-token");
    expect(Array.isArray(body.orders)).toBe(true);
    expect(Array.isArray(body.returns)).toBe(true);
    expect(body.portalLanguage).toBe("en");
  });

  it("rejects a verified portal token that does not match the requested contact", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-vp",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "other-contact-hash",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "valid-tok",
    });
    verifyPortalSessionMock.mockResolvedValueOnce({
      id: "sess-vp",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "other-contact-hash",
      lookupValueNorm: "other@example.com",
      matchedReturnIds: null,
    });
    fetchOrdersByFilterMock.mockResolvedValueOnce([
      { id: "gid://shopify/Order/1", name: "#1001", createdAt: new Date().toISOString() },
    ]);

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "victim@example.com",
        sessionId: "sess-vp",
        portalToken: "valid-tok",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.requiresOtp).toBe(true);
    expect(fetchOrdersByFilterMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("persists matchedReturnIds back to the session after success", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-mr",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("user@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "tok-mr",
    });
    prismaMock.returnCase.findMany.mockResolvedValue([
      { id: "rc-1", status: "PENDING", createdAt: new Date(), items: [], events: [] },
      { id: "rc-2", status: "APPROVED", createdAt: new Date(), items: [], events: [] },
    ]);

    await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        sessionId: "sess-mr",
        portalToken: "tok-mr",
      }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sess-mr" },
        data: expect.objectContaining({
          matchedReturnIds: JSON.stringify(["rc-1", "rc-2"]),
        }),
      }),
    );
  });

  it("matchedReturnIds persistence failure is non-fatal — response still 200", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-mr",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("user@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "tok-mr",
    });
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    prismaMock.lookupSession.update.mockRejectedValueOnce(new Error("db down"));

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        sessionId: "sess-mr",
        portalToken: "tok-mr",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
  });
});

// ───────────────────── sessionExpired branch ─────────────────────

describe("sessionExpired branch", () => {
  it("portalToken provided but no sessionId → 401 with sessionExpired flag", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        portalToken: "some-token",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.sessionExpired).toBe(true);
    expect(body.error).toMatch(/expired/i);
  });

  it("portalToken with unknown sessionId → 401 with sessionExpired flag", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(null);

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        sessionId: "ghost-session",
        portalToken: "tok",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.sessionExpired).toBe(true);
  });

  it("expired session body carries sessionExpired flag (not just 401)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-x",
      expiresAt: new Date(Date.now() - 1000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 5_000),
      verifiedAt: new Date(),
      portalToken: "tok",
    });

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "user@x.com",
        sessionId: "sess-x",
        portalToken: "tok",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.sessionExpired).toBe(true);
  });
});

// ───────────────────── account lockout edge cases ─────────────────────

describe("account lockout boundary", () => {
  it("does NOT lock at exactly 14 cumulative failures (just below threshold)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([
      { attemptsCount: 7, verifiedAt: null },
      { attemptsCount: 7, verifiedAt: null },
    ]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "fresh-sess" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBe(true);
    expect(body.accountLocked).toBeUndefined();
  });

  it("locks at exactly 15 cumulative failures (boundary)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([
      { attemptsCount: 5, verifiedAt: null },
      { attemptsCount: 5, verifiedAt: null },
      { attemptsCount: 5, verifiedAt: null },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.accountLocked).toBe(true);
  });

  it("verified sessions do NOT count toward lockout total", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([
      { attemptsCount: 50, verifiedAt: new Date() }, // verified — ignored
      { attemptsCount: 3, verifiedAt: null },
    ]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "fresh-sess" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBe(true);
    expect(body.accountLocked).toBeUndefined();
  });

  it("lockout query filters by lookupValueHash + 1-hour window", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "fresh" });

    const before = Date.now();
    await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "User@Example.COM" }),
      params: {},
      context: {},
    } as never);
    const after = Date.now();

    const arg = prismaMock.lookupSession.findMany.mock.calls[0][0] as {
      where: { shopId: string; lookupValueHash: string; createdAt: { gte: Date } };
    };
    // Hash uses lowercased + trimmed contact
    expect(arg.where.lookupValueHash).toBe(sha256Lower("User@Example.COM"));
    expect(arg.where.shopId).toBe("shop-1");
    const gteMs = arg.where.createdAt.gte.getTime();
    // Within ~10s of "1 hour before now"
    expect(gteMs).toBeGreaterThanOrEqual(before - 60 * 60 * 1000 - 5_000);
    expect(gteMs).toBeLessThanOrEqual(after - 60 * 60 * 1000 + 5_000);
  });
});

// ───────────────────── existing-session resend edge cases ─────────────────────

describe("existing-session resend edge cases", () => {
  it("session at MAX_OTP_ATTEMPTS triggers fresh-session path (lockout / new session)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    // findUnique returns a session that has reached the per-session attempt cap.
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "maxed",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("u@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 5, // === MAX_OTP_ATTEMPTS — falls through past the resend block
      otpSentAt: new Date(Date.now() - 120_000),
    });
    // findMany for lockout — empty so we'd create a new session.
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "new-after-max" });

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "maxed",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("new-after-max");
    expect(prismaMock.lookupSession.create).toHaveBeenCalled();
    // The maxed-out session was NOT updated (resend branch was skipped).
    expect(prismaMock.lookupSession.update).not.toHaveBeenCalled();
  });

  it("expired existing session falls through to lockout/new path", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "expired",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("u@x.com"),
      expiresAt: new Date(Date.now() - 1_000), // already expired
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 10_000),
    });
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "fresh-after-exp" });

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "expired",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("fresh-after-exp");
    expect(prismaMock.lookupSession.create).toHaveBeenCalled();
  });

  it("first call without otpSentAt (unset) triggers immediate (re)send", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "no-sent",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("u@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: null, // unset → cooldown=0
    });

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "no-sent",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("no-sent");
    expect(body.cooldownMs).toBeUndefined();
    expect(sendOtpEmailMock).toHaveBeenCalled();
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "no-sent" },
        data: expect.objectContaining({ attemptsCount: 2 }),
      }),
    );
  });

  it("does not reuse a sessionId for a different contact lookup value", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "mismatched-session",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "other-contact-hash",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
    });
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "fresh-for-contact" });

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "mismatched-session",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("fresh-for-contact");
    expect(prismaMock.lookupSession.update).not.toHaveBeenCalled();
  });
});

// ───────────────────── send-OTP failure handling ─────────────────────

describe("send-OTP failure handling", () => {
  it("sendOtpEmail rejection fails closed and keeps the session retryable", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "swallow-sess" });
    sendOtpEmailMock.mockRejectedValueOnce(new Error("smtp boom"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.emailVerificationUnavailable).toBe(true);
    expect(body.requiresOtp).toBeUndefined();
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith({
      where: { id: "swallow-sess" },
      data: { otpTarget: null, otpSentAt: null, attemptsCount: 0 },
    });
  });

  it("sendOtpEmail rejection on resend path also fails closed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "resend-fail",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: sha256Lower("u@x.com"),
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
    });
    sendOtpEmailMock.mockRejectedValueOnce(new Error("smtp dead"));

    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "resend-fail",
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.emailVerificationUnavailable).toBe(true);
    expect(body.requiresOtp).toBeUndefined();
    expect(prismaMock.lookupSession.update).toHaveBeenLastCalledWith({
      where: { id: "resend-fail" },
      data: { otpTarget: null, otpSentAt: null, attemptsCount: 1 },
    });
  });
});

// ───────────────────── lookupValueHash normalisation ─────────────────────

describe("lookupValueHash normalisation", () => {
  it("case-variant emails hash to identical bucket (lockout shared)", async () => {
    // First call with mixed case
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "case-1" });

    await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "  USER@X.COM  " }),
      params: {},
      context: {},
    } as never);

    // Second call with all-lowercase
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "case-2" });

    await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "user@x.com" }),
      params: {},
      context: {},
    } as never);

    const firstHash = (
      prismaMock.lookupSession.findMany.mock.calls[0][0] as { where: { lookupValueHash: string } }
    ).where.lookupValueHash;
    const secondHash = (
      prismaMock.lookupSession.findMany.mock.calls[1][0] as { where: { lookupValueHash: string } }
    ).where.lookupValueHash;
    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe(sha256Lower("user@x.com"));
  });

  it("session create stores normalised lookupValueNorm + hash", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "norm-sess" });

    await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "  Mixed@CASE.com " }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.lookupSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lookupValueNorm: "mixed@case.com",
          lookupValueHash: sha256Lower("Mixed@CASE.com"),
        }),
      }),
    );
  });
});
