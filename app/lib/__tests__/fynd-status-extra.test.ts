/**
 * Extra parameterized coverage for shouldAdvanceFyndStatus +
 * classifyFyndRefundStatus.
 *
 * Complements:
 *   - fynd-status-precedence.test.ts (focused regression cases)
 *   - fynd-refund-classifier.test.ts (logistics-vs-refund disambiguation)
 *
 * Goal: pairwise-cover the FYND_STATUS_PRECEDENCE map so any future tweak to
 * the rank table is caught by the suite. We mirror the (private) precedence
 * table here as STATUS_RANK and drive `it.each` from it.
 */
import { describe, it, expect } from "vitest";
import { shouldAdvanceFyndStatus, classifyFyndRefundStatus } from "../fynd-webhook.server";

// Mirror of FYND_STATUS_PRECEDENCE in fynd-webhook.server.ts. If you change
// that map, mirror the change here — these tests pin the contract.
const STATUS_RANK: Record<string, number> = {
  // Forward (pre-delivery)
  bag_confirmed: 10,
  bag_invoiced: 11,
  dp_assigned: 12,
  bag_packed: 13,
  bag_picked: 14,
  out_for_delivery: 15,
  delivery_done: 16,
  handed_over_to_customer: 16,
  // Return journey
  return_initiated: 20,
  return_dp_assigned: 21,
  out_for_pickup: 22,
  dp_out_for_pickup: 22,
  return_bag_picked: 23,
  return_bag_in_transit: 24,
  out_for_delivery_to_store: 25,
  return_bag_out_for_delivery: 25,
  return_bag_delivered: 26,
  return_delivered: 26,
  return_accepted: 27,
  // Refund stages
  credit_note_generated: 30,
  credit_note: 30,
  refund_pending: 31,
  refund_initiated: 32,
  refund_processing: 32,
  refund_in_progress: 32,
  refund_under_process: 32,
  in_progress: 32,
  processing: 32,
  refund_done: 40,
  refund_completed: 40,
  refunded: 40,
  completed: 40,
  return_completed: 41,
  // RTO branch
  rto_initiated: 35,
  rto_dp_assigned: 36,
  rto_bag_in_transit: 37,
  rto_bag_delivered: 38,
  rto_bag_accepted: 39,
};

// ---------------------------------------------------------------------------
// shouldAdvanceFyndStatus — pairwise across-rank coverage
// ---------------------------------------------------------------------------

/**
 * Ordered representative tour through the precedence map. Picking one
 * representative per distinct rank (plus a couple of equal-rank companions)
 * gives us a chain that pairwise-covers every rank boundary.
 */
const ORDERED_CHAIN: Array<[string, number]> = [
  ["bag_confirmed", 10],
  ["bag_invoiced", 11],
  ["dp_assigned", 12],
  ["bag_packed", 13],
  ["bag_picked", 14],
  ["out_for_delivery", 15],
  ["delivery_done", 16],
  ["return_initiated", 20],
  ["return_dp_assigned", 21],
  ["out_for_pickup", 22],
  ["return_bag_picked", 23],
  ["return_bag_in_transit", 24],
  ["out_for_delivery_to_store", 25],
  ["return_bag_delivered", 26],
  ["return_accepted", 27],
  ["credit_note_generated", 30],
  ["refund_pending", 31],
  ["refund_initiated", 32],
  ["rto_initiated", 35],
  ["rto_dp_assigned", 36],
  ["rto_bag_in_transit", 37],
  ["rto_bag_delivered", 38],
  ["rto_bag_accepted", 39],
  ["refund_done", 40],
  ["return_completed", 41],
];

// Adjacent forward pairs: (n, n+1) — must always advance.
const ADJACENT_FORWARD_PAIRS: Array<[string, string]> = [];
for (let i = 0; i < ORDERED_CHAIN.length - 1; i += 1) {
  ADJACENT_FORWARD_PAIRS.push([ORDERED_CHAIN[i][0], ORDERED_CHAIN[i + 1][0]]);
}

// Adjacent reverse pairs: (n+1, n) — must always be refused.
const ADJACENT_REVERSE_PAIRS: Array<[string, string]> = ADJACENT_FORWARD_PAIRS.map(
  ([a, b]) => [b, a] as [string, string],
);

// Long-jump forward pairs (skip several ranks).
const LONG_FORWARD_PAIRS: Array<[string, string]> = [
  ["bag_confirmed", "return_completed"],
  ["bag_confirmed", "refund_done"],
  ["return_initiated", "refund_done"],
  ["return_initiated", "return_completed"],
  ["bag_picked", "rto_bag_accepted"],
  ["dp_assigned", "credit_note_generated"],
];

