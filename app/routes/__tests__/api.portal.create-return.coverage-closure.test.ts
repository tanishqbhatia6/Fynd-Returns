import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for api.portal.create-return:
 *   - line 31 col 38: `return null` inside matchReturnOffers when offers list is empty
 *   - line 32 col 43: inline arrow `(t) => t.toLowerCase()` only runs when
 *     productTags has at least one tag
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
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  verifyPortalCsrfMock: vi.fn(() => true),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  parseJsonArrayMock: vi.fn((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback)),
}));
Object.assign(prismaMock, createPrismaMock());
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

import { action } from "../api.portal.create-return";

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/create-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  shopifyModuleMock.unauthenticated.admin.mockReset();
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderByFyndAffiliateIdMock.mockReset();
  parseJsonArrayMock.mockReset().mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));
});

describe("matchReturnOffers — closure branches", () => {
  it("returns null path when offers JSON is an empty array (line 31 col 38)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: true,
        returnOffersJson: JSON.stringify([]), // empty offers list → matchReturnOffers exits at L31
      },
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });

    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1, reasonCode: "size" }],
        lineItemsWithPrice: [{ id: "li-1", productTags: [] }],
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No matching offer/);
  });

  it("runs the (t) => t.toLowerCase() arrow on line 32 when productTags has values", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: true,
        // Offer requires tag "Sale" — productTags MUST be lowercased to match
        returnOffersJson: JSON.stringify([
          { tag: "sale", offerType: "discount_pct", offerValue: 10, message: "10% off" },
        ]),
      },
    });
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
        // productTags has values — exercises the arrow at line 32 col 43
        lineItemsWithPrice: [{ id: "li-1", productTags: ["SALE", "Featured"] }],
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offerAccepted).toBe(true);
  });
});
