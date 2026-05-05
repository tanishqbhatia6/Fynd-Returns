/**
 * Loader + action tests for app.settings.return-settings.tsx — the giant
 * "return settings" form covering no-return periods, restricted tags,
 * refund routing, Fynd gates, scheduled reports, gift returns, etc.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  findOrCreateShopMock,
  fetchAllLocationsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  fetchAllLocationsMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchAllLocations: fetchAllLocationsMock,
}));

import { loader, action } from "../app.settings.return-settings";

function formReq(form: Record<string, string | string[]>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) {
      for (const item of v) fd.append(k, item);
    } else {
      fd.append(k, v);
    }
  }
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: {} as unknown,
  });
  findOrCreateShopMock.mockReset();
  fetchAllLocationsMock.mockReset().mockResolvedValue([]);
});

describe("loader", () => {
  it("returns defaults when shop has no settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.noReturnPeriodEnabled).toBe(false);
    expect(data.noReturnPeriodStart).toBe("");
    expect(data.noReturnPeriodEnd).toBe("");
    expect(data.restrictedProductTags).toEqual([]);
    expect(data.photoRequired).toBe(false);
    expect(data.returnFeeAmount).toBe("0");
    expect(data.returnFeeCurrency).toBe("USD");
    expect(data.refundLocationMode).toBe("auto");
    expect(data.refundPaymentMethod).toBe("original");
    expect(data.refundStoreCreditPct).toBe(100);
    expect(data.discountCodePrefix).toBe("RETURN");
    expect(data.discountCodeExpiryDays).toBe(90);
    expect(data.portalAllowedFulfillmentStatuses).toEqual(["FULFILLED", "PARTIALLY_FULFILLED"]);
    expect(data.allowedFyndStatusesForRefund).toEqual([]);
    expect(data.allowedFyndStatusesForReturn).toEqual([]);
    expect(data.refundGatePreset).toBe("none");
    expect(data.scheduledReportFrequency).toBe("weekly");
    expect(data.scheduledReportDay).toBe(1);
  });

  it("returns persisted settings and serializes dates as YYYY-MM-DD", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        noReturnPeriodEnabled: true,
        noReturnPeriodStart: new Date("2025-12-20T00:00:00.000Z"),
        noReturnPeriodEnd: new Date("2025-12-31T00:00:00.000Z"),
        restrictedProductTagsJson: JSON.stringify(["final-sale", "gift"]),
        photoRequired: true,
        returnFeeAmount: 5.5,
        returnFeeCurrency: "EUR",
        autoApproveEnabled: true,
        autoRefundEnabled: false,
        refundLocationMode: "manual",
        refundLocationId: "gid://shopify/Location/123",
        refundPaymentMethod: "store_credit",
        refundStoreCreditPct: 80,
        discountCodeRefundEnabled: true,
        discountCodePrefix: "BACK",
        discountCodeExpiryDays: 60,
        portalExchangeEnabled: true,
        portalAllowedFulfillmentStatuses: JSON.stringify(["FULFILLED"]),
        fyndConsolidateReturns: true,
        fyndConsolidateWindowHours: 8,
        syncRefundToFynd: true,
        allowedFyndStatusesForRefund: JSON.stringify(["delivered"]),
        refundGatePreset: "after_delivery",
        allowedFyndStatusesForReturn: JSON.stringify(["return_initiated"]),
        scheduledReportEnabled: true,
        scheduledReportFrequency: "monthly",
        scheduledReportDay: 15,
        scheduledReportEmails: "ops@x.com",
        giftReturnsEnabled: true,
        greenReturnsDonateEnabled: true,
        greenReturnsDonateMessage: "We donate items",
      },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.noReturnPeriodEnabled).toBe(true);
    expect(data.noReturnPeriodStart).toBe("2025-12-20");
    expect(data.noReturnPeriodEnd).toBe("2025-12-31");
    expect(data.restrictedProductTags).toEqual(["final-sale", "gift"]);
    expect(data.photoRequired).toBe(true);
    expect(data.returnFeeAmount).toBe("5.5");
    expect(data.returnFeeCurrency).toBe("EUR");
    expect(data.refundLocationMode).toBe("manual");
    expect(data.refundLocationId).toBe("gid://shopify/Location/123");
    expect(data.portalAllowedFulfillmentStatuses).toEqual(["FULFILLED"]);
    expect(data.allowedFyndStatusesForRefund).toEqual(["delivered"]);
    expect(data.refundGatePreset).toBe("after_delivery");
    expect(data.allowedFyndStatusesForReturn).toEqual(["return_initiated"]);
    expect(data.scheduledReportFrequency).toBe("monthly");
    expect(data.scheduledReportDay).toBe(15);
    expect(data.giftReturnsEnabled).toBe(true);
    expect(data.greenReturnsDonateMessage).toBe("We donate items");
  });

  it("falls back to defaults when JSON columns are malformed", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        portalAllowedFulfillmentStatuses: "{not-valid-json",
        allowedFyndStatusesForRefund: "broken",
        allowedFyndStatusesForReturn: "also-broken",
        refundGatePreset: null,
      },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.portalAllowedFulfillmentStatuses).toEqual(["FULFILLED", "PARTIALLY_FULFILLED"]);
    expect(data.allowedFyndStatusesForRefund).toEqual([]);
    expect(data.allowedFyndStatusesForReturn).toEqual([]);
    // refundGatePreset: when not set, infers from statuses (which fail to parse → "none")
    expect(data.refundGatePreset).toBe("none");
  });

  it("survives fetchAllLocations failure (non-fatal)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    fetchAllLocationsMock.mockRejectedValueOnce(new Error("scope missing"));
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.shopLocations).toEqual([]);
  });

  it("returns shopLocations when admin call succeeds", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    fetchAllLocationsMock.mockResolvedValueOnce([
      { id: "gid://shopify/Location/1", name: "Main" },
    ]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.shopLocations).toHaveLength(1);
    expect(data.shopLocations[0]).toMatchObject({ name: "Main" });
  });
});

describe("action", () => {
  it("persists basic settings with defaults when fields omitted", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledTimes(1);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ shopId: "shop-1" });
    expect(args.create.noReturnPeriodEnabled).toBe(false);
    expect(args.create.photoRequired).toBe(false);
    expect(args.create.returnFeeAmount).toBe(0);
    expect(args.create.returnFeeCurrency).toBe("USD");
    expect(args.create.refundLocationMode).toBe("auto");
    expect(args.create.refundPaymentMethod).toBe("original");
    expect(args.create.refundStoreCreditPct).toBe(100);
    expect(args.create.discountCodePrefix).toBe("RETURN");
    expect(args.create.discountCodeExpiryDays).toBe(90);
    expect(args.create.refundGatePreset).toBe("none");
    expect(args.create.allowedFyndStatusesForRefund).toBeNull();
    expect(args.create.allowedFyndStatusesForReturn).toBeNull();
    // Default fulfillment statuses should be persisted as JSON
    expect(JSON.parse(args.create.portalAllowedFulfillmentStatuses)).toEqual([
      "FULFILLED",
      "PARTIALLY_FULFILLED",
    ]);
  });

  it("clamps returnFeeAmount to 0 minimum and clamps storeCreditPct to 0..100", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnFeeAmount: "-99",
        refundStoreCreditPct: "250",
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.returnFeeAmount).toBe(0);
    expect(args.create.refundStoreCreditPct).toBe(100);
  });

  it("clamps refundStoreCreditPct lower bound to 0 and parses returnFeeAmount float", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnFeeAmount: "12.34",
        refundStoreCreditPct: "-5",
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.returnFeeAmount).toBeCloseTo(12.34);
    expect(args.create.refundStoreCreditPct).toBe(0);
  });

  it("rejects no-return period when end is before start", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({
        noReturnPeriodEnabled: "on",
        noReturnPeriodStart: "2025-12-31",
        noReturnPeriodEnd: "2025-12-01",
      }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({
      success: false,
      error: "No-return period end date must be after the start date.",
    });
    expect(prismaMock.shopSettings.upsert).not.toHaveBeenCalled();
  });

  it("accepts no-return period when start <= end", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({
        noReturnPeriodEnabled: "on",
        noReturnPeriodStart: "2025-12-01",
        noReturnPeriodEnd: "2025-12-31",
      }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.noReturnPeriodEnabled).toBe(true);
    expect(args.create.noReturnPeriodStart).toBeInstanceOf(Date);
    expect(args.create.noReturnPeriodEnd).toBeInstanceOf(Date);
  });

  it("tolerates malformed restrictedProductTagsJson (keeps existing)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ restrictedProductTagsJson: "{not-json" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    // tagsStr remains undefined → create receives undefined; update uses ?? undefined
    expect(args.create.restrictedProductTagsJson).toBeUndefined();
    expect(args.update.restrictedProductTagsJson).toBeUndefined();
  });

  it("serializes valid restrictedProductTagsJson array", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        restrictedProductTagsJson: JSON.stringify(["final-sale", "clearance"]),
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(JSON.parse(args.create.restrictedProductTagsJson)).toEqual([
      "final-sale",
      "clearance",
    ]);
  });

  it("falls back to default fyndConsolidateWindowHours when invalid", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ fyndConsolidateWindowHours: "999" }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.fyndConsolidateWindowHours).toBe(4);
  });

  it("accepts allowed fyndConsolidateWindowHours value (8)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ fyndConsolidateWindowHours: "8" }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.fyndConsolidateWindowHours).toBe(8);
  });

  it("refundGatePreset=none nullifies allowedFyndStatusesForRefund", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        refundGatePreset: "none",
        allowedFyndStatusesForRefund: ["delivered", "qc_passed"],
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.refundGatePreset).toBe("none");
    expect(args.create.allowedFyndStatusesForRefund).toBeNull();
  });

  it("refundGatePreset=custom uses lowercased trimmed multi-select values", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        refundGatePreset: "custom",
        allowedFyndStatusesForRefund: ["  Delivered  ", "QC_Passed", ""],
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.refundGatePreset).toBe("custom");
    expect(JSON.parse(args.create.allowedFyndStatusesForRefund)).toEqual([
      "delivered",
      "qc_passed",
    ]);
  });

  it("refundGatePreset=after_delivery computes allowed statuses from preset", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ refundGatePreset: "after_delivery" }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.refundGatePreset).toBe("after_delivery");
    // preset returns a non-null statuses string (real lib output)
    expect(typeof args.create.allowedFyndStatusesForRefund).toBe("string");
    const parsed = JSON.parse(args.create.allowedFyndStatusesForRefund);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("portalAllowedFulfillmentStatuses uses provided multi-select values", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        portalAllowedFulfillmentStatuses: ["FULFILLED", "IN_PROGRESS"],
      }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(JSON.parse(args.create.portalAllowedFulfillmentStatuses)).toEqual([
      "FULFILLED",
      "IN_PROGRESS",
    ]);
  });

  it("clamps scheduledReportDay to 1..28", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ scheduledReportDay: "99" }),
      params: {}, context: {},
    } as never);
    const args = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(args.create.scheduledReportDay).toBe(28);
  });

  it("returns success:false with error message when DB throws", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({
      request: formReq({}),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: false, error: "DB unavailable" });
  });
});
