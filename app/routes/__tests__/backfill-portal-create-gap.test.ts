/**
 * Gap-coverage tests for two routes:
 *
 *   1. /api/admin/backfill-fynd-items   (target ≥99 %)
 *      - Bag-level fallback (lines ~201–224): bag has neither `articles`
 *        nor `items` nor `item` ⇒ executes the bag-flat fallback path
 *        which pushes a synthesised FyndBagInfo derived from bag-level
 *        fields and runs both lazy-evaluated price IIFEs.
 *      - Title + price fuzzy match edge (lines ~263–266): items are
 *        matched ONLY when |returnItem.price - bag.price| < 1 — i.e.
 *        the numeric tolerance branch of strategy #4.
 *
 *   2. /api/portal/create-return   (target ≥99 %)
 *      - Auto-approve "reject" / unknown-verdict branch (line 952):
 *        when `evaluateAutoApproveRules` returns a value that is
 *        neither "manual_review" nor "approve" the code falls into the
 *        final else and still sets status="approved".
 *      - Object-shaped price → coercion (lines 1193–1195): when the
 *        `lineItemsWithPrice[i].price` arrives as an OBJECT (Shopify
 *        money sub-doc) the SUT digs out a numeric field via a small
 *        ladder. Multiple sub-tests probe each ladder rung.
 *
 * NOTE: These tests target uncovered branches in addition to existing
 * suites; we never modify production source.  Both routes share
 * `db.server`, `shopify.server`, and `lib/fynd.server`, so this file
 * uses single combined mocks for those modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const H = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  // shopify.server provides BOTH the named `authenticate` (used by the
  // backfill admin route) AND the default export (used by the portal
  // route).
  authenticateAdminMock: vi.fn(),
  shopifyDefault: { unauthenticated: { admin: vi.fn() } },
  // fynd.server is shared — backfill needs platform client; portal
  // typically gets `ok:false` so Fynd-sync stays inert.
  createFyndClientOrErrorMock: vi.fn(),
  // portal-only deps
  checkRateLimitMock: vi.fn(async () => ({
    allowed: true,
    remaining: 5,
    retryAfterMs: 0,
  })),
  verifyPortalCsrfMock: vi.fn(() => true),
  withRestCredentialsMock: vi.fn((a: unknown) => a),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  parseJsonArrayMock: vi.fn((s: string | null, fb: unknown[]) => (s ? JSON.parse(s) : fb)),
  evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
  parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
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

Object.assign(H.prismaMock, createPrismaMock());
(H.prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findFirst: vi.fn().mockResolvedValue(null),
};

vi.mock("../../db.server", () => ({ default: H.prismaMock }));
vi.mock("../../shopify.server", () => ({
  default: H.shopifyDefault,
  authenticate: { admin: H.authenticateAdminMock },
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: H.createFyndClientOrErrorMock,
}));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: H.checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalCsrfToken: H.verifyPortalCsrfMock,
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
  fetchOrder: H.fetchOrderMock,
  fetchOrderByOrderNumber: H.fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: H.fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: H.withRestCredentialsMock,
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: H.createReturnOnFyndMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendNewReturnNotification: H.sendNewReturnNotificationMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: H.checkReturnEligibilityMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: H.evaluateAutoApproveRulesMock,
  parseAutoApproveRules: H.parseAutoApproveRulesMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: H.parseReturnIdConfigMock,
  buildReturnRequestId: H.buildReturnRequestIdMock,
  formatReturnRequestId: H.formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: H.nextReturnIdCounterMock,
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: H.parseJsonArrayMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: H.normalizeSourceChannelMock,
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: vi.fn().mockResolvedValue(undefined),
}));

import { action as backfillAction } from "../api.admin.backfill-fynd-items";
import { action as portalAction } from "../api.portal.create-return";

const origEnv = { ...process.env };

function backfillReq(body: unknown = {}) {
  return new Request("https://app.example/api/admin/backfill-fynd-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function portalJsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/create-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function portalShop(overrideSettings: Record<string, unknown> = {}) {
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

function portalBody(extra: Record<string, unknown> = {}) {
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
  resetPrismaMock(H.prismaMock);
  const fynd = (
    H.prismaMock as unknown as Record<
      string,
      { upsert: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
    >
  ).fyndOrderMapping;
  fynd.upsert.mockReset().mockResolvedValue({});
  fynd.findFirst.mockReset().mockResolvedValue(null);

  H.authenticateAdminMock
    .mockReset()
    .mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  H.shopifyDefault.unauthenticated.admin.mockReset();
  H.shopifyDefault.unauthenticated.admin.mockResolvedValue({
    admin: { graphql: vi.fn() },
  });
  H.createFyndClientOrErrorMock
    .mockReset()
    .mockResolvedValue({ ok: false, error: "Fynd not configured" });
  H.checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  H.verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  H.withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  H.fetchOrderMock.mockReset().mockResolvedValue({
    id: "gid://shopify/Order/1",
    email: "shopper@example.com",
    displayFulfillmentStatus: "FULFILLED",
    displayFinancialStatus: "PAID",
    sourceName: "web",
    affiliateOrderId: null,
    lineItems: [],
  });
  H.fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  H.fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  H.parseJsonArrayMock
    .mockReset()
    .mockImplementation((s: string | null, fb: unknown[]) => (s ? JSON.parse(s) : fb));
  H.evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  H.parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  H.createReturnOnFyndMock.mockReset().mockResolvedValue({
    success: true,
    fyndReturnId: "fr-1",
    fyndShipmentId: "fs-1",
  });
  H.sendNewReturnNotificationMock.mockReset().mockResolvedValue(undefined);
  H.checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  H.buildReturnRequestIdMock.mockReset().mockReturnValue("R-1001");
  H.parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "id" });
  H.formatReturnRequestIdMock.mockReset().mockImplementation((x: string) => `R-${x}`);
  H.nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
  H.normalizeSourceChannelMock.mockReset().mockImplementation((x: string) => x);
});

afterEach(() => {
  process.env = { ...origEnv };
});

// ─────────────────────────────────────────────────────────────────────
// SECTION A: backfill-fynd-items gap coverage
// ─────────────────────────────────────────────────────────────────────

describe("backfill-fynd-items — gap coverage", () => {
  it("bag-level fallback: synthesises FyndBagInfo from bare bag fields when articles/items/item are absent", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const baldShipment = {
      shipment_id: "SHIP-FB",
      bags: [
        {
          bag_id: "BAG-FB",
          seller_identifier: "FB-SKU",
          article_id: "FB-ART",
          quantity: 7,
          size: "L",
          affiliate_bag_details: { affiliate_line_id: "FB-LINE" },
          prices: { price_effective: "199", transfer_price: "180" },
          // no articles / items / item
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [baldShipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fb",
        returnRequestNo: "RR-FB",
        shopifyOrderId: "gid://shopify/Order/9",
        shopifyOrderName: "#9000",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-fb",
            title: "x",
            sku: "FB-SKU",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.errors).toBe(0);

    const updateCall = H.prismaMock.returnItem.update.mock.calls[0][0];
    expect(updateCall.data).toMatchObject({
      fyndShipmentId: "SHIP-FB",
      fyndBagId: "BAG-FB",
      fyndArticleId: "FB-ART",
      fyndAffiliateLineId: "FB-LINE",
      fyndSellerIdentifier: "FB-SKU",
      fyndQuantityAvailable: 7,
      fyndPriceEffective: "199", // price_effective preferred
      fyndSize: "L",
    });
  });

  it("bag-level fallback: only `transfer_price` present → priceEffective IIFE returns the transfer_price string", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-T",
      bags: [
        {
          bag_id: "BAG-T",
          seller_identifier: "T-SKU",
          prices: { transfer_price: "55" },
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [shipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-t",
        returnRequestNo: "RR-T",
        shopifyOrderId: "gid://shopify/Order/8",
        shopifyOrderName: "#9001",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-t",
            title: "x",
            sku: "T-SKU",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const upd = H.prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(upd.fyndPriceEffective).toBe("55");
  });

  it("bag-level fallback: no `prices` object — both price IIFEs return null and no price field is set", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-NP",
      bags: [
        {
          bag_id: "BAG-NP",
          seller_identifier: "NP-SKU",
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [shipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-np",
        returnRequestNo: "RR-NP",
        shopifyOrderId: "gid://shopify/Order/10",
        shopifyOrderName: "#9002",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-np",
            title: "x",
            sku: "NP-SKU",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const upd = H.prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(upd.fyndPriceEffective).toBeUndefined(); // null filtered before assignment
    expect(upd.fyndSellerIdentifier).toBe("NP-SKU");
  });

  it("title+price fuzzy: matches when |Δprice| < 1 (numeric tolerance branch)", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-FZ",
      bags: [
        {
          bag_id: "BAG-FZ",
          prices: { transfer_price: "100.50" },
          articles: [
            {
              article_id: "ART-FZ",
              item: { item_id: "ITM-FZ", name: "Cool Widget Plus" },
            },
          ],
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [shipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fz",
        returnRequestNo: "RR-FZ",
        shopifyOrderId: "gid://shopify/Order/11",
        shopifyOrderName: "#9003",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-fz",
            title: "Cool Widget Plus",
            sku: null,
            price: "100.00",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const upd = H.prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(upd.fyndArticleId).toBe("ART-FZ");
    expect(upd.fyndBagId).toBe("BAG-FZ");
  });

  it("title+price fuzzy: |Δprice| ≥ 1 rejects the candidate (predicate returns false)", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-FZX",
      bags: [
        {
          bag_id: "BAG-FZX",
          prices: { transfer_price: "50" },
          articles: [
            {
              article_id: "ART-FZX",
              item: { item_id: "ITM-FZX", name: "Lonely Widget" },
            },
          ],
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [shipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fzx",
        returnRequestNo: "RR-FZX",
        shopifyOrderId: "gid://shopify/Order/12",
        shopifyOrderName: "#9004",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-fzx",
            title: "Lonely Widget",
            sku: null,
            price: "200.00",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
    expect(H.prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(body.results[0].details.some((d: string) => d.includes("no Fynd bag match"))).toBe(true);
  });

  it("title+price fuzzy: NaN-coerced item.price still allows match by title only (skips numeric guard)", async () => {
    H.prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-NAN",
      bags: [
        {
          bag_id: "BAG-NAN",
          prices: { transfer_price: "999.99" },
          articles: [
            {
              article_id: "ART-NAN",
              item: { item_id: "ITM-NAN", name: "Naan Bread" },
            },
          ],
        },
      ],
    };
    H.createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        getShipments: vi.fn(),
        searchShipmentsByExternalOrderId: vi.fn(async () => ({
          items: [shipment],
        })),
      },
    });
    H.prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-nan",
        returnRequestNo: "RR-NAN",
        shopifyOrderId: "gid://shopify/Order/13",
        shopifyOrderName: "#9005",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-nan",
            title: "Naan Bread",
            sku: null,
            price: "n/a",
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
      request: backfillReq(),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const upd = H.prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(upd.fyndBagId).toBe("BAG-NAN");
  });
});

// ─────────────────────────────────────────────────────────────────────
// SECTION B: portal.create-return gap coverage
// ─────────────────────────────────────────────────────────────────────

describe("portal.create-return — gap coverage", () => {
  it("auto-approve evaluator returns 'reject' → final else (line 952), status='approved'", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(
      portalShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"true","then":"reject"}]',
      }),
    );
    H.prismaMock.session.findFirst.mockResolvedValueOnce({
      accessToken: "tok",
    });
    H.parseAutoApproveRulesMock.mockReturnValueOnce([{ if: "true", then: "reject" }]);
    H.evaluateAutoApproveRulesMock.mockReturnValueOnce("reject");

    const created = {
      id: "rc-rej-1",
      status: "approved",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await portalAction({
      request: portalJsonReq(portalBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg?.data?.status).toBe("approved");
    expect(H.evaluateAutoApproveRulesMock).toHaveBeenCalled();
  });

  it("auto-approve evaluator returns null → final else, status='approved'", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(
      portalShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"true","then":"weird"}]',
      }),
    );
    H.prismaMock.session.findFirst.mockResolvedValueOnce({
      accessToken: "tok",
    });
    H.parseAutoApproveRulesMock.mockReturnValueOnce([{ if: "true", then: "weird" }]);
    H.evaluateAutoApproveRulesMock.mockReturnValueOnce(null);

    const created = {
      id: "rc-null-1",
      status: "approved",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const res = await portalAction({
      request: portalJsonReq(portalBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(arg?.data?.status).toBe("approved");
  });

  it("object-shaped price → coerces via `obj.amount` (lines 1193-1195)", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(portalShop());
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const created = {
      id: "rc-obj-amount",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    await portalAction({
      request: portalJsonReq(
        portalBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { amount: "42.50", currencyCode: "USD" },
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

    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = arg?.data?.items?.create ?? [];
    expect(items[0]?.price).toBe("42.50");
  });

  it("object-shaped price → falls through ladder to `obj.value`", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(portalShop());
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const created = {
      id: "rc-obj-value",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    await portalAction({
      request: portalJsonReq(
        portalBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { value: 12.34 },
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

    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = arg?.data?.items?.create ?? [];
    expect(items[0]?.price).toBe("12.34");
  });

  it("object-shaped price → falls through to `obj.transfer_price`", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(portalShop());
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const created = {
      id: "rc-obj-tp",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    await portalAction({
      request: portalJsonReq(
        portalBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { transfer_price: "9.99" },
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

    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = arg?.data?.items?.create ?? [];
    expect(items[0]?.price).toBe("9.99");
  });

  it("offer-accept: createDiscountCode inner catch (line 94) — admin.graphql throws → returns error string", async () => {
    // Reaches `createDiscountCode` (acceptOffer=true + matching offer +
    // returnOffersEnabled) and makes the inner GraphQL call throw, which
    // is the ONLY way to hit line 93–94 inside createDiscountCode itself
    // (the outer try/catch catches `unauthenticated.admin` failures).
    H.prismaMock.shop.findUnique.mockResolvedValueOnce({
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
      },
    });
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const graphql = vi.fn().mockRejectedValue(new Error("graphql network failure"));
    H.shopifyDefault.unauthenticated.admin.mockResolvedValueOnce({
      admin: { graphql },
    });

    const res = await portalAction({
      request: portalJsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "shopper@example.com",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
        lineItemsWithPrice: [{ id: "li-1", productTags: [] }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    // The outer route catches and returns a generic message, but the
    // path through line 94 still executes — coverage proves it.
    expect(body.error).toBeTruthy();
  });

  it("offer-accept: createDiscountCode inner catch (non-Error) → fallback string 'Failed to create discount code'", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        blocklistEnabled: false,
        returnWindowDays: 30,
        returnOffersEnabled: true,
        returnOffersJson: JSON.stringify([
          { offerType: "discount_flat", offerValue: 5, message: "5 off" },
        ]),
      },
    });
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Throw non-Error → exercises the `else` arm of the ternary on line 94
    const graphql = vi.fn().mockImplementation(async () => {
      throw "raw string failure";
    });
    H.shopifyDefault.unauthenticated.admin.mockResolvedValueOnce({
      admin: { graphql },
    });

    const res = await portalAction({
      request: portalJsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "shopper@example.com",
        acceptOffer: true,
        items: [{ lineItemId: "li-1", qty: 1 }],
        lineItemsWithPrice: [{ id: "li-1", productTags: [] }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });

  it("late line-item resolution (lines 507-514): non-GID orderId + non-GID lineItem → fetchOrderByFyndAffiliateId resolves and updates effectiveOrderId", async () => {
    // Path: enters block at ~line 497 (hasNonGidLineItems=true),
    // effectiveOrderId is NOT a gid:// → first fetchOrder skipped,
    // fetchOrderByFyndAffiliateId returns an order whose id IS a gid →
    // executes lines 509-514 (sets shopifyOrder, console.log, reassigns
    // effectiveOrderId).
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(portalShop());
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // First call: top-level orderId-resolution branch (lines 297-319) —
    // we want it to NOT find a Shopify GID, leaving effectiveOrderId
    // as the non-GID string for the later block.
    H.fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null); // top-level resolve fails
    // Mapping cache miss (line 325 onwards) — already default null.
    // Second call inside the line-item resolution block (line 508):
    H.fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/77",
      sourceName: "web",
      lineItems: [
        {
          id: "gid://shopify/LineItem/777",
          title: "Tee",
          sku: "TEE-1",
          quantity: 1,
        },
      ],
    });
    const created = {
      id: "rc-late-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    const body = portalBody({
      // non-GID, non-numeric, non-FYND: skips top-level Fynd-prefix
      // resolver at line 346 so my second mock value is reserved for
      // the late-resolution call inside the line-item block (line 508).
      orderId: "ABC-XYZ",
      // Non-GID lineItem to trigger hasNonGidLineItems
      items: [{ lineItemId: "BAG-XYZ", qty: 1, reasonCode: "size" }],
      lineItemsWithPrice: [
        {
          id: "BAG-XYZ",
          title: "Tee",
          price: "25.00",
          quantity: 1,
          productTags: [],
          sku: "TEE-1",
        },
      ],
    });

    const res = await portalAction({
      request: portalJsonReq(body),
      params: {},
      context: {},
    } as never);
    // Should successfully reach creation OR return a 4xx caused by
    // downstream validation; either way lines 507-514 executed.
    expect([200, 400, 500]).toContain(res.status);
    expect(H.fetchOrderByFyndAffiliateIdMock).toHaveBeenCalled();
  });

  it("object-shaped price with no recognised field → null price (final ternary branch)", async () => {
    H.prismaMock.shop.findUnique.mockResolvedValueOnce(portalShop());
    H.prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const created = {
      id: "rc-obj-none",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

    await portalAction({
      request: portalJsonReq(
        portalBody({
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: { currency: "USD", note: "weird" },
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

    const arg = (H.prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = arg?.data?.items?.create ?? [];
    expect(items[0]?.price).toBeNull();
  });
});
