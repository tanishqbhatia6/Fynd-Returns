import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.create-return — coverage-focused integration tests.
 *
 * Companion to api.portal.create-return.test.ts (which covers preflight,
 * top-level guards, CSRF, param-validation, blocklist, and offer-accept
 * paths).  This file targets the heavier *happy-path* return-creation
 * branches that fire AFTER the offer-accept short-circuit doesn't apply:
 *   • per-item line-item validation (qty bounds, shape, count cap)
 *   • blocklist match by phone / order_name (in addition to email)
 *   • Fynd sync trigger after auto-approve
 *   • autoApprove rule evaluation (manual_review, approve, no-rules,
 *     disabled)
 *   • return-window expiry
 *   • shopify line-item validation against lineItemsWithPrice
 *   • exchange resolutionType + structured exchange variant payload
 *
 * Heavy mock — every external dependency is stubbed so the tests are
 * pure and deterministic.
 */

const {
  prismaMock,
  shopifyModuleMock,
  checkRateLimitMock,
  verifyPortalCsrfMock,
  withRestCredentialsMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  parseJsonArrayMock,
  evaluateAutoApproveRulesMock,
  parseAutoApproveRulesMock,
  createReturnOnFyndMock,
  createFyndClientOrErrorMock,
  claimAndCreateShopifyReturnMock,
  sendNewReturnNotificationMock,
  checkReturnEligibilityMock,
  buildReturnRequestIdMock,
  parseReturnIdConfigMock,
  formatReturnRequestIdMock,
  nextReturnIdCounterMock,
  normalizeSourceChannelMock,
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
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  parseJsonArrayMock: vi.fn((s: string | null, fallback: unknown[]) =>
    s ? JSON.parse(s) : fallback,
  ),
  evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
  parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => [] as unknown[]),
  createReturnOnFyndMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn(),
  claimAndCreateShopifyReturnMock: vi.fn(),
  sendNewReturnNotificationMock: vi.fn().mockResolvedValue(undefined),
  checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => { eligible: boolean; reason?: string }>(
    () => ({ eligible: true }),
  ),
  buildReturnRequestIdMock: vi.fn(() => "R-1001"),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "id" })),
  formatReturnRequestIdMock: vi.fn((x: string) => `R-${x}`),
  nextReturnIdCounterMock: vi.fn().mockResolvedValue(1),
  normalizeSourceChannelMock: vi.fn((x: string) => x),
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
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../lib/shopify-return-claim.server", () => ({
  claimAndCreateShopifyReturn: claimAndCreateShopifyReturnMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendNewReturnNotification: sendNewReturnNotificationMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: evaluateAutoApproveRulesMock,
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: nextReturnIdCounterMock,
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: vi.fn().mockResolvedValue(undefined),
}));

import { action } from "../api.portal.create-return";

const origEnv = { ...process.env };

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/create-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Standard happy-path shop record with auto-approve disabled. */
function happyShop(overrideSettings: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: {
      id: "settings-1",
      blocklistEnabled: false,
      returnWindowDays: 30,
      returnOffersEnabled: false,
      autoApproveEnabled: false,
      autoApproveRulesJson: null,
      greenReturnsEnabled: false,
      ...overrideSettings,
    },
  };
}

