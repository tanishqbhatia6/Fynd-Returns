import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Extra integration coverage for api.portal.order — focuses on branches
 * that the existing api.portal.order.test.ts file does not exercise:
 *
 *   1. FyndOrderMapping cache HIT fast path (stored GID → fetchOrderByGid)
 *      and stored shopifyOrderName fallback when no GID is present.
 *   2. SKU-based qty fallback (returnedQtyMap aggregation when stored
 *      shopifyLineItemId is a Fynd bag ID rather than a Shopify line GID),
 *      including avoidance of double-counting.
 *   3. Multi-shipment bucketing — the per-shipment grouping populates
 *      `shipments[]` and `shipmentReturnedQtyMap` keyed by bagId,
 *      shopifyLineItemId, and `sku:<sku>`. Also: any-eligible override
 *      flips order-level eligibility back to true.
 *   4. Financial / fulfillment status gates — REFUNDED, VOIDED,
 *      UNFULFILLED, and the multi-shipment override that does NOT
 *      bypass return-rule blocks.
 */

const {
  prismaMock,
  shopifyModuleMock,
  checkRateLimitMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByGidMock,
  fetchOrderByFyndAffiliateIdMock,
  withRestCredentialsMock,
  createFyndClientOrErrorMock,
  formatReturnRequestIdMock,
  checkReturnEligibilityMock,
  createPortalCsrfTokenMock,
  parseJsonArrayMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByGidMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  withRestCredentialsMock: vi.fn((a: unknown) => a),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  formatReturnRequestIdMock: vi.fn((x: string) => `R-${x.slice(0, 6)}`),
  checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => { eligible: boolean; reason?: string }>(() => ({ eligible: true })),
  createPortalCsrfTokenMock: vi.fn(() => "csrf-token-abc"),
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
vi.mock("../../lib/return-request-id", () => ({
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalCsrfToken: createPortalCsrfTokenMock,
}));
vi.mock("../../lib/shopify-admin.server", async () => {
  class OrderAccessError extends Error {
    constructor(public reason: string, public orderNumber: string) {
      super(`Order ${orderNumber} cannot be accessed: ${reason}`);
      this.name = "OrderAccessError";
    }
  }
  return {
    OrderAccessError,
    fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
    fetchOrderByGid: fetchOrderByGidMock,
    fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
    withRestCredentials: withRestCredentialsMock,
  };
});

import { loader } from "../api.portal.order";

function mkReq(qs: string, method = "GET") {
  return new Request(`https://app.example/api/portal/order?${qs}`, { method });
}

type MappingMock = {
  upsert: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
};
function getMappingMock(): MappingMock {
  return (prismaMock as unknown as { fyndOrderMapping: MappingMock }).fyndOrderMapping;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const mapping = getMappingMock();
  mapping.upsert.mockReset();
  mapping.upsert.mockResolvedValue({});
  mapping.findFirst.mockReset();
  mapping.findFirst.mockResolvedValue(null);
  shopifyModuleMock.unauthenticated.admin.mockReset().mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  fetchOrderByOrderNumberMock.mockReset();
  fetchOrderByGidMock.mockReset();
  fetchOrderByFyndAffiliateIdMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  formatReturnRequestIdMock.mockReset().mockImplementation((x: string) => `R-${x.slice(0, 6)}`);
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  createPortalCsrfTokenMock.mockReset().mockReturnValue("csrf-token-abc");
  parseJsonArrayMock.mockReset().mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));

  // Defaults shared across most cases
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
  prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  prismaMock.returnCase.findMany.mockResolvedValue([]);
  prismaMock.returnItem.findMany.mockResolvedValue([]);
  prismaMock.shopSettings.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────
// 1. FyndOrderMapping cache HIT fast path
// ─────────────────────────────────────────────────────────────

