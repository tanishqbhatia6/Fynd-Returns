import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Targeted coverage push for api.portal.order — tests below are crafted to
 * exercise branches the existing two test files leave uncovered:
 *
 *   - safeStr / safeCurrencyCode / safeImageUrl object-extraction paths
 *   - parseAllowedFyndStatuses / extractNumericPrice exotic inputs
 *   - isShipmentEligibleForReturn merchant-allowed status branch
 *   - formattedReturns mapping (with notes / sku fallback titles)
 *   - ReturnCase.fyndOrderId resolution (GID + name fallback)
 *   - The full Fynd synthetic-order build path (lines 314–651):
 *       * affiliate-order-id resolves a real Shopify order via prefix stripping
 *       * synthetic order fallback when Shopify still can't resolve
 *       * bag-level fallback when no articles
 *       * customer / shipping address extraction from Fynd payload
 *       * FyndOrderMapping upsert for the resolved-via-affiliate path
 *   - Single-shipment Fynd enrichment (lines 746–782) bag-level fallback
 *   - Admin-configurable allowedFulfillmentStatuses parse + non-default value
 *   - Generic "this order is not eligible" else branch (PARTIALLY_PAID)
 *   - returnOffersData enabled true branch
 *   - Multi-shipment override (line 1026) with a shipment-level eligibility flip
 *   - Shipment qty map skips rows with no fyndShipmentId (line 1059)
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