// Long-jump reverse pairs (must be refused).
const LONG_REVERSE_PAIRS: Array<[string, string]> = LONG_FORWARD_PAIRS.map(
  ([a, b]) => [b, a] as [string, string],
);

// Equal-rank pairs (different keys, same rank). incRank >= curRank ⇒ should advance.
const EQUAL_RANK_PAIRS: Array<[string, string]> = [
  ["delivery_done", "handed_over_to_customer"],
  ["handed_over_to_customer", "delivery_done"],
  ["out_for_pickup", "dp_out_for_pickup"],
  ["dp_out_for_pickup", "out_for_pickup"],
  ["out_for_delivery_to_store", "return_bag_out_for_delivery"],
  ["return_bag_out_for_delivery", "out_for_delivery_to_store"],
  ["return_bag_delivered", "return_delivered"],
  ["return_delivered", "return_bag_delivered"],
  ["credit_note_generated", "credit_note"],
  ["credit_note", "credit_note_generated"],
  ["refund_initiated", "refund_processing"],
  ["refund_processing", "refund_in_progress"],
  ["refund_in_progress", "refund_under_process"],
  ["in_progress", "processing"],
  ["processing", "refund_initiated"],
  ["refund_done", "refund_completed"],
  ["refund_completed", "refunded"],
  ["refunded", "completed"],
  ["completed", "refund_done"],
];

describe("shouldAdvanceFyndStatus — pairwise across the precedence map", () => {
  it.each(ADJACENT_FORWARD_PAIRS)(
    "advances forward across adjacent ranks: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
      // Sanity-check the mirror: rank really did increase.
      expect(STATUS_RANK[incoming]).toBeGreaterThan(STATUS_RANK[current]);
    },
  );

  it.each(ADJACENT_REVERSE_PAIRS)(
    "refuses reverse across adjacent ranks: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(false);
      expect(STATUS_RANK[incoming]).toBeLessThan(STATUS_RANK[current]);
    },
  );

  it.each(LONG_FORWARD_PAIRS)(
    "advances forward across long jumps: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
    },
  );

  it.each(LONG_REVERSE_PAIRS)(
    "refuses reverse across long jumps: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(false);
    },
  );

  it.each(EQUAL_RANK_PAIRS)(
    "allows equal-rank cross-write (incRank >= curRank): %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
      expect(STATUS_RANK[current]).toBe(STATUS_RANK[incoming]);
    },
  );
});

// ---------------------------------------------------------------------------
// shouldAdvanceFyndStatus — null/empty/unknown/normalisation
// ---------------------------------------------------------------------------

