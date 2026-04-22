/**
 * Pin the forward-only Fynd status advancement rule (P1 fix from QA audit).
 *
 * Bug repro: out-of-order webhooks (e.g. a delayed `bag_picked` arriving after
 * `return_completed`) used to overwrite `fyndCurrentStatus`, reverting the
 * visible journey state. The new rule refuses downgrades within the known
 * precedence sequence but lets unknown statuses through (better to record an
 * unknown than silently drop it).
 */
import { describe, it, expect } from "vitest";
import { shouldAdvanceFyndStatus } from "../fynd-webhook.server";

describe("shouldAdvanceFyndStatus", () => {
  describe("forward advancement", () => {
    it("allows forward journey progress", () => {
      expect(shouldAdvanceFyndStatus("bag_confirmed", "bag_picked")).toBe(true);
      expect(shouldAdvanceFyndStatus("return_initiated", "return_dp_assigned")).toBe(true);
      expect(shouldAdvanceFyndStatus("return_dp_assigned", "return_bag_picked")).toBe(true);
      expect(shouldAdvanceFyndStatus("return_bag_in_transit", "return_bag_delivered")).toBe(true);
      expect(shouldAdvanceFyndStatus("return_accepted", "refund_initiated")).toBe(true);
      expect(shouldAdvanceFyndStatus("refund_initiated", "refund_done")).toBe(true);
    });

    it("allows transition from null/empty (first webhook)", () => {
      expect(shouldAdvanceFyndStatus(null, "return_initiated")).toBe(true);
      expect(shouldAdvanceFyndStatus(undefined, "bag_confirmed")).toBe(true);
      expect(shouldAdvanceFyndStatus("", "dp_assigned")).toBe(true);
    });

    it("allows idempotent re-write of the same status", () => {
      expect(shouldAdvanceFyndStatus("return_bag_picked", "return_bag_picked")).toBe(true);
      expect(shouldAdvanceFyndStatus("REFUND_DONE", "refund_done")).toBe(true);
    });
  });

  describe("downgrade prevention (the bug repro)", () => {
    it("refuses to revert a refund-complete return back to a journey state", () => {
      expect(shouldAdvanceFyndStatus("refund_done", "return_bag_picked")).toBe(false);
      expect(shouldAdvanceFyndStatus("refund_completed", "return_dp_assigned")).toBe(false);
      expect(shouldAdvanceFyndStatus("refunded", "out_for_pickup")).toBe(false);
    });

    it("refuses to revert a delivered return back to in-transit", () => {
      expect(shouldAdvanceFyndStatus("return_bag_delivered", "return_bag_in_transit")).toBe(false);
      expect(shouldAdvanceFyndStatus("return_accepted", "return_bag_picked")).toBe(false);
    });

    it("refuses to revert a picked-up return back to dp_assigned", () => {
      expect(shouldAdvanceFyndStatus("return_bag_picked", "return_dp_assigned")).toBe(false);
    });
  });

  describe("unknown statuses are allowed through (don't silently drop)", () => {
    it("allows when the incoming status is unknown", () => {
      // We'd rather record a new/unrecognised status than drop it.
      expect(shouldAdvanceFyndStatus("return_bag_picked", "some_new_fynd_status_v2")).toBe(true);
    });

    it("allows when the current status is unknown", () => {
      expect(shouldAdvanceFyndStatus("legacy_status_xyz", "return_dp_assigned")).toBe(true);
    });
  });

  describe("normalisation", () => {
    it("normalises whitespace and case", () => {
      expect(shouldAdvanceFyndStatus("BAG CONFIRMED", "bag_picked")).toBe(true);
      expect(shouldAdvanceFyndStatus("Refund Done", "return_bag_picked")).toBe(false);
    });
  });

  describe("incoming empty/null is rejected", () => {
    it("returns false when incoming status is empty", () => {
      expect(shouldAdvanceFyndStatus("return_initiated", null)).toBe(false);
      expect(shouldAdvanceFyndStatus("return_initiated", "")).toBe(false);
    });
  });
});
