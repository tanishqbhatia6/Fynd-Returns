/**
 * Returns-process SLA computation.
 *
 * Three SLAs are defined in business terms:
 *   - approval SLA: customer requested → admin approved
 *   - pickup SLA:   admin approved → courier picked up the bag
 *   - refund SLA:   admin approved → refund completed (or store-credit
 *                   issued)
 *
 * Pure module — no Prisma. Caller passes a snapshot of the returnCase
 * + its events (or the relevant timestamps) and we return per-stage
 * breach state. This keeps the function trivially testable and reusable
 * from the return-detail page, the returns-list page, the dashboard,
 * the SLA-breach digest cron, and the merchant notification path.
 *
 * Defaults match the industry baseline merchants set if they don't
 * configure their own (Shopify retail-ops benchmarks). Each shop can
 * override via SlaConfig.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DEFAULT_SLA_HOURS = {
  approval: 48,
  pickup: 72,
  refund: 120,
} as const;

export type SlaConfig = Partial<typeof DEFAULT_SLA_HOURS>;

export type SlaStage = "approval" | "pickup" | "refund";

export type SlaBreachLevel = "ok" | "warning" | "breached";

export interface SlaBreach {
  stage: SlaStage;
  level: SlaBreachLevel;
  /** Hours elapsed in this stage. */
  elapsedHours: number;
  /** Hours allowed before breach. */
  thresholdHours: number;
  /** Exact ISO timestamp at which the SLA threshold was crossed (or
   *  is forecast to cross, if level === "warning"). null when stage
   *  is not applicable. */
  breachAt: string | null;
}

export interface ReturnCaseSlaInput {
  status: string;
  resolutionType?: string | null;
  createdAt: Date | string;
  /** Timestamp at which the admin approved the return (event-derived). */
  approvedAt?: Date | string | null;
  /** Timestamp at which Fynd reported the bag picked up (return_bag_picked). */
  pickedUpAt?: Date | string | null;
  /** Timestamp at which refund/store-credit completed. */
  refundedAt?: Date | string | null;
  /** Used to anchor "now" — defaults to current Date. Tests pass a fixed value. */
  now?: Date;
}

const TERMINAL_STATUSES = new Set([
  "rejected",
  "cancelled",
  "closed",
  "completed",
]);

/**
 * Threshold for warning before breach. We surface "warning" at 80% of
 * the SLA window so admins see things slipping before a hard breach.
 */
const WARNING_FRACTION = 0.8;

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return isNaN(x.getTime()) ? null : x;
}

function classify(elapsedHours: number, thresholdHours: number): SlaBreachLevel {
  if (elapsedHours >= thresholdHours) return "breached";
  if (elapsedHours >= thresholdHours * WARNING_FRACTION) return "warning";
  return "ok";
}

/**
 * Compute SLA state for each applicable stage. Stages that don't apply
 * to the case (e.g. pickup SLA when the case is still pending review)
 * are omitted from the result.
 */
export function computeSlaBreaches(
  input: ReturnCaseSlaInput,
  config: SlaConfig = {},
): SlaBreach[] {
  const now = input.now ?? new Date();
  const status = (input.status || "").toLowerCase();
  const resolution = (input.resolutionType || "").toLowerCase();
  const created = toDate(input.createdAt);
  const approved = toDate(input.approvedAt ?? null);
  const pickedUp = toDate(input.pickedUpAt ?? null);
  const refunded = toDate(input.refundedAt ?? null);

  const thresholds = {
    approval: (config.approval ?? DEFAULT_SLA_HOURS.approval),
    pickup: (config.pickup ?? DEFAULT_SLA_HOURS.pickup),
    refund: (config.refund ?? DEFAULT_SLA_HOURS.refund),
  };

  const out: SlaBreach[] = [];

  // Approval SLA: applies only while NOT yet approved AND status not terminal
  if (!approved && created && !TERMINAL_STATUSES.has(status)) {
    const elapsedHours = (now.getTime() - created.getTime()) / HOUR;
    out.push({
      stage: "approval",
      level: classify(elapsedHours, thresholds.approval),
      elapsedHours: round1(elapsedHours),
      thresholdHours: thresholds.approval,
      breachAt: new Date(created.getTime() + thresholds.approval * HOUR).toISOString(),
    });
  }

  // Pickup SLA: applies after approval, until pickedUpAt is set, and only
  // for resolution types that involve physical return (refund/exchange/replacement).
  // Store credit + virtual items don't need pickup.
  const requiresPickup = resolution === "" || resolution === "refund" || resolution === "exchange" || resolution === "replacement";
  if (approved && !pickedUp && requiresPickup && !TERMINAL_STATUSES.has(status)) {
    const elapsedHours = (now.getTime() - approved.getTime()) / HOUR;
    out.push({
      stage: "pickup",
      level: classify(elapsedHours, thresholds.pickup),
      elapsedHours: round1(elapsedHours),
      thresholdHours: thresholds.pickup,
      breachAt: new Date(approved.getTime() + thresholds.pickup * HOUR).toISOString(),
    });
  }

  // Refund SLA: applies after approval, until refunded
  if (approved && !refunded && !TERMINAL_STATUSES.has(status)) {
    const elapsedHours = (now.getTime() - approved.getTime()) / HOUR;
    out.push({
      stage: "refund",
      level: classify(elapsedHours, thresholds.refund),
      elapsedHours: round1(elapsedHours),
      thresholdHours: thresholds.refund,
      breachAt: new Date(approved.getTime() + thresholds.refund * HOUR).toISOString(),
    });
  }

  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Best-tone summary across all stages. Used to pick a single Banner colour. */
export function worstSlaLevel(breaches: SlaBreach[]): SlaBreachLevel {
  let worst: SlaBreachLevel = "ok";
  for (const b of breaches) {
    if (b.level === "breached") return "breached";
    if (b.level === "warning") worst = "warning";
  }
  return worst;
}

/** Human-friendly stage label. */
export function slaStageLabel(stage: SlaStage): string {
  if (stage === "approval") return "Approval";
  if (stage === "pickup") return "Pickup";
  return "Refund";
}

/** Human-friendly elapsed/breach summary, e.g. "Overdue by 6h" / "Due in 12h". */
export function describeSlaBreach(breach: SlaBreach): string {
  const overage = breach.elapsedHours - breach.thresholdHours;
  if (breach.level === "breached") {
    return overage >= 24
      ? `Overdue by ${Math.floor(overage / 24)}d`
      : `Overdue by ${Math.floor(overage)}h`;
  }
  const remaining = breach.thresholdHours - breach.elapsedHours;
  return remaining >= 24
    ? `Due in ${Math.floor(remaining / 24)}d`
    : `Due in ${Math.max(1, Math.floor(remaining))}h`;
}

export const SLA_CONSTANTS = { HOUR, DAY };
