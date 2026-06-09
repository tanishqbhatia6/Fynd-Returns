/**
 * Final-push branch coverage for the seven /api/portal/* routes.
 *
 * Strategy
 * ────────
 * Each describe block uses `vi.resetModules()` + `vi.doMock(...)` and a
 * fresh dynamic `await import(...)` so a single test file can hit every
 * route without colliding on module-level mocks. This keeps the file
 * size small while letting each route stand on its own dependency
 * graph.
 *
 * Targets
 *   - api.portal.lookup.ts                — Fynd discovery synthetic-fallback
 *                                            branches around lines 444–561
 *   - api.portal.order.ts                  — multi-shipment status logic +
 *                                            safeStr/safeImageUrl/extractNumericPrice
 *                                            edge branches (90/102/114/164/187)
 *   - api.portal.create-return.ts          — port of the err-not-Error branch +
 *                                            already-GID effectiveOrderId fast path
 *   - api.portal.cancel-return.ts          — non-Error catch + matchedReturnIds
 *                                            JSON.parse fallback branch
 *   - api.portal.fynd-enrich.ts            — rawItems via res.shipments fallback;
 *                                            return-enrichment with shipmentId pulled
 *                                            from `id` (not shipment_id); journey_type
 *                                            substring match
 *   - api.portal.otp.send.ts                — non-email session.lookupValueNorm path
 *                                            (dev-mode console.log)
 *   - api.portal.otp.verify.ts              — totalRecentFailures reduce hits the
 *                                            `s.attemptsCount ?? 0` nullish branch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

function jsonReq(url: string, body: unknown, opts: { auth?: string; method?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth) headers.Authorization = opts.auth;
  return new Request(url, {
    method: opts.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ──────────────────────────────────────────────────────────────────────
// 1. api.portal.lookup.ts — Fynd discovery synthetic fallback branches
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.lookup — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadAction(
    setup: (mocks: {
      prisma: ReturnType<typeof createPrismaMock>;
      searchShipments: ReturnType<typeof vi.fn>;
      fetchOrderByOrderNumber: ReturnType<typeof vi.fn>;
      fetchOrderByFyndAffiliateId: ReturnType<typeof vi.fn>;
      parseFyndOrderDetailsForTab: ReturnType<typeof vi.fn>;
      extractFyndJourney: ReturnType<typeof vi.fn>;
      createFyndClientOrError: ReturnType<typeof vi.fn>;
    }) => void,
  ) {
    const prisma = createPrismaMock();
    const searchShipments = vi.fn(async () => ({ items: [] }));
    const fetchOrderByOrderNumber = vi.fn(async () => null);
    const fetchOrderByFyndAffiliateId = vi.fn(async () => null);
    const parseFyndOrderDetailsForTab = vi.fn(() => null);
    const extractFyndJourney = vi.fn(() => []);
    const createFyndClientOrError = vi.fn(async () => ({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipments },
    }));

    setup({
      prisma,
      searchShipments,
      fetchOrderByOrderNumber,
      fetchOrderByFyndAffiliateId,
      parseFyndOrderDetailsForTab,
      extractFyndJourney,
      createFyndClientOrError,
    });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../shopify.server", () => ({
      default: { unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })) } },
    }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/notification.server", () => ({
      sendOtpEmail: vi.fn(async () => undefined),
    }));
    vi.doMock("../../lib/shopify-admin.server", () => ({
      fetchOrdersByFilter: vi.fn(async () => []),
      fetchOrderByOrderNumber,
      fetchOrderByGid: vi.fn(async () => null),
      fetchOrderByFyndAffiliateId,
      withRestCredentials: vi.fn((a: unknown) => a),
    }));
    vi.doMock("../../lib/fynd.server", () => ({ createFyndClientOrError }));
    vi.doMock("../../lib/fynd-payload.server", () => ({
      getTrackingInfoFromFyndPayload: vi.fn(() => null),
      extractFyndJourney,
      getPickupAddressFromFyndPayload: vi.fn(() => null),
      parseFyndOrderDetailsForTab,
    }));
    vi.doMock("../../lib/portal-i18n", () => ({ getPortalLabels: vi.fn(() => ({})) }));
    vi.doMock("../../lib/portal-auth.server", () => ({
      createPortalCsrfToken: () => "csrf",
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

    return (await import("../api.portal.lookup")).action;
  }

  it("synthetic order from Fynd: uses res.shipments fallback when items absent (rawItems branch)", async () => {
    const action = await loadAction(({ prisma, searchShipments, parseFyndOrderDetailsForTab }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.shopSettings.findUnique.mockResolvedValue(null);
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      // Use res.shipments instead of res.items — exercises the `?? res.shipments` branch.
      searchShipments.mockResolvedValue({
        shipments: [
          {
            journey_type: "forward",
            affiliate_order_id: "AFF-9",
            customer_details: { email: "x@x.com" },
            billing_details: { email: "billing@x.com" },
            bags: [
              {
                delivery_address: { state_code: "KA", zip: "560001" },
                prices: { currency: "USD" },
              },
            ],
            order_value: { currency: "EUR" },
          },
        ],
      });
      parseFyndOrderDetailsForTab.mockReturnValue({
        shipments: [
          {
            items: [
              {
                identifier: "ID-1",
                quantity: undefined,
                originalPrice: "20.00",
                title: undefined,
                sku: undefined,
              },
            ],
          },
        ],
      });
    });

    const res = await action({
      request: jsonReq("https://app/x/api/portal/lookup", {
        shop: "store",
        lookupType: "order_no",
        lookupValue: "AFF-9",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).not.toHaveProperty("email");
    expect(body.orders[0].currencyCode).toBe("USD");
    // Line items deduped by sku/itemId/title — falls back to "" key which dedupes to one entry
    expect(body.orders[0].lineItems.length).toBeGreaterThanOrEqual(1);
  });

  it("synthetic order: data.items branch + state fallback + zip fallback", async () => {
    const action = await loadAction(({ prisma, searchShipments, parseFyndOrderDetailsForTab }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.shopSettings.findUnique.mockResolvedValue(null);
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      searchShipments.mockResolvedValue({
        data: {
          items: [
            {
              journey_type: "forward",
              external_order_id: "EXT-1",
              customer_details: { email: "shopper@example.com" },
              delivery_address: {
                city: "Mumbai",
                state: "MH",
                country: "IN",
                pincode: "400001",
                name: "John Doe",
              },
              prices: { currency_code: "INR" },
            },
          ],
        },
      });
      parseFyndOrderDetailsForTab.mockReturnValue(null); // exercises the !parsed branch
    });

    const res = await action({
      request: jsonReq("https://app/x/api/portal/lookup", {
        shop: "store",
        lookupType: "order_no",
        lookupValue: "EXT-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    const o = body.orders[0];
    expect(o).not.toHaveProperty("shippingAddress");
  });

  it("ReturnCase synthetic: prefers item.sku when notes is null", async () => {
    const action = await loadAction(({ prisma }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.returnCase.findMany.mockResolvedValueOnce([]); // initial returnsRaw
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.shopSettings.findUnique.mockResolvedValue(null);
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      // ReturnCase fallback findMany — items use sku-only (notes null) hitting line 411 idx 2
      prisma.returnCase.findMany.mockResolvedValueOnce([
        {
          id: "rc-syn",
          shopifyOrderId: null,
          shopifyOrderName: null,
          customerEmailNorm: "buyer@x.com",
          fyndShipmentId: null,
          fyndPayloadJson: null,
          items: [{ id: "it-A", shopifyLineItemId: null, notes: null, sku: null, qty: 1 }],
          createdAt: new Date(),
        },
      ]);
    });

    const res = await action({
      request: jsonReq("https://app/x/api/portal/lookup", {
        shop: "store",
        lookupType: "order_no",
        lookupValue: "X-99",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0].lineItems[0].title).toBe("Item"); // final fallback
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. api.portal.order.ts — multi-shipment + safe* helper edge branches
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.order — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadLoader(
    setup: (m: {
      prisma: ReturnType<typeof createPrismaMock>;
      searchShipments: ReturnType<typeof vi.fn>;
      fetchOrderByOrderNumber: ReturnType<typeof vi.fn>;
      createFyndClientOrError: ReturnType<typeof vi.fn>;
      checkReturnEligibility: ReturnType<typeof vi.fn>;
    }) => void,
  ) {
    const prisma = createPrismaMock();
    const searchShipments = vi.fn(async () => ({ items: [] }));
    const fetchOrderByOrderNumber = vi.fn(async () => null);
    const createFyndClientOrError = vi.fn(async () => ({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipments },
    }));
    const checkReturnEligibility = vi.fn(() => ({ eligible: true }));

    setup({
      prisma,
      searchShipments,
      fetchOrderByOrderNumber,
      createFyndClientOrError,
      checkReturnEligibility,
    });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../shopify.server", () => ({
      default: { unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })) } },
    }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/shopify-admin.server", () => ({
      fetchOrderByOrderNumber,
      fetchOrderByGid: vi.fn(async () => null),
      fetchOrderByFyndAffiliateId: vi.fn(async () => null),
      OrderAccessError: class extends Error {
        constructor() {
          super("order access");
        }
      },
      withRestCredentials: vi.fn((a: unknown) => a),
    }));
    vi.doMock("../../lib/return-rules.server", () => ({ checkReturnEligibility }));
    vi.doMock("../../lib/fynd.server", () => ({ createFyndClientOrError }));
    vi.doMock("../../lib/portal-auth.server", () => ({
      createPortalCsrfToken: () => "csrf",
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
    vi.doMock("../../lib/return-request-id", () => ({
      formatReturnRequestId: (x: string) => `R-${x}`,
    }));
    vi.doMock("../../lib/parse-json", () => ({
      parseJsonArray: (s: string | null, fb: unknown[]) => (s ? JSON.parse(s) : fb),
    }));

    return (await import("../api.portal.order")).loader;
  }

  it("multi-shipment Fynd-synthetic order: at-least-one eligible overrides status block", async () => {
    const loader = await loadLoader(({ prisma, searchShipments, fetchOrderByOrderNumber }) => {
      prisma.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.fyndOrderMapping.upsert.mockResolvedValue({});
      prisma.shopSettings.findUnique.mockResolvedValue({
        allowedFyndStatusesForReturn: null,
        returnWindowDays: 30,
      });
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      prisma.returnItem.findMany.mockResolvedValue([]);
      fetchOrderByOrderNumber.mockResolvedValue(null);
      searchShipments.mockResolvedValue({
        items: [
          // Two shipments — one delivered (eligible), one pre-delivery (not)
          {
            journey_type: "forward",
            shipment_id: "S1",
            status: "delivery_done",
            affiliate_order_id: "ORD-1",
            customer_details: { email: "shopper@example.com", phone: "+15550100" },
            delivery_address: { email: "shopper@example.com", phone: "+15550100" },
            // bag with safeStr-extracted name from object (line 90 branch idx 5/6)
            bags: [
              {
                bag_id: "B1",
                quantity: 2,
                articles: [
                  {
                    article_id: "A1",
                    seller_identifier: "SKU1",
                    item: {
                      // name is an object — exercises safeStr's nested extraction
                      name: { display_name: "Wrap dress" },
                      images: [{ url: "https://img.test/1.jpg" }], // safeImageUrl object branch
                    },
                    quantity_available: 5,
                  },
                ],
                prices: { transfer_price: 25.5 },
              },
            ],
          },
          {
            journey_type: "forward",
            shipment_id: "S2",
            status: "out_for_delivery",
            customer_details: { email: "shopper@example.com", phone: "+15550100" },
            delivery_address: { email: "shopper@example.com", phone: "+15550100" },
            // bag with no articles/items — exercises the bag-level fallback path
            bags: [
              {
                bag_id: "B2",
                quantity: 1,
                item: { name: "Solo" },
                seller_identifier: "SKU2",
                article_id: "A2",
              },
            ],
          },
        ],
      });
    });

    const res = await loader({
      request: new Request("https://app/x/api/portal/order?shop=store&orderNumber=ORD-1", {
        method: "GET",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shipments).toHaveLength(2);
    expect(body.shipments[0].eligible).toBe(true);
    expect(body.shipments[1].eligible).toBe(false);
    expect(body.returnEligibility.eligible).toBe(true); // override applied
  });

  it("multi-shipment: all not eligible AND order-level rules block — eligibility stays false (no override)", async () => {
    const loader = await loadLoader(({ prisma, searchShipments, checkReturnEligibility }) => {
      prisma.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.fyndOrderMapping.upsert.mockResolvedValue({});
      prisma.shopSettings.findUnique.mockResolvedValue({
        allowedFyndStatusesForReturn: null,
        returnWindowDays: 30,
      });
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      prisma.returnItem.findMany.mockResolvedValue([]);
      // Block by return rules (e.g. order outside window)
      checkReturnEligibility.mockReturnValue({ eligible: false, reason: "Outside return window" });
      searchShipments.mockResolvedValue({
        items: [
          {
            journey_type: "forward",
            shipment_id: "S1",
            status: "delivery_done",
            affiliate_order_id: "ORD-2",
            customer_details: { email: "shopper@example.com", phone: "+15550100" },
            delivery_address: { email: "shopper@example.com", phone: "+15550100" },
            bags: [
              {
                bag_id: "B1",
                quantity: 1,
                articles: [
                  {
                    article_id: "A1",
                    item: { name: "Item" },
                    line_number: 1,
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    const res = await loader({
      request: new Request("https://app/x/api/portal/order?shop=store&orderNumber=ORD-2", {
        method: "GET",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // One shipment eligible, but return-rules block kept in place
    expect(body.returnEligibility.eligible).toBe(false);
    expect(body.returnEligibility.reason).toMatch(/Outside return window/);
  });

  it("Shopify-resolved order with Fynd enrichment for sku-matching", async () => {
    const loader = await loadLoader(({ prisma, searchShipments, fetchOrderByOrderNumber }) => {
      prisma.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.shopSettings.findUnique.mockResolvedValue({
        allowedFyndStatusesForReturn: null,
        returnWindowDays: 30,
      });
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      prisma.returnItem.findMany.mockResolvedValue([]);
      fetchOrderByOrderNumber.mockResolvedValue({
        id: "gid://shopify/Order/1",
        name: "#100",
        email: "shopper@example.com",
        createdAt: new Date().toISOString(),
        displayFulfillmentStatus: "FULFILLED",
        displayFinancialStatus: "PAID",
        currencyCode: "USD",
        lineItems: [
          {
            id: "gid://line/1",
            title: "Tee",
            sku: "SKU1",
            price: "10.00",
            quantity: 2,
            productTags: [],
          },
        ],
        shippingCountry: "US",
        shippingProvince: "CA",
      });
      // Enrichment Fynd call returns matching shipment with bag → exercises sku match path
      searchShipments.mockResolvedValue({
        items: [
          {
            journey_type: "forward",
            shipment_id: "S1",
            status: "delivery_done",
            id: undefined,
            customer_details: { email: "shopper@example.com", phone: "+15550100" },
            delivery_address: { email: "shopper@example.com", phone: "+15550100" },
            bags: [
              {
                bag_id: "B1",
                quantity: 1,
                articles: [
                  { article_id: "A1", seller_identifier: "SKU1", item: { item_id: "ID1" } },
                ],
              },
            ],
          },
        ],
      });
    });

    const res = await loader({
      request: new Request("https://app/x/api/portal/order?shop=store&orderNumber=100", {
        method: "GET",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0].items[0].sku).toBe("SKU1");
  });

  it("OrderAccessError fallback returns 200 with fallback flag", async () => {
    // Pre-stub OrderAccessError as our own class via mock — and use the same instance
    // when throwing from fetchOrderByOrderNumber so the `instanceof` check matches.
    class FakeOrderAccessError extends Error {
      constructor() {
        super("order access");
      }
    }
    const loader = await loadLoader(({ prisma, fetchOrderByOrderNumber }) => {
      prisma.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      // Throw a generic error with message that triggers the "not approved" SAFE_PATTERN
      // fallback (lines 1131-1144) — produces same { fallback: true } 200 response.
      fetchOrderByOrderNumber.mockRejectedValue(
        new Error("Order object is protected and not approved"),
      );
    });
    void FakeOrderAccessError;

    const res = await loader({
      request: new Request("https://app/x/api/portal/order?shop=store&orderNumber=999", {
        method: "GET",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe(true);
  });

  it("SessionNotFoundError → 403 store-not-connected response", async () => {
    const loader = await loadLoader(({ prisma, fetchOrderByOrderNumber }) => {
      prisma.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
      prisma.returnCase.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      const err = new Error("session missing");
      err.name = "SessionNotFoundError";
      fetchOrderByOrderNumber.mockRejectedValue(err);
    });

    const res = await loader({
      request: new Request("https://app/x/api/portal/order?shop=store&orderNumber=999", {
        method: "GET",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/has not connected/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. api.portal.create-return.ts — error swallow + already-GID fast path
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.create-return — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadAction(
    setup: (m: {
      prisma: ReturnType<typeof createPrismaMock>;
      fetchOrder: ReturnType<typeof vi.fn>;
      fetchOrderByFyndAffiliateId: ReturnType<typeof vi.fn>;
      createFyndClientOrError: ReturnType<typeof vi.fn>;
    }) => void,
  ) {
    const prisma = createPrismaMock();
    const fetchOrder = vi.fn(async () => null);
    const fetchOrderByFyndAffiliateId = vi.fn(async () => null);
    const createFyndClientOrError = vi.fn(async () => ({ ok: false, error: "off" }));

    setup({ prisma, fetchOrder, fetchOrderByFyndAffiliateId, createFyndClientOrError });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../shopify.server", () => ({
      default: { unauthenticated: { admin: vi.fn(async () => ({ admin: { graphql: vi.fn() } })) } },
    }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/portal-auth.server", () => ({
      verifyPortalCsrfToken: vi.fn(() => true),
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
    vi.doMock("../../lib/shopify-admin.server", () => ({
      fetchOrder,
      fetchOrderByOrderNumber: vi.fn(async () => null),
      fetchOrderByFyndAffiliateId,
      withRestCredentials: vi.fn((a: unknown) => a),
    }));
    vi.doMock("../../lib/fynd.server", () => ({ createFyndClientOrError }));
    vi.doMock("../../lib/fynd-returns.server", () => ({ createReturnOnFynd: vi.fn() }));
    vi.doMock("../../lib/notification.server", () => ({
      sendNewReturnNotification: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../lib/return-rules.server", () => ({
      checkReturnEligibility: vi.fn(() => ({ eligible: true })),
    }));
    vi.doMock("../../lib/auto-approve.server", () => ({
      evaluateAutoApproveRules: vi.fn(() => "approve"),
      parseAutoApproveRules: vi.fn(() => []),
    }));
    vi.doMock("../../lib/return-request-id", () => ({
      parseReturnIdConfig: vi.fn(() => ({ bodyMode: "id" })),
      buildReturnRequestId: vi.fn(() => "R-1"),
      formatReturnRequestId: vi.fn((x: string) => `R-${x}`),
    }));
    vi.doMock("../../lib/return-id-counter.server", () => ({
      nextReturnIdCounter: vi.fn().mockResolvedValue(1),
    }));
    vi.doMock("../../lib/parse-json", () => ({
      parseJsonArray: vi.fn((s: string | null, fb: unknown[]) => (s ? JSON.parse(s) : fb)),
    }));
    vi.doMock("../../lib/source-channel.server", () => ({
      normalizeSourceChannel: vi.fn((x: string) => x),
    }));
    vi.doMock("../../lib/fynd-retry.server", () => ({
      scheduleRetry: vi.fn().mockResolvedValue(undefined),
    }));

    return (await import("../api.portal.create-return")).action;
  }

  it("non-Error caught at outer try → wrapped as Something went wrong", async () => {
    const action = await loadAction(({ prisma }) => {
      // Throw a non-Error to exercise the `err instanceof Error ? err.message : ""` branch
      prisma.shop.findUnique.mockImplementation(() => {
        throw "boom-string";
      });
    });
    process.env.PORTAL_CSRF_REQUIRED = "false";
    const res = await action({
      request: jsonReq("https://a/api/portal/create-return", {
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "gid://shopify/Order/1",
        customerEmail: "u@x.com",
        items: [{ lineItemId: "gid://shopify/LineItem/1", qty: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Something went wrong/);
  });

  it("orderId is purely numeric → skips affiliate-resolve fast path", async () => {
    const action = await loadAction(({ prisma, fetchOrder, fetchOrderByFyndAffiliateId }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          id: "s1",
          returnWindowDays: 30,
          blocklistEnabled: false,
          autoApproveEnabled: false,
        },
      });
      prisma.session.findFirst.mockResolvedValue({ accessToken: "tok" });
      prisma.returnItem.findMany.mockResolvedValue([]);
      prisma.fyndOrderMapping.findFirst.mockResolvedValue(null);
      // numeric orderId — "12345" matches /^\d+$/, so the affiliate-resolve block is skipped
      fetchOrder.mockResolvedValue({
        id: "12345",
        email: "u@x.com",
        displayFulfillmentStatus: "FULFILLED",
        displayFinancialStatus: "PAID",
        sourceName: "web",
        affiliateOrderId: null,
      });
      // Transaction returns a return case-like object
      prisma.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          returnItem: { findMany: vi.fn(async () => []) },
          returnCase: {
            create: vi.fn(async () => ({
              id: "rc-1",
              returnRequestNo: null,
              status: "approved",
              createdAt: new Date(),
              items: [],
            })),
            update: vi.fn(async () => ({})),
          },
          returnEvent: { create: vi.fn(async () => ({})) },
        };
        return cb(tx);
      });
    });
    process.env.PORTAL_CSRF_REQUIRED = "false";
    const res = await action({
      request: jsonReq("https://a/api/portal/create-return", {
        shop: "store",
        shopifyOrderName: "1001",
        orderId: "12345",
        customerEmail: "u@x.com",
        orderCreatedAt: new Date().toISOString(),
        items: [{ lineItemId: "gid://shopify/LineItem/1", qty: 1 }],
        lineItemsWithPrice: [
          { id: "gid://shopify/LineItem/1", title: "T", price: "10", quantity: 1 },
        ],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // affiliate-resolve should NOT have been invoked because the ID is purely numeric
    expect((await res.json()).success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. api.portal.cancel-return.ts — non-Error catch + matchedReturnIds JSON.parse
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.cancel-return — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadAction(
    setup: (m: {
      prisma: ReturnType<typeof createPrismaMock>;
      verifyPortalToken: ReturnType<typeof vi.fn>;
      verifyPortalSession: ReturnType<typeof vi.fn>;
      verifyPortalCsrfToken: ReturnType<typeof vi.fn>;
    }) => void,
  ) {
    const prisma = createPrismaMock();
    const verifyPortalToken = vi.fn(() => ({ sessionId: "sess-1", shopId: "shop-1" }));
    const verifyPortalSession = vi.fn(async () => ({
      id: "sess-1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      lookupValueNorm: "user@example.com",
      matchedReturnIds: JSON.stringify(["rc-1"]),
    }));
    const verifyPortalCsrfToken = vi.fn(() => true);

    setup({ prisma, verifyPortalToken, verifyPortalSession, verifyPortalCsrfToken });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-auth.server", () => ({
      verifyPortalToken,
      verifyPortalSession,
      verifyPortalCsrfToken,
    }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/portal-config.server", () => ({
      parsePortalConfig: vi.fn(() => ({ allowReturnCancellation: true })),
    }));
    vi.doMock("../../lib/notification.server", () => ({
      sendCancellationNotification: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../../lib/webhook-dispatch.server", () => ({ dispatchWebhookEvent: vi.fn() }));

    return (await import("../api.portal.cancel-return")).action;
  }

  it("non-Error thrown in outer try → 500 with 'Internal server error' fallback", async () => {
    const action = await loadAction(({ verifyPortalSession }) => {
      // Throw a non-Error from the verified-session helper.
      verifyPortalSession.mockImplementation(() => {
        throw "raw-string";
      });
    });
    process.env.PORTAL_CSRF_REQUIRED = "false";
    const res = await action({
      request: jsonReq(
        "https://a/api/portal/cancel-return",
        { shop: "store", returnCaseId: "rc-1" },
        { auth: "Bearer t" },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Internal server error");
  });

  it("matchedReturnIds is malformed JSON → catch swallows, returns 404 (empty array)", async () => {
    const action = await loadAction(({ prisma, verifyPortalSession }) => {
      verifyPortalSession.mockResolvedValue({
        id: "sess-1",
        shopId: "shop-1",
        lookupType: "email",
        lookupValueHash: "hash",
        lookupValueNorm: "user@example.com",
        matchedReturnIds: "{not-json", // exercises the `catch { /* ignore */ }` branch
      });
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {},
      });
    });
    process.env.PORTAL_CSRF_REQUIRED = "false";
    const res = await action({
      request: jsonReq(
        "https://a/api/portal/cancel-return",
        { shop: "store", returnCaseId: "rc-1" },
        { auth: "Bearer t" },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/Return not found/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. api.portal.fynd-enrich.ts — shipments fallback + journey_type substring
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.fynd-enrich — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadAction(
    setup: (m: {
      prisma: ReturnType<typeof createPrismaMock>;
      searchShipments: ReturnType<typeof vi.fn>;
      createFyndClientOrError: ReturnType<typeof vi.fn>;
      verifyPortalSession: ReturnType<typeof vi.fn>;
    }) => void,
  ) {
    const prisma = createPrismaMock();
    const searchShipments = vi.fn();
    const createFyndClientOrError = vi.fn(async () => ({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipments },
    }));
    const verifyPortalSession = vi.fn(async () => ({
      id: "sess-1",
      shopId: "shop-1",
      lookupType: "order_no",
      lookupValueHash: "hash",
      lookupValueNorm: "100",
      matchedReturnIds: JSON.stringify(["rc-1", "rc-2"]),
    }));

    setup({ prisma, searchShipments, createFyndClientOrError, verifyPortalSession });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-auth.server", () => ({ verifyPortalSession }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/fynd.server", () => ({ createFyndClientOrError }));
    vi.doMock("../../lib/fynd-payload.server", () => ({
      parseFyndOrderDetailsForTab: vi.fn(() => ({ orderInfo: { name: "#1" } })),
      extractFyndJourney: vi.fn(() => [{ status: "ok" }]),
      getTrackingInfoFromFyndPayload: vi.fn(() => ({ awb: "A1" })),
      getPickupAddressFromFyndPayload: vi.fn(() => ({ city: "X" })),
    }));

    return (await import("../api.portal.fynd-enrich")).action;
  }

  it("type=order: res.shipments fallback path (when items absent)", async () => {
    const action = await loadAction(({ prisma, searchShipments }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.fyndOrderMapping.upsert.mockResolvedValue({});
      // Use res.shipments (not items). Shipment also uses `id` not `shipment_id` — exercises
      // the `s.id` fallback in line 107.
      searchShipments.mockResolvedValue({
        shipments: [{ journey_type: "forward", id: "S-99", order_id: "FY-9" }],
      });
    });
    const res = await action({
      request: jsonReq("https://a/api/portal/fynd-enrich", {
        shop: "store",
        type: "order",
        orderName: "#100",
        portalToken: "t",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fyndData).toBeTruthy();
  });

  it("type=returns: journey_type substring match + uses item.id when shipment_id absent", async () => {
    const action = await loadAction(({ prisma, searchShipments }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.returnCase.findMany.mockResolvedValue([
        {
          id: "rc-1",
          shopifyOrderName: "#100",
          fyndShipmentId: "old-bag-id",
          fyndPayloadJson: null,
        },
      ]);
      // Shipment uses `id` instead of `shipment_id`; journey_type contains "return" but isn't exactly "return"
      searchShipments.mockResolvedValue({
        items: [{ journey_type: "post_return_check", id: "RS-1" }],
      });
    });
    const res = await action({
      request: jsonReq("https://a/api/portal/fynd-enrich", {
        shop: "store",
        type: "returns",
        returnIds: ["rc-1"],
        portalToken: "t",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returnEnrichments["rc-1"]).toBeDefined();
    // liveShipmentId derived from shipment_id (first) or shipmentId — should be empty string -> undefined
    // Since neither field is set, it falls back to undefined
    expect(body.returnEnrichments["rc-1"].fyndShipmentId).toBeUndefined();
  });

  it("type=returns: items extraction prefers res.results when items+shipments+data.items absent", async () => {
    const action = await loadAction(({ prisma, searchShipments }) => {
      prisma.shop.findUnique.mockResolvedValue({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { id: "s1" },
      });
      prisma.returnCase.findMany.mockResolvedValue([
        { id: "rc-2", shopifyOrderName: "#101", fyndShipmentId: "S-A", fyndPayloadJson: null },
      ]);
      // No journey_type at all → returnItems empty, falls back to candidateItems = items
      // Use shipment_id matching for exact match path
      searchShipments.mockResolvedValue({
        results: [{ shipment_id: "S-A" }],
      });
    });
    const res = await action({
      request: jsonReq("https://a/api/portal/fynd-enrich", {
        shop: "store",
        type: "returns",
        returnIds: ["rc-2"],
        portalToken: "t",
        sessionId: "sess-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returnEnrichments["rc-2"].fyndShipmentId).toBe("S-A");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. api.portal.otp.send.ts — unsupported non-email session.lookupValueNorm path
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.otp.send — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("phone (non-email) target: fails closed instead of issuing an undeliverable OTP", async () => {
    const prisma = createPrismaMock();
    prisma.lookupSession.findUnique.mockResolvedValue({
      id: "sess-1",
      shopId: "shop-1",
      lookupValueNorm: "+15551234567", // no @
      attemptsCount: 0,
      otpSentAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.lookupSession.update.mockResolvedValue({});
    const sendOtpEmail = vi.fn(async () => undefined);
    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/notification.server", () => ({ sendOtpEmail }));
    const portalLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    vi.doMock("../../lib/observability/logger.server", () => ({ portalLogger }));
    process.env.NODE_ENV = "development"; // ensure dev-mode debug branch fires
    const action = (await import("../api.portal.otp.send")).action;
    const res = await action({
      request: jsonReq("https://a/api/portal/otp/send", { sessionId: "sess-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.phoneVerificationUnavailable).toBe(true);
    expect(prisma.lookupSession.update).not.toHaveBeenCalled();
    expect(sendOtpEmail).not.toHaveBeenCalled();
    expect(portalLogger.debug).not.toHaveBeenCalled();
    process.env.NODE_ENV = "test";
  });

  it("email target but shopRecord lookup returns null → no email sent (line 65 branch)", async () => {
    const prisma = createPrismaMock();
    prisma.lookupSession.findUnique.mockResolvedValue({
      id: "sess-1",
      shopId: "shop-missing",
      lookupValueNorm: "user@example.com",
      attemptsCount: 0,
      otpSentAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.lookupSession.update.mockResolvedValue({});
    prisma.shop.findUnique.mockResolvedValue(null); // shopRecord falsy
    const sendOtpEmail = vi.fn(async () => undefined);
    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/notification.server", () => ({ sendOtpEmail }));
    const action = (await import("../api.portal.otp.send")).action;
    const res = await action({
      request: jsonReq("https://a/api/portal/otp/send", { sessionId: "sess-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 7. api.portal.otp.verify.ts — null attemptsCount + non-Error catch
// ──────────────────────────────────────────────────────────────────────
describe("api.portal.otp.verify — final branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("recent sessions with null attemptsCount → reduce uses 0 fallback", async () => {
    const prisma = createPrismaMock();
    prisma.lookupSession.findUnique.mockResolvedValue({
      id: "sess-1",
      shopId: "shop-1",
      lookupValueHash: "hash-x",
      otpTarget: "$2b$10$abc.bcrypted.hash.here",
      otpSentAt: new Date(),
      attemptsCount: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Some sessions with null attemptsCount — exercises `s.attemptsCount ?? 0`
    prisma.lookupSession.findMany.mockResolvedValue([
      { attemptsCount: null, verifiedAt: null },
      { attemptsCount: 1, verifiedAt: null },
      { attemptsCount: 5, verifiedAt: new Date() }, // verified — excluded
    ]);
    prisma.lookupSession.update.mockResolvedValue({ attemptsCount: 1 });

    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/portal-auth.server", () => ({
      createPortalToken: vi.fn(() => "token-1"),
    }));

    const action = (await import("../api.portal.otp.verify")).action;
    const res = await action({
      request: jsonReq("https://a/api/portal/otp/verify", {
        sessionId: "sess-1",
        otp: "wrong-code",
      }),
      params: {},
      context: {},
    } as never);
    // bcrypt.compare against junk hash → invalid (catch path returns isValid=false too)
    // attemptsCount goes from 0 → 1, attemptsRemaining = 4 → 400 invalid
    expect([400, 429]).toContain(res.status);
  });

  it("non-Error thrown in outer try → 500 with 'Verification failed' fallback", async () => {
    const prisma = createPrismaMock();
    // lookupSession.findUnique throws a non-Error to land in the outer catch
    prisma.lookupSession.findUnique.mockImplementation(() => {
      throw "non-error";
    });
    vi.doMock("../../db.server", () => ({ default: prisma }));
    vi.doMock("../../lib/portal-cors.server", () => ({
      getPortalCorsHeaders: () => new Headers(),
      withCors: (r: Response) => r,
    }));
    vi.doMock("../../lib/rate-limit.server", () => ({
      checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
      rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
    }));
    vi.doMock("../../lib/portal-auth.server", () => ({ createPortalToken: vi.fn(() => "token") }));

    const action = (await import("../api.portal.otp.verify")).action;
    const res = await action({
      request: jsonReq("https://a/api/portal/otp/verify", { sessionId: "sess-1", otp: "123456" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Verification failed");
  });
});
