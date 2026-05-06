/**
 * Final coverage-closure loader tests for app/routes/app.returns.$id.tsx.
 *
 * Targets the residual uncovered loader branches that the existing
 * `app.returns.id.loader.test.ts` and `app.returns.id.loader-deep.test.ts`
 * suites skip:
 *   - Line 431: buildTrackingUrlFromCourierAndAwb fallback (rTrackingUrl
 *     missing, effective carrier+awb derived from existing returnLabelJson)
 *   - Lines 606-607: signFyndUrl Promise.all .catch() rejection branches
 *     (label and invoice both reject — both resolved to null)
 *
 * NODE env (no jsdom). Uses the same mocking shape as
 * app.returns.id.loader-deep.test.ts.
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
  buildReturnRequestIdMock: vi.fn(() => "RET-CLO-1"),
  formatReturnRequestIdMock: vi.fn((id: string) => id),
  nextReturnIdCounterMock: vi.fn(async () => 1),
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
    id: "rc-clo",
    shopId: "shop-1",
    status: "approved",
    refundStatus: null,
    shopifyOrderId: "manual:x",
    shopifyOrderName: "#1234",
    returnRequestNo: "RET-CLO-1",
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

function runLoader(id = "rc-clo", search = "") {
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
  buildReturnRequestIdMock.mockReset().mockReturnValue("RET-CLO-1");
  formatReturnRequestIdMock.mockReset().mockImplementation((id: string) => id);
  nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
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

describe("app.returns.$id loader — coverage closure", () => {
  it("derives effCarrier+effAwb from existing returnLabelJson when Fynd response is missing them (line 431)", async () => {
    // Returned shipment has neither carrier nor AWB nor trackingUrl,
    // so the loader falls back to the JSON.parse of the stored returnLabelJson.
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        shopifyOrderName: "#7777",
        fyndShipmentId: "SHIP-X",
        fyndPayloadJson: '{"shipments":[]}',
        returnLabelJson: JSON.stringify({ carrier: "ExistingDart", trackingNumber: "EX-123" }),
      }),
    );
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "set-1",
      shopId: "shop-1",
      fyndCompanyId: "co",
      fyndApplicationId: "app",
      fyndCredentials: "creds",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({
          items: [{
            journey_type: "return",
            // no awb/carrier in returned shipment, no tracking_url either
            status: "return_initiated",
          }],
        }),
      },
    });
    buildTrackingUrlFromCourierAndAwbMock.mockReturnValue("https://built.example/EX-123");

    const data = await runLoader();
    expect(buildTrackingUrlFromCourierAndAwbMock).toHaveBeenCalledWith("ExistingDart", "EX-123");
    const rl = data.returnCase.returnLabelJson ? JSON.parse(data.returnCase.returnLabelJson as string) : null;
    expect(rl?.trackingUrl).toBe("https://built.example/EX-123");
  });

  it("recovers from signFyndUrl rejection for both label and invoice (lines 606-607 catch branches)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "set-1" } });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:x",
        returnLabelJson: JSON.stringify({
          labelUrl: "https://hdn-1.fynd.example/label.pdf",
          invoiceUrl: "https://hdn-1.fynd.example/inv.pdf",
          signedAt: 0,
          signedInvoiceAt: 0,
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
      .mockRejectedValueOnce(new Error("label signing failed"))
      .mockRejectedValueOnce(new Error("invoice signing failed"));

    const data = await runLoader();
    // Both rejections caught -> returnLabelInfo has no signed URLs added
    expect(data.returnLabelInfo?.signedLabelUrl).toBeUndefined();
    expect((data.returnLabelInfo as Record<string, unknown>)?.signedInvoiceUrl).toBeUndefined();
    // Loader still returns shop data (no crash)
    expect(data.shopDomain).toBe("store.myshopify.com");
  });
});
