/**
 * Loader tests for app.reports.tsx — the analytics/reports page. Covers:
 *  - date range filtering (default last_30_days, custom from/to, preset overrides)
 *  - groupBy aggregation across status / reasons / resolution / channels / geo
 *  - currency selection (dominant currency from data vs settings fallback)
 *  - revenue math (refund sum, avg, retained), rate KPIs, period-over-period
 *  - graceful failure paths (DB errors, fraud columns missing, empty data)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));

import { loader } from "../app.reports";

function mkReq(qs = "") {
  return new Request(`https://app.example/app/reports${qs}`);
}

const baseShop = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: {
    id: "s-1",
    shopTimezone: "UTC",
    shopLocale: "en",
    shopCurrency: "USD",
    fyndApplicationId: null,
    fyndCredentials: null,
  },
};

beforeEach(() => {
  // Full reset of implementations (resetPrismaMock only does mockClear, which
  // leaves persistent mockImplementation()s from prior tests in place).
  Object.assign(prismaMock, createPrismaMock());
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  // Default: shop exists with default settings
  prismaMock.shop.findUnique.mockResolvedValue(baseShop);
});

describe("app.reports loader", () => {
  it("returns default empty-state shape when shop has no return data", async () => {
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalReturns).toBe(0);
    expect(data.statusMap).toEqual({});
    expect(data.topReasons).toEqual([]);
    expect(data.error).toBeNull();
    expect(data.range).toBe("last_30_days");
    expect(data.shopCurrency).toBe("USD"); // falls back to settings
  });

  it("creates the shop record on first load if missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce(baseShop);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.shop.create).toHaveBeenCalled();
    expect(data.error).toBeNull();
  });

  it("filters all aggregate queries by the resolved date range (last_30_days default)", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    // The first count() call is total returns within range — assert it has a date window.
    const firstCountCall = prismaMock.returnCase.count.mock.calls[0][0];
    expect(firstCountCall.where).toMatchObject({
      shopId: "shop-1",
      createdAt: { gte: expect.any(Date), lte: expect.any(Date) },
    });
  });

  it("honours an explicit from/to custom range", async () => {
    await loader({
      request: mkReq("?range=custom&from=2025-01-01&to=2025-01-31"),
      params: {}, context: {},
    } as never);
    const firstCountCall = prismaMock.returnCase.count.mock.calls[0][0];
    const gte = firstCountCall.where.createdAt.gte as Date;
    const lte = firstCountCall.where.createdAt.lte as Date;
    expect(gte.getUTCFullYear()).toBe(2025);
    expect(gte.getUTCMonth()).toBe(0);
    expect(lte.getUTCMonth()).toBe(0);
  });

  it("aggregates statusMap from returnCase.groupBy results", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("status")) {
        return [
          { status: "approved", _count: 5 },
          { status: "completed", _count: 2 },
          { status: "rejected", _count: 1 },
          { status: "pending", _count: 3 },
        ] as any;
      }
      return [];
    });
    prismaMock.returnCase.count.mockResolvedValue(11);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.statusMap).toMatchObject({ approved: 5, completed: 2, rejected: 1, pending: 3 });
    // approvedCount = approved + completed
    expect(data.approvedCount).toBe(7);
    // statusChartData is sorted by value desc and capitalised
    expect(data.statusChartData[0]).toMatchObject({ name: "Approved", value: 5 });
  });

  it("builds topReasons from returnItem.groupBy and ignores blank/null reason codes", async () => {
    prismaMock.returnItem.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("reasonCode")) {
        return [
          { reasonCode: "size", _count: 8 },
          { reasonCode: "defect", _count: 3 },
          { reasonCode: "", _count: 2 },     // ignored
          { reasonCode: null, _count: 99 },   // ignored
        ] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.topReasons).toEqual([
      { reason: "size", count: 8 },
      { reason: "defect", count: 3 },
    ]);
  });

  it("aggregates resolutionChartData and computes exchangeConversionRate", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("resolutionType")) {
        return [
          { resolutionType: "refund", _count: 6 },
          { resolutionType: "exchange", _count: 2 },
          { resolutionType: "store_credit", _count: 1 },
          { resolutionType: "replacement", _count: 1 },
        ] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.resolutionChartData.find((d: any) => d.name === "Refund")?.value).toBe(6);
    expect(data.resolutionChartData.find((d: any) => d.name === "Exchange")?.value).toBe(2);
    expect(data.resolvedCount).toBe(10);
    // 2/10 = 20%
    expect(data.exchangeConversionRate).toBe(20);
  });

  it("sums refund amounts from JSON and computes avgRefundAmount + revenueRetainedRate", async () => {
    // Make refunded count match (drives avgRefundAmount)
    prismaMock.returnCase.count.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      // approved + refunded combo
      if (w.refundStatus === "refunded") return 3;
      return 0;
    });
    prismaMock.returnCase.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      // refunded cases for revenue
      if (w.status?.in?.includes("approved") && w.refundJson) {
        return [
          { refundJson: JSON.stringify({ amount: "30.00", method: "card" }), currency: "USD" },
          { refundJson: JSON.stringify({ amount: "60.00", method: "card" }), currency: "USD" },
          { refundJson: JSON.stringify({ amount: "10.00", method: "store_credit" }), currency: "USD" },
          { refundJson: "{not-json", currency: "USD" }, // ignored
        ] as any;
      }
      // retained cases (exchange / store_credit with refundJson)
      if (w.resolutionType?.in?.includes("exchange")) {
        return [
          { refundJson: JSON.stringify({ amount: "100.00" }) },
        ] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalRefundAmount).toBeCloseTo(100, 2);
    expect(data.avgRefundAmount).toBeCloseTo(100 / 3, 2);
    // retained 100 vs refund 100 -> 50%
    expect(data.revenueRetainedRate).toBe(50);
    // Refund method breakdown
    expect(data.refundMethodBreakdown[0].method).toBe("card");
    expect(data.refundMethodBreakdown[0].count).toBe(2);
  });

  it("uses the dominant currency from data when present (overrides shop settings)", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("currency")) {
        return [{ currency: "EUR", _count: 12 }] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.shopCurrency).toBe("EUR");
  });

  it("falls back to shop settings currency when no return data has currency", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      ...baseShop,
      settings: { ...baseShop.settings, shopCurrency: "GBP" },
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.shopCurrency).toBe("GBP");
  });

  it("merges title-grouped + sku-grouped products and sorts by count desc", async () => {
    prismaMock.returnItem.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("title")) {
        return [
          { title: "Hat", _count: { title: 3 } },
          { title: "Shoe", _count: { title: 7 } },
        ] as any;
      }
      if (args.by?.includes("sku")) {
        return [
          { sku: "ABC", _count: { sku: 5 } },
        ] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.topProductsData).toEqual([
      { title: "Shoe", count: 7 },
      { title: "SKU ABC", count: 5 },
      { title: "Hat", count: 3 },
    ]);
  });

  it("computes geoData from customerCountry groupBy and filters blanks", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("customerCountry")) {
        return [
          { customerCountry: "US", _count: 10 },
          { customerCountry: "CA", _count: 4 },
          { customerCountry: "  ", _count: 1 }, // filtered (blank)
        ] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.geoData).toEqual([
      { country: "US", count: 10 },
      { country: "CA", count: 4 },
    ]);
  });

  it("computes channel attribution from createdByChannel + sourceChannel groupBys", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("createdByChannel")) {
        return [{ createdByChannel: "portal", _count: 9 }] as any;
      }
      if (args.by?.includes("sourceChannel")) {
        return [{ sourceChannel: "web", _count: 9 }] as any;
      }
      return [];
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.createdByChannelData).toEqual([{ channel: "portal", count: 9 }]);
    expect(data.sourceChannelData).toEqual([{ channel: "web", count: 9 }]);
  });

  it("computes period-over-period change vs previous equal-length window", async () => {
    let nthCall = 0;
    prismaMock.returnCase.count.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      // The period-prev-window query uses createdAt: { gte, lt } (lt, not lte)
      if (w?.createdAt?.lt && !w?.createdAt?.lte) return 4;
      // The very first call is total returns
      nthCall++;
      if (nthCall === 1) return 8;
      return 0;
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    // (8 - 4) / 4 * 100 = 100
    expect(data.totalReturns).toBe(8);
    expect(data.periodChange).toBe(100);
  });

  it("tolerates fraud-risk column failure and returns 0 fraudAlertCount", async () => {
    // Throw on the fraud-specific count() calls (those with fraudRiskLevel in where)
    const realCount = prismaMock.returnCase.count.getMockImplementation() as ((args: unknown) => unknown) | undefined;
    prismaMock.returnCase.count.mockImplementation(async (args: any) => {
      if (args?.where?.fraudRiskLevel) throw new Error("column does not exist");
      return realCount ? await realCount(args) : 0;
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.fraudAlertCount).toBe(0);
    expect(data.error).toBeNull();
    warnSpy.mockRestore();
  });

  it("returns the safe error-state payload when the loader body throws", async () => {
    // Force an unexpected throw deep in the pipeline. Use Once so the
    // rejected implementation does not leak into subsequent tests.
    prismaMock.returnCase.count.mockRejectedValueOnce(new Error("DB down"));
    // The Promise.all that triggers it has 15+ count calls — make all of them
    // reject so the catch block fires on whichever resolves first.
    prismaMock.returnCase.count.mockImplementation(async () => {
      throw new Error("DB down");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.error).toMatch(/Failed to load reports/i);
    expect(data.totalReturns).toBe(0);
    expect(data.statusMap).toEqual({});
    expect(data.shopCurrency).toBe("USD");
    errSpy.mockRestore();
    // Restore default so later tests aren't poisoned.
    prismaMock.returnCase.count.mockReset();
    prismaMock.returnCase.count.mockResolvedValue(0);
  });

  it("flags hasFyndConfig=true only when both Fynd applicationId and credentials are set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      ...baseShop,
      settings: {
        ...baseShop.settings,
        fyndApplicationId: "app-123",
        fyndCredentials: "encrypted-blob",
      },
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.hasFyndConfig).toBe(true);
  });
});
