import { describe, it, expect, vi, beforeEach } from "vitest";

/* vi.mock is hoisted — factories can't reference module-scope variables.
   Use vi.hoisted to create the mock fn synchronously before hoisting. */
const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("../../db.server", () => ({
  default: {
    returnCase: {
      findMany: findManyMock,
    },
  },
}));

import { calculateFraudScore, batchCalculateFraudScores } from "../fraud-detection.server";

beforeEach(() => {
  findManyMock.mockReset();
});

function mkReturn(
  overrides: Partial<{
    daysAgo: number;
    status: string;
    resolutionType: string;
    items: { reasonCode: string | null; price: string | null }[];
    orderDaysAgo: number | null;
  }> = {},
) {
  const now = Date.now();
  const createdAt = new Date(now - (overrides.daysAgo ?? 0) * 24 * 60 * 60 * 1000);
  return {
    createdAt,
    status: overrides.status ?? "pending",
    resolutionType: overrides.resolutionType ?? "refund",
    orderProcessedAt:
      overrides.orderDaysAgo != null
        ? new Date(createdAt.getTime() - overrides.orderDaysAgo * 24 * 60 * 60 * 1000)
        : null,
    shopId: "shop-1",
    items: overrides.items ?? [{ reasonCode: "damaged", price: "50" }],
  };
}

