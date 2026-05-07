/**
 * Refund forecasting / cash-flow projection.
 *
 * Pure module. Given a snapshot of in-flight ReturnCases (status not
 * yet "completed" / "rejected" / "cancelled") + their items' prices,
 * computes:
 *
 *  - approvedNotYetRefunded: $$ already approved but not refunded yet.
 *    This is the merchant's incoming refund liability — money they
 *    will pay out as soon as Fynd confirms pickup + warehouse receipt.
 *
 *  - inReviewLiability: $$ that's pending admin review. A fraction of
 *    these will be approved (use the merchant's historical approval
 *    rate to get a probability-weighted projection).
 *
 *  - byCurrency: same totals split per currency code so multi-region
 *    merchants see CAD / USD / GBP separately rather than as a sum.
 *
 *  - p50DaysToRefund / p95DaysToRefund: percentiles of the
 *    historical createdAt → refunded_at gap, used to forecast WHEN
 *    the liability will hit.
 *
 * Caller passes already-fetched data; this module does no Prisma I/O,
 * keeping it trivially testable from vitest.
 */

export interface ForecastReturnSnapshot {
  status: string;
  resolutionType: string | null;
  itemTotalPrice: number; // sum of items' price * qty for this case
  currency: string | null;
  /** ms epoch — used for percentile timing if completed. */
  createdAtMs: number;
  /** Set when the case has actually completed (refunded). null otherwise. */
  refundedAtMs: number | null;
}

export interface RefundForecast {
  approvedNotYetRefunded: number;
  inReviewLiability: number;
  byCurrency: Record<string, { approved: number; inReview: number }>;
  /** Probability-weighted projected total (approval-rate × inReview + approvedNotYetRefunded). */
  projectedTotal: number;
  /** Approval rate (0..1) used in the projection. Echoed back so the UI
   *  can show "based on N% historical approval rate". */
  approvalRateUsed: number;
  /** Median days from createdAt → refunded for completed cases. null
   *  when sample size is too small (<5). */
  p50DaysToRefund: number | null;
  /** 95th-percentile days. */
  p95DaysToRefund: number | null;
  /** Sample size used for the percentile computation. */
  refundedSampleSize: number;
}

const APPROVED_STATUSES = new Set(["approved"]);
const IN_REVIEW_STATUSES = new Set(["pending", "processing", "initiated"]);

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (p <= 0) return sortedAsc[0];
  if (p >= 1) return sortedAsc[sortedAsc.length - 1];
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

export function computeRefundForecast(
  snapshots: ForecastReturnSnapshot[],
  options: {
    /** Historical approval rate (0..1). When omitted, defaults to 0.85
     *  — the industry-typical baseline for return approvals. */
    approvalRate?: number;
  } = {},
): RefundForecast {
  const approvalRate = clamp01(options.approvalRate ?? 0.85);

  let approved = 0;
  let inReview = 0;
  const byCurrency: Record<string, { approved: number; inReview: number }> = {};
  const refundDays: number[] = [];

  for (const s of snapshots) {
    const status = (s.status || "").toLowerCase();
    const cur = (s.currency || "USD").toUpperCase();

    if (APPROVED_STATUSES.has(status)) {
      approved += s.itemTotalPrice;
      bucket(byCurrency, cur, "approved", s.itemTotalPrice);
    } else if (IN_REVIEW_STATUSES.has(status)) {
      inReview += s.itemTotalPrice;
      bucket(byCurrency, cur, "inReview", s.itemTotalPrice);
    }

    // Percentile sample: completed cases only (refundedAtMs set)
    if (s.refundedAtMs !== null) {
      const days = (s.refundedAtMs - s.createdAtMs) / (1000 * 60 * 60 * 24);
      if (days >= 0 && Number.isFinite(days)) refundDays.push(days);
    }
  }

  refundDays.sort((a, b) => a - b);
  const sample = refundDays.length;

  return {
    approvedNotYetRefunded: round2(approved),
    inReviewLiability: round2(inReview),
    byCurrency: Object.fromEntries(
      Object.entries(byCurrency).map(([k, v]) => [k, { approved: round2(v.approved), inReview: round2(v.inReview) }]),
    ),
    projectedTotal: round2(approved + inReview * approvalRate),
    approvalRateUsed: approvalRate,
    p50DaysToRefund: sample >= 5 ? round1(percentile(refundDays, 0.5)!) : null,
    p95DaysToRefund: sample >= 5 ? round1(percentile(refundDays, 0.95)!) : null,
    refundedSampleSize: sample,
  };
}

function bucket(
  by: Record<string, { approved: number; inReview: number }>,
  cur: string,
  key: "approved" | "inReview",
  amount: number,
): void {
  if (!by[cur]) by[cur] = { approved: 0, inReview: 0 };
  by[cur][key] += amount;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
