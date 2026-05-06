/**
 * Deep loader tests for app/routes/app.returns.$id.tsx — exercises the long
 * tail of branches in the ~540-line loader that the existing
 * app.returns.id.loader.test.ts skims past:
 *   - Fynd shipment fetch + label/invoice merge (createFyndClientOrError)
 *   - Forward AWB auto-population from extractShippingDetailsFromFyndPayload
 *   - returnLabelJson cleanup (forward shipment data incorrectly stored
 *     as return label)
 *   - Customer enrichment from BOTH Shopify order and Fynd payload
 *   - signFyndUrl branch for return label + forward shipment URLs
 *   - parseFyndPayloadForDisplay / parseFyndOrderDetailsForTab return-shape
 *     wiring + shipment filter by fyndShipmentId
 *   - Auto-heal stale fyndSyncStatus = "processing" when real shipment
 *     data exists
 *   - Forward AWB cleanup when stored value is a Fynd ID
 *   - Blocklist check (email + phone)
 *   - allowedFyndStatusesForRefund + refundGatePreset return shape
 *   - buildTrackingUrlFromCourierAndAwb for existing carrier/AWB
 *   - returnRequestNo backfill via sequential counter path
 *
 * All tests run in NODE env (no jsdom) and call the loader function
 * directly with mocked dependencies — no React rendering happens here.
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
  fetchAllLocationsMock: vi.fn<(...args: unknown[]) => Promise<Array<{ id: string; name: string; isActive: boolean }>>>(async () => []),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "hash", prefix: "RET" })),
  buildReturnRequestIdMock: vi.fn(() => "RET-ABC123"),
  formatReturnRequestIdMock: vi.fn((id: string) => id),
  nextReturnIdCounterMock: vi.fn(async () => 42),
  parseFyndPayloadForDisplayMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  parseFyndOrderDetailsForTabMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  getPickupAddressFromFyndPayloadMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  extractFyndJourneyMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
  extractCustomerFromFyndPayloadMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  extractShippingDetailsFromFyndPayloadMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  extractAffiliateOrderIdFromFyndPayloadMock: vi.fn<(...args: unknown[]) => string | null>(() => null),
  isLikelyFyndIdMock: vi.fn<(v?: unknown) => boolean>(() => false),
  buildTrackingUrlFromCourierAndAwbMock: vi.fn<(...args: unknown[]) => string | null>(() => null),
  isFyndPrivateUrlMock: vi.fn<(...args: unknown[]) => boolean>(() => false),
  signFyndUrlMock: vi.fn<(s: unknown, url?: string) => Promise<unknown>>(async () => null),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, reason: "not_configured" })),
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

function mkReq(id: string, search = "") {
  return new Request(`https://app.example/app/returns/${id}${search}`);
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
    customerAddress1: null,
    customerAddress2: null,
    customerProvince: null,
    customerZip: null,
    fyndPayloadJson: null,
    returnLabelJson: null,
    forwardAwb: null,
    returnAwb: null,
    fyndShipmentId: null,
    fyndCurrentStatus: null,
    fyndSyncStatus: null,
    fyndReturnId: null,
    isGreenReturn: false,
    items: [],
    events: [],
    orderProcessedAt: null,
    currency: "USD",
    resolutionType: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function runLoader(id = "rc-1", search = "") {
  return loader({
    request: mkReq(id, search),
    params: { id },
    context: {},
  } as never);
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
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, reason: "not_configured" });
});

describe("app.returns.$id loader — deep coverage", () => {
  it("404s when return case is not found (control)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    await expect(runLoader()).rejects.toMatchObject({ status: 404 });
  });

  it("backfills returnRequestNo via nextReturnIdCounter when bodyMode is sequential", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "set-1", returnIdConfigJson: '{"bodyMode":"sequential"}' },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ returnRequestNo: null, shopifyOrderId: "manual:x" }),
    );
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "sequential", prefix: "RET" });
    nextReturnIdCounterMock.mockResolvedValueOnce(7);
    buildReturnRequestIdMock.mockReturnValueOnce("RET-007");

    const data = await runLoader();
    expect(nextReturnIdCounterMock).toHaveBeenCalledWith("set-1");
    expect(data.returnCase.returnRequestNo).toBe("RET-007");
  });

  it("backfills returnRequestNo with date_sequential bodyMode", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "set-1", returnIdConfigJson: null },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ returnRequestNo: null, shopifyOrderId: "manual:x" }),
    );
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "date_sequential", prefix: "RET" });
    nextReturnIdCounterMock.mockResolvedValueOnce(99);

    await runLoader();
    expect(nextReturnIdCounterMock).toHaveBeenCalled();
  });

  it("swallows error when returnRequestNo backfill update fails (non-fatal)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "set-1", returnIdConfigJson: null },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ returnRequestNo: null, shopifyOrderId: "manual:x" }),
    );
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("update failed"));

    // Should still return a valid loader result despite the failed backfill
    const data = await runLoader();
    expect(data.shopDomain).toBe("store.myshopify.com");
  });

  it("falls through slow path when fast-path fetchOrder throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/1234" }),
    );
    fetchOrderMock.mockRejectedValueOnce(new Error("boom"));

    const data = await runLoader();
    expect(data.shopifyOrder).toBeNull();
  });

  it("merges customer info from Shopify shippingAddress when fields are missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "gid://shopify/Order/1",
        customerName: null,
        customerEmailNorm: null,
        customerCity: null,
      }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1",
      email: "Buyer@Example.COM",
      phone: "+1-555-0100",
      shippingAddress: {
        firstName: "John",
        lastName: "Doe",
        city: "Vancouver",
        country: "CA",
        address1: "123 Main",
        address2: "Apt 4",
        province: "BC",
        zip: "V6B1A1",
      },
      fulfillments: [],
    });

    const data = await runLoader();
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const enrichCall = updateCalls.find((c: unknown[]) => {
      const data = (c[0] as { data?: Record<string, unknown> })?.data;
      return data && (data.customerName || data.customerCity);
    });
    expect(enrichCall).toBeTruthy();
    expect(data.shopifyOrder?.email).toBe("Buyer@Example.COM");
  });

  it("merges customer info from Fynd payload when Shopify order is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        customerName: null,
        customerEmailNorm: null,
        customerCity: null,
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    extractCustomerFromFyndPayloadMock.mockReturnValueOnce({
      name: "Fynd User",
      email: "FYND@USER.COM",
      phone: "+91-1111",
      city: "Mumbai",
      country: "IN",
      address1: "Bandra",
      address2: null,
      province: "MH",
      zip: "400050",
    });

    await runLoader();
    expect(extractCustomerFromFyndPayloadMock).toHaveBeenCalled();
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const enrich = updateCalls.find((c: unknown[]) => {
      const d = (c[0] as { data?: Record<string, unknown> })?.data;
      return d && d.customerCity === "Mumbai";
    });
    expect(enrich).toBeTruthy();
  });

  it("auto-populates forwardAwb from Fynd shipping details when not a Fynd ID", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndPayloadJson: '{"shipments":[]}',
        forwardAwb: null,
      }),
    );
    extractShippingDetailsFromFyndPayloadMock.mockReturnValueOnce({
      trackingNumber: "AWB-REAL-123",
      carrier: "BlueDart",
    });
    isLikelyFyndIdMock.mockImplementation(() => false);

    await runLoader();
    const updates = prismaMock.returnCase.update.mock.calls;
    const awbUpdate = updates.find(
      (c: unknown[]) => (c[0] as { data?: { forwardAwb?: string } })?.data?.forwardAwb === "AWB-REAL-123",
    );
    expect(awbUpdate).toBeTruthy();
  });

  it("does NOT auto-populate forwardAwb when tracking is a Fynd ID", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndPayloadJson: '{"shipments":[]}',
        forwardAwb: null,
      }),
    );
    extractShippingDetailsFromFyndPayloadMock.mockReturnValueOnce({
      trackingNumber: "FYND-INTERNAL-99",
    });
    isLikelyFyndIdMock.mockImplementation((v: unknown) => v === "FYND-INTERNAL-99");

    await runLoader();
    const updates = prismaMock.returnCase.update.mock.calls;
    const awbUpdate = updates.find(
      (c: unknown[]) => (c[0] as { data?: { forwardAwb?: string } })?.data?.forwardAwb === "FYND-INTERNAL-99",
    );
    expect(awbUpdate).toBeFalsy();
  });

  it("clears returnLabelJson when source=fynd and trackingNumber duplicates forwardAwb", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        forwardAwb: "AWB-DUP-1",
        returnLabelJson: JSON.stringify({ source: "fynd", trackingNumber: "AWB-DUP-1" }),
      }),
    );

    const data = await runLoader();
    expect(data.returnCase.returnLabelJson).toBeNull();
  });

  it("preserves returnLabelJson when JSON.parse throws (corrupt JSON)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        returnLabelJson: "{not-valid-json",
      }),
    );

    const data = await runLoader();
    // Corrupt JSON is left as-is, no crash
    expect(data.returnCase.returnLabelJson).toBe("{not-valid-json");
  });

  it("filters fyndOrderDetailsTab.shipments by fyndShipmentId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndShipmentId: "SHIP-2",
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [
        { shipmentId: "SHIP-1", journeyType: "forward", cpName: "BD", shipmentStatus: "delivered" },
        { shipmentId: "SHIP-2", journeyType: "forward", cpName: "BD", shipmentStatus: "delivered" },
        { shipmentId: "SHIP-3", journeyType: "return" },
      ],
    });

    const data = await runLoader();
    expect(data.fyndOrderDetailsTab?.shipments).toBeTruthy();
    // Re-parsed final filter retains target + return shipments
    const ids = (data.fyndOrderDetailsTab?.shipments ?? []).map((s: { shipmentId?: string }) => s.shipmentId);
    expect(ids).toContain("SHIP-2");
    expect(ids).not.toContain("SHIP-1");
  });

  it("calls Fynd searchShipments when return label is incomplete + shipmentId is set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        shopifyOrderName: "#1234",
        fyndShipmentId: "SHIP-A",
        fyndPayloadJson: '{"shipments":[]}',
        returnLabelJson: null,
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co-1",
      fyndApplicationId: "app-1",
      fyndCredentials: "creds",
    });
    const searchShipmentsByExternalOrderIdMock = vi.fn().mockResolvedValue({
      items: [
        {
          journey_type: "return",
          delivery_partner_details: { display_name: "Delhivery", awb_no: "AWB-RET-XYZ" },
          status: "return_initiated",
          tracking_url: "https://track.example/AWB-RET-XYZ",
          invoice: { label_url: "https://label.example/x.pdf", invoice_url: "https://inv.example/x.pdf" },
          meta: {},
        },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsByExternalOrderIdMock },
    });
    isLikelyFyndIdMock.mockReturnValue(false);

    const data = await runLoader();
    expect(searchShipmentsByExternalOrderIdMock).toHaveBeenCalledWith("1234", expect.any(Object));
    // returnLabelJson should now be merged with rCarrier/rAwb/rTrackingUrl
    const rl = data.returnCase.returnLabelJson ? JSON.parse(data.returnCase.returnLabelJson as string) : null;
    expect(rl?.carrier).toBe("Delhivery");
    expect(rl?.trackingNumber).toBe("AWB-RET-XYZ");
  });

  it("survives Fynd searchShipments rejection without crashing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        shopifyOrderName: "#1234",
        fyndShipmentId: "SHIP-A",
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co-1",
      fyndApplicationId: "app-1",
      fyndCredentials: "creds",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockRejectedValue(new Error("network down")),
      },
    });

    const data = await runLoader();
    expect(data.shopDomain).toBe("store.myshopify.com");
  });

  it("uses returnSearchRes.shipments fallback path when items is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        shopifyOrderName: "#9999",
        fyndShipmentId: "SHIP-B",
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co-1",
      fyndApplicationId: "app-1",
      fyndCredentials: "creds",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({
          shipments: [{ status: "return_initiated", awb_no: "X" }],
        }),
      },
    });
    isLikelyFyndIdMock.mockReturnValue(false);

    const data = await runLoader();
    expect(data.shopDomain).toBe("store.myshopify.com");
  });

  it("uses returnSearchRes.data.items deep fallback path", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        shopifyOrderName: "#5555",
        fyndShipmentId: "SHIP-C",
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co-1",
      fyndApplicationId: "app-1",
      fyndCredentials: "creds",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({
          data: { items: [] },
        }),
      },
    });

    const data = await runLoader();
    expect(data.shopDomain).toBe("store.myshopify.com");
  });

  it("skips Fynd fetch when no fyndShipmentId is set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", fyndShipmentId: null }),
    );

    await runLoader();
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("skips Fynd fetch when both return label + forward shipment are complete", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndShipmentId: "SHIP-A",
        fyndPayloadJson: '{"shipments":[]}',
        returnLabelJson: JSON.stringify({ trackingUrl: "u", labelUrl: "l" }),
      }),
    );
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [{ shipmentId: "SHIP-A", journeyType: "forward", cpName: "BD", shipmentStatus: "delivered" }],
    });

    await runLoader();
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("builds tracking URL from existing carrier+AWB when trackingUrl is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        returnLabelJson: JSON.stringify({ carrier: "BlueDart", trackingNumber: "BD-123" }),
      }),
    );
    buildTrackingUrlFromCourierAndAwbMock.mockReturnValue("https://bluedart.example/BD-123");

    const data = await runLoader();
    const rl = JSON.parse(data.returnCase.returnLabelJson as string);
    expect(rl.trackingUrl).toBe("https://bluedart.example/BD-123");
  });

  it("auto-heals stale fyndSyncStatus=processing when real shipment data exists", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndShipmentId: "S1",
        fyndPayloadJson: '{"shipments":[]}',
        fyndSyncStatus: "processing",
        returnLabelJson: JSON.stringify({ trackingUrl: "u", labelUrl: "l" }),
      }),
    );
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [{ shipmentId: "S1", journeyType: "forward", forwardAwb: "REAL-AWB", cpName: "X", shipmentStatus: "y" }],
    });
    isLikelyFyndIdMock.mockReturnValue(false);

    await runLoader();
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const heal = updateCalls.find(
      (c: unknown[]) => (c[0] as { data?: { fyndSyncStatus?: string } })?.data?.fyndSyncStatus === "synced",
    );
    expect(heal).toBeTruthy();
  });

  it("clears forwardAwb when stored value is a Fynd ID", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        forwardAwb: "FYND-123",
      }),
    );
    isLikelyFyndIdMock.mockImplementation((v: unknown) => v === "FYND-123");

    const data = await runLoader();
    expect(data.displayForwardAwb).toBeNull();
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const cleared = updateCalls.find((c: unknown[]) => {
      const d = (c[0] as { data?: { forwardAwb?: unknown } })?.data;
      return d && d.forwardAwb === null;
    });
    expect(cleared).toBeTruthy();
  });

  it("filters Fynd-id forwardAwb out of fyndOrderDetailsTab.shipments for display", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndPayloadJson: '{"shipments":[]}',
      }),
    );
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [{ shipmentId: "S1", journeyType: "forward", forwardAwb: "FYND-internal" }],
    });
    isLikelyFyndIdMock.mockImplementation((v: unknown) => v === "FYND-internal");

    const data = await runLoader();
    const s0 = (data.fyndOrderDetailsTab?.shipments?.[0] ?? null) as { forwardAwb?: string | null } | null;
    expect(s0?.forwardAwb).toBeNull();
  });

  it("returns isCodOrder=true when paymentGatewayNames contain a COD pattern", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/1" }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["Cash on Delivery"],
      fulfillments: [],
    });

    const data = await runLoader();
    expect(data.isCodOrder).toBe(true);
  });

  it("returns isCodOrder=true when displayFinancialStatus is PENDING", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/2" }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/2",
      paymentGatewayNames: ["stripe"],
      displayFinancialStatus: "PENDING",
      fulfillments: [],
    });

    const data = await runLoader();
    expect(data.isCodOrder).toBe(true);
  });

  it("signs Fynd private label URL when SIGN_TTL has elapsed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        returnLabelJson: JSON.stringify({
          labelUrl: "https://hdn-1.fynd.example/label.pdf",
          invoiceUrl: "https://hdn-1.fynd.example/inv.pdf",
          signedAt: 0,
        }),
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co",
      fyndApplicationId: "app",
      fyndCredentials: "creds",
    });
    isFyndPrivateUrlMock.mockReturnValue(true);
    signFyndUrlMock
      .mockResolvedValueOnce({ signedUrl: "https://signed.example/label?sig=x" })
      .mockResolvedValueOnce({ signedUrl: "https://signed.example/inv?sig=y" });

    const data = await runLoader();
    expect(data.returnLabelInfo?.signedLabelUrl).toBe("https://signed.example/label?sig=x");
    expect((data.returnLabelInfo as Record<string, unknown>)?.signedInvoiceUrl).toBe("https://signed.example/inv?sig=y");
  });

  it("does not sign URLs when shopSettings is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        returnLabelJson: JSON.stringify({ labelUrl: "https://fynd.example/x" }),
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);
    isFyndPrivateUrlMock.mockReturnValue(true);

    const data = await runLoader();
    expect(signFyndUrlMock).not.toHaveBeenCalled();
    expect(data.returnLabelInfo?.signedLabelUrl).toBeUndefined();
  });

  it("signs Fynd private URLs in forward shipment data", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndPayloadJson: '{"shipments":[]}',
        returnLabelJson: JSON.stringify({ trackingUrl: "u", labelUrl: "l" }),
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "c",
      fyndApplicationId: "a",
      fyndCredentials: "x",
    });
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [{
        shipmentId: "S1",
        journeyType: "forward",
        invoiceUrl: "https://hdn-1.fynd/inv.pdf",
        labelUrl: "https://hdn-1.fynd/label.pdf",
        cpName: "BD", shipmentStatus: "delivered",
      }],
    });
    isFyndPrivateUrlMock.mockReturnValue(true);
    signFyndUrlMock.mockImplementation(async (_s: unknown, url?: string) => ({ signedUrl: (url ?? "") + "?sig=ok" }));

    const data = await runLoader();
    const s0 = data.fyndOrderDetailsTab?.shipments?.[0] as Record<string, unknown> | undefined;
    expect(s0?.signedInvoiceUrl).toContain("?sig=ok");
    expect(s0?.signedLabelUrl).toContain("?sig=ok");
  });

  it("returns refundGatePreset and allowedFyndStatusesForRefund parsed from settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x" }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      refundGatePreset: "ai_safe",
      allowedFyndStatusesForRefund: '["return_accepted","refund_initiated"]',
    });

    const data = await runLoader();
    expect(data.refundGatePreset).toBe("ai_safe");
    expect(data.allowedFyndStatusesForRefund).toEqual(["return_accepted", "refund_initiated"]);
  });

  it("handles malformed allowedFyndStatusesForRefund JSON gracefully", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x" }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      allowedFyndStatusesForRefund: "{not-json",
    });

    const data = await runLoader();
    expect(data.allowedFyndStatusesForRefund).toEqual([]);
  });

  it("returns blocklist=true when customer email is blocked", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", customerEmailNorm: "bad@example.com" }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ id: "set-1", shopId: "shop-1" });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({
      id: "bl-1", type: "email", value: "bad@example.com",
    });

    const data = await runLoader();
    expect(data.isBlocklisted).toBe(true);
  });

  it("returns blocklist=false when blocklist query throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x" }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ id: "set-1", shopId: "shop-1" });
    prismaMock.blocklistEntry.findFirst.mockRejectedValueOnce(new Error("DB"));

    const data = await runLoader();
    expect(data.isBlocklisted).toBe(false);
  });

  it("returns blocklist=false when there are no checks (no email + no phone)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", customerEmailNorm: null, customerPhoneNorm: null }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ id: "set-1", shopId: "shop-1" });

    const data = await runLoader();
    expect(data.isBlocklisted).toBe(false);
    expect(prismaMock.blocklistEntry.findFirst).not.toHaveBeenCalled();
  });

  it("checks blocklist by phone when only phone is set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        customerEmailNorm: null,
        customerPhoneNorm: "+15555550100",
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ id: "set-1", shopId: "shop-1" });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce(null);

    await runLoader();
    expect(prismaMock.blocklistEntry.findFirst).toHaveBeenCalled();
  });

  it("returns fyndCurrentStatus from DB column when present", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", fyndCurrentStatus: "return_accepted" }),
    );

    const data = await runLoader();
    expect(data.fyndCurrentStatus).toBe("return_accepted");
  });

  it("falls back to parsing fyndCurrentStatus from JSON payload when DB column is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndCurrentStatus: null,
        fyndPayloadJson: JSON.stringify({ status: "return_initiated" }),
      }),
    );

    const data = await runLoader();
    expect(data.fyndCurrentStatus).toBe("return_initiated");
  });

  it("uses shipment_status fallback when status field is absent in payload", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndCurrentStatus: null,
        fyndPayloadJson: JSON.stringify({ shipment_status: "out_for_pickup" }),
      }),
    );

    const data = await runLoader();
    expect(data.fyndCurrentStatus).toBe("out_for_pickup");
  });

  it("returns null fyndCurrentStatus when payload JSON is corrupt and no DB column", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        fyndCurrentStatus: null,
        fyndPayloadJson: "{not-json",
      }),
    );

    const data = await runLoader();
    expect(data.fyndCurrentStatus).toBeNull();
  });

  it("computes daysRemaining from returnCase.orderProcessedAt when shopifyOrder is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", orderProcessedAt: tenDaysAgo }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1", shopId: "shop-1", returnWindowDays: 30,
    });

    const data = await runLoader();
    expect(data.daysRemaining).not.toBeNull();
    expect(data.returnDeadline).toBeTruthy();
  });

  it("returns null daysRemaining when no order date is available", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", orderProcessedAt: null }),
    );

    const data = await runLoader();
    expect(data.daysRemaining).toBeNull();
    expect(data.returnDeadline).toBeNull();
  });

  it("returns shopCurrency from shopifyOrder.currencyCode when returnCase.currency is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "gid://shopify/Order/1", currency: null }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      currencyCode: "EUR",
      fulfillments: [],
    });

    const data = await runLoader();
    expect(data.shopCurrency).toBe("EUR");
  });

  it("falls back to shopSettings.shopCurrency when both case + order are null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", currency: null }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1", shopId: "shop-1", shopCurrency: "GBP",
    });

    const data = await runLoader();
    expect(data.shopCurrency).toBe("GBP");
  });

  it("returns shopLocations as [] when fetchAllLocations rejects (non-fatal)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        status: "approved",
        shopifyOrderId: "gid://shopify/Order/1",
        isGreenReturn: false,
      }),
    );
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", fulfillments: [] });
    fetchAllLocationsMock.mockRejectedValueOnce(new Error("API limit"));

    const data = await runLoader();
    expect(data.shopLocations).toEqual([]);
  });

  it("propagates Response thrown inside the try block (not wrapped as 500)", async () => {
    // shop=null -> 404 -- already covered. Try unauthenticated path: authenticate throws
    // a Response; the loader should re-throw it untouched.
    const authResponse = new Response("Unauthorized", { status: 302 });
    authenticateMock.mockRejectedValueOnce(authResponse);

    await expect(runLoader()).rejects.toMatchObject({ status: 302 });
  });

  it("wraps unexpected non-Response errors as 500", async () => {
    authenticateMock.mockRejectedValueOnce(new Error("something else"));

    await expect(runLoader()).rejects.toMatchObject({ status: 500 });
  });

  it("returnLabelInfo is null when JSON.parse of returnLabelJson throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", returnLabelJson: "not-json" }),
    );

    const data = await runLoader();
    expect(data.returnLabelInfo).toBeNull();
  });

  it("returns refundLocationMode='auto' when shopSettings is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ status: "approved", shopifyOrderId: "manual:x" }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);

    const data = await runLoader();
    expect(data.refundLocationMode).toBe("auto");
  });

  it("propagates fulfillmentLocation from shopifyOrder when refund-eligible", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ status: "approved", shopifyOrderId: "gid://shopify/Order/9" }),
    );
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9",
      fulfillments: [{ location: { id: "loc-99", name: "DC East" } }],
    });

    const data = await runLoader();
    expect(data.fulfillmentLocationId).toBe("loc-99");
    expect(data.fulfillmentLocationName).toBe("DC East");
  });

  it("returns customerReturnHistory=[] when customerEmailNorm is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", customerEmailNorm: null }),
    );

    const data = await runLoader();
    expect(data.customerReturnHistory).toEqual([]);
  });

  it("returns customerReturnCount=0 when no email/phone is available", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", customerEmailNorm: null }),
    );

    const data = await runLoader();
    expect(data.customerReturnCount).toBe(0);
  });

  it("returns hasRealShipmentData=true when payload shipments include a non-Fynd-id forwardAwb", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", fyndPayloadJson: '{"shipments":[]}' }),
    );
    parseFyndOrderDetailsForTabMock.mockReturnValue({
      shipments: [{ shipmentId: "S1", journeyType: "forward", forwardAwb: "REAL-AWB-1", cpName: "X", shipmentStatus: "Y" }],
    });
    isLikelyFyndIdMock.mockReturnValue(false);

    const data = await runLoader();
    expect(data.hasRealShipmentData).toBe(true);
  });

  it("returns hasRealShipmentData=false when no shipment has a real AWB", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x" }),
    );

    const data = await runLoader();
    expect(data.hasRealShipmentData).toBe(false);
  });

  it("propagates pickupAddress + returnJourney from Fynd helpers", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", fyndPayloadJson: '{"shipments":[]}' }),
    );
    getPickupAddressFromFyndPayloadMock.mockReturnValueOnce({ city: "Pune", country: "IN" });
    extractFyndJourneyMock.mockReturnValueOnce([{ status: "return_initiated", date: "2024-01-01" }]);

    const data = await runLoader();
    expect(data.pickupAddress).toEqual({ city: "Pune", country: "IN" });
    expect(data.returnJourney).toHaveLength(1);
  });

  it("uses fyndPayloadInfo from parseFyndPayloadForDisplay", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({ shopifyOrderId: "manual:x", fyndPayloadJson: '{"shipments":[]}' }),
    );
    parseFyndPayloadForDisplayMock.mockReturnValueOnce({
      shipments: [{ shipmentStatus: "delivered" }],
    });

    const data = await runLoader();
    expect(data.fyndPayloadInfo).toEqual({ shipments: [{ shipmentStatus: "delivered" }] });
  });
});
