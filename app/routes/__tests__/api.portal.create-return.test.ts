import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.create-return route — validation gates + offer-accept path.
 *
 * This file has ~1,300 statements; a full end-to-end test would require
 * mocking Shopify Admin, Fynd, return-rules engine, notification service,
 * auto-approve rules, and more. This test focuses on the high-value
 * guards (method, rate-limit, CSRF, param validation, blocklist, shop
 * lookup) plus the complete "accept offer → generate discount code" path,
 * since those are self-contained and catch the most common breakage.
 */

const {
  prismaMock,
  shopifyModuleMock,
  checkRateLimitMock,
  verifyPortalCsrfMock,
  withRestCredentialsMock,
  fetchOrderByFyndAffiliateIdMock,
  parseJsonArrayMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  shopifyModuleMock: {
    unauthenticated: {
      admin: vi.fn(),
    },
  },
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  verifyPortalCsrfMock: vi.fn(() => true),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  parseJsonArrayMock: vi.fn((s: string | null, fallback: unknown[]) =>
    s ? JSON.parse(s) : fallback,
  ),
}));
Object.assign(prismaMock, createPrismaMock());
// Add models used by create-return but not in the base factory
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findFirst: vi.fn().mockResolvedValue(null),
};

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
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalCsrfToken: verifyPortalCsrfMock,
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
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrder: vi.fn(),
  fetchOrderByOrderNumber: vi.fn(),
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: vi.fn(),
}));
vi.mock("../../lib/notification.server", () => ({
  sendNewReturnNotification: vi.fn(),
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: vi.fn(() => ({ eligible: true })),
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: vi.fn(() => ({ autoApprove: false })),
  parseAutoApproveRules: vi.fn(() => []),
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: vi.fn(() => ({})),
  buildReturnRequestId: vi.fn(() => "R-001"),
  formatReturnRequestId: vi.fn((x: string) => x),
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: vi.fn().mockResolvedValue(1),
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: vi.fn((x: string) => x),
}));

import { loader, action } from "../api.portal.create-return";

const origEnv = { ...process.env };

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body =
      typeof body === "string"
        ? body
        : JSON.stringify({
            customerEmail: "shopper@example.com",
            portalToken: "verified-token",
            sessionId: "session-1",
            ...(body as Record<string, unknown>),
          });
  }
  return new Request("https://app.example/api/portal/create-return", init);
}

beforeEach(() => {
  process.env = { ...origEnv };
  resetPrismaMock(prismaMock);
  (
    (prismaMock as unknown as Record<string, unknown>).fyndOrderMapping as Record<
      string,
      { mockReset?: () => void; mockResolvedValue?: (v: unknown) => void }
    >
  ).upsert.mockReset?.();
  (
    (prismaMock as unknown as Record<string, unknown>).fyndOrderMapping as Record<
      string,
      { mockReset?: () => void; mockResolvedValue?: (v: unknown) => void }
    >
  ).findFirst.mockReset?.();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderByFyndAffiliateIdMock.mockReset();
  parseJsonArrayMock
    .mockReset()
    .mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));
});

afterEach(() => {
  process.env = { ...origEnv };
});

// ────────────── loader (preflight) ──────────────

describe("loader", () => {
  it("204 on OPTIONS preflight", async () => {
    const req = new Request("https://a/x", { method: "OPTIONS" });
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res?.status).toBe(204);
  });

  it("null for other methods", async () => {
    const req = new Request("https://a/x");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res).toBe(null);
  });
});

// ────────────── action: top-level guards ──────────────

