/**
 * Loader tests for app/routes/app.returns.$id.tsx — the return detail page.
 *
 * The loader is a sprawling ~600 LOC orchestration that:
 *   - 404s on missing return / shop
 *   - backfills returnRequestNo
 *   - resolves the Shopify order via several strategies (manual skip,
 *     fast GID/numeric path, slow candidate-name path with multiple
 *     fallbacks via fetchOrderByFyndAffiliateId)
 *   - persists the resolved GID back to the row
 *   - falls through customer/AWB enrichment, settings, etc.
 *
 * These tests pin the order-resolution branches and the basic shape of
 * the data returned to the component. The heavier downstream branches
 * (Fynd shipment fetch, signed URLs, blocklist) are exercised lightly
 * via defaults; deep coverage of those paths lives in their own unit
 * tests for the underlying helpers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  withRestCredentialsMock,
  fetchAllLocationsMock,
  parseReturnIdConfigMock,
  buildReturnRequestIdMock,
  formatReturnRequestIdMock,
  nextReturnIdCounterMock,
  parseFyndPayloadForDisplayMock,
  parseFyndOrderDetailsForTabMock,
  getPickupAddressFromFyndPayloadMock,
  extractFyndJourneyMock,
  extractCustomerFromFyndPayloadMock,
  extractShippingDetailsFromFyndPayloadMock,
  extractAffiliateOrderIdFromFyndPayloadMock,
  isLikelyFyndIdMock,
  buildTrackingUrlFromCourierAndAwbMock,
  isFyndPrivateUrlMock,
  signFyndUrlMock,
  createFyndClientOrErrorMock,
  refundLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchAllLocationsMock: vi.fn<
    (...args: unknown[]) => Promise<Array<{ id: string; name: string; isActive: boolean }>>
  >(async () => []),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "hash", prefix: "RET" })),
  buildReturnRequestIdMock: vi.fn(() => "RET-ABC123"),
  formatReturnRequestIdMock: vi.fn((id: string) => id),
  nextReturnIdCounterMock: vi.fn(async () => 42),
  parseFyndPayloadForDisplayMock: vi.fn(() => null),
  parseFyndOrderDetailsForTabMock: vi.fn(() => null),
  getPickupAddressFromFyndPayloadMock: vi.fn(() => null),
  extractFyndJourneyMock: vi.fn(() => []),
  extractCustomerFromFyndPayloadMock: vi.fn(() => null),
  extractShippingDetailsFromFyndPayloadMock: vi.fn(() => null),
  extractAffiliateOrderIdFromFyndPayloadMock: vi.fn<(...args: unknown[]) => string | null>(
    () => null,
  ),
  isLikelyFyndIdMock: vi.fn(() => false),
  buildTrackingUrlFromCourierAndAwbMock: vi.fn(() => null),
  isFyndPrivateUrlMock: vi.fn(() => false),
  signFyndUrlMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createFyndClientOrErrorMock: vi.fn(async () => ({ ok: false, reason: "not_configured" })),
  refundLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
  fetchAllLocations: fetchAllLocationsMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: nextReturnIdCounterMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  parseFyndPayloadForDisplay: parseFyndPayloadForDisplayMock,
  parseFyndOrderDetailsForTab: parseFyndOrderDetailsForTabMock,
  getPickupAddressFromFyndPayload: getPickupAddressFromFyndPayloadMock,
  extractFyndJourney: extractFyndJourneyMock,
  extractCustomerFromFyndPayload: extractCustomerFromFyndPayloadMock,
  extractShippingDetailsFromFyndPayload: extractShippingDetailsFromFyndPayloadMock,
  extractAffiliateOrderIdFromFyndPayload: extractAffiliateOrderIdFromFyndPayloadMock,
  isLikelyFyndId: isLikelyFyndIdMock,
  buildTrackingUrlFromCourierAndAwb: buildTrackingUrlFromCourierAndAwbMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  isFyndPrivateUrl: isFyndPrivateUrlMock,
  signFyndUrl: signFyndUrlMock,
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/observability/logger.server", () => ({
  refundLogger: refundLoggerMock,
}));

import { loader } from "../app.returns.$id";

function mkReq(id: string) {
  return new Request(`https://app.example/app/returns/${id}`);
}

function makeReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "initiated",
    refundStatus: null,
    shopifyOrderId: null,
    shopifyOrderName: null,
    returnRequestNo: "RET-EXISTING",
    customerName: "Jane",
    customerEmailNorm: "jane@example.com",
    customerPhoneNorm: null,
    customerCity: "Toronto",
    customerCountry: "CA",
    fyndPayloadJson: null,
    returnLabelJson: null,
    forwardAwb: null,
    returnAwb: null,
    fyndShipmentId: null,
    fyndCurrentStatus: null,
    fyndSyncStatus: null,
    isGreenReturn: false,
    items: [],
    events: [],
    orderProcessedAt: null,
    currency: "USD",
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok-123" },
    admin: { graphql: vi.fn() },
  });
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  withRestCredentialsMock.mockReset().mockImplementation((admin: unknown) => admin);
  fetchAllLocationsMock.mockReset().mockResolvedValue([]);
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "hash", prefix: "RET" });
  buildReturnRequestIdMock.mockReset().mockReturnValue("RET-ABC123");
  formatReturnRequestIdMock.mockReset().mockImplementation((id: string) => id);
  nextReturnIdCounterMock.mockReset().mockResolvedValue(42);
  parseFyndPayloadForDisplayMock.mockReset().mockReturnValue(null);
  parseFyndOrderDetailsForTabMock.mockReset().mockReturnValue(null);
  getPickupAddressFromFyndPayloadMock.mockReset().mockReturnValue(null);
  extractFyndJourneyMock.mockReset().mockReturnValue([]);
  extractCustomerFromFyndPayloadMock.mockReset().mockReturnValue(null);
  extractShippingDetailsFromFyndPayloadMock.mockReset().mockReturnValue(null);
  extractAffiliateOrderIdFromFyndPayloadMock.mockReset().mockReturnValue(null);
  isLikelyFyndIdMock.mockReset().mockReturnValue(false);
  buildTrackingUrlFromCourierAndAwbMock.mockReset().mockReturnValue(null);
  isFyndPrivateUrlMock.mockReset().mockReturnValue(false);
  signFyndUrlMock.mockReset().mockResolvedValue(null);
  createFyndClientOrErrorMock
    .mockReset()
    .mockResolvedValue({ ok: false, reason: "not_configured" });
});

describe("app.returns.$id loader", () => {
  it("400s when id param is missing", async () => {
    await expect(
      loader({ request: mkReq(""), params: {}, context: {} } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404s when shop is not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await expect(
      loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("404s when return case is not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    await expect(
      loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("500s when DB throws while fetching the return case", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("manual return path: skips Shopify order resolution entirely", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:abc-001", shopifyOrderName: "manual-001" }),
    );

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(fetchOrderMock).not.toHaveBeenCalled();
    expect(fetchOrderByFyndAffiliateIdMock).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      isManualReturn: true,
      shopifyOrder: null,
      shopDomain: "store.myshopify.com",
    });
  });

  it("fast path: GID-prefixed shopifyOrderId hits fetchOrder once", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/1234", shopifyOrderName: "#1001" }),
    );
    const order = {
      id: "gid://shopify/Order/1234",
      name: "#1001",
      email: "buyer@example.com",
      shippingAddress: null,
      fulfillments: [],
      paymentGatewayNames: [],
      currencyCode: "USD",
    };
    fetchOrderMock.mockResolvedValueOnce(order);

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(fetchOrderMock).toHaveBeenCalledTimes(1);
    expect(fetchOrderMock).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/1234");
    expect(fetchOrderByFyndAffiliateIdMock).not.toHaveBeenCalled();
    expect(data.shopifyOrder).toEqual(order);
  });

  it("fast path: numeric-only shopifyOrderId also goes through fetchOrder", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "9876543210" }),
    );
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/9876543210", name: "#1002" });

    await loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never);

    expect(fetchOrderMock).toHaveBeenCalledWith(expect.anything(), "9876543210");
    expect(fetchOrderByFyndAffiliateIdMock).not.toHaveBeenCalled();
  });

  it("slow path: non-GID/non-numeric id falls through to candidate search", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "AFF-XYZ", shopifyOrderName: "#1003" }),
    );
    // First candidate (#1003 stripped to "1003") wins
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/555",
      name: "#1003",
    });

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(fetchOrderMock).not.toHaveBeenCalled();
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalled();
    const calls = fetchOrderByFyndAffiliateIdMock.mock.calls.map((c) => c[1]);
    expect(calls).toEqual(expect.arrayContaining(["1003", "AFF-XYZ"]));
    expect(data.shopifyOrder?.id).toBe("gid://shopify/Order/555");
  });

  it("slow path: Fynd affiliate fallback via extractAffiliateOrderIdFromFyndPayload", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "AFF-XYZ",
        shopifyOrderName: null,
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    extractAffiliateOrderIdFromFyndPayloadMock.mockReturnValue("FY-1009");
    // Only the Fynd-derived candidate resolves
    fetchOrderByFyndAffiliateIdMock.mockImplementation(async (_a: unknown, c: string) => {
      if (c === "FY-1009") return { id: "gid://shopify/Order/777", name: "#1009" };
      return null;
    });

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(extractAffiliateOrderIdFromFyndPayloadMock).toHaveBeenCalled();
    expect(data.shopifyOrder?.id).toBe("gid://shopify/Order/777");
  });

  it("slow path: returns null shopifyOrder when every candidate fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "AFF-XYZ", shopifyOrderName: "#1010" }),
    );
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(data.shopifyOrder).toBeNull();
    expect(refundLoggerMock.warn).toHaveBeenCalled();
  });

  it("persists resolved Shopify GID back to the row when it differs", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "AFF-XYZ", shopifyOrderName: "#1004" }),
    );
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/444",
      name: "#1004",
    });

    await loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never);

    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const persistedShopifyId = updateCalls.find(
      (c: unknown[]) =>
        (c[0] as { data?: Record<string, unknown> })?.data?.shopifyOrderId ===
        "gid://shopify/Order/444",
    );
    expect(persistedShopifyId).toBeTruthy();
  });

  it("backfills returnRequestNo when missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "set-1", returnIdConfigJson: null },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ returnRequestNo: null, shopifyOrderId: "manual:x" }),
    );
    buildReturnRequestIdMock.mockReturnValueOnce("RET-NEWLY-MINTED");

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(buildReturnRequestIdMock).toHaveBeenCalled();
    expect(data.returnCase.returnRequestNo).toBe("RET-NEWLY-MINTED");
  });

  it("returns locale defaults (en/USD/UTC) when shopSettings is sparse", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", currency: null }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(data.shopLocale).toBe("en");
    expect(data.shopCurrency).toBe("USD");
    expect(data.shopTimezone).toBe("UTC");
    expect(data.bonusCreditEnabled).toBe(false);
    expect(data.bonusCreditPct).toBe(10);
    expect(data.discountCodeRefundEnabled).toBe(false);
    expect(data.discountCodePrefix).toBe("RETURN");
    expect(data.discountCodeExpiryDays).toBe(90);
  });

  it("uses shopSettings values when present", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", currency: null }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      shopLocale: "fr-CA",
      shopCurrency: "CAD",
      shopTimezone: "America/Toronto",
      bonusCreditEnabled: true,
      bonusCreditPct: 15,
      returnWindowDays: 14,
      refundLocationMode: "manual",
      refundPaymentMethod: "store_credit",
      refundStoreCreditPct: 80,
    });

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(data.shopLocale).toBe("fr-CA");
    expect(data.shopCurrency).toBe("CAD");
    expect(data.shopTimezone).toBe("America/Toronto");
    expect(data.bonusCreditEnabled).toBe(true);
    expect(data.bonusCreditPct).toBe(15);
  });

  it("isRefundEligible: fetches shop locations for non-green approved return", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        status: "approved",
        refundStatus: null,
        shopifyOrderId: "gid://shopify/Order/1",
        isGreenReturn: false,
      }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1",
      fulfillments: [{ location: { id: "loc-1", name: "Main Warehouse" } }],
    });
    fetchAllLocationsMock.mockResolvedValueOnce([
      { id: "loc-1", name: "Main Warehouse", isActive: true },
    ]);

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(fetchAllLocationsMock).toHaveBeenCalled();
    expect(data.shopLocations).toHaveLength(1);
    expect(data.fulfillmentLocationId).toBe("loc-1");
    expect(data.fulfillmentLocationName).toBe("Main Warehouse");
  });

  it("does NOT fetch locations for green returns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        status: "approved",
        refundStatus: null,
        shopifyOrderId: "gid://shopify/Order/1",
        isGreenReturn: true,
      }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1",
      fulfillments: [],
    });

    await loader({ request: mkReq("rc-1"), params: { id: "rc-1" }, context: {} } as never);

    expect(fetchAllLocationsMock).not.toHaveBeenCalled();
  });

  it("includes customerReturnHistory and pendingCount-style data", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x" }),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-prev", returnRequestNo: "RET-OLD", status: "completed", createdAt: new Date() },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(3);

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(data.customerReturnHistory).toHaveLength(1);
    expect(data.customerReturnCount).toBe(3);
    expect(data.customerEmail).toBe("jane@example.com");
  });

  it("computes daysRemaining from order.processedAt + returnWindowDays", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    // Order processed 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/1" }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1",
      processedAt: fiveDaysAgo,
    });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      returnWindowDays: 30,
    });

    const data = await loader({
      request: mkReq("rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);

    expect(data.daysRemaining).toBeGreaterThan(20);
    expect(data.daysRemaining).toBeLessThanOrEqual(26);
    expect(data.returnDeadline).toBeTruthy();
  });
});