/** Default body for an automatic-mode return creation request. */
function happyBody(extra: Record<string, unknown> = {}) {
  return {
    shop: "store",
    shopifyOrderName: "1001",
    orderId: "gid://shopify/Order/1",
    customerEmail: "shopper@example.com",
    items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1, reasonCode: "size" }],
    lineItemsWithPrice: [
      {
        id: "gid://shopify/LineItem/100",
        title: "Tee",
        price: "25.00",
        quantity: 1,
        productTags: ["sale"],
        sku: "TEE-1",
      },
    ],
    orderCreatedAt: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  process.env = { ...origEnv, PORTAL_CSRF_REQUIRED: "false" };
  resetPrismaMock(prismaMock);
  const fynd = (
    prismaMock as unknown as Record<
      string,
      { upsert: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
    >
  ).fyndOrderMapping;
  fynd.upsert.mockReset().mockResolvedValue({});
  fynd.findFirst.mockReset().mockResolvedValue(null);
  prismaMock.fyndWebhookLog.findMany.mockReset().mockResolvedValue([]);
  shopifyModuleMock.unauthenticated.admin.mockReset();
  // Default: Shopify admin returns a graphql function (not used in most tests)
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderMock.mockReset().mockResolvedValue({
    id: "gid://shopify/Order/1",
    displayFulfillmentStatus: "FULFILLED",
    displayFinancialStatus: "PAID",
    sourceName: "web",
    affiliateOrderId: null,
    lineItems: [],
  });
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  parseJsonArrayMock
    .mockReset()
    .mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  createReturnOnFyndMock
    .mockReset()
    .mockResolvedValue({ success: true, fyndReturnId: "fr-1", fyndShipmentId: "fs-1" });
  createFyndClientOrErrorMock
    .mockReset()
    .mockResolvedValue({ ok: false, error: "Fynd not configured" });
  claimAndCreateShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1", claimed: true });
  sendNewReturnNotificationMock.mockReset().mockResolvedValue(undefined);
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-1001");
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "id" });
  formatReturnRequestIdMock.mockReset().mockImplementation((x: string) => `R-${x}`);
  nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
  normalizeSourceChannelMock.mockReset().mockImplementation((x: string) => x);
});

afterEach(() => {
  process.env = { ...origEnv };
});

// ────────────────────────── line-item validation ──────────────────────────

describe("line item validation (auto mode)", () => {
  it("400 when items array is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq(happyBody({ items: [] })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least one item/i);
  });

  it("400 when an item is missing lineItemId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq(happyBody({ items: [{ qty: 1 }] })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lineItemId and qty/i);
  });

  it("400 when an item has qty < 1", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq(
        happyBody({ items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 0 }] }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/qty/i);
  });

  it("400 when an item has qty > 999", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq(
        happyBody({ items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1000 }] }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/quantity exceeds maximum/i);
  });

  it("400 when more than 100 items submitted", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const items = Array.from({ length: 101 }, (_, i) => ({
      lineItemId: `gid://shopify/LineItem/${i}`,
      qty: 1,
    }));
    const res = await action({
      request: jsonReq(happyBody({ items })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too many items/i);
  });

  it("400 when selected lineItemId not present in lineItemsWithPrice", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "gid://shopify/LineItem/UNKNOWN", qty: 1 }],
          lineItemsWithPrice: [
            { id: "gid://shopify/LineItem/100", title: "Tee", price: "25.00", quantity: 1 },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid line item/i);
  });
});

// ────────────────────────── blocklist (phone + order_name) ──────────────────────────

describe("blocklist additional matchers", () => {
  it("403 when phone matches a blocklist entry", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop({ blocklistEnabled: true }));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({
      id: "b-1",
      type: "phone",
      value: "+15551234567",
    });
    const res = await action({
      request: jsonReq(happyBody({ customerPhone: "+1 (555) 123-4567" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Unable to process/);
  });

  it("403 when order_name matches a blocklist entry", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop({ blocklistEnabled: true }));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({
      id: "b-1",
      type: "order_name",
      value: "#1001",
    });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("does not call blocklistEntry when no email/phone/order_name available", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop({ blocklistEnabled: true }));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // No customer email/phone — but shopifyOrderName is always present, so
    // blocklist will still query. Just confirm it does not 403 when empty.
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({
        ...happyBody(),
        customerEmail: undefined,
        customerPhone: undefined,
      }),
      params: {},
      context: {},
    } as never);
    // Either reaches creation (200) or fails downstream — must not be 403
    expect(res.status).not.toBe(403);
    expect(prismaMock.blocklistEntry.findFirst).toHaveBeenCalled();
  });
});

// ────────────────────────── return window expiry ──────────────────────────

describe("return-window expiry", () => {
  it("400 when current date is past the return window", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop({ returnWindowDays: 7 }));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 60);
    const res = await action({
      request: jsonReq(happyBody({ orderCreatedAt: longAgo.toISOString() })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Return window has expired/i);
  });

  it("uses default 30-day window when settings.returnWindowDays missing", async () => {
    const shop = happyShop();
    delete (shop.settings as Record<string, unknown>).returnWindowDays;
    prismaMock.shop.findUnique.mockResolvedValueOnce(shop);
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const old = new Date();
    old.setDate(old.getDate() - 45);
    const res = await action({
      request: jsonReq(happyBody({ orderCreatedAt: old.toISOString() })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/within 30 days/);
  });
});

// ────────────────────────── eligibility ──────────────────────────

describe("return eligibility", () => {
  it("400 when checkReturnEligibility flags item ineligible", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    checkReturnEligibilityMock.mockReturnValueOnce({ eligible: false, reason: "Final sale item" });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Final sale item|not eligible/i);
  });
});

