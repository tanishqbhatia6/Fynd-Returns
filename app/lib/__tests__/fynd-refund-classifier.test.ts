/**
 * Regression tests for classifyFyndRefundStatus.
 *
 * Background: a previous loose regex (`/initiated|pending|processing/`) matched
 * logistics journey events like `return_initiated` and `rto_initiated`, which caused
 * the webhook to flip refundStatus → "in_progress" and the admin timeline to jump to
 * "Refund Processing" with all six progress steps green — long before any refund had
 * actually been requested. These tests pin the new behaviour.
 */
import { describe, it, expect } from "vitest";
import { classifyFyndRefundStatus } from "../fynd-webhook.server";

describe("classifyFyndRefundStatus", () => {
  describe("logistics journey events MUST NOT be classified as refund events", () => {
    const journeyStatuses = [
      "return_initiated",
      "return_dp_assigned",
      "return_bag_picked",
      "return_bag_in_transit",
      "return_bag_delivered",
      "return_accepted",
      "rto_initiated",
      "rto_dp_assigned",
      "bag_confirmed",
      "out_for_delivery",
      "delivery_done",
      "out_for_pickup",
      "dp_out_for_pickup",
      "bag_picked",
      "in_transit",
    ];
    for (const status of journeyStatuses) {
      it(`"${status}" is neither in-progress nor complete`, () => {
        const r = classifyFyndRefundStatus(status);
        expect(r.isInProgress).toBe(false);
        expect(r.isComplete).toBe(false);
      });
    }
  });

  describe("true refund-in-progress tokens are detected", () => {
    const inProgressStatuses = [
      "refund_initiated",
      "refund_pending",
      "refund_processing",
      "refund_in_progress",
      "refund_under_process",
      "REFUND_INITIATED",
      "Refund Initiated",
      "Refund Pending",
      "UNDER PROCESS",
      "under_process",
      "in_progress",
      "processing",
    ];
    for (const status of inProgressStatuses) {
      it(`"${status}" is in_progress`, () => {
        const r = classifyFyndRefundStatus(status);
        expect(r.isInProgress).toBe(true);
        expect(r.isComplete).toBe(false);
      });
    }
  });

  describe("refund-complete tokens are detected", () => {
    const completeStatuses = [
      "refund_done",
      "refunded",
      "REFUNDED",
      "Refund Done",
      "Refund Completed",
      "refund_completed",
      "completed",
      "COMPLETED",
    ];
    for (const status of completeStatuses) {
      it(`"${status}" is complete`, () => {
        const r = classifyFyndRefundStatus(status);
        expect(r.isComplete).toBe(true);
        // "completed" is technically ambiguous (could mean shipment completed) but we
        // accept it as refund_complete for backward compatibility — what matters is that
        // logistics events do NOT trip it.
      });
    }
  });

  describe("edge cases", () => {
    it("null/empty/undefined are neutral", () => {
      expect(classifyFyndRefundStatus(null)).toEqual({ isInProgress: false, isComplete: false });
      expect(classifyFyndRefundStatus(undefined)).toEqual({ isInProgress: false, isComplete: false });
      expect(classifyFyndRefundStatus("")).toEqual({ isInProgress: false, isComplete: false });
    });

    it("unrelated tokens are neutral", () => {
      expect(classifyFyndRefundStatus("bag_packed")).toEqual({ isInProgress: false, isComplete: false });
      expect(classifyFyndRefundStatus("handed_over_to_customer")).toEqual({ isInProgress: false, isComplete: false });
      expect(classifyFyndRefundStatus("deadstock")).toEqual({ isInProgress: false, isComplete: false });
    });
  });
});
