/**
 * SLO Tracking — Service Level Objective definitions and burn rate calculations
 *
 * Provides SLO definitions, burn rate computation, and span attribute helpers
 * for alerting on error budget consumption.
 */

import { trace, context } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// SLO Definitions
// ---------------------------------------------------------------------------

export type SLOIndicator = "latency_p99" | "error_rate" | "availability";

export interface SLODefinition {
  /** Unique name for the SLO */
  name: string;
  /** Target as a fraction (e.g., 0.999 = 99.9%) */
  target: number;
  /** Window in seconds (e.g., 2592000 = 30 days) */
  windowSeconds: number;
  /** Type of indicator */
  indicator: SLOIndicator;
  /** Threshold value (e.g., 500 for 500ms latency) */
  threshold?: number;
  /** Human-readable description */
  description: string;
}

export const SLO_DEFINITIONS: SLODefinition[] = [
  {
    name: "api_latency_p99",
    target: 0.99,
    windowSeconds: 30 * 24 * 3600, // 30 days
    indicator: "latency_p99",
    threshold: 500, // 500ms
    description: "99% of API requests complete within 500ms",
  },
  {
    name: "api_error_rate",
    target: 0.999,
    windowSeconds: 30 * 24 * 3600,
    indicator: "error_rate",
    description: "99.9% of API requests succeed (non-5xx)",
  },
  {
    name: "fynd_sync_success",
    target: 0.95,
    windowSeconds: 7 * 24 * 3600, // 7 days
    indicator: "error_rate",
    description: "95% of Fynd sync attempts succeed",
  },
  {
    name: "webhook_delivery",
    target: 0.99,
    windowSeconds: 7 * 24 * 3600,
    indicator: "error_rate",
    description: "99% of outbound webhooks delivered within 3 attempts",
  },
  {
    name: "refund_processing",
    target: 0.99,
    windowSeconds: 7 * 24 * 3600,
    indicator: "error_rate",
    description: "99% of refund processing attempts succeed",
  },
];

// ---------------------------------------------------------------------------
// Burn Rate Calculator
// ---------------------------------------------------------------------------

/**
 * Calculate SLO burn rate.
 *
 * burn_rate = actual_error_rate / allowed_error_rate
 *
 * - burn_rate = 1.0: consuming budget at exactly the sustainable rate
 * - burn_rate > 1.0: consuming budget FASTER than sustainable (alert!)
 * - burn_rate < 1.0: consuming budget slower than sustainable (healthy)
 *
 * @param errors Number of errors in the window
 * @param total Total number of events in the window
 * @param target SLO target as fraction (e.g., 0.999)
 * @returns Burn rate multiplier
 */
export function calculateBurnRate(errors: number, total: number, target: number): number {
  if (total === 0) return 0;
  const actualErrorRate = errors / total;
  const allowedErrorRate = 1 - target;
  if (allowedErrorRate === 0) return actualErrorRate > 0 ? Infinity : 0;
  return actualErrorRate / allowedErrorRate;
}

/**
 * Calculate error budget remaining as a percentage.
 *
 * @returns Percentage of error budget remaining (100% = fully intact, 0% = exhausted)
 */
export function errorBudgetRemaining(errors: number, total: number, target: number): number {
  if (total === 0) return 100;
  const allowedErrors = Math.floor(total * (1 - target));
  if (allowedErrors === 0) return errors === 0 ? 100 : 0;
  const remaining = Math.max(0, allowedErrors - errors);
  return (remaining / allowedErrors) * 100;
}

// ---------------------------------------------------------------------------
// Span attribute helpers
// ---------------------------------------------------------------------------

/**
 * Annotate the active span with SLO tracking attributes.
 * Use this in request handlers to enable SLO-based alerting.
 *
 * @example
 * annotateSLO("api_latency_p99", { breached: durationMs > 500 });
 */
export function annotateSLO(
  sloName: string,
  opts: { breached?: boolean; durationMs?: number },
): void {
  const span = trace.getSpan(context.active());
  if (!span) return;

  const slo = SLO_DEFINITIONS.find((s) => s.name === sloName);
  if (!slo) return;

  span.setAttribute("slo.name", sloName);
  span.setAttribute("slo.target", slo.target);
  if (slo.threshold) span.setAttribute("slo.target_ms", slo.threshold);
  if (opts.breached !== undefined) span.setAttribute("slo.breached", opts.breached);
  if (opts.durationMs !== undefined) span.setAttribute("slo.duration_ms", opts.durationMs);
}

/**
 * Get an SLO definition by name.
 */
export function getSLO(name: string): SLODefinition | undefined {
  return SLO_DEFINITIONS.find((s) => s.name === name);
}