describe("shouldAdvanceFyndStatus — boundary inputs", () => {
  const FIRST_TRANSITIONS: Array<[string | null | undefined, string]> = [
    [null, "bag_confirmed"],
    [undefined, "return_initiated"],
    ["", "refund_done"],
    [null, "rto_initiated"],
    [undefined, "completely_unknown_status"],
  ];
  it.each(FIRST_TRANSITIONS)("allows first transition from %s -> %s", (current, incoming) => {
    expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
  });

  const REJECT_INCOMING_EMPTY: Array<[string, string | null | undefined]> = [
    ["bag_confirmed", null],
    ["return_initiated", undefined],
    ["refund_done", ""],
    ["rto_initiated", null],
  ];
  it.each(REJECT_INCOMING_EMPTY)(
    "refuses when incoming is empty/null: cur=%s inc=%s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(false);
    },
  );

  const IDEMPOTENT_PAIRS: Array<[string, string]> = [
    ["bag_confirmed", "bag_confirmed"],
    ["return_initiated", "RETURN_INITIATED"],
    ["refund_done", "Refund Done"],
    ["rto_bag_accepted", "rto bag accepted"],
    ["completely_unknown", "completely_unknown"],
  ];
  it.each(IDEMPOTENT_PAIRS)(
    "treats normalised-equal statuses as idempotent: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
    },
  );

  const UNKNOWN_PAIRS: Array<[string, string]> = [
    ["return_bag_picked", "some_new_fynd_status_v2"],
    ["legacy_status_xyz", "return_dp_assigned"],
    ["totally_unknown_a", "totally_unknown_b"],
    ["refund_done", "brand_new_terminal_state"],
  ];
  it.each(UNKNOWN_PAIRS)("lets unknown statuses through: %s -> %s", (current, incoming) => {
    expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
  });

  const NORMALISATION_FORWARD: Array<[string, string]> = [
    ["BAG CONFIRMED", "bag_picked"],
    ["bag confirmed", "BAG_PICKED"],
    ["Return Initiated", "Return Bag Picked"],
    ["return  initiated", "return_bag_picked"], // collapse runs of whitespace
  ];
  it.each(NORMALISATION_FORWARD)(
    "normalises whitespace + case for forward moves: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(true);
    },
  );

  const NORMALISATION_REVERSE: Array<[string, string]> = [
    ["Refund Done", "return_bag_picked"],
    ["REFUND_DONE", "Return Bag Picked"],
    ["return completed", "refund_pending"],
  ];
  it.each(NORMALISATION_REVERSE)(
    "normalises whitespace + case for reverse refusals: %s -> %s",
    (current, incoming) => {
      expect(shouldAdvanceFyndStatus(current, incoming)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// classifyFyndRefundStatus — extra parameterised coverage
// ---------------------------------------------------------------------------

describe("classifyFyndRefundStatus — extra parameterised coverage", () => {
  type ClassifyCase = {
    label: string;
    input: string | null | undefined;
    isInProgress: boolean;
    isComplete: boolean;
  };

  const CASES: ClassifyCase[] = [
    // In-progress canonical tokens
    {
      label: "refund_initiated lowercase",
      input: "refund_initiated",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "refund_pending lowercase",
      input: "refund_pending",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "refund_processing lowercase",
      input: "refund_processing",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "refund_in_progress lowercase",
      input: "refund_in_progress",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "refund_under_process lowercase",
      input: "refund_under_process",
      isInProgress: true,
      isComplete: false,
    },
    // In-progress with whitespace / mixed case
    {
      label: "Refund Initiated mixed case w/ space",
      input: "Refund Initiated",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "REFUND PENDING upper w/ space",
      input: "REFUND PENDING",
      isInProgress: true,
      isComplete: false,
    },
    {
      label: "refund processing space-separated",
      input: "refund processing",
      isInProgress: true,
      isComplete: false,
    },
    // Bare "in_progress"/"processing"/"under_process" (in REFUND_IN_PROGRESS list)
    { label: "in_progress bare", input: "in_progress", isInProgress: true, isComplete: false },
    { label: "processing bare", input: "processing", isInProgress: true, isComplete: false },
    { label: "under_process bare", input: "under_process", isInProgress: true, isComplete: false },

    // Complete
    { label: "refund_done", input: "refund_done", isInProgress: false, isComplete: true },
    { label: "refund_completed", input: "refund_completed", isInProgress: false, isComplete: true },
    { label: "refunded lowercase", input: "refunded", isInProgress: false, isComplete: true },
    { label: "REFUNDED upper", input: "REFUNDED", isInProgress: false, isComplete: true },
    {
      label: "Refund Done mixed case w/ space",
      input: "Refund Done",
      isInProgress: false,
      isComplete: true,
    },
    { label: "completed bare", input: "completed", isInProgress: false, isComplete: true },

    // Logistics journey events — must be neutral
    {
      label: "return_initiated logistics",
      input: "return_initiated",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "return_dp_assigned logistics",
      input: "return_dp_assigned",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "return_bag_picked logistics",
      input: "return_bag_picked",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "return_bag_in_transit logistics",
      input: "return_bag_in_transit",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "return_bag_delivered logistics",
      input: "return_bag_delivered",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "return_accepted logistics",
      input: "return_accepted",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "rto_initiated logistics",
      input: "rto_initiated",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "rto_dp_assigned logistics",
      input: "rto_dp_assigned",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "bag_confirmed logistics",
      input: "bag_confirmed",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "out_for_delivery logistics",
      input: "out_for_delivery",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "delivery_done logistics",
      input: "delivery_done",
      isInProgress: false,
      isComplete: false,
    },
    {
      label: "out_for_pickup logistics",
      input: "out_for_pickup",
      isInProgress: false,
      isComplete: false,
    },
    { label: "deadstock logistics", input: "deadstock", isInProgress: false, isComplete: false },
    {
      label: "credit_note_generated",
      input: "credit_note_generated",
      isInProgress: false,
      isComplete: false,
    },

    // Empty / null / undefined
    { label: "null", input: null, isInProgress: false, isComplete: false },
    { label: "undefined", input: undefined, isInProgress: false, isComplete: false },
    { label: "empty string", input: "", isInProgress: false, isComplete: false },

    // Unknown / unrelated
    { label: "garbage", input: "xyz_unknown", isInProgress: false, isComplete: false },
    {
      label: "partial-match initiated (logistics) is NOT refund",
      input: "rto_initiated",
      isInProgress: false,
      isComplete: false,
    },
  ];

  it.each(CASES)(
    "$label -> isInProgress=$isInProgress, isComplete=$isComplete",
    ({ input, isInProgress, isComplete }) => {
      const result = classifyFyndRefundStatus(input);
      expect(result.isInProgress).toBe(isInProgress);
      expect(result.isComplete).toBe(isComplete);
    },
  );
});
