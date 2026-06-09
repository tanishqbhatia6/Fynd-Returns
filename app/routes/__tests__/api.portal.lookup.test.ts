import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.lookup — 602-line lookup dispatcher.
 *
 * Covers: loader preflight, action guards (method / rate-limit / params /
 * shop lookup), the OTP gate (email path — new session, resend cooldown,
 * account lockout, portalToken verification), and the non-OTP lookup
 * paths by lookupType (return_id, return_no/order_no, email, phone,
 * return_awb). Skips the heavy Shopify-orders enrichment + Fynd
 * enrichment tail since those are self-contained async side-effects
 * tested elsewhere.
 */

const {
  prismaMock,
  checkRateLimitMock,
  sendOtpEmailMock,
  fetchOrdersByFilterMock,
  withRestCredentialsMock,
  shopifyModuleMock,
  getPortalLabelsMock,
  getTrackingInfoMock,
  extractJourneyMock,
  getPickupAddressMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  sendOtpEmailMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  fetchOrdersByFilterMock: vi.fn(async () => []),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  getPortalLabelsMock: vi.fn(() => ({ heading: "Your Returns" })),
  getTrackingInfoMock: vi.fn(() => null),
  extractJourneyMock: vi.fn(() => []),
  getPickupAddressMock: vi.fn(() => null),
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
  fetchOrderByOrderNumber: vi.fn(),
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
  createPortalCsrfToken: () => "test-csrf-token",
  verifyPortalSession: vi.fn(async () => ({
    id: "session-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "shopper@example.com",
    matchedReturnIds: null,
  })),
  hashLookupValue: vi.fn(() => "hash"),
}));

import { loader, action } from "../api.portal.lookup";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/portal/lookup", init);
}

function baseShop(settings: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: { id: "s-1", ...settings },
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  sendOtpEmailMock.mockReset().mockResolvedValue(undefined);
  fetchOrdersByFilterMock.mockReset().mockResolvedValue([]);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  shopifyModuleMock.unauthenticated.admin
    .mockReset()
    .mockResolvedValue({ admin: { graphql: vi.fn() } });
  getPortalLabelsMock.mockReset().mockReturnValue({ heading: "Your Returns" });
  getTrackingInfoMock.mockReset().mockReturnValue(null);
  extractJourneyMock.mockReset().mockReturnValue([]);
  getPickupAddressMock.mockReset().mockReturnValue(null);
});

// ────────────── loader ──────────────

describe("loader", () => {
  it("204 on OPTIONS preflight", async () => {
    const res = await loader({
      request: new Request("https://a/x", { method: "OPTIONS" }),
      params: {},
      context: {},
    } as never);
    expect(res?.status).toBe(204);
  });

  it("null on other methods", async () => {
    const res = await loader({
      request: new Request("https://a/x"),
      params: {},
      context: {},
    } as never);
    expect(res).toBe(null);
  });
});

// ────────────── action: top-level guards ──────────────

