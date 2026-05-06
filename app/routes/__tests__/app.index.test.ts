/**
 * Loader tests for app._index.tsx — the merchant dashboard. Covers the
 * core data shape returned to the component (counts, recent returns,
 * top reasons, suggestions, daily trend, fraud alerts) plus the
 * defensive error-fallback path when Prisma misbehaves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, runFyndRetryQueueMock, pollStaleReturnsMock } = vi.hoisted(
  () => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateMock: vi.fn(),
    runFyndRetryQueueMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    pollStaleReturnsMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  }),
);
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd-retry.server", () => ({ runFyndRetryQueue: runFyndRetryQueueMock }));
vi.mock("../../lib/fynd-status-poll.server", () => ({ pollStaleReturns: pollStaleReturnsMock }));

import { loader } from "../app._index";

function mkReq(path = "/app") {
  return new Request(`https://app.example${path}`);
}

function mkShop(overrides: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: {
      id: "s-1",
      shopTimezone: "UTC",
      shopLocale: "en",
      shopCurrency: "USD",
      fyndApplicationId: null,
      fyndCredentials: null,
      ...((overrides.settings as Record<string, unknown>) || {}),
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  runFyndRetryQueueMock.mockReset().mockResolvedValue(undefined);
  pollStaleReturnsMock.mockReset().mockResolvedValue(undefined);
  prismaMock.$queryRaw.mockReset().mockResolvedValue([]);
});

describe("app._index loader", () => {
  it("returns dashboard defaults for a freshly-installed shop with no returns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.totalReturns).toBe(0);
    expect(data.approvedCount).toBe(0);
    expect(data.pendingCount).toBe(0);
    expect(data.refundedCount).toBe(0);
    expect(data.shopDomain).toBe("store.myshopify.com");
    expect(data.error).toBeNull();
    expect(data.suggestions).toEqual([]);
    expect(data.recentReturns).toEqual([]);
    expect(data.topReasons).toEqual([]);
  });

  it("creates a shop record when none exists", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce(mkShop());

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { shopDomain: "store.myshopify.com" } }),
    );
    expect(data.error).toBeNull();
  });

  it("aggregates totals, status map and approvedCount from groupBy", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.count.mockResolvedValueOnce(10); // totalReturns
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 5 },
      { status: "completed", _count: 2 },
      { status: "pending", _count: 3 },
    ]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.totalReturns).toBe(10);
    expect(data.statusMap).toEqual({ approved: 5, completed: 2, pending: 3 });
    expect(data.approvedCount).toBe(7); // approved + completed
  });

  it("returns recent returns ordered desc with up to 8 items", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    const recent = [
      { id: "r1", status: "pending", createdAt: new Date(), items: [] },
      { id: "r2", status: "approved", createdAt: new Date(), items: [] },
    ];
    prismaMock.returnCase.findMany.mockResolvedValueOnce(recent);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.recentReturns).toEqual(recent);
    // Verify the query asked for ordering + limit
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 8,
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("builds topReasons sorted by count, filters blanks, caps at 10", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnItem.groupBy.mockResolvedValueOnce([
      { reasonCode: "wrong_size", _count: 5 },
      { reasonCode: "defective", _count: 8 },
      { reasonCode: "", _count: 99 }, // should be filtered
      { reasonCode: null, _count: 99 }, // should be filtered
      { reasonCode: "changed_mind", _count: 1 },
    ]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.topReasons).toEqual([
      { reason: "defective", count: 8 },
      { reason: "wrong_size", count: 5 },
      { reason: "changed_mind", count: 1 },
    ]);
  });

  it("emits 'pending review' suggestion when pendingCount > 0", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.count
      .mockResolvedValueOnce(5) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(0) // fyndSyncedCount
      .mockResolvedValueOnce(3) // pendingCount
      .mockResolvedValueOnce(0) // rejectedCount
      .mockResolvedValueOnce(5) // allTimeReturns
      .mockResolvedValueOnce(0) // approvedNotRefundedCount
      .mockResolvedValueOnce(0) // greenReturnCount
      .mockResolvedValueOnce(0); // blocklistCount

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.pendingCount).toBe(3);
    const pendingSugg = data.suggestions.find((s) => s.message.includes("pending review"));
    expect(pendingSugg).toBeDefined();
    expect(pendingSugg?.actionUrl).toBe("/app/returns?status=pending");
  });

  it("flags Fynd-not-synced when integration is configured but returns are missing fyndReturnNo", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShop({
        settings: {
          id: "s-1",
          shopTimezone: "UTC",
          shopLocale: "en",
          fyndApplicationId: "app-123",
          fyndCredentials: "creds",
        },
      }),
    );
    prismaMock.returnCase.count
      .mockResolvedValueOnce(5) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(1) // fyndSyncedCount
      .mockResolvedValueOnce(0) // pendingCount
      .mockResolvedValueOnce(0); // rejectedCount
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([{ status: "approved", _count: 3 }]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.hasFyndConfig).toBe(true);
    const fyndSugg = data.suggestions.find((s) => s.message.includes("not synced to Fynd"));
    expect(fyndSugg).toBeDefined();
    expect(fyndSugg?.type).toBe("warning");
  });

  it("computes revenueAtRisk from raw SQL aggregation", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.$queryRaw.mockResolvedValueOnce([{ total: "1234.56" }]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.revenueAtRisk).toBeCloseTo(1234.56, 2);
  });

  it("computes revenueRetained by summing exchange/store_credit refundJson amounts", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    // returnsForDaily, approvedWithEvents, retainedCases, refundedForAmount,
    // fraudAlertReturns are all findMany calls. Override the call that
    // matches retainedCases with non-empty refundJson.
    prismaMock.returnCase.findMany.mockImplementation(
      async (
        args:
          | { where?: { resolutionType?: { in?: string[] } }; select?: { refundJson?: boolean } }
          | undefined,
      ) => {
        if (args?.where?.resolutionType?.in?.includes("exchange")) {
          return [
            { refundJson: JSON.stringify({ amount: "100.00" }) },
            { refundJson: JSON.stringify({ amount: "50.50" }) },
            { refundJson: "not json {{" }, // gracefully skipped
          ];
        }
        return [];
      },
    );

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.revenueRetained).toBeCloseTo(150.5, 2);
  });

  it("computes exchangeRate as a percentage of resolved returns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([]) // returnsByStatus
      .mockResolvedValueOnce([
        { resolutionType: "exchange", _count: 3 },
        { resolutionType: "refund", _count: 7 },
      ]) // resolutionAgg
      .mockResolvedValueOnce([]); // currencyAgg

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // 3 of 10 = 30%
    expect(data.exchangeRate).toBe(30);
    expect(data.resolutionMap).toEqual({ exchange: 3, refund: 7 });
  });

  it("computes avgRefundAmount only over rows with positive amount", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(
      async (args: { where?: { refundStatus?: string } } | undefined) => {
        if (args?.where?.refundStatus === "refunded") {
          return [
            { refundJson: JSON.stringify({ amount: "60" }) },
            { refundJson: JSON.stringify({ amount: "40" }) },
            { refundJson: JSON.stringify({ amount: "0" }) }, // excluded (not >0)
            { refundJson: JSON.stringify({}) }, // excluded (no amount)
          ];
        }
        return [];
      },
    );

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // (60 + 40) / 2 = 50
    expect(data.avgRefundAmount).toBe(50);
    expect(data.totalRefundAmount).toBe(100);
  });

  it("uses dominant currency from actual return data, falling back to settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShop({
        settings: {
          id: "s-1",
          shopCurrency: "USD",
          shopTimezone: "UTC",
          shopLocale: "en",
        },
      }),
    );
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([]) // returnsByStatus
      .mockResolvedValueOnce([]) // resolutionAgg
      .mockResolvedValueOnce([{ currency: "INR", _count: 12 }]); // currencyAgg

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.shopCurrency).toBe("INR");
  });

  it("falls back to USD when no currency data and no shop currency setting", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShop({ settings: { id: "s-1", shopTimezone: "UTC", shopLocale: "en" } }),
    );

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.shopCurrency).toBe("USD");
  });

  it("returns fraudAlertReturns + count when fraud columns are present", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    const fraudReturns = [
      {
        id: "fr1",
        customerName: "Bad Actor",
        customerEmailNorm: "bad@example.com",
        fraudRiskLevel: "critical",
        fraudRiskScore: 95,
        shopifyOrderName: "#1001",
      },
    ];
    prismaMock.returnCase.findMany.mockImplementation(
      async (args: { where?: { fraudRiskLevel?: { in?: string[] } } } | undefined) => {
        if (args?.where?.fraudRiskLevel?.in?.includes("critical")) {
          return fraudReturns;
        }
        return [];
      },
    );
    prismaMock.returnCase.count.mockImplementation(
      async (args: { where?: { fraudRiskLevel?: { in?: string[] } } } | undefined) => {
        if (args?.where?.fraudRiskLevel?.in?.includes("critical")) {
          return 1;
        }
        return 0;
      },
    );

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.fraudAlertCount).toBe(1);
    expect(data.fraudAlertReturns).toEqual(fraudReturns);
  });

  it("gracefully degrades to defaults when fraud columns are missing (catch path)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(
      async (args: { where?: { fraudRiskLevel?: { in?: string[] } } } | undefined) => {
        if (args?.where?.fraudRiskLevel?.in?.includes("critical")) {
          throw new Error("column rc.fraudRiskLevel does not exist");
        }
        return [];
      },
    );

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.fraudAlertCount).toBe(0);
    expect(data.fraudAlertReturns).toEqual([]);
    // The rest of the dashboard should still load
    expect(data.error).toBeNull();
  });

  it("returns full default fallback object when the entire loader path throws", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("DB on fire"));
    prismaMock.shop.create.mockRejectedValueOnce(new Error("DB on fire"));

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.error).toMatch(/Failed to load dashboard/);
    expect(data.totalReturns).toBe(0);
    expect(data.approvedCount).toBe(0);
    expect(data.shopDomain).toBe("store.myshopify.com");
    expect(data.shopCurrency).toBe("USD");
    expect(data.shopTimezone).toBe("UTC");
    expect(data.range).toBe("last_30_days");
  });

  it("respects ?range= and ?from=/?to= query params for custom date ranges", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());

    const data = await loader({
      request: mkReq("/app?range=custom&from=2025-01-01&to=2025-01-31"),
      params: {},
      context: {},
    } as never);

    expect(data.range).toBe("custom");
    expect(data.from).toBe("2025-01-01");
    expect(data.to).toBe("2025-01-31");
  });
});
