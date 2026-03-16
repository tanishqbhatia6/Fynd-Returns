/**
 * Fraud Detection & Return Abuse Scoring
 *
 * Computes a risk score (0-100) for a customer based on return patterns.
 * Used by auto-approve rules, return list badges, and customer page.
 */
import prisma from "../db.server";

export interface FraudScore {
  score: number;
  level: "low" | "medium" | "high" | "critical";
  factors: FraudFactor[];
}

export interface FraudFactor {
  name: string;
  description: string;
  score: number; // contribution to total
  weight: number;
}

type ReturnForScoring = {
  createdAt: Date;
  status: string;
  resolutionType: string;
  items: { reasonCode: string | null; price: string | null }[];
  orderProcessedAt: Date | null;
  shopId: string;
};

function getLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 81) return "critical";
  if (score >= 61) return "high";
  if (score >= 31) return "medium";
  return "low";
}

/**
 * Calculate fraud risk score for a customer.
 * @param shopId - Shop identifier
 * @param customerEmail - Normalized customer email
 * @param returnWindowDays - Shop's return window setting (for timing analysis)
 */
export async function calculateFraudScore(
  shopId: string,
  customerEmail: string,
  returnWindowDays: number = 30,
): Promise<FraudScore> {
  const factors: FraudFactor[] = [];

  // Get all returns for this customer in the last 12 months
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const returns = await prisma.returnCase.findMany({
    where: {
      shopId,
      customerEmailNorm: customerEmail,
      createdAt: { gte: twelveMonthsAgo },
    },
    select: {
      createdAt: true,
      status: true,
      resolutionType: true,
      orderProcessedAt: true,
      shopId: true,
      items: { select: { reasonCode: true, price: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  if (returns.length === 0) {
    return { score: 0, level: "low", factors: [] };
  }

  // ── Factor 1: Return Frequency (25%) ──
  const FREQ_WEIGHT = 25;
  const now = new Date();
  const returnsLast30 = returns.filter(r => (now.getTime() - r.createdAt.getTime()) < 30 * 24 * 60 * 60 * 1000).length;
  const returnsLast90 = returns.filter(r => (now.getTime() - r.createdAt.getTime()) < 90 * 24 * 60 * 60 * 1000).length;

  let freqRaw = 0;
  if (returnsLast30 >= 5) freqRaw = 100;
  else if (returnsLast30 >= 3) freqRaw = 80;
  else if (returnsLast90 >= 6) freqRaw = 70;
  else if (returnsLast90 >= 4) freqRaw = 50;
  else if (returnsLast90 >= 2) freqRaw = 25;
  else freqRaw = 0;

  const freqScore = Math.round(freqRaw * FREQ_WEIGHT / 100);
  factors.push({
    name: "Return Frequency",
    description: `${returnsLast30} returns in 30 days, ${returnsLast90} in 90 days`,
    score: freqScore,
    weight: FREQ_WEIGHT,
  });

  // ── Factor 2: Return Rate (25%) ──
  // Approximate: compare to total shop returns (not ideal, but avoids Shopify API call)
  const RATE_WEIGHT = 25;
  const totalReturnCount = returns.length;
  let rateRaw = 0;
  if (totalReturnCount >= 10) rateRaw = 100;
  else if (totalReturnCount >= 7) rateRaw = 80;
  else if (totalReturnCount >= 5) rateRaw = 60;
  else if (totalReturnCount >= 3) rateRaw = 30;
  else rateRaw = 0;

  const rateScore = Math.round(rateRaw * RATE_WEIGHT / 100);
  factors.push({
    name: "Total Returns (12 mo)",
    description: `${totalReturnCount} returns in the last 12 months`,
    score: rateScore,
    weight: RATE_WEIGHT,
  });

  // ── Factor 3: Reason Patterns (15%) ──
  const REASON_WEIGHT = 15;
  const reasonCounts: Record<string, number> = {};
  for (const r of returns) {
    for (const item of r.items) {
      const reason = item.reasonCode ?? "unknown";
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  const topReasonCount = Math.max(...Object.values(reasonCounts), 0);
  const totalReasons = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
  const reasonConcentration = totalReasons > 0 ? topReasonCount / totalReasons : 0;

  let reasonRaw = 0;
  if (reasonConcentration >= 0.8 && topReasonCount >= 3) reasonRaw = 80;
  else if (reasonConcentration >= 0.6 && topReasonCount >= 3) reasonRaw = 50;
  else if (topReasonCount >= 5) reasonRaw = 40;
  else reasonRaw = 0;

  const reasonScore = Math.round(reasonRaw * REASON_WEIGHT / 100);
  const topReason = Object.entries(reasonCounts).sort(([,a],[,b]) => b - a)[0];
  factors.push({
    name: "Reason Patterns",
    description: topReason ? `"${topReason[0]}" used ${topReason[1]}x (${Math.round(reasonConcentration * 100)}% of all)` : "No patterns",
    score: reasonScore,
    weight: REASON_WEIGHT,
  });

  // ── Factor 4: High-Value Pattern (15%) ──
  const VALUE_WEIGHT = 15;
  const prices = returns.flatMap(r => r.items.map(i => parseFloat(i.price ?? "0")).filter(p => p > 0));
  const highValueItems = prices.filter(p => p >= 100);
  const highValuePct = prices.length > 0 ? highValueItems.length / prices.length : 0;

  let valueRaw = 0;
  if (highValuePct >= 0.7 && highValueItems.length >= 3) valueRaw = 80;
  else if (highValuePct >= 0.5 && highValueItems.length >= 2) valueRaw = 50;
  else if (highValueItems.length >= 3) valueRaw = 30;
  else valueRaw = 0;

  const valueScore = Math.round(valueRaw * VALUE_WEIGHT / 100);
  factors.push({
    name: "High-Value Returns",
    description: `${highValueItems.length} items over $100 (${Math.round(highValuePct * 100)}% of returned items)`,
    score: valueScore,
    weight: VALUE_WEIGHT,
  });

  // ── Factor 5: Timing Pattern (10%) ──
  // Returns submitted near end of return window
  const TIMING_WEIGHT = 10;
  let lateTiming = 0;
  for (const r of returns) {
    if (r.orderProcessedAt) {
      const daysSinceOrder = (r.createdAt.getTime() - r.orderProcessedAt.getTime()) / (24 * 60 * 60 * 1000);
      const windowUsage = daysSinceOrder / returnWindowDays;
      if (windowUsage >= 0.85) lateTiming++;
    }
  }
  const lateTimingPct = returns.length > 0 ? lateTiming / returns.length : 0;

  let timingRaw = 0;
  if (lateTimingPct >= 0.5 && lateTiming >= 3) timingRaw = 80;
  else if (lateTimingPct >= 0.3 && lateTiming >= 2) timingRaw = 50;
  else if (lateTiming >= 2) timingRaw = 25;
  else timingRaw = 0;

  const timingScore = Math.round(timingRaw * TIMING_WEIGHT / 100);
  factors.push({
    name: "Late Returns",
    description: `${lateTiming} of ${returns.length} returns submitted near window end (>85% used)`,
    score: timingScore,
    weight: TIMING_WEIGHT,
  });

  // ── Factor 6: Resolution Pattern (10%) ──
  // Always choosing refund over exchange = slightly suspicious
  const RESOLUTION_WEIGHT = 10;
  const refundOnlyCount = returns.filter(r => r.resolutionType === "refund").length;
  const refundOnlyPct = returns.length > 0 ? refundOnlyCount / returns.length : 0;

  let resolutionRaw = 0;
  if (refundOnlyPct >= 0.9 && refundOnlyCount >= 4) resolutionRaw = 70;
  else if (refundOnlyPct >= 0.8 && refundOnlyCount >= 3) resolutionRaw = 40;
  else resolutionRaw = 0;

  const resolutionScore = Math.round(resolutionRaw * RESOLUTION_WEIGHT / 100);
  factors.push({
    name: "Refund-Only Pattern",
    description: `${refundOnlyCount} of ${returns.length} returns chose refund (${Math.round(refundOnlyPct * 100)}%)`,
    score: resolutionScore,
    weight: RESOLUTION_WEIGHT,
  });

  // ── Total ──
  const totalScore = Math.min(100, factors.reduce((a, f) => a + f.score, 0));

  return {
    score: totalScore,
    level: getLevel(totalScore),
    factors,
  };
}

/**
 * Batch compute fraud scores for multiple customers.
 * Used by the customers list page.
 */
export async function batchCalculateFraudScores(
  shopId: string,
  customerEmails: string[],
  returnWindowDays: number = 30,
): Promise<Map<string, FraudScore>> {
  const results = new Map<string, FraudScore>();
  // Process in parallel batches of 10
  const batchSize = 10;
  for (let i = 0; i < customerEmails.length; i += batchSize) {
    const batch = customerEmails.slice(i, i + batchSize);
    const scores = await Promise.all(
      batch.map(email => calculateFraudScore(shopId, email, returnWindowDays).then(score => [email, score] as const))
    );
    for (const [email, score] of scores) {
      results.set(email, score);
    }
  }
  return results;
}