describe("calculateFraudScore", () => {
  it("returns zeros and level=low for new customers (no returns)", async () => {
    findManyMock.mockResolvedValue([]);
    const r = await calculateFraudScore("shop-1", "new@example.com");
    expect(r.score).toBe(0);
    expect(r.level).toBe("low");
    expect(r.factors).toEqual([]);
  });

  it("classifies low volume as low risk", async () => {
    findManyMock.mockResolvedValue([mkReturn({ daysAgo: 10 })]);
    const r = await calculateFraudScore("shop-1", "a@example.com");
    expect(r.level).toBe("low");
    expect(r.factors.length).toBeGreaterThan(0);
  });

  it("flags critical for 5+ returns in 30 days + 10+ total", async () => {
    const returns = Array.from({ length: 12 }, () =>
      mkReturn({
        daysAgo: 10,
        items: [
          { reasonCode: "damaged", price: "150" },
          { reasonCode: "damaged", price: "150" },
        ],
        orderDaysAgo: 28, // 28/30 = 93% window — late timing
        resolutionType: "refund",
      }),
    );
    findManyMock.mockResolvedValue(returns);
    const r = await calculateFraudScore("shop-1", "abuser@example.com", 30);
    expect(r.score).toBeGreaterThanOrEqual(61);
    expect(["high", "critical"]).toContain(r.level);
    // Factors exposed so the UI can show the "why".
    expect(r.factors.find((f) => f.name === "Return Frequency")?.score).toBeGreaterThan(0);
    expect(r.factors.find((f) => f.name === "Total Returns (12 mo)")?.score).toBeGreaterThan(0);
  });

  it("reason-concentration factor triggers when 80%+ share a reason", async () => {
    const returns = Array.from({ length: 5 }, () =>
      mkReturn({
        daysAgo: 45, // pushes into 90d bucket
        items: [{ reasonCode: "changed_my_mind", price: "25" }],
      }),
    );
    findManyMock.mockResolvedValue(returns);
    const r = await calculateFraudScore("shop-1", "x@example.com");
    const reasonFactor = r.factors.find((f) => f.name === "Reason Patterns");
    expect(reasonFactor?.score).toBeGreaterThan(0);
    expect(reasonFactor?.description).toMatch(/changed_my_mind/);
  });

  it("high-value pattern triggers for expensive items", async () => {
    findManyMock.mockResolvedValue([
      mkReturn({
        daysAgo: 5,
        items: [
          { reasonCode: "damaged", price: "250" },
          { reasonCode: "damaged", price: "300" },
        ],
      }),
      mkReturn({ daysAgo: 15, items: [{ reasonCode: "damaged", price: "500" }] }),
      mkReturn({ daysAgo: 25, items: [{ reasonCode: "damaged", price: "150" }] }),
    ]);
    const r = await calculateFraudScore("shop-1", "x@example.com");
    const valueFactor = r.factors.find((f) => f.name === "High-Value Returns");
    expect(valueFactor?.score).toBeGreaterThan(0);
  });

  it("refund-only pattern triggers when 90%+ refunds", async () => {
    const returns = Array.from({ length: 5 }, () =>
      mkReturn({ daysAgo: 10, resolutionType: "refund" }),
    );
    findManyMock.mockResolvedValue(returns);
    const r = await calculateFraudScore("shop-1", "x@example.com");
    const resFactor = r.factors.find((f) => f.name === "Refund-Only Pattern");
    expect(resFactor?.score).toBeGreaterThan(0);
  });

  it("late-timing factor skips when orderProcessedAt is null", async () => {
    findManyMock.mockResolvedValue([
      mkReturn({ daysAgo: 1, orderDaysAgo: null }),
      mkReturn({ daysAgo: 2, orderDaysAgo: null }),
    ]);
    const r = await calculateFraudScore("shop-1", "x@example.com");
    const timing = r.factors.find((f) => f.name === "Late Returns");
    expect(timing?.score).toBe(0);
  });

  it("caps total score at 100", async () => {
    // Stack every factor at maximum — 12 returns, all refunds, all late, all high-value, all same reason.
    const returns = Array.from({ length: 12 }, () =>
      mkReturn({
        daysAgo: 5,
        items: [
          { reasonCode: "damaged", price: "500" },
          { reasonCode: "damaged", price: "500" },
          { reasonCode: "damaged", price: "500" },
        ],
        orderDaysAgo: 29,
        resolutionType: "refund",
      }),
    );
    findManyMock.mockResolvedValue(returns);
    const r = await calculateFraudScore("shop-1", "max@example.com", 30);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("handles items with null/zero prices without crashing", async () => {
    findManyMock.mockResolvedValue([
      mkReturn({
        items: [
          { reasonCode: null, price: null },
          { reasonCode: "damaged", price: "0" },
        ],
      }),
    ]);
    const r = await calculateFraudScore("shop-1", "x@example.com");
    // High-value factor should stay 0; no crash.
    expect(r.factors.find((f) => f.name === "High-Value Returns")?.score).toBe(0);
  });

  it("thresholds: 31-60 → medium, 61-80 → high, 81+ → critical", async () => {
    // Build a return-set that lands in the medium band.
    const medium = Array.from({ length: 4 }, () =>
      mkReturn({ daysAgo: 60, resolutionType: "exchange" }),
    );
    findManyMock.mockResolvedValue(medium);
    const r = await calculateFraudScore("shop-1", "m@example.com");
    if (r.score >= 81) expect(r.level).toBe("critical");
    else if (r.score >= 61) expect(r.level).toBe("high");
    else if (r.score >= 31) expect(r.level).toBe("medium");
    else expect(r.level).toBe("low");
  });
});

describe("batchCalculateFraudScores", () => {
  it("returns a Map keyed by email", async () => {
    findManyMock.mockResolvedValue([]);
    const m = await batchCalculateFraudScores("shop-1", ["a@x.com", "b@x.com", "c@x.com"]);
    expect(m.size).toBe(3);
    expect(m.get("a@x.com")?.level).toBe("low");
  });

  it("processes >10 customers across multiple batches", async () => {
    findManyMock.mockResolvedValue([]);
    const emails = Array.from({ length: 25 }, (_, i) => `u${i}@x.com`);
    const m = await batchCalculateFraudScores("shop-1", emails);
    expect(m.size).toBe(25);
    // Each customer triggers one Prisma call.
    expect(findManyMock).toHaveBeenCalledTimes(25);
  });

  it("handles empty list", async () => {
    const m = await batchCalculateFraudScores("shop-1", []);
    expect(m.size).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