describe("action: top-level guards", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: jsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: jsonReq({ shop: "x" }), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("413 when declared payload size is too large", async () => {
    const req = new Request("https://app.example/api/portal/create-return", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(80 * 1024 * 1024 + 1),
      },
      body: JSON.stringify({ shop: "x" }),
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "Return request payload too large",
    });
  });

  it("400 on invalid JSON", async () => {
    const badReq = new Request("https://app.example/api/portal/create-return", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await action({ request: badReq, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });
});

// ────────────── CSRF gating ──────────────

describe("CSRF gating", () => {
  it("403 when REQUIRE_CSRF is true AND token missing/invalid", async () => {
    process.env.PORTAL_CSRF_REQUIRED = "true";
    verifyPortalCsrfMock.mockReturnValueOnce(false);
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("403 when token provided (opt-in path) but invalid", async () => {
    process.env.PORTAL_CSRF_REQUIRED = "false";
    verifyPortalCsrfMock.mockReturnValueOnce(false);
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "o",
        portalCsrfToken: "bad",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("skips CSRF when required=false AND no token present", async () => {
    process.env.PORTAL_CSRF_REQUIRED = "false";
    // No token; shop not found will short-circuit after CSRF pass
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
    expect(verifyPortalCsrfMock).not.toHaveBeenCalled();
  });
});

// ────────────── Param validation ──────────────

describe("param validation", () => {
  it("400 when shop missing", async () => {
    const res = await action({
      request: jsonReq({ shopifyOrderName: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when shopifyOrderName missing", async () => {
    const res = await action({
      request: jsonReq({ shop: "store" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when order name > 64 chars", async () => {
    const res = await action({
      request: jsonReq({ shop: "store", shopifyOrderName: "#" + "x".repeat(100) }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when orderId missing in auto (non-manual) mode", async () => {
    const res = await action({
      request: jsonReq({ shop: "store", shopifyOrderName: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/orderId/i),
      }),
    );
  });

  it("adds # prefix automatically to order name", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
      }),
      params: {},
      context: {},
    } as never);
    // Shop wasn't found, but the flow reached past order-name validation → confirms # was accepted
    expect(prismaMock.shop.findUnique).toHaveBeenCalled();
  });
});

// ────────────── Shop lookup ──────────────

describe("shop lookup", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({
        shop: "missing",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("normalises non-dotted shop to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await action({
      request: jsonReq({
        shop: "mystore",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
      }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "mystore.myshopify.com" },
      }),
    );
  });
});

// ────────────── Blocklist ──────────────

describe("blocklist", () => {
  it("403 when customer email matches a blocklist entry", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: true,
        returnWindowDays: 30,
        returnOffersEnabled: false,
      },
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({
      id: "b-1",
      type: "email",
      value: "bad@actor.com",
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "bad@actor.com",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Unable to process/);
  });

  it("allows when blocklist disabled even if email is listed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: false,
      },
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // No call to blocklistEntry.findFirst should happen
    await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "bad@actor.com",
      }),
      params: {},
      context: {},
    } as never).catch(() => {});
    expect(prismaMock.blocklistEntry.findFirst).not.toHaveBeenCalled();
  });
});

// ────────────── Offer accept path ──────────────

describe("accept offer flow", () => {
  function mkShopWithOffers(offersJson: string | null) {
    return {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: true,
        returnOffersJson: offersJson,
      },
    };
  }

  it("400 when returnOffersEnabled=false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: false,
      },
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not enabled/i);
  });

  it("400 when no offers match the reason/tag combination", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShopWithOffers(
        JSON.stringify([
          {
            reasonCode: "defective",
            offerType: "discount_pct",
            offerValue: 20,
            message: "20% off",
          },
        ]),
      ),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1, reasonCode: "size" }], // doesn't match "defective"
        lineItemsWithPrice: [{ id: "li-1", productTags: [] }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No matching offer/);
  });

  it("500 when Shopify discount-code creation fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShopWithOffers(
        JSON.stringify([{ offerType: "discount_pct", offerValue: 15, message: "15% off" }]),
      ),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Stub admin.graphql to return userErrors
    const graphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          discountCodeBasicCreate: {
            userErrors: [{ message: "code already in use" }],
          },
        },
      }),
    });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: { graphql } });

    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/code already in use/);
  });

  it("success: generates discount code with matched offer", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShopWithOffers(
        JSON.stringify([{ offerType: "discount_flat", offerValue: 10, message: "10 off" }]),
      ),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const graphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
            userErrors: [],
          },
        },
      }),
    });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: { graphql } });

    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offerAccepted).toBe(true);
    expect(body.discountCode).toMatch(/^KEEP-/);
    expect(body.offerValue).toBe(10);
    expect(body.offerType).toBe("discount_flat");
  });

  it("500 when Shopify GraphQL itself throws mid-flight", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShopWithOffers(
        JSON.stringify([{ offerType: "discount_pct", offerValue: 25, message: "25% off" }]),
      ),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("shopify down"));
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});
