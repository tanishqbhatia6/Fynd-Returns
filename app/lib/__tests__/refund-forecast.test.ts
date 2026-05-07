/**
 * Refund-forecast pure-function tests.
 */
import { describe, it, expect } from "vitest";
import {
  computeRefundForecast,
  type ForecastReturnSnapshot,
} from "../refund-forecast.server";

const DAY = 1000 * 60 * 60 * 24;
const NOW = new Date("2026-05-07T00:00:00Z").getTime();

function snap(over: Partial<ForecastReturnSnapshot> = {}): ForecastReturnSnapshot {
  return {
    status: "pending",
    resolutionType: "refund",
    itemTotalPrice: 100,
    currency: "USD",
    createdAtMs: NOW - 3 * DAY,
    refundedAtMs: null,
    ...over,
  };
}

describe("computeRefundForecast — totals", () => {
  it("buckets approved vs in-review correctly", () => {
    const out = computeRefundForecast([
      snap({ status: "approved", itemTotalPrice: 200 }),
      snap({ status: "pending", itemTotalPrice: 150 }),
      snap({ status: "processing", itemTotalPrice: 50 }),
      snap({ status: "completed", itemTotalPrice: 999, refundedAtMs: NOW }), // excluded — already refunded
      snap({ status: "rejected", itemTotalPrice: 999 }), // excluded — not paying out
    ]);
    expect(out.approvedNotYetRefunded).toBe(200);
    expect(out.inReviewLiability).toBe(200); // 150 + 50
  });

  it("treats unknown statuses as excluded from totals", () => {
    const out = computeRefundForecast([
      snap({ status: "weird-future-status", itemTotalPrice: 999 }),
    ]);
    expect(out.approvedNotYetRefunded).toBe(0);
    expect(out.inReviewLiability).toBe(0);
  });

  it("handles empty snapshot list (everything zero)", () => {
    const out = computeRefundForecast([]);
    expect(out.approvedNotYetRefunded).toBe(0);
    expect(out.inReviewLiability).toBe(0);
    expect(out.projectedTotal).toBe(0);
    expect(out.byCurrency).toEqual({});
  });
});

describe("computeRefundForecast — approvalRate weighting", () => {
  it("defaults to 0.85 when no approvalRate provided", () => {
    const out = computeRefundForecast([snap({ status: "pending", itemTotalPrice: 100 })]);
    expect(out.approvalRateUsed).toBe(0.85);
    expect(out.projectedTotal).toBe(85);
  });

  it("uses caller-provided approvalRate", () => {
    const out = computeRefundForecast(
      [snap({ status: "pending", itemTotalPrice: 100 })],
      { approvalRate: 0.5 },
    );
    expect(out.approvalRateUsed).toBe(0.5);
    expect(out.projectedTotal).toBe(50);
  });

  it("clamps approvalRate above 1 to 1", () => {
    const out = computeRefundForecast([snap({ itemTotalPrice: 100 })], { approvalRate: 5 });
    expect(out.approvalRateUsed).toBe(1);
  });

  it("clamps negative approvalRate to 0", () => {
    const out = computeRefundForecast([snap({ itemTotalPrice: 100 })], { approvalRate: -1 });
    expect(out.approvalRateUsed).toBe(0);
    expect(out.projectedTotal).toBe(0);
  });

  it("treats NaN approvalRate as 0", () => {
    const out = computeRefundForecast([snap({ itemTotalPrice: 100 })], { approvalRate: NaN });
    expect(out.approvalRateUsed).toBe(0);
  });

  it("approved liability is added in full to projectedTotal regardless of approvalRate", () => {
    const out = computeRefundForecast(
      [
        snap({ status: "approved", itemTotalPrice: 100 }),
        snap({ status: "pending", itemTotalPrice: 100 }),
      ],
      { approvalRate: 0.5 },
    );
    // 100 (approved, full) + 100 * 0.5 (in-review × rate) = 150
    expect(out.projectedTotal).toBe(150);
  });
});

describe("computeRefundForecast — multi-currency split", () => {
  it("splits totals by currency code", () => {
    const out = computeRefundForecast([
      snap({ status: "approved", itemTotalPrice: 200, currency: "USD" }),
      snap({ status: "approved", itemTotalPrice: 100, currency: "CAD" }),
      snap({ status: "pending", itemTotalPrice: 50, currency: "CAD" }),
    ]);
    expect(out.byCurrency.USD).toEqual({ approved: 200, inReview: 0 });
    expect(out.byCurrency.CAD).toEqual({ approved: 100, inReview: 50 });
  });

  it("uppercases currency codes for stable bucketing", () => {
    const out = computeRefundForecast([
      snap({ status: "approved", itemTotalPrice: 200, currency: "usd" }),
      snap({ status: "approved", itemTotalPrice: 100, currency: "USD" }),
    ]);
    expect(out.byCurrency.USD.approved).toBe(300);
    expect(Object.keys(out.byCurrency)).toEqual(["USD"]);
  });

  it("falls back to USD when currency is null", () => {
    const out = computeRefundForecast([snap({ status: "approved", currency: null })]);
    expect(out.byCurrency.USD).toBeTruthy();
  });
});

describe("computeRefundForecast — defensive fallbacks", () => {
  it("treats unparseable currency as USD bucket (defensive)", () => {
    const out = computeRefundForecast([
      // simulate a row where status & currency normalisation runs through
      // the defensive empty-string fallbacks (status undefined string)
      snap({ status: "approved", currency: "" }),
    ]);
    expect(out.byCurrency.USD).toBeTruthy();
  });

  it("normalises an empty status string without crashing (line 83 falsy branch)", () => {
    // Empty status hits the `(s.status || "").toLowerCase()` fallback
    // and is then excluded from both buckets (no APPROVED/IN_REVIEW match).
    const out = computeRefundForecast([
      snap({ status: "", itemTotalPrice: 999 }),
    ]);
    expect(out.approvedNotYetRefunded).toBe(0);
    expect(out.inReviewLiability).toBe(0);
    // No crash; result is well-formed
    expect(out.projectedTotal).toBe(0);
  });
});

describe("computeRefundForecast — percentile timing", () => {
  it("returns null percentiles when fewer than 5 refunded samples", () => {
    const out = computeRefundForecast([
      snap({ status: "completed", refundedAtMs: NOW, createdAtMs: NOW - 2 * DAY }),
      snap({ status: "completed", refundedAtMs: NOW, createdAtMs: NOW - 3 * DAY }),
    ]);
    expect(out.p50DaysToRefund).toBeNull();
    expect(out.p95DaysToRefund).toBeNull();
    expect(out.refundedSampleSize).toBe(2);
  });

  it("computes p50 / p95 when 5+ refunded samples are present", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) =>
      snap({ status: "completed", refundedAtMs: NOW, createdAtMs: NOW - d * DAY }),
    );
    const out = computeRefundForecast(samples);
    expect(out.refundedSampleSize).toBe(10);
    expect(out.p50DaysToRefund).toBeGreaterThanOrEqual(4);
    expect(out.p50DaysToRefund).toBeLessThanOrEqual(6);
    expect(out.p95DaysToRefund).toBeGreaterThanOrEqual(9);
  });

  it("ignores nonsensical refundedAt < createdAt", () => {
    const out = computeRefundForecast([
      ...Array(5).fill(0).map(() =>
        snap({ status: "completed", refundedAtMs: NOW, createdAtMs: NOW + DAY }),
      ),
    ]);
    expect(out.refundedSampleSize).toBe(0);
    expect(out.p50DaysToRefund).toBeNull();
  });
});