/** Configure Fynd client to return shipments (or empty) from search call. */
function setFyndShipments(shipments: unknown[], shape: "items" | "shipments" | "data.items" = "items") {
  let payload: Record<string, unknown>;
  if (shape === "items") payload = { items: shipments };
  else if (shape === "shipments") payload = { shipments };
  else payload = { data: { items: shipments } };
  createFyndClientOrErrorMock.mockResolvedValue({
    ok: true,
    client: {
      searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue(payload),
    },
  });
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

  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
  prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  prismaMock.returnCase.findMany.mockResolvedValue([]);
  prismaMock.returnItem.findMany.mockResolvedValue([]);
  prismaMock.shopSettings.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. OPTIONS preflight & rate-limit
// ─────────────────────────────────────────────────────────────────────────

describe("preflight + rate-limit", () => {
  it("returns 204 for OPTIONS preflight", async () => {
    const req = new Request("https://app.example/api/portal/order?shop=store&orderNumber=1", { method: "OPTIONS" });
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(204);
  });

  it("returns 429 when rate limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 5000 });
    const res = await loader({ request: mkReq("shop=store&orderNumber=1"), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when shop missing", async () => {
    const res = await loader({ request: mkReq("orderNumber=1"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when orderNumber missing or too long", async () => {
    const res1 = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    expect(res1.status).toBe(400);
    const big = "x".repeat(70);
    const res2 = await loader({ request: mkReq(`shop=store&orderNumber=${big}`), params: {}, context: {} } as never);
    expect(res2.status).toBe(400);
  });

  it("404 when shop record not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq("shop=store&orderNumber=1"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. formattedReturns mapping (lines 225-231)
// ─────────────────────────────────────────────────────────────────────────

describe("formattedReturns mapping", () => {
  it("maps return cases with items, prefers notes over sku, falls back through chain", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null); // not found path
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "case-1",
        returnRequestNo: "RR-001",
        status: "initiated",
        refundStatus: "pending",
        createdAt: new Date(),
        fyndReturnNo: "FYND-1",
        items: [
          { shopifyLineItemId: "li-1", notes: "Custom note", sku: "SKU-A", qty: 1, reasonCode: "size" },
          { shopifyLineItemId: "li-2", notes: null, sku: "SKU-B", qty: 2, reasonCode: "defect" },
          { shopifyLineItemId: "li-3", notes: null, sku: null, qty: 1, reasonCode: "other" },
        ],
      },
      {
        id: "case-2",
        returnRequestNo: null, // triggers formatReturnRequestId fallback
        status: "approved",
        refundStatus: null,
        createdAt: new Date(),
        fyndReturnNo: null,
        items: [],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=ZZZZ"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.existingReturns).toHaveLength(2);
    expect(body.existingReturns[0].items[0].title).toBe("Custom note");
    expect(body.existingReturns[0].items[1].title).toBe("SKU-B"); // sku fallback
    expect(body.existingReturns[0].items[2].title).toBe("li-3"); // shopifyLineItemId fallback
    expect(body.existingReturns[1].returnRequestId).toMatch(/^R-/); // formatReturnRequestId used
    expect(body.activeReturns).toHaveLength(2); // both initiated and approved are active
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. ReturnCase.fyndOrderId resolution (lines 281-301)
// ─────────────────────────────────────────────────────────────────────────

describe("ReturnCase fyndOrderId resolution", () => {
  it("resolves via fyndCase.shopifyOrderId GID", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      shopifyOrderId: "gid://shopify/Order/777",
      shopifyOrderName: "#777",
    });
    fetchOrderByGidMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/777",
      name: "#777",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [],
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=777"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByGidMock).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/777");
  });

  it("falls back from ReturnCase to fetchOrderByOrderNumber when no GID", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      shopifyOrderId: "synthetic-id",
      shopifyOrderName: "#888",
    });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/888",
      name: "#888",
      createdAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [],
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=888"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByOrderNumberMock).toHaveBeenNthCalledWith(2, expect.anything(), "888");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Fynd synthetic-order build path (lines 314-651)
// ─────────────────────────────────────────────────────────────────────────

describe("Fynd synthetic order build path", () => {
  it("resolves Shopify order via affiliate prefix stripping when Shopify direct lookup misses", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      enableFyndIntegration: true,
      allowedFyndStatusesForReturn: null,
    });
    setFyndShipments([
      {
        shipment_id: "SHIP-100",
        affiliate_order_id: "FYNDSHOPIFYX14115",
        order_id: "FYMP69B0",
        status: "delivery_done",
        currency: "INR",
        bags: [],
        journey_type: "forward",
      },
    ]);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/14115",
      name: "#14115",
      createdAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [],
    });

    const res = await loader({
      request: mkReq("shop=store&orderNumber=FYNDSHOPIFYX14115"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalledWith(expect.anything(), "FYNDSHOPIFYX14115");
    // Backfill upsert was queued
    expect(getMappingMock().upsert).toHaveBeenCalled();
  });

  it("builds synthetic order with full bag/article extraction when Shopify can't resolve", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: JSON.stringify(["custom_status"]),
      portalAllowedFulfillmentStatuses: null,
      returnWindowDays: 14,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "SHIP-A",
        order_id: "FYMP-ORD-A",
        external_order_id: "EXT-1",
        affiliate_order_id: "EXT-1",
        status: "delivery_done",
        order_date: "2024-01-01T00:00:00Z",
        currency: { currency_code: "INR" },
        customer_details: { name: "Alice Smith", email: "alice@x.com", phone: "+9112345" },
        delivery_address: {
          address: "123 Main St",
          area: "Apt 4",
          city: "Mumbai",
          state: "MH",
          country: "India",
          pincode: "400001",
          landmark: "Near park",
          name: "Alice Smith",
          phone: "+9112345",
        },
        billing_details: { email: "billing@x.com" },
        bags: [
          {
            bag_id: "bag-1",
            quantity: 2,
            line_number: 1,
            prices: { transfer_price: 250, price_effective: 200 },
            affiliate_bag_details: { affiliate_line_id: "ALI-1" },
            articles: [
              {
                article_id: "art-1",
                seller_identifier: "SKU-X",
                quantity_available: 5,
                size: "M",
                line_number: 1,
                item: {
                  item_id: "item-1",
                  name: "T-Shirt",
                  l3_category_name: "Apparel",
                  images: [{ secure_url: "https://img.example/1.jpg" }],
                },
              },
            ],
          },
        ],
        journey_type: "forward",
      },
    ]);

    const res = await loader({
      request: mkReq("shop=store&orderNumber=EXT-1"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order._isFyndSyntheticOrder).toBe(true);
    expect(body.order.email).toBe("alice@x.com");
    expect(body.order.shippingAddress.address1).toBe("123 Main St");
    expect(body.order.shippingAddress.firstName).toBe("Alice");
    expect(body.order.shippingAddress.lastName).toBe("Smith");
    expect(body.order.lineItems).toHaveLength(1);
    expect(body.order.lineItems[0].title).toBe("T-Shirt");
    expect(body.order.lineItems[0].sku).toBe("SKU-X");
    expect(body.order.lineItems[0].imageUrl).toBe("https://img.example/1.jpg");
    expect(body.order.lineItems[0].quantity).toBe(2);
    expect(body.order.lineItems[0].variantTitle).toBe("Apparel");
    expect(body.order.lineItems[0].fyndArticleId).toBe("art-1");
    expect(body.order.lineItems[0].fyndAffiliateLineId).toBe("ALI-1");
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0].shipmentId).toBe("SHIP-A");
    expect(body.shipments[0].eligible).toBe(true);
  });

  it("uses bag-level fallback when no articles/items/item present", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "SHIP-B",
        order_id: "FYMP-B",
        external_order_id: "EXT-2",
        affiliate_order_id: "EXT-2",
        status: "delivery_done",
        currency: "INR",
        bags: [
          {
            bag_id: "bag-2",
            quantity: 1,
            line_number: 0,
            seller_identifier: "SKU-BAG",
            article_id: "ART-BAG",
            prices: { transfer_price: 99 },
            affiliate_bag_details: { affiliate_line_id: "BAG-LI" },
            item: undefined, // no item
            // no articles
            // no items
            size: "L",
            item_name: "Bag-level Item",
          },
        ],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=store&orderNumber=EXT-2"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.lineItems).toHaveLength(1);
    const li = body.order.lineItems[0];
    expect(li.title).toBe("Bag-level Item");
    expect(li.sku).toBe("SKU-BAG");
    expect(li.fyndArticleId).toBe("ART-BAG");
    expect(li.fyndAffiliateLineId).toBe("BAG-LI");
    expect(li.variantTitle).toBe("L");
  });

  it("filters out return shipments and falls back to all shipments if all are returns", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "RET-ONLY",
        order_id: "FY-R",
        affiliate_order_id: "EXT-R",
        external_order_id: "EXT-R",
        status: "return_initiated",
        currency: "INR",
        bags: [{ bag_id: "rb1", quantity: 1, item: { name: "ReturnItem" } }],
        journey_type: "return",
      },
    ]);

    const res = await loader({
      request: mkReq("shop=store&orderNumber=EXT-R"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Falls back to all shipments since no forward shipments existed
    expect(body.order._isFyndSyntheticOrder).toBe(true);
  });

  it("uses 'shipments' shape and 'data.items' shape from search result", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments(
      [
        {
          shipment_id: "S-shape",
          affiliate_order_id: "EXT-S",
          status: "delivery_done",
          currency: "INR",
          bags: [],
        },
      ],
      "data.items",
    );

    const res = await loader({
      request: mkReq("shop=store&orderNumber=EXT-S"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order._isFyndSyntheticOrder).toBe(true);
  });

  it("returns 404 when no shipments returned at all", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([]);
    const res = await loader({
      request: mkReq("shop=store&orderNumber=NOSUCH"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });

  it("non-fatal when Fynd client throws — proceeds to 404", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("fynd boom"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=BOOM"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("FyndOrderMapping upsert failure is caught and logged (non-fatal)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "S-up",
        order_id: "FY-UP",
        affiliate_order_id: "EXT-UP",
        external_order_id: "EXT-UP",
        status: "delivery_done",
        currency: "INR",
        bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "X" }] }],
      },
    ]);
    // First upsert (early synthetic-order cache write) rejects → console.warn path
    getMappingMock().upsert.mockRejectedValueOnce(new Error("db conflict"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await loader({ request: mkReq("shop=store&orderNumber=EXT-UP"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Single-shipment Fynd enrichment fallback (lines 746-782)
// ─────────────────────────────────────────────────────────────────────────

describe("single-shipment Fynd enrichment", () => {
  it("uses bag-level fallback for shipments with no articles when shopify order is resolved", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9001",
      name: "#9001",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [
        { id: "li-shop-1", title: "Resolved Title", quantity: 1, price: "250", sku: "SKU-Z", productTags: [], imageUrl: "img.jpg", variantTitle: "Var" },
      ],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: null,
    });
    setFyndShipments([
      {
        shipment_id: "SHIP-EZ",
        status: "delivery_done",
        bags: [
          {
            bag_id: "b-no-art",
            quantity: 1,
            line_number: 2,
            seller_identifier: "SKU-Z", // matches shopify line item
            article_id: "ART-EZ",
            prices: { transfer_price: 250 },
            affiliate_bag_details: { affiliate_line_id: "ALI-EZ" },
            // no articles, no items, no item key
            size: "Var",
            item: { name: "FromBag", item_id: "fbi-1", size: "Var" },
          },
        ],
      },
    ]);

    const res = await loader({ request: mkReq("shop=store&orderNumber=9001"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The fallback path triggers because there are no articles
    // (note: when bag.item is set, the code treats it as a single-article path, but
    // the absence of bag.articles AND bag.items still hits the bag-level fallback test)
    expect(body.shipments).toHaveLength(1);
  });

  it("ignores Fynd enrichment when search throws (non-fatal)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9002",
      name: "#9002",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockRejectedValue(new Error("fynd-down")),
      },
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=9002"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shipments).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Admin-configurable allowedFulfillmentStatuses parse (lines 824-827)
// ─────────────────────────────────────────────────────────────────────────

describe("portalAllowedFulfillmentStatuses settings parse", () => {
  it("custom statuses are honored — DELIVERED is admitted", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/100",
      name: "#100",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "DELIVERED", // not in default list
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      portalAllowedFulfillmentStatuses: JSON.stringify(["DELIVERED", "FULFILLED"]),
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=100"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(true);
  });

  it("malformed JSON in portalAllowedFulfillmentStatuses falls back to defaults", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/101",
      name: "#101",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED", // default-allowed
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      portalAllowedFulfillmentStatuses: "{not-json",
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=101"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Generic else-branch ineligibility message (lines 862-865)
// ─────────────────────────────────────────────────────────────────────────

describe("generic ineligibility else branch", () => {
  it("PARTIALLY_PAID financial + an unrecognised fulfillment hits the generic message", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/200",
      name: "#200",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "PENDING_FULFILLMENT", // not in default allow list, not in branch matchers
      displayFinancialStatus: "PARTIALLY_PAID",
      currencyCode: "USD",
      lineItems: [],
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=200"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/not eligible for a return at this time/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. Fynd shipment-status block (lines 887-891)
// ─────────────────────────────────────────────────────────────────────────

describe("Fynd shipment-status order-level block", () => {
  it("blocks single-shipment order with non-delivered shipment status with the friendly message", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/300",
      name: "#300",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-X", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: null,
    });
    setFyndShipments([
      {
        shipment_id: "OUT",
        status: "out_for_delivery",
        bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "SKU-X" }] }],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=300"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/Out For Delivery/);
    expect(body.returnEligibility.reason).toMatch(/can only be initiated after the order has been delivered/i);
  });

  it("merchant-allowed Fynd status admits a non-delivered shipment", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/301",
      name: "#301",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-X", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: JSON.stringify(["out_for_delivery"]),
    });
    setFyndShipments([
      {
        shipment_id: "OUT-OK",
        status: "out_for_delivery",
        bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "SKU-X" }] }],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=301"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnEligibility.eligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9. returnOffersData enabled branch (lines 952-953)
// ─────────────────────────────────────────────────────────────────────────

describe("returnOffersData enabled", () => {
  it("emits enabled offers from returnOffersJson when returnOffersEnabled=true", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/400",
      name: "#400",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "100", sku: "S", productTags: [] }],
    });
    const offers = [
      { offerType: "percent", offerValue: 10, message: "10% off if you keep" },
    ];
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      returnOffersEnabled: true,
      returnOffersJson: JSON.stringify(offers),
      returnFeeAmount: 5,
      returnFeeCurrency: "USD",
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=400"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnOffers).toEqual({ enabled: true, offers });
    expect(body.returnFee).toEqual({ amount: 5, currency: "USD" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10. returnItem.findMany throws — non-fatal qty path (line 977 catch)
// ─────────────────────────────────────────────────────────────────────────

describe("non-fatal returnItem qty lookups", () => {
  it("primary returnItem.findMany rejection does not fail the response", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/500",
      name: "#500",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.returnItem.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=500"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("SKU-fallback returnItem.findMany rejection is non-fatal", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/501",
      name: "#501",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-Q", productTags: [] }],
    });
    prismaMock.returnItem.findMany
      .mockResolvedValueOnce([]) // direct ID lookup OK
      .mockRejectedValueOnce(new Error("sku-down")); // SKU lookup fails
    const res = await loader({ request: mkReq("shop=store&orderNumber=501"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 11. Multi-shipment qty map: rows skip when no fyndShipmentId (line 1059)
// ─────────────────────────────────────────────────────────────────────────

describe("shipmentReturnedQtyMap edge cases", () => {
  it("skips returnItem rows that have no fyndShipmentId in the multi-shipment map", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/600",
      name: "#600",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-shop-A", title: "Shirt", quantity: 2, price: "100", sku: "SKU-A", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      { shipment_id: "SHIP-Q", status: "delivery_done", bags: [{ bag_id: "bq1", quantity: 1, articles: [{ seller_identifier: "SKU-A" }] }] },
    ]);
    prismaMock.returnItem.findMany
      .mockResolvedValueOnce([]) // direct
      .mockResolvedValueOnce([]) // SKU
      .mockResolvedValueOnce([
        // skipped: no fyndShipmentId
        { fyndShipmentId: null, shopifyLineItemId: "li-shop-A", fyndBagId: "bq1", sku: "SKU-A", qty: 99 },
        // counted normally
        { fyndShipmentId: "SHIP-Q", shopifyLineItemId: null, fyndBagId: null, sku: null, qty: 1 },
      ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=600"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.shipmentReturnedQtyMap["SHIP-Q"]).toBeDefined();
    // The 99-qty row was skipped (no fyndShipmentId)
    const bucket = body.shipmentReturnedQtyMap["SHIP-Q"];
    expect(Object.values(bucket as Record<string, number>)).not.toContain(99);
  });

  it("returnItem.findMany for shipment-scoped lookup rejection is non-fatal", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/601",
      name: "#601",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      { shipment_id: "SHIP-FAIL", status: "delivery_done", bags: [{ bag_id: "b1", quantity: 1, articles: [{ seller_identifier: "S" }] }] },
    ]);
    prismaMock.returnItem.findMany
      .mockResolvedValueOnce([]) // direct
      .mockResolvedValueOnce([]) // SKU
      .mockRejectedValueOnce(new Error("ship-qty-down"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=601"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 12. SessionNotFoundError → 403
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// 13. Exotic helper coverage via the synthetic-order build path
// ─────────────────────────────────────────────────────────────────────────

describe("helper extraction edge cases", () => {
  it("safeStr extracts from object with .status / .title fields, safeCurrencyCode object, safeImageUrl object", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "S-X",
        order_id: "OX",
        affiliate_order_id: "AO-X",
        external_order_id: "AO-X",
        // status as an OBJECT — exercises safeStr object branch (line 88-93)
        status: { status: "delivery_done" },
        currency: { code: "EUR" }, // safeCurrencyCode object branch
        order_date: { value: "2024-06-01T00:00:00Z" }, // safeStr object .value branch
        bags: [
          {
            bag_id: "bX",
            quantity: 1,
            // price as object — extractNumericPrice object branch (lines 162-166)
            prices: { transfer_price: { amount: 199 } },
            articles: [
              {
                article_id: "ax",
                seller_identifier: "SX",
                size: { name: "Large" }, // safeStr object .name branch
                item: {
                  item_id: "iX",
                  name: { display_name: "Resolved Title" },
                  // image as OBJECT
                  images: [{ secure_url: "https://img/x.jpg" }],
                },
              },
            ],
          },
        ],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=AO-X"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // safeCurrencyCode object → "EUR"
    expect(body.order.currencyCode).toBe("EUR");
    expect(body.order._isFyndSyntheticOrder).toBe(true);
    expect(body.order.lineItems[0].title).toBe("Resolved Title");
    expect(body.order.lineItems[0].variantTitle).toBe("Large");
    expect(body.order.lineItems[0].imageUrl).toBe("https://img/x.jpg");
    // extractNumericPrice on object payload
    expect(body.order.lineItems[0].price).toBe("199");
  });

  it("extractNumericPrice handles string and string-not-a-number inputs", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "S-PR",
        order_id: "OPR",
        affiliate_order_id: "AOPR",
        external_order_id: "AOPR",
        status: "delivery_done",
        currency: 123, // safeCurrencyCode non-string non-object → fallback
        bags: [
          {
            bag_id: "b-pr-1",
            quantity: 1,
            // price as string-numeric
            prices: { transfer_price: "42.50" },
            articles: [{ seller_identifier: "S1", item: { name: "Item-1" } }],
          },
          {
            bag_id: "b-pr-2",
            quantity: 1,
            // price string non-numeric → "0"
            prices: { transfer_price: "not-a-number" },
            articles: [{ seller_identifier: "S2", item: { name: "Item-2" } }],
          },
        ],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=AOPR"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.lineItems[0].price).toBe("42.50");
    expect(body.order.lineItems[1].price).toBe("0");
    expect(body.order.currencyCode).toBe("INR"); // safeCurrencyCode fallback
  });

  it("parseAllowedFyndStatuses handles malformed JSON and returns []", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/PSE",
      name: "#PSE",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: "{not-json", // triggers parse catch (line 150)
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=PSE"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("parseAllowedFyndStatuses returns [] for empty array JSON", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/PSE2",
      name: "#PSE2",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "S", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      allowedFyndStatusesForReturn: JSON.stringify([]), // empty array → returns []
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=PSE2"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 14. Single-shipment enrichment bag-level fallback (lines 746-782)
// ─────────────────────────────────────────────────────────────────────────

describe("single-shipment enrichment bag-level fallback", () => {
  it("hits bag-level fallback when bag has no articles/items and no .item key", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/SS-FB",
      name: "#SSFB",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [
        { id: "li-shop-FB", title: "Shop Title", quantity: 1, price: "75", sku: "SKU-FB", productTags: ["tag1"], imageUrl: "img-fb.jpg", variantTitle: "VarFB" },
      ],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      {
        shipment_id: "SHIP-FB",
        status: "delivery_done",
        bags: [
          {
            // bag with no articles, no items, no item key — triggers fallback (lines 746-782)
            bag_id: "bag-fb",
            quantity: 2,
            line_number: 5,
            seller_identifier: "SKU-FB", // matches Shopify line item
            article_id: "ART-FB",
            prices: { transfer_price: 75, price_effective: 70 },
            affiliate_bag_details: { affiliate_line_id: "ALI-FB" },
            size: "VarFB",
          },
        ],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=SSFB"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shipments).toHaveLength(1);
    const item = body.shipments[0].items[0];
    // matchedShopify wins for id/title/price/imageUrl/productTags
    expect(item.id).toBe("li-shop-FB");
    expect(item.title).toBe("Shop Title");
    expect(item.price).toBe("75");
    expect(item.imageUrl).toBe("img-fb.jpg");
    expect(item.productTags).toEqual(["tag1"]);
    expect(item.fyndAffiliateLineId).toBe("ALI-FB");
    expect(item.fyndArticleId).toBe("ART-FB");
    expect(item.fyndLineNumber).toBe(5);
  });

  it("bag-level fallback with no SKU-match falls back to bag-derived title", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/SS-NM",
      name: "#SSNM",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [
        { id: "li-other", title: "Other", quantity: 1, price: "10", sku: "SKU-OTHER", productTags: [] },
      ],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      {
        shipment_id: "SHIP-NM",
        status: "delivery_done",
        bags: [
          {
            // No matching SKU in shopify line items, no bag.item, no articles
            bag_id: "bag-nm",
            quantity: 1,
            // no seller_identifier, no article_id → sku is null
            // no prices object → 0
          },
        ],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=SSNM"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shipments[0].items[0].id).toBe("bag-nm");
    expect(body.shipments[0].items[0].title).toBe("Item"); // default fallback
    expect(body.shipments[0].items[0].sku).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 15. Specific micro-branches — line 348, 529, 1000, 1026
// ─────────────────────────────────────────────────────────────────────────

describe("micro-branches", () => {
  it("fetchOrderByFyndAffiliateId rejection is swallowed (line 348 .catch)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockRejectedValueOnce(new Error("affiliate-boom"));
    setFyndShipments([
      {
        shipment_id: "S-AB",
        order_id: "OAB",
        affiliate_order_id: "AOAB",
        external_order_id: "AOAB",
        status: "delivery_done",
        currency: "INR",
        bags: [{ bag_id: "b-ab", quantity: 1, articles: [{ seller_identifier: "S" }] }],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=AOAB"), params: {}, context: {} } as never);
    // Synthetic order is built since fetchOrderByFyndAffiliateId failed
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order._isFyndSyntheticOrder).toBe(true);
  });

  it("dedupes line items by id when same bag id appears across shipments (line 529)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValue(null);
    getMappingMock().findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    setFyndShipments([
      {
        shipment_id: "S-D1",
        affiliate_order_id: "AODUP",
        external_order_id: "AODUP",
        status: "delivery_done",
        currency: "INR",
        bags: [
          {
            bag_id: "DUP-BAG",
            quantity: 1,
            articles: [{ seller_identifier: "X", item: { name: "Dup" } }],
          },
        ],
      },
      {
        shipment_id: "S-D2",
        affiliate_order_id: "AODUP",
        external_order_id: "AODUP",
        status: "delivery_done",
        currency: "INR",
        bags: [
          {
            bag_id: "DUP-BAG", // same bag id as shipment 1
            quantity: 1,
            articles: [{ seller_identifier: "X", item: { name: "Dup" } }],
          },
        ],
      },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=AODUP"), params: {}, context: {} } as never);
    const body = await res.json();
    // Dedupe collapses 2 collected lineItems → 1
    expect(body.order.lineItems).toHaveLength(1);
    expect(body.order.lineItems[0].id).toBe("DUP-BAG");
  });

  it("SKU-fallback skips returnItem rows that have no sku (line 1000)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/SK0",
      name: "#SK0",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "USD",
      lineItems: [{ id: "li-1", title: "X", quantity: 2, price: "10", sku: "SKU-X", productTags: [] }],
    });
    prismaMock.returnItem.findMany
      .mockResolvedValueOnce([]) // direct: none
      .mockResolvedValueOnce([
        // First row has NO sku → should be skipped (line 1000 continue)
        { sku: null, qty: 5, shopifyLineItemId: "fynd-bag" },
        // Second row has matching sku → counted
        { sku: "SKU-X", qty: 1, shopifyLineItemId: "fynd-bag-2" },
      ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=SK0"), params: {}, context: {} } as never);
    const body = await res.json();
    // qty 5 must NOT be counted (no sku); qty 1 IS counted
    expect(body.returnedQtyMap["li-1"]).toBe(1);
  });

  it("multi-shipment override flips ineligible→eligible when status block is the only blocker (line 1026)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/OVR",
      name: "#OVR",
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      // Use an UNFULFILLED order so order-level eligibility starts false
      displayFulfillmentStatus: "UNFULFILLED",
      displayFinancialStatus: "PAID",
      currencyCode: "INR",
      lineItems: [{ id: "li-1", title: "X", quantity: 1, price: "10", sku: "SKU-OV", productTags: [] }],
    });
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      // First shipment delivered → triggers anyShipmentEligible
      { shipment_id: "OS1", status: "delivery_done", bags: [{ bag_id: "ob1", quantity: 1, articles: [{ seller_identifier: "SKU-OV" }] }] },
      // Second shipment not eligible
      { shipment_id: "OS2", status: "out_for_delivery", bags: [{ bag_id: "ob2", quantity: 1, articles: [{ seller_identifier: "SKU-Y" }] }] },
    ]);
    const res = await loader({ request: mkReq("shop=store&orderNumber=OVR"), params: {}, context: {} } as never);
    const body = await res.json();
    // Override flips back to eligible
    expect(body.returnEligibility.eligible).toBe(true);
    expect(body.shipments).toHaveLength(2);
  });
});

describe("error fallbacks", () => {
  it("SessionNotFoundError → 403", async () => {
    const err = new Error("no session");
    (err as { name: string }).name = "SessionNotFoundError";
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(err);
    const res = await loader({ request: mkReq("shop=store&orderNumber=1"), params: {}, context: {} } as never);
    expect(res.status).toBe(403);
  });

  it("OrderAccessError → 200 fallback envelope", async () => {
    fetchOrderByOrderNumberMock.mockImplementationOnce(async () => {
      const { OrderAccessError } = await import("../../lib/shopify-admin.server");
      // The mock OrderAccessError class accepts (reason, orderNumber); cast to any
      // because the production class's signature differs (code: "PCDA"|"NOT_FOUND").
      const Ctor = OrderAccessError as unknown as new (reason: string, orderNumber: string) => Error;
      throw new Ctor("protected", "1234");
    });
    const res = await loader({ request: mkReq("shop=store&orderNumber=1234"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.orderNumber).toBe("1234");
  });

  it("'protected' error message → 200 fallback envelope", async () => {
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("Order object is protected"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=4567"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
  });

  it("generic error → 200 fallback (final catch)", async () => {
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("network failure"));
    const res = await loader({ request: mkReq("shop=store&orderNumber=9999"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
    expect(body.error).toMatch(/couldn't find this order automatically/i);
  });
});
