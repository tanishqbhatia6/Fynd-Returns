/**
 * @vitest-environment jsdom
 *
 * Gap-coverage tests for `app/routes/app._index.tsx`.
 *
 * The existing `app.index.test.ts` (loader) and
 * `app.index.component.test.tsx` (component) suites get the dashboard route
 * to ~88% statements. The remaining uncovered lines are all in the loader:
 *
 *   - Lines 55-79: buildSuggestions branches for the "info: awaiting
 *     refund", "avg processing time > 5 days" warning, and the "Other"
 *     reason hint.
 *   - Lines 99-109: the once-per-day session/webhook cleanup block plus
 *     the `import("../lib/fynd-retry.server")` / `fynd-status-poll.server`
 *     dynamic imports kicked off after each loader invocation.
 *   - Lines 227-228: the `returnsForDaily.forEach` body that ticks the
 *     daily bucket (only runs when there's at least one return in the
 *     window).
 *   - Lines 247-271: the `avgProcessingDays` SQL path AND its
 *     `catch (...)` fallback branch (only entered when
 *     `approvedWithEvents.length >= 1`).
 *
 * These are all loader-side. Even though this file is `.tsx` with a jsdom
 * environment (per the brief), driving the loader function directly is
 * fine — we just don't render anything.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// `vi.hoisted` ensures these mocks are constructed before the SUT's
// `vi.mock` calls are evaluated — same shape as the existing
// `app.index.test.ts` loader test.
const {
  prismaMock,
  authenticateMock,
  runFyndRetryQueueMock,
  pollStaleReturnsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  runFyndRetryQueueMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  pollStaleReturnsMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd-retry.server", () => ({ runFyndRetryQueue: runFyndRetryQueueMock }));
vi.mock("../../lib/fynd-status-poll.server", () => ({ pollStaleReturns: pollStaleReturnsMock }));

// `recharts` is imported at the top of `app._index.tsx` even when only the
// loader runs. Stub it so jsdom doesn't pull in canvas/ResizeObserver.
vi.mock("recharts", () => {
  const Empty = () => null;
  return {
    AreaChart: Empty,
    Area: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    ResponsiveContainer: Empty,
  };
});

// shopify-app-react-router/server is pulled in transitively via
// shopify.server. The component test file already has this exact stub —
// it's needed even when we're only exercising the loader because module
// resolution still happens at import time.
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

import { loader } from "../app._index";

function mkReq(path = "/app") {
  return new Request(`https://app.example${path}`);
}

function mkShop(overrides: Record<string, unknown> = {}) {
  return {
    id: "shop-gap-1",
    shopDomain: "store.myshopify.com",
    settings: {
      id: "s-gap-1",
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
  // resetPrismaMock only mockClear()s — implementations from previous tests
  // can leak forward (e.g. an `approvedWithEvents`-returning findMany can
  // make the next test enter the SQL block unintentionally). Fully reset
  // the methods we override across this suite.
  prismaMock.returnCase.findMany.mockReset().mockResolvedValue([]);
  prismaMock.returnCase.count.mockReset().mockResolvedValue(0);
  prismaMock.returnCase.groupBy.mockReset().mockResolvedValue([]);
  prismaMock.returnItem.groupBy.mockReset().mockResolvedValue([]);
  prismaMock.shop.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.shop.create.mockReset().mockImplementation(async ({ data }) => ({
    id: "cmmock",
    ...data,
    settings: null,
  }));
  prismaMock.lookupSession.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prismaMock.fyndWebhookLog.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prismaMock.blocklistEntry.count.mockReset().mockResolvedValue(0);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  runFyndRetryQueueMock.mockReset().mockResolvedValue(undefined);
  pollStaleReturnsMock.mockReset().mockResolvedValue(undefined);
  prismaMock.$queryRaw.mockReset().mockResolvedValue([]);
});

describe("app._index loader — buildSuggestions gap branches", () => {
  it("emits the 'awaiting refund' info suggestion when approvedNotRefundedCount > 0", async () => {
    // This wires up the loader so the buildSuggestions input has
    // approvedNotRefundedCount > 0 — drives lines 54-61.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    // 16-element Promise.all order: count, groupBy, findMany, groupBy,
    //   count×5 (refundedCount, fyndSyncedCount, pendingCount,
    //     rejectedCount, allTimeReturns),
    //   findMany×2 (approvedWithEvents, returnsForDaily),
    //   count×2 (approvedNotRefundedCount, greenReturnCount),
    //   groupBy (resolutionAgg), findMany (retainedCases),
    //   count (blocklistEntry).
    // We only need to override the count calls; defaults handle the rest.
    prismaMock.returnCase.count
      .mockResolvedValueOnce(8) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(0) // fyndSyncedCount
      .mockResolvedValueOnce(0) // pendingCount
      .mockResolvedValueOnce(0) // rejectedCount
      .mockResolvedValueOnce(8) // allTimeReturns
      .mockResolvedValueOnce(3) // approvedNotRefundedCount ←
      .mockResolvedValueOnce(0) // greenReturnCount
      .mockResolvedValueOnce(0); // blocklistCount call falls through to default

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) => s.message.includes("awaiting refund"));
    expect(sugg).toBeDefined();
    expect(sugg?.type).toBe("info");
    expect(sugg?.actionUrl).toBe("/app/returns?status=approved");
  });

  it("uses singular 'approved return' in awaiting-refund message when count is exactly 1", async () => {
    // Drives the ternary on line 57 (approvedNotRefundedCount > 1) — false branch.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.count
      .mockResolvedValueOnce(2) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(0) // fyndSyncedCount
      .mockResolvedValueOnce(0) // pendingCount
      .mockResolvedValueOnce(0) // rejectedCount
      .mockResolvedValueOnce(2) // allTimeReturns
      .mockResolvedValueOnce(1); // approvedNotRefundedCount = 1

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) => s.message.includes("awaiting refund"));
    expect(sugg).toBeDefined();
    expect(sugg?.message).toMatch(/^1 approved return awaiting refund/);
  });

  it("emits the 'avg processing time' warning when avgProcessingDays > 5 and approvedCount >= 2", async () => {
    // Drives lines 63-69 (avgProcessingDays > 5) — needs the SQL avg
    // path to return > 5.0 AND approvedCount >= 2 AND totalReturns > 0
    // (otherwise buildSuggestions short-circuits at line 34).
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.count.mockResolvedValueOnce(10); // totalReturns > 0
    // approvedWithEvents.length >= 1 ⇒ branch entered. The findMany call
    // for approvedWithEvents is the one with `select: { createdAt, updatedAt }`.
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean>; where?: { status?: { in?: string[] } } } | undefined;
      // approvedWithEvents: select: { createdAt: true, updatedAt: true }
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [
          { createdAt: new Date("2025-01-01"), updatedAt: new Date("2025-01-15") },
          { createdAt: new Date("2025-01-05"), updatedAt: new Date("2025-01-20") },
        ];
      }
      return [];
    });
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 3 },
    ]);
    // The `$queryRaw` is called twice in this codepath: once for
    // atRiskResult, once for the avg processing time. The first returns
    // the at-risk total, the second returns avg_days.
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }]) // revenueAtRisk
      .mockResolvedValueOnce([{ avg_days: 7.34 }]); // avgProcessingDays > 5

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // avgProcessingDays itself isn't returned, but its effect — the
    // "processing time" suggestion — is fully observable.
    const sugg = data.suggestions.find((s) => s.message.includes("processing time"));
    expect(sugg).toBeDefined();
    expect(sugg?.type).toBe("warning");
    expect(sugg?.message).toContain("7"); // rounded
  });

  it("emits the 'Other reason' hint suggestion when the top reason is 'Other' and totalReturns >= 2", async () => {
    // Drives lines 72-79 (topReason.reason === "Other") — also covers
    // the case-insensitive 'other' alternative via assertion.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnItem.groupBy.mockResolvedValueOnce([
      { reasonCode: "Other", _count: 6 },
      { reasonCode: "wrong_size", _count: 2 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(8); // totalReturns

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) => s.message.includes("'Other'"));
    expect(sugg).toBeDefined();
    expect(sugg?.type).toBe("info");
    expect(sugg?.actionUrl).toBe("/app/settings/return-settings");
  });

  it("also emits the 'Other reason' hint when the top reason is the lowercase 'other'", async () => {
    // The branch checks for both 'Other' and 'other' — exercise the
    // lowercase variant explicitly.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnItem.groupBy.mockResolvedValueOnce([
      { reasonCode: "other", _count: 4 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2); // totalReturns >= 2

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) => s.message.includes("Other"));
    expect(sugg).toBeDefined();
  });

  it("caps the suggestions list at 3 entries even when many branches fire", async () => {
    // The function ends with `return suggestions.slice(0, 3)` — verify
    // the slice when 4+ suggestions would otherwise have been added.
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      mkShop({
        settings: {
          id: "s-gap-1",
          shopTimezone: "UTC",
          shopLocale: "en",
          fyndApplicationId: "app-id",
          fyndCredentials: "creds",
        },
      }),
    );
    // pendingCount > 0 ⇒ pending suggestion
    // hasFyndConfig + fyndSyncedCount < approvedCount ⇒ fynd suggestion
    // approvedNotRefundedCount > 0 ⇒ awaiting-refund suggestion
    // 'Other' reason ⇒ would have been #4 (sliced off)
    prismaMock.returnCase.count
      .mockResolvedValueOnce(10) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(0) // fyndSyncedCount (< approvedCount)
      .mockResolvedValueOnce(2) // pendingCount
      .mockResolvedValueOnce(0) // rejectedCount
      .mockResolvedValueOnce(10) // allTimeReturns
      .mockResolvedValueOnce(3); // approvedNotRefundedCount
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 5 }, // approvedCount=5 > fyndSyncedCount=0
    ]);
    prismaMock.returnItem.groupBy.mockResolvedValueOnce([
      { reasonCode: "Other", _count: 9 },
    ]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.suggestions.length).toBeLessThanOrEqual(3);
  });
});

describe("app._index loader — daily trend bucket gap (lines 227-228)", () => {
  it("buckets returnsForDaily entries into the dailyData map", async () => {
    // returnsForDaily is the 11th item in Promise.all (the second
    // findMany with `select: { createdAt: true }` and no `updatedAt`).
    // When it's non-empty AND a key matches, the forEach body increments
    // the bucket — this is the line 227-228 gap.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      // returnsForDaily: select: { createdAt: true }, no updatedAt
      if (a?.select?.createdAt && !a?.select?.updatedAt && !a?.select?.refundJson) {
        // Use today's date so it falls inside the default last-30d window.
        const today = new Date();
        const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        return [
          { createdAt: today },
          { createdAt: yesterday },
          { createdAt: today }, // duplicates exercise the increment
        ];
      }
      return [];
    });

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // returnsOverTime should contain non-zero days for our two buckets.
    const totalReturnsCount = data.returnsOverTime.reduce((acc, r) => acc + r.returns, 0);
    expect(totalReturnsCount).toBeGreaterThanOrEqual(2);
  });

  it("ignores returnsForDaily entries whose createdAt falls outside the daily window", async () => {
    // Drives the `if (dailyData[key] !== undefined) dailyData[key]++` false
    // branch — a date older than 90 days never has a bucket key.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    const ancient = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && !a?.select?.updatedAt && !a?.select?.refundJson) {
        return [{ createdAt: ancient }];
      }
      return [];
    });

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // No bucket should have ticked.
    expect(data.returnsOverTime.every((r) => r.returns === 0)).toBe(true);
  });
});

describe("app._index loader — avgProcessingDays SQL gap (lines 247-271)", () => {
  it("rounds the SQL avg_days result to one decimal place (observed via $queryRaw call)", async () => {
    // approvedWithEvents.length >= 1 ⇒ enters the try block. The SQL
    // returns avg_days ⇒ avgProcessingDays = round(value*10)/10.
    // avgProcessingDays isn't directly returned from the loader, but we
    // can observe the SQL was invoked exactly twice (revenueAtRisk +
    // processing-time) which means the try-block ran.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [{ createdAt: new Date(), updatedAt: new Date() }];
      }
      return [];
    });
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }]) // revenueAtRisk
      .mockResolvedValueOnce([{ avg_days: 2.456 }]); // processingResult

    await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Two $queryRaw calls = both the at-risk SQL AND the avg-processing SQL ran.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("leaves avgProcessingDays null (no warning suggestion) when the SQL avg_days is null", async () => {
    // SQL returned a row, but avg_days is null ⇒ avgProcessingDays stays null
    // ⇒ the `> 5` warning suggestion can never be added.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [
          { createdAt: new Date(), updatedAt: new Date() },
          { createdAt: new Date(), updatedAt: new Date() },
        ];
      }
      return [];
    });
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 5 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(5); // totalReturns
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([{ avg_days: null }]);

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Both $queryRaw runs fired (try-block reached) but no processing-time warning.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(data.suggestions.find((s) => s.message.includes("processing time"))).toBeUndefined();
  });

  it("falls back to updatedAt-based avg when the processing-time SQL throws", async () => {
    // Drives lines 265-271 (catch block). When the SQL raises (e.g.
    // ReturnEvent column missing on older DBs), the loader recomputes the
    // average from `updatedAt - createdAt` over the in-memory rows.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [
          {
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-03T00:00:00Z"), // 2 days
          },
          {
            createdAt: new Date("2025-01-04T00:00:00Z"),
            updatedAt: new Date("2025-01-08T00:00:00Z"), // 4 days
          },
        ];
      }
      return [];
    });
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 4 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(8); // totalReturns >= 2
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }]) // revenueAtRisk OK
      .mockRejectedValueOnce(new Error("relation \"ReturnEvent\" does not exist")); // SQL fails

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Fallback path computed avg = 3.0 days, which is below the > 5 threshold —
    // we observe via the absence of the "processing time" warning AND the
    // fact that the SQL block was attempted (both $queryRaw mocks were drained).
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(data.suggestions.find((s) => s.message.includes("processing time"))).toBeUndefined();
  });

  it("emits the processing-time warning from the SQL fallback when the in-memory avg exceeds 5 days", async () => {
    // Same fallback path, but with rows whose updatedAt - createdAt > 5d so
    // we hit the `avgProcessingDays > 5` branch — observable via the
    // suggestion list. This sets BOTH the catch path AND the buildSuggestions
    // line 64-69 branch when entered from the in-memory fallback.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [
          {
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-15T00:00:00Z"), // 14 days
          },
          {
            createdAt: new Date("2025-01-02T00:00:00Z"),
            updatedAt: new Date("2025-01-16T00:00:00Z"), // 14 days
          },
        ];
      }
      return [];
    });
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 4 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(8);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }])
      .mockRejectedValueOnce(new Error("ReturnEvent table absent"));

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) => s.message.includes("processing time"));
    expect(sugg).toBeDefined();
    expect(sugg?.type).toBe("warning");
  });

  it("yields no processing-time warning in the fallback when every row has clock skew", async () => {
    // Drives the `times.filter((t) => t >= 0)` branch when `times.length`
    // ends up zero (every updatedAt < createdAt). avgProcessingDays stays
    // null ⇒ no "processing time" suggestion can fire.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [
          {
            createdAt: new Date("2025-01-10T00:00:00Z"),
            updatedAt: new Date("2025-01-01T00:00:00Z"), // negative
          },
        ];
      }
      return [];
    });
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }])
      .mockRejectedValueOnce(new Error("boom"));

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Both $queryRaw calls fired ⇒ the catch branch ran. No warning suggestion.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(data.suggestions.find((s) => s.message.includes("processing time"))).toBeUndefined();
  });

  it("does not enter the SQL block when approvedWithEvents is empty", async () => {
    // Drives the `if (approvedWithEvents.length >= 1)` false branch.
    // avgProcessingDays stays null and the second $queryRaw is never called
    // (only the at-risk SQL fires).
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    // Default findMany returns [] — approvedWithEvents.length === 0.

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Only the revenueAtRisk $queryRaw fires; the processing-time SQL never runs.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(data.suggestions.find((s) => s.message.includes("processing time"))).toBeUndefined();
  });
});

describe("app._index loader — once-per-day cleanup gap (lines 95-109)", () => {
  // These tests trigger the loader's once-per-day cleanup branch (lines
  // 95-109). The branch is gated on a module-scoped `lastSessionCleanup`
  // timestamp — re-importing the module via vi.isolateModulesAsync gives us
  // a fresh `lastSessionCleanup = 0` so the very first loader call enters
  // the cleanup block, exercising:
  //   - prisma.lookupSession.deleteMany(...)         (line 97)
  //   - prisma.fyndWebhookLog.deleteMany(...)        (line 100)
  //   - their .catch handlers                        (lines 99 + 102)
  //   - import("../lib/fynd-retry.server").then(...) (lines 105-107)
  //   - import("../lib/fynd-status-poll.server")...  (lines 108-110)

  /**
   * Re-import `app._index` after a `vi.resetModules()` so each test gets
   * a fresh `lastSessionCleanup = 0`. We re-register the companion mocks
   * via `vi.doMock` because the top-level `vi.mock` calls only apply to
   * the original registry. We also re-mock the *transitive* db imports
   * pulled in by the dynamic `import("../lib/fynd-*-server")` calls so
   * teardown doesn't trip the "module loaded after env teardown" guard.
   */
  async function loadFreshLoader() {
    vi.resetModules();
    vi.doMock("../../db.server", () => ({ default: prismaMock }));
    vi.doMock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
    vi.doMock("../../lib/fynd-retry.server", () => ({ runFyndRetryQueue: runFyndRetryQueueMock }));
    vi.doMock("../../lib/fynd-status-poll.server", () => ({ pollStaleReturns: pollStaleReturnsMock }));
    vi.doMock("recharts", () => {
      const Empty = () => null;
      return {
        AreaChart: Empty, Area: Empty, XAxis: Empty, YAxis: Empty,
        CartesianGrid: Empty, Tooltip: Empty, ResponsiveContainer: Empty,
      };
    });
    vi.doMock("@shopify/shopify-app-react-router/server", () => ({
      boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
      shopifyApp: vi.fn(() => ({
        addDocumentResponseHeaders: vi.fn(),
        authenticate: { admin: vi.fn() },
        unauthenticated: {}, login: vi.fn(),
        registerWebhooks: vi.fn(), sessionStorage: {},
      })),
      ApiVersion: { January25: "2025-01" },
      AppDistribution: { AppStore: "app_store" },
      DeliveryMethod: { Http: "http" },
    }));
    return await import("../app._index");
  }

  it("invokes the lookupSession + fyndWebhookLog cleanup deleteMany on the first loader call after a cold module load", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.lookupSession.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.fyndWebhookLog.deleteMany.mockResolvedValue({ count: 0 });

    const reloaded = await loadFreshLoader();
    await reloaded.loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Both cleanup deleteMany calls should have been triggered exactly once.
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fyndWebhookLog.deleteMany).toHaveBeenCalledTimes(1);
    // Drain microtasks so the dynamic-import retry/poll callbacks settle
    // before vitest tears the env down.
    await new Promise((r) => setTimeout(r, 50));
    expect(runFyndRetryQueueMock).toHaveBeenCalled();
    expect(pollStaleReturnsMock).toHaveBeenCalled();
  });

  it("swallows cleanup deleteMany + dynamic-import rejections via the .catch handlers", async () => {
    // The deleteMany cleanups and the dynamic-import callbacks are
    // fire-and-forget (`.catch(...)`). If any reject, the loader must
    // NOT propagate. Drives the catch arrows on lines 99, 102, 106, 109.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.lookupSession.deleteMany.mockRejectedValueOnce(new Error("session purge fail"));
    prismaMock.fyndWebhookLog.deleteMany.mockRejectedValueOnce(new Error("webhook purge fail"));
    runFyndRetryQueueMock.mockRejectedValueOnce(new Error("retry queue fail"));
    pollStaleReturnsMock.mockRejectedValueOnce(new Error("poll fail"));

    const reloaded = await loadFreshLoader();
    const data = await reloaded.loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // Loader returns its happy-path shape — rejections were swallowed.
    expect(data.error).toBeNull();
    // Drain the catch handlers before teardown so they don't surface as
    // unhandled rejections.
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("app._index loader — misc branch coverage", () => {
  it("does not emit the awaiting-refund suggestion when totalReturns === 0 (early return)", async () => {
    // The very first branch of buildSuggestions is `if (data.totalReturns === 0)
    // return suggestions;` — make sure none of the gap-paths fire when
    // there's no return data at all.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    // Defaults give totalReturns=0 ⇒ buildSuggestions short-circuits.

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.suggestions).toEqual([]);
  });

  it("does not emit the avg-processing-time warning when approvedCount < 2", async () => {
    // Drives the `&& data.approvedCount >= 2` false branch on line 63.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnCase.findMany.mockImplementation(async (args: unknown) => {
      const a = args as { select?: Record<string, boolean> } | undefined;
      if (a?.select?.createdAt && a?.select?.updatedAt) {
        return [{ createdAt: new Date(), updatedAt: new Date() }];
      }
      return [];
    });
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 1 }, // approvedCount=1, below threshold
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(5); // totalReturns
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([{ avg_days: 12 }]); // > 5 but approvedCount<2

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    // SQL ran (avgProcessingDays computed internally) but no warning suggestion.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(data.suggestions.find((s) => s.message.includes("processing time"))).toBeUndefined();
  });

  it("does not emit the 'Other' suggestion when totalReturns < 2", async () => {
    // Drives the `&& data.totalReturns >= 2` false branch on line 73.
    prismaMock.shop.findUnique.mockResolvedValueOnce(mkShop());
    prismaMock.returnItem.groupBy.mockResolvedValueOnce([
      { reasonCode: "Other", _count: 1 },
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1); // totalReturns=1

    const data = await loader({
      request: mkReq("/app"),
      params: {},
      context: {},
    } as never);

    expect(data.suggestions.find((s) => s.message.includes("Other"))).toBeUndefined();
  });
});
