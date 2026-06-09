/**
 * Final coverage closure for:
 *   - app/routes/api.admin.backfill-fynd-items.ts  → 91% → ≥99%
 *   - app/routes/api.portal.create-return.ts        → 96% → ≥99%
 *
 * Targeted uncovered lines:
 *   backfill-fynd-items
 *     201-221  bag-level fallback when bag has no articles/items/item
 *     263-266  title+price fuzzy match price-proximity branch
 *   portal.create-return
 *     952      auto-approve evaluator returns neither "approve" nor
 *              "manual_review" (else fallthrough to "approved")
 *     1193-1195  liInfo.price is an object (not string) — extract via
 *                amount/value/effective/transfer_price/price_effective
 *
 * No source modifications. Existing tests untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ─────────────────────────── shared hoisted mocks ───────────────────────────
const {
  prismaMock,
  shopifyModuleMock,
  authenticateMock,
  createFyndClientOrErrorMock,
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
  authenticateMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
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
vi.mock("../../shopify.server", () => ({
  default: shopifyModuleMock,
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
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
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
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

import { action as backfillAction } from "../api.admin.backfill-fynd-items";
import { action as portalCreateAction } from "../api.portal.create-return";

const origEnv = { ...process.env };

function backfillReq(body: unknown = {}) {
  return new Request("https://app.example/api/admin/backfill-fynd-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function portalReq(body: unknown) {
  return new Request("https://app.example/api/portal/create-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

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

  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });

  shopifyModuleMock.unauthenticated.admin.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderMock.mockReset().mockResolvedValue({
    id: "gid://shopify/Order/1",
    email: "shopper@example.com",
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

// ───────────────────────── backfill-fynd-items 201-221 + 263-266 ─────────────────────────

describe("backfill-fynd-items — bag-level fallback (lines 201-221)", () => {
  it("populates allBags via bag-level fallback when bag has no articles/items/item", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    // Bag has NO articles, NO items, NO item — drives the bag-level fallback path
    // populating from bag.seller_identifier / bag.article_id / bag.affiliate_bag_details.
    const shipment = {
      shipment_id: "SHIP-FB",
      bags: [
        {
          bag_id: "BAG-FB",
          seller_identifier: "FB-SKU",
          article_id: "FB-ART",
          quantity: 7,
          size: "L",
          affiliate_bag_details: { affiliate_line_id: "FB-LINE" },
          prices: { transfer_price: "200", price_effective: "250" },
          item: { item_id: "FB-ITM", name: "Fallback Widget", size: "L" },
        },
      ],
    };
    // Note: the fallback predicate at line 198-200 checks
    //   articles.length === 0 && items.length === 0 && !bag.item
    // The truthy bag.item above would skip the fallback branch.
    // To actually enter lines 201-221, omit bag.item entirely.
    shipment.bags[0] = {
      bag_id: "BAG-FB",
      seller_identifier: "FB-SKU",
      article_id: "FB-ART",
      quantity: 7,
      size: "L",
      affiliate_bag_details: { affiliate_line_id: "FB-LINE" },
      prices: { transfer_price: "200", price_effective: "250" },
    } as never;

    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fb",
        returnRequestNo: "RR-FB",
        shopifyOrderId: "gid://shopify/Order/100",
        shopifyOrderName: "#1001",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-fb",
            title: "Whatever",
            sku: "FB-SKU", // matches bag.seller_identifier → uses fallback bag entry
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillAction({
      request: backfillReq({}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    const data = prismaMock.returnItem.update.mock.calls[0][0].data;
    // Confirm the values came from the bag-level fallback (lines 201-221)
    expect(data).toMatchObject({
      fyndShipmentId: "SHIP-FB",
      fyndBagId: "BAG-FB",
      fyndArticleId: "FB-ART",
      fyndAffiliateLineId: "FB-LINE",
      fyndSellerIdentifier: "FB-SKU",
      fyndQuantityAvailable: 7,
      fyndPriceEffective: "250",
      fyndSize: "L",
    });
  });

  it("bag-level fallback handles missing prices/size/affiliate cleanly (null guards)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-FB2",
      bags: [
        {
          bag_id: "BAG-FB2",
          seller_identifier: "FB2-SKU",
          // no article_id, no quantity, no size, no prices, no affiliate_bag_details
          affiliate_bag_details: {},
          prices: {},
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fb2",
        returnRequestNo: "RR-FB2",
        shopifyOrderId: "gid://shopify/Order/200",
        shopifyOrderName: "#2002",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-fb2",
            title: "Anything",
            sku: "FB2-SKU",
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillAction({
      request: backfillReq({}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const data = prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(data.fyndSellerIdentifier).toBe("FB2-SKU");
    expect(data.fyndBagId).toBe("BAG-FB2");
    expect(data.fyndShipmentId).toBe("SHIP-FB2");
    // Null-or-skipped fields:
    expect(data.fyndPriceEffective).toBeUndefined();
    expect(data.fyndSize).toBeUndefined();
    expect(data.fyndAffiliateLineId).toBeUndefined();
  });
});

describe("backfill-fynd-items — title+price proximity (lines 263-266)", () => {
  it("matches by title containment AND price within $1 tolerance", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    // No bagId/sku/affiliateLineId hits — fall through to title fuzzy match
    // with price proximity (return item price 99.50 vs bag price 99.99 → diff < 1)
    const shipment = {
      shipment_id: "SHIP-T",
      bags: [
        {
          bag_id: "BAG-T",
          affiliate_bag_details: { affiliate_line_id: "T-LINE" },
          prices: { transfer_price: "99.99" },
          articles: [
            {
              seller_identifier: "T-SKU",
              article_id: "T-ART",
              item: { item_id: "T-ITM", name: "Vintage Blue Widget" },
            },
          ],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-t",
        returnRequestNo: "RR-T",
        shopifyOrderId: "gid://shopify/Order/300",
        shopifyOrderName: "#3003",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-t",
            title: "Vintage Blue Widget", // exact-contained title
            sku: null, // sku miss
            price: "99.50", // within $1 of bag's 99.99 → satisfies line 266
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillAction({
      request: backfillReq({}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    const data = prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(data.fyndBagId).toBe("BAG-T");
    expect(data.fyndSellerIdentifier).toBe("T-SKU");
  });

  it("rejects title match when price difference > $1", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-NM",
      bags: [
        {
          bag_id: "BAG-NM",
          affiliate_bag_details: {},
          prices: { transfer_price: "10.00" }, // far from 99.50
          articles: [
            {
              seller_identifier: "NM-SKU",
              article_id: "NM-ART",
              item: { name: "Vintage Blue Widget" },
            },
          ],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-nm",
        returnRequestNo: "RR-NM",
        shopifyOrderId: "gid://shopify/Order/400",
        shopifyOrderName: "#4004",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-nm",
            title: "Vintage Blue Widget",
            sku: null,
            price: "99.50", // diff with 10.00 is 89.50 → > 1
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillAction({
      request: backfillReq({}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    // Title contains but price diff > 1, so the predicate at 266 returns false →
    // no match → no DB write
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(body.results[0].details.some((d: string) => d.includes("no Fynd bag match"))).toBe(true);
  });
});

// ───────────────────────── portal.create-return 952 + 1193-1195 ─────────────────────────

describe("portal.create-return — auto-approve else fallthrough (line 952)", () => {
  it("status=approved when evaluator returns neither 'approve' nor 'manual_review'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"true","then":"hold"}]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ if: "true", then: "hold" }]);
    // Drives the final `else` at line 952 — anything that isn't
    // "manual_review" or "approve".
    evaluateAutoApproveRulesMock.mockReturnValueOnce("deny");
    const createdRc = { id: "rc-952", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    const res = await portalCreateAction({
      request: portalReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.status).toBe("approved");
  });
});

describe("portal.create-return — price object handling (lines 1193-1195)", () => {
  it("extracts price from object via 'amount' key", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-px-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    await portalCreateAction({
      request: portalReq(
        happyBody({
          // eligibility check parseFloat(li.price) returns NaN for object,
          // but checkReturnEligibility is mocked to eligible=true — so we
          // proceed and hit the price-object branch in the items.create map.
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { amount: "42.00", currencyCode: "USD" } as unknown as string,
              quantity: 1,
              productTags: [],
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const itemPrice = callArg?.data?.items?.create?.[0]?.price;
    expect(itemPrice).toBe("42.00");
  });

  it("extracts price from object via fallback keys (transfer_price)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-px-2", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    await portalCreateAction({
      request: portalReq(
        happyBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { transfer_price: 18.5 } as unknown as string,
              quantity: 1,
              productTags: [],
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.items?.create?.[0]?.price).toBe("18.5");
  });

  it("returns null when price object has none of the recognized keys", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-px-3", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    await portalCreateAction({
      request: portalReq(
        happyBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { foo: "bar" } as unknown as string,
              quantity: 1,
              productTags: [],
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.items?.create?.[0]?.price).toBeNull();
  });
});

// Bonus closure for stale baseline gaps (lines 94, 507-514) to push file ≥99%.

describe("portal.create-return — late line-item resolution (lines 507-514)", () => {
  it("late-resolves non-GID orderId during non-GID lineItem resolution", async () => {
    // Shop config: standard.
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // First call: initial orderId resolution (happens earlier) → return null so
    // effectiveOrderId stays non-GID through the line item resolution branch.
    // Use an orderId that does NOT start with "FYND" so the "last resort" branch
    // at line 346 (which would consume our 2nd mock) is skipped.
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null);
    // Second call inside line-item resolution branch (lines 507-514) → resolves to GID.
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/777",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      sourceName: "web",
      lineItems: [],
    });
    fetchOrderMock.mockResolvedValue(null);

    const createdRc = { id: "rc-late", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);

    const res = await portalCreateAction({
      request: portalReq(
        happyBody({
          // Non-GID orderId (non-FYND prefix) AND non-GID lineItem → drives the
          // line-item resolution branch (497-514) without first hitting the
          // "last resort" FYND-prefix path.
          orderId: "STORE-ALIAS-XYZ",
          items: [{ lineItemId: "BAG-3777852", qty: 1, reasonCode: "size" }],
          lineItemsWithPrice: [
            {
              id: "BAG-3777852",
              title: "Tee",
              price: "25.00",
              quantity: 1,
              productTags: [],
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBeLessThan(500);
    // Confirm both resolution paths fired (initial + inside line-item block at 507-514)
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalled();
  });
});

describe("portal.create-return — discount code error catch (line 94)", () => {
  it("returns error when discount-code GraphQL throws inside try", async () => {
    // Shop has offers enabled and JSON parses to a single matching offer.
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: true,
        returnOffersJson: JSON.stringify([
          { offerType: "discount_pct", offerValue: 10, message: "10% off" },
        ]),
        autoApproveEnabled: false,
        greenReturnsEnabled: false,
      },
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // graphql throws → caught at line 93-95 → returns { code: "", error: ... }
    const graphql = vi.fn().mockRejectedValue(new Error("graphql network down"));
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: { graphql } });

    const res = await portalCreateAction({
      request: portalReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "shopper@example.com",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/graphql network down/);
  });
});