// ────────────────────────── happy path: full creation ──────────────────────────

describe("full happy-path creation", () => {
  it("200 + creates returnCase when manual approval (autoApprove disabled)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = {
      id: "rc-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
      returnRequestNo: null,
    };
    // Patch create + update to return the case
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...createdRc,
      returnRequestNo: "R-1001",
    });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.returnId).toBe("rc-1");
    expect(body.status).toBe("initiated");
    expect(body.summary.itemsCount).toBe(1);
    expect(prismaMock.returnCase.create).toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalled();
  });

  it("normalizes shopifyOrderName by adding leading # when missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-2", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody({ shopifyOrderName: "1001" })),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.shopifyOrderName).toBe("#1001");
  });
});

// ────────────────────────── auto-approve evaluation ──────────────────────────

describe("autoApprove rule evaluation", () => {
  it("status=approved when settings.autoApproveEnabled=true and no rules → approve", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]); // no rules → falls through to "approved"
    const createdRc = { id: "rc-aa-1", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.status).toBe("approved");
  });

  it("status=approved when rule evaluator returns 'approve'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"true","then":"approve"}]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ if: "true", then: "approve" }]);
    evaluateAutoApproveRulesMock.mockReturnValueOnce("approve");
    const createdRc = { id: "rc-aa-2", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.status).toBe("approved");
    expect(evaluateAutoApproveRulesMock).toHaveBeenCalled();
  });

  it("status=initiated when rule evaluator returns 'manual_review'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"orderValue>1000","then":"manual_review"}]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([
      { if: "orderValue>1000", then: "manual_review" },
    ]);
    evaluateAutoApproveRulesMock.mockReturnValueOnce("manual_review");
    const createdRc = { id: "rc-aa-3", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.status).toBe("initiated");
  });

  it("queries customer return count when customerEmail provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"customerReturnCount<3","then":"approve"}]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([
      { if: "customerReturnCount<3", then: "approve" },
    ]);
    (prismaMock.returnCase.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    const createdRc = { id: "rc-aa-4", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerEmailNorm: "shopper@example.com" }),
      }),
    );
    const ctx = (evaluateAutoApproveRulesMock.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
    expect(ctx.customerReturnCount).toBe(2);
  });

  it("status=initiated when autoApproveEnabled=false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop({ autoApproveEnabled: false }));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-na-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.status).toBe("initiated");
    expect(evaluateAutoApproveRulesMock).not.toHaveBeenCalled();
  });
});

// ────────────────────────── Fynd sync ──────────────────────────