describe("FyndOrderMapping cache hit fast path", () => {
  it("uses fetchOrderByGid when mapping has a stored shopifyOrderId GID", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null); // initial Shopify search misses
    getMappingMock().findFirst.mockResolvedValueOnce({
      id: "map-1",
      shopId: "shop-1",
      shopifyOrderId: "gid://shopify/Order/123456",
      shopifyOrderName: "#1001",
      fyndOrderId: "FYMP123",
      fyndShipmentId: "ship-1",
    });
    fetchOrderByGidMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/123456",
      name: "#1001",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "T", quantity: 1, price: "10", productTags: [] }],
    });

    const res = await loader({ request: mkReq("shop=store&orderNumber=1001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByGidMock).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/123456");
    const body = await res.json();
    expect(body.order.id).toBe("gid://shopify/Order/123456");
  });

  it("falls back to fetchOrderByOrderNumber with stored shopifyOrderName when GID is missing", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null); // primary lookup misses
    getMappingMock().findFirst.mockResolvedValueOnce({
      id: "map-2",
      shopId: "shop-1",
      shopifyOrderId: null, // NO GID stored
      shopifyOrderName: "#2002",
    });
    // 2nd call (from mapping branch) finds the order
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/2002",
      name: "#2002",
      createdAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [],
    });

    const res = await loader({ request: mkReq("shop=store&orderNumber=2002"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // The 2nd call uses the cleaned name (without leading "#")
    expect(fetchOrderByOrderNumberMock).toHaveBeenNthCalledWith(2, expect.anything(), "2002");
  });

  it("does not call fetchOrderByGid when stored shopifyOrderId is not a gid:// (synthetic)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    getMappingMock().findFirst.mockResolvedValueOnce({
      id: "map-3",
      shopId: "shop-1",
      shopifyOrderId: "FYNDSHOPIFYX14115", // synthetic value, not a GID
      shopifyOrderName: "#FYNDSHOPIFYX14115",
    });
    // Mapping branch: GID skipped, falls through to name lookup
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/14115",
      name: "#FYNDSHOPIFYX14115",
      createdAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [],
    });

    const res = await loader({ request: mkReq("shop=store&orderNumber=FYNDSHOPIFYX14115"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByGidMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// 2. SKU-based qty fallback
// ─────────────────────────────────────────────────────────────

describe("SKU-based qty fallback", () => {
  function mkOrder() {
    return {
      id: "gid://shopify/Order/1",
      name: "#3001",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [
        { id: "li-shopify-1", title: "Shirt", quantity: 3, price: "20", sku: "SKU-A", productTags: [] },
        { id: "li-shopify-2", title: "Pants", quantity: 2, price: "30", sku: "SKU-B", productTags: [] },
      ],
    };
  }

  it("aggregates SKU-based qty when shopifyLineItemId stored in DB does not match the order's line ID", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrder());
    // Direct ID lookup → empty (stored IDs are Fynd bag IDs)
    prismaMock.returnItem.findMany.mockResolvedValueOnce([]);
    // SKU lookup → finds 1 SKU-A returned, with shopifyLineItemId being a Fynd bag (not the Shopify line ID)
    prismaMock.returnItem.findMany.mockResolvedValueOnce([
      { sku: "SKU-A", qty: 1, shopifyLineItemId: "fynd-bag-99" },
      { sku: "SKU-B", qty: 2, shopifyLineItemId: "fynd-bag-100" },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=3001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnedQtyMap).toEqual({
      "li-shopify-1": 1,
      "li-shopify-2": 2,
    });
  });

  it("avoids double-counting when shopifyLineItemId already counted in direct ID lookup", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrder());
    // Direct ID match: SKU-A's row already counted under "li-shopify-1"
    prismaMock.returnItem.findMany.mockResolvedValueOnce([
      { shopifyLineItemId: "li-shopify-1", qty: 1 },
    ]);
    // SKU lookup finds the same row (same shopifyLineItemId) AND a SKU-B row with different bag id
    prismaMock.returnItem.findMany.mockResolvedValueOnce([
      { sku: "SKU-A", qty: 1, shopifyLineItemId: "li-shopify-1" }, // skip — already counted
      { sku: "SKU-B", qty: 2, shopifyLineItemId: "fynd-bag-200" }, // include
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=3001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnedQtyMap["li-shopify-1"]).toBe(1); // not 2
    expect(body.returnedQtyMap["li-shopify-2"]).toBe(2);
  });

  it("ignores SKU rows with no matching SKU on the order", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrder());
    prismaMock.returnItem.findMany.mockResolvedValueOnce([]);
    prismaMock.returnItem.findMany.mockResolvedValueOnce([
      { sku: "SKU-UNRELATED", qty: 5, shopifyLineItemId: "fynd-bag-x" },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=3001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnedQtyMap).toEqual({});
  });

  it("skips the SKU fallback entirely when the order has no line items with SKUs", async () => {
    const order = mkOrder();
    order.lineItems = order.lineItems.map((li) => ({ ...li, sku: null as unknown as string })) as typeof order.lineItems;
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(order);
    prismaMock.returnItem.findMany.mockResolvedValueOnce([]); // direct ID lookup

    const res = await loader({ request: mkReq("shop=store&orderNumber=3001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // returnItem.findMany should only be called once (direct), not twice (SKU)
    expect(prismaMock.returnItem.findMany).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Multi-shipment bucketing
// ─────────────────────────────────────────────────────────────

describe("multi-shipment bucketing", () => {
  /** Helper: configure Fynd client to return a multi-shipment search result. */
  function setFyndShipments(shipments: unknown[]) {
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({ items: shipments }),
      },
    });
  }

  it("populates shipments[] grouped by shipment ID and includes per-shipment items (Shopify-resolved order, multi-shipment)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/4001",
      name: "#4001",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [
        { id: "li-shop-A", title: "Shirt", quantity: 1, price: "100", sku: "SKU-A", productTags: [] },
        { id: "li-shop-B", title: "Pants", quantity: 1, price: "200", sku: "SKU-B", productTags: [] },
      ],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: null,
    });
    setFyndShipments([
      {
        shipment_id: "SHIP-1",
        status: "delivery_done",
        bags: [
          {
            bag_id: "bag-1",
            quantity: 1,
            articles: [{ seller_identifier: "SKU-A", article_id: "art-1", item: { item_id: "item-A", name: "Shirt" } }],
          },
        ],
      },
      {
        shipment_id: "SHIP-2",
        status: "out_for_delivery",
        bags: [
          {
            bag_id: "bag-2",
            quantity: 1,
            articles: [{ seller_identifier: "SKU-B", article_id: "art-2", item: { item_id: "item-B", name: "Pants" } }],
          },
        ],
      },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=4001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.shipments).toHaveLength(2);
    expect(body.shipments[0].shipmentId).toBe("SHIP-1");
    expect(body.shipments[0].eligible).toBe(true);
    expect(body.shipments[1].shipmentId).toBe("SHIP-2");
    expect(body.shipments[1].eligible).toBe(false);
    expect(body.shipments[1].eligibilityReason).toMatch(/delivered/i);
    // SKU matching reuses Shopify line item ID:
    expect(body.shipments[0].items[0].id).toBe("li-shop-A");
    expect(body.shipments[1].items[0].id).toBe("li-shop-B");
  });

  it("populates shipmentReturnedQtyMap with bagId, shopifyLineItemId, and sku: keys", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/4002",
      name: "#4002",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [
        { id: "li-shop-A", title: "Shirt", quantity: 2, price: "100", sku: "SKU-A", productTags: [] },
      ],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1", allowedFyndStatusesForReturn: null });
    setFyndShipments([
      {
        shipment_id: "SHIP-1",
        status: "delivery_done",
        bags: [{ bag_id: "bag-1", quantity: 1, articles: [{ seller_identifier: "SKU-A", item: { item_id: "i1" } }] }],
      },
    ]);

    // returnItem rows (the SECOND findMany call — fyndShipmentId-scoped lookup)
    prismaMock.returnItem.findMany
      .mockResolvedValueOnce([]) // direct ID lookup
      // SKU lookup — order has SKU-A so SKU branch runs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          fyndShipmentId: "SHIP-1",
          shopifyLineItemId: "li-shop-A",
          fyndBagId: "bag-1",
          sku: "SKU-A",
          qty: 1,
        },
      ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=4002"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.shipmentReturnedQtyMap).toBeDefined();
    expect(body.shipmentReturnedQtyMap["SHIP-1"]).toMatchObject({
      "bag-1": 1,
      "li-shop-A": 1,
      "sku:sku-a": 1,
    });
  });

  it("multi-shipment override flips status-blocked order back to eligible when ANY shipment is eligible", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/4003",
      name: "#4003",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-X", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1", allowedFyndStatusesForReturn: null });
    setFyndShipments([
      { shipment_id: "S1", status: "delivery_done", bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "SKU-X" }] }] },
      { shipment_id: "S2", status: "out_for_delivery", bags: [{ bag_id: "b2", quantity: 1, articles: [{ seller_identifier: "SKU-Y" }] }] },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=4003"), params: {}, context: {} } as never);
    const body = await res.json();
    // Order-level eligibility ends up true because S1 is eligible (override)
    expect(body.returnEligibility.eligible).toBe(true);
    expect(body.shipments).toHaveLength(2);
    expect(body.shipments.find((s: { shipmentId: string }) => s.shipmentId === "S1").eligible).toBe(true);
    expect(body.shipments.find((s: { shipmentId: string }) => s.shipmentId === "S2").eligible).toBe(false);
  });

  it("multi-shipment override does NOT bypass return-rule blocks (out of return window)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/4004",
      name: "#4004",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-X", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1", allowedFyndStatusesForReturn: null });
    // Return rule check FAILS the order-wide eligibility on the first call; per-item calls return ok.
    checkReturnEligibilityMock
      .mockReturnValueOnce({ eligible: false, reason: "Return window has expired" })
      .mockReturnValue({ eligible: true });
    setFyndShipments([
      { shipment_id: "S1", status: "delivery_done", bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "SKU-X" }] }] },
      { shipment_id: "S2", status: "delivery_done", bags: [{ bag_id: "b2", quantity: 1, articles: [{ seller_identifier: "SKU-Y" }] }] },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=4004"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/Return window/i);
    // Even though shipments are eligible, the order-level rule block is preserved.
    expect(body.shipments).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Financial / fulfillment status gates