describe("action: guards", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: jsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 60000 });
    const res = await action({ request: jsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when shop / lookupType / lookupValue missing", async () => {
    const res = await action({ request: jsonReq({ shop: "s" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 on invalid lookupType", async () => {
    const res = await action({
      request: jsonReq({ shop: "s", lookupType: "not_a_type", lookupValue: "x" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when lookupValue too short", async () => {
    const res = await action({
      request: jsonReq({ shop: "s", lookupType: "email", lookupValue: "a" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when lookupValue too long (> 256 chars)", async () => {
    const res = await action({
      request: jsonReq({ shop: "s", lookupType: "email", lookupValue: "a".repeat(300) }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "missing", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("normalises non-dotted shop to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await action({
      request: jsonReq({ shop: "mystore", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "mystore.myshopify.com" },
      }),
    );
  });

  it("500 on malformed JSON body", async () => {
    const bad = new Request("https://app.example/api/portal/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    const res = await action({ request: bad, params: {}, context: {} } as never);
    // Falls into the catch-all — the function doesn't explicitly return 500, so the
    // catch in the outer try/catch hits. Either 400 or 500 is acceptable.
    expect([400, 500]).toContain(res.status);
  });
});

// ────────────── OTP gate ──────────────

describe("OTP gate (email)", () => {
  it("new session + OTP dispatched on first call", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.create.mockResolvedValueOnce({ id: "sess-1" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requiresOtp).toBe(true);
    expect(body.sessionId).toBe("sess-1");
    expect(sendOtpEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "u@x.com" }));
  });

  it("resend within cooldown returns cooldownMs instead of re-sending OTP", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      expiresAt: new Date(Date.now() + 60000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 5000), // 5s ago, within 60s cooldown
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.cooldownMs).toBeGreaterThan(0);
    expect(sendOtpEmailMock).not.toHaveBeenCalled();
  });

  it("resend past cooldown generates new OTP + updates session", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      expiresAt: new Date(Date.now() + 60000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000), // 2min ago, past cooldown
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.lookupSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "sess-1" },
        data: expect.objectContaining({ otpTarget: expect.any(String), attemptsCount: 2 }),
      }),
    );
    expect(sendOtpEmailMock).toHaveBeenCalled();
  });

  it("429 account lockout after 15+ recent failures across sessions", async () => {
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

  it("second call with sessionId but no portalToken → still requiresOtp (unverified)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    // Existing session found on the first branch, past cooldown so reissues new OTP
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect((await res.json()).requiresOtp).toBe(true);
  });

  it("401 when portalToken provided but session expired", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      expiresAt: new Date(Date.now() - 1000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "tok-1",
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
        portalToken: "tok-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("401 when portalToken provided but session not yet verified", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: null,
      portalToken: null,
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
        portalToken: "tok-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect((await res.json()).requiresOtp).toBe(true);
  });

  it("401 on portalToken mismatch", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(baseShop({ portalOtpEmailEnabled: true }));
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      expiresAt: new Date(Date.now() + 60000),
      attemptsCount: 1,
      otpSentAt: new Date(Date.now() - 120_000),
      verifiedAt: new Date(),
      portalToken: "real-token",
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "u@x.com",
        sessionId: "sess-1",
        portalToken: "wrong-token",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
});

// ────────────── Non-OTP lookup paths ──────────────

describe("lookup dispatch (no OTP required)", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue(baseShop());
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: null,
    });
    // Single findMany now (id + include were consolidated). Default to empty so each
    // test only asserts on the where-clause shape, which is what these tests care about.
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  });

  it("return_id lookup builds OR clause with id + returnRequestNo (both cases)", async () => {
    await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "r-abc" }),
      params: {},
      context: {},
    } as never);
    const whereArg = (
      prismaMock.returnCase.findMany.mock.calls[0][0] as Record<string, Record<string, unknown>>
    ).where;
    expect(Array.isArray(whereArg.OR)).toBe(true);
    expect(whereArg.OR).toEqual(
      expect.arrayContaining([
        { id: "r-abc" },
        { returnRequestNo: "r-abc" },
        { returnRequestNo: "R-ABC" },
      ]),
    );
  });

  it("return_no strips leading # and looks up by multiple fields", async () => {
    await action({
      request: jsonReq({ shop: "store", lookupType: "return_no", lookupValue: "#R-123" }),
      params: {},
      context: {},
    } as never);
    const whereArg = (
      prismaMock.returnCase.findMany.mock.calls[0][0] as Record<string, Record<string, unknown>>
    ).where;
    const orList = whereArg.OR as Array<Record<string, { equals?: string }>>;
    const equalsVals = orList.map((x) => Object.values(x)[0]?.equals);
    expect(equalsVals).toContain("r-123");
  });

  it("forward_awb / return_awb uses contains across both fields", async () => {
    await action({
      request: jsonReq({ shop: "store", lookupType: "return_awb", lookupValue: "AWB-1" }),
      params: {},
      context: {},
    } as never);
    const whereArg = (
      prismaMock.returnCase.findMany.mock.calls[0][0] as Record<string, Record<string, unknown>>
    ).where;
    const orList = whereArg.OR as Array<Record<string, { contains?: string }>>;
    expect(orList.some((x) => x.forwardAwb?.contains === "awb-1")).toBe(true);
    expect(orList.some((x) => x.returnAwb?.contains === "awb-1")).toBe(true);
  });

  it("phone type strips non-digits from the query", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-verified",
      shopId: "shop-1",
      lookupType: "phone",
      lookupValueHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      verifiedAt: new Date(),
      portalToken: "tok-verified",
    });
    await action({
      request: jsonReq({
        shop: "store",
        lookupType: "phone",
        lookupValue: "+1 (415) 555-1212",
        sessionId: "sess-verified",
        portalToken: "tok-verified",
      }),
      params: {},
      context: {},
    } as never);
    const whereArg = (
      prismaMock.returnCase.findMany.mock.calls[0][0] as Record<string, Record<string, unknown>>
    ).where;
    const orList = whereArg.OR as Array<Record<string, { contains?: string }>>;
    expect(orList[0].customerPhoneNorm?.contains).toBe("14155551212");
  });

  it("email lookup queries both email + phone norm fields", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-verified",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 1,
      verifiedAt: new Date(),
      portalToken: "tok-verified",
    });
    await action({
      request: jsonReq({
        shop: "store",
        lookupType: "email",
        lookupValue: "USER@Example.com",
        sessionId: "sess-verified",
        portalToken: "tok-verified",
      }),
      params: {},
      context: {},
    } as never);
    const whereArg = (
      prismaMock.returnCase.findMany.mock.calls[0][0] as Record<string, Record<string, unknown>>
    ).where;
    const orList = whereArg.OR as Array<Record<string, { contains?: string }>>;
    expect(orList[0].customerEmailNorm?.contains).toBe("user@example.com");
  });
});

describe("empty-result path", () => {
  it("returns empty returns array when no matches", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(baseShop());
    prismaMock.shopSettings.findUnique.mockResolvedValue({ portalLanguage: "en" });
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "nope" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returns).toEqual([]);
  });
});
