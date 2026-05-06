import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for api.portal.order — targets the fallback `return`
 * statements in helpers when given exotic objects:
 *   - line 93   safeStr fallback (object with no recognized keys)
 *   - line 117  safeImageUrl fallback (object with no URL keys)
 *   - line 151  parseAllowedFyndStatuses returns [] when JSON parses to non-array
 *   - line 167  extractNumericPrice fallback (object with no numeric keys)
 *
 * All four are reached via the Fynd synthetic-order build path, where
 * shipment/bag/article/item/price values flow through these helpers.
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

type MappingMock = { upsert: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
function getMappingMock(): MappingMock {
  return (prismaMock as unknown as { fyndOrderMapping: MappingMock }).fyndOrderMapping;
}

function setFyndShipments(shipments: unknown[]) {
  createFyndClientOrErrorMock.mockResolvedValue({
    ok: true,
    client: {
      searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({ items: shipments }),
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
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByGidMock.mockReset();
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
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

describe("api.portal.order — helper fallback returns", () => {
  it("hits safeStr fallback (line 93), safeImageUrl fallback (line 117), and extractNumericPrice fallback (line 167)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValue({ shopId: "shop-1" });
    setFyndShipments([
      {
        shipment_id: "S-FB",
        order_id: "OFB",
        affiliate_order_id: "AOFB",
        external_order_id: "AOFB",
        // status as object with NO recognized keys → safeStr returns "" (line 93)
        status: { random_unknown_field: "x" },
        // currency object → no recognized keys, fallback (handled in safeCurrencyCode but harmless)
        currency: { random: 1 },
        bags: [
          {
            bag_id: "bFB",
            quantity: 1,
            // price object with NO numeric keys → extractNumericPrice returns "0" (line 167)
            prices: { transfer_price: { unrelated_key: "no-price-here" } },
            articles: [
              {
                article_id: "aFB",
                seller_identifier: "SFB",
                // size as object with no recognized keys → safeStr fallback (line 93)
                size: { totally_unknown: 1 },
                item: {
                  item_id: "iFB",
                  // name as object with no recognized keys → safeStr fallback (line 93)
                  name: { unrecognized: "x" },
                  // image as object with no recognized URL keys → safeImageUrl returns null (line 117)
                  images: [{ caption: "no-url-here" }],
                },
              },
            ],
          },
        ],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=store&orderNumber=AOFB"),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order._isFyndSyntheticOrder).toBe(true);
    // safeImageUrl fallback → null
    expect(body.order.lineItems[0].imageUrl).toBeNull();
    // extractNumericPrice fallback → "0"
    expect(body.order.lineItems[0].price).toBe("0");
    // safeStr fallback → title becomes default "Item"
    expect(body.order.lineItems[0].title).toBe("Item");
  });

  it("hits parseAllowedFyndStatuses non-array branch (line 151) — JSON parses to a number, falls through to []", async () => {
    // Need a Fynd-shipment-bearing order so parseAllowedFyndStatuses is invoked.
    // Use synthetic build path: Shopify returns null, Fynd returns shipments.
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      shopId: "shop-1",
      // JSON parses successfully to a number — neither !raw nor (Array && length>0) → reaches line 151
      allowedFyndStatusesForReturn: "42",
    });
    setFyndShipments([
      {
        shipment_id: "S-PAFS",
        order_id: "OPAFS",
        affiliate_order_id: "AOPAFS",
        external_order_id: "AOPAFS",
        status: "delivery_done",
        bags: [
          {
            bag_id: "bPAFS",
            quantity: 1,
            prices: { transfer_price: 50 },
            articles: [{ seller_identifier: "SPAFS", item: { name: "X" } }],
          },
        ],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=store&orderNumber=AOPAFS"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});