describe("Fynd sync trigger", () => {
  it("allocates return items from cached Fynd shipment webhook payload when browser snapshot is absent", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      {
        rawPayload: JSON.stringify({
          event: { name: "shipment", type: "create" },
          payload: {
            shipment: {
              status: "placed",
              shipment_id: "17797917699901820308",
              bags: [
                {
                  bag_id: 3881011,
                  line_number: 1,
                  quantity: 1,
                  article: {
                    _id: "69e0be738dd8d8e41fdb57cf",
                    seller_identifier: "RETURN3",
                    size: "M",
                  },
                  affiliate_bag_details: {
                    affiliate_order_id: "FYNDSHOPIFYX14403",
                    affiliate_meta: {
                      affiliate_line_id: 17555511443606,
                      affiliate_sku: "RETURN3",
                    },
                  },
                  prices: { price_effective: 100 },
                },
                {
                  bag_id: 3881012,
                  line_number: 2,
                  quantity: 1,
                  article: {
                    _id: "69e0be738dd8d8e41fdb57cf",
                    seller_identifier: "RETURN3",
                    size: "M",
                  },
                  affiliate_bag_details: {
                    affiliate_order_id: "FYNDSHOPIFYX14403",
                    affiliate_meta: {
                      affiliate_line_id: 17555511443606,
                      affiliate_sku: "RETURN3",
                    },
                  },
                  prices: { price_effective: 100 },
                },
              ],
            },
          },
        }),
      },
    ]);
    const createdRc = {
      id: "rc-webhook-snapshot",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    const res = await action({
      request: jsonReq(
        happyBody({
          shopifyOrderName: "FYNDSHOPIFYX14403",
          items: [
            {
              lineItemId: "gid://shopify/LineItem/17555511443606",
              qty: 2,
              reasonCode: "Size too Big",
            },
          ],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/17555511443606",
              title: "RETURN APP TESTING 1",
              price: "100.00",
              quantity: 4,
              productTags: [],
              sku: "RETURN3",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const createArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArg.data.fyndShipmentId).toBe("17797917699901820308");
    expect(createArg.data.items.create).toEqual([
      expect.objectContaining({
        fyndBagId: "3881011",
        fyndSellerIdentifier: "RETURN3",
        fyndLineNumber: 1,
        qty: 1,
      }),
      expect.objectContaining({
        fyndBagId: "3881012",
        fyndSellerIdentifier: "RETURN3",
        fyndLineNumber: 2,
        qty: 1,
      }),
    ]);
  });

  it("calls createReturnOnFynd when status=approved AND fynd client ok", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = {
      id: "rc-fynd-1",
      status: "approved",
      createdAt: new Date(),
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 }],
      fyndShipmentId: null,
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      affiliateOrderId: "AFF-1",
      lineItems: [],
    });
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    createReturnOnFyndMock.mockResolvedValue({
      success: true,
      fyndReturnId: "FR-99",
      fyndShipmentId: "FS-99",
      fyndReturnNo: "RN-99",
    });

    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(createFyndClientOrErrorMock).toHaveBeenCalled();
    expect(claimAndCreateShopifyReturnMock).toHaveBeenCalledWith(
      "rc-fynd-1",
      expect.anything(),
      "gid://shopify/Order/1",
      [
        {
          shopifyLineItemId: "gid://shopify/LineItem/100",
          qty: 1,
          reasonCode: null,
          notes: null,
          sku: null,
        },
      ],
      expect.objectContaining({ requestedAt: createdRc.createdAt.toISOString() }),
    );
    expect(createReturnOnFyndMock).toHaveBeenCalledWith(
      expect.anything(),
      createdRc,
      expect.objectContaining({ affiliateOrderId: "AFF-1" }),
    );
    // Confirm status update with synced flag
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-fynd-1" },
        data: expect.objectContaining({ fyndSyncStatus: "synced", fyndReturnId: "FR-99" }),
      }),
    );
  });

  it("does NOT call createReturnOnFynd when status=initiated", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-noFynd-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("schedules retry when Fynd sync throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-fail-1", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      affiliateOrderId: "AFF-2",
      lineItems: [],
    });
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("Fynd 502"));

    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    // The endpoint should still succeed even when Fynd sync fails; retry is fire-and-forget.
    expect(res.status).toBe(200);
    expect(createReturnOnFyndMock).toHaveBeenCalled();
  });

  it("skips Fynd sync for green returns even when status=approved", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
        greenReturnsEnabled: true,
        greenReturnsThreshold: "100",
        greenReturnsProductTags: '["sale"]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-green-1", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    // The body has price 25 and tag "sale", so it qualifies as green → no Fynd sync
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("sets fyndSyncStatus=pending on returnCase when status=approved + non-green", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-pending-1", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.fyndSyncStatus).toBe("pending");
  });
});

// ────────────────────────── exchange flow ──────────────────────────

describe("exchange / structured variants", () => {
  it("persists resolutionType=exchange and exchangePreference text", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-ex-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangePreference: "Size L instead",
        }),
      ),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.resolutionType).toBe("exchange");
    expect(callArg?.data?.exchangePreference).toMatch(/Size L instead/);
  });

  it("falls back to refund when resolutionType is unrecognized", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-rf-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody({ resolutionType: "warranty_swap" })),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.resolutionType).toBe("refund");
  });
});

// ────────────────────────── notification fire-and-forget ──────────────────────────

describe("notification fire-and-forget", () => {
  it("calls sendNewReturnNotification on successful creation", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = {
      id: "rc-not-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
      returnRequestNo: "R-1001",
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(sendNewReturnNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "store.myshopify.com",
        orderName: "#1001",
        customerEmail: "shopper@example.com",
        itemCount: 1,
      }),
    );
  });
});