// ─────────────────────────────────────────────────────────────

describe("financial / fulfillment status gates", () => {
  function mkOrderWithStatuses(financial: string, fulfillment: string) {
    return {
      id: "gid://shopify/Order/5",
      name: "#5005",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: fulfillment,
      displayFinancialStatus: financial,
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-X", productTags: [] }],
    };
  }

  it("blocks orders with financialStatus=REFUNDED", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("REFUNDED", "FULFILLED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/already been refunded/i);
  });

  it("blocks orders with financialStatus=VOIDED", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("VOIDED", "FULFILLED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/already been refunded/i);
  });

  it("blocks orders with fulfillmentStatus=UNFULFILLED with the not-shipped-yet message", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("PAID", "UNFULFILLED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/has not been shipped yet/i);
  });

  it("blocks orders with fulfillmentStatus=ON_HOLD with the on-hold message", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("PAID", "ON_HOLD"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/on hold/i);
  });

  it("blocks orders with fulfillmentStatus=SCHEDULED with the scheduled-not-shipped message", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("PAID", "SCHEDULED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/scheduled/i);
  });

  it("REFUNDED takes precedence over UNFULFILLED (refund message wins)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("REFUNDED", "UNFULFILLED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.reason).toMatch(/already been refunded/i);
  });

  it("PAID + FULFILLED + no Fynd data passes the gates and returns eligible:true", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(mkOrderWithStatuses("PAID", "FULFILLED"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=5005"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(true);
    expect(body.portalCsrfToken).toBe("csrf-token-abc");
  });
});
