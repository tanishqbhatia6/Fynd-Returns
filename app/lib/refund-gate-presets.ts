/**
 * Refund Gate Presets — maps simple seller-friendly labels
 * to the underlying Fynd status arrays stored in `allowedFyndStatusesForRefund`.
 *
 * The `process_refund` backend gate (api.returns.$id.actions.ts) reads
 * `allowedFyndStatusesForRefund` directly — presets just auto-populate that
 * field on save so sellers don't need to know raw Fynd status codes.
 */

export type RefundGatePreset = "none" | "after_pickup" | "after_delivery" | "after_qc" | "custom";

/** Fynd statuses in the refund-processing phase — always included in non-"none" presets */
const REFUND_FLOW_STATUSES = [
  "refund_initiated",
  "refund_on_hold",
  "refund_acknowledged",
  "refund_pending",
  "refund_pending_for_approval",
  "beneficiary_awaited",
  "manual_refund",
  "credit_note_generated",
];

/**
 * Mapping from preset key → array of allowed Fynd statuses.
 * Each preset includes all statuses from that milestone onward,
 * plus all refund-flow statuses (if Fynd is already processing refund,
 * the seller should be able to issue the Shopify refund too).
 */
const PRESET_STATUS_MAP: Record<Exclude<RefundGatePreset, "none" | "custom">, string[]> = {
  after_pickup: [
    "return_bag_picked",
    "return_bag_in_transit",
    "return_bag_out_for_delivery",
    "out_for_delivery_to_store",
    "return_bag_delivered",
    "return_delivered",
    "return_accepted",
    "return_completed",
    ...REFUND_FLOW_STATUSES,
  ],
  after_delivery: [
    "return_bag_delivered",
    "return_delivered",
    "return_accepted",
    "return_completed",
    ...REFUND_FLOW_STATUSES,
  ],
  after_qc: [
    "return_accepted",
    "return_completed",
    ...REFUND_FLOW_STATUSES,
  ],
};

/**
 * Returns the array of allowed Fynd statuses for a given preset.
 * - "none" → null (gate disabled)
 * - "custom" → null (caller should use the raw allowedFyndStatusesForRefund)
 * - otherwise → the preset's mapped statuses
 */
export function getStatusesForPreset(preset: RefundGatePreset): string[] | null {
  if (preset === "none" || preset === "custom") return null;
  return PRESET_STATUS_MAP[preset] ?? null;
}

/**
 * Given an existing array of allowed statuses, infer which preset matches.
 * Used for migration: shops that already have allowedFyndStatusesForRefund
 * but no refundGatePreset yet.
 */
export function inferPresetFromStatuses(statuses: string[]): RefundGatePreset {
  if (!statuses || statuses.length === 0) return "none";

  for (const [preset, presetStatuses] of Object.entries(PRESET_STATUS_MAP)) {
    const presetSet = new Set(presetStatuses);
    const statusSet = new Set(statuses);
    if (
      presetSet.size === statusSet.size &&
      [...presetSet].every((s) => statusSet.has(s))
    ) {
      return preset as RefundGatePreset;
    }
  }

  return "custom";
}

/** Human-readable labels for each preset (used in settings UI + return detail page). */
export const PRESET_LABELS: Record<RefundGatePreset, { label: string; description: string }> = {
  none: {
    label: "No restriction",
    description: "Refunds allowed regardless of Fynd return status",
  },
  after_pickup: {
    label: "After bag is picked up",
    description: "Allow refund once the courier picks up the return bag",
  },
  after_delivery: {
    label: "After bag reaches warehouse",
    description: "Allow refund once the return bag is delivered to the warehouse",
  },
  after_qc: {
    label: "After QC / acceptance",
    description: "Allow refund only after the warehouse inspects and accepts the items",
  },
  custom: {
    label: "Custom",
    description: "Manually select which Fynd statuses allow refunds",
  },
};
