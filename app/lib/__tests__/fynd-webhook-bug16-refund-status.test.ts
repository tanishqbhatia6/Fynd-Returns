/**
 * Bug #16 — webhook mis-classification of shipment status as refund status.
 *
 * Production symptom: customer sees their return at "RETURN PICKED" on
 * Fynd (status = `return_bag_picked`), but our admin shows "Refund
 * Processing — stage 5 (Received)" — completely wrong.
 *
 * The bug had three layers (full RCA in commit message). These tests pin
 * the classifier and the extractor — the two modules that bug #16 had
 * conflated.
 */
import { describe, it, expect } from "vitest";
import { classifyFyndRefundStatus } from "../fynd-webhook.server";

describe("Bug #16 — classifyFyndRefundStatus must NOT match generic shipment statuses", () => {
  it.each([
    "in_progress",
    "processing",
    "return_bag_picked",
    "return_initiated",
    "return_dp_assigned",
    "delivery_done",
    "bag_picked",
    "out_for_pickup",
    "out_for_delivery",
    "out_for_delivery_to_store",
  ])('does NOT classify "%s" as refund-in-progress', (status) => {
    const r = classifyFyndRefundStatus(status);
    expect(r.isInProgress).toBe(false);
  });

  it.each([
    "refund_pending",
    "refund_processing",
    "refund_in_progress",
    "refund_under_process",
    "under_process",
    "under process",
    "UNDER PROCESS",
  ])('still classifies "%s" as refund-in-progress (genuine refund tokens)', (status) => {
    const r = classifyFyndRefundStatus(status);
    expect(r.isInProgress).toBe(true);
  });

  it.each(["refund_initiated", "Refund Initiated"])(
    'ignores Fynd "%s" because Shopify app owns refund initiation',
    (status) => {
      const r = classifyFyndRefundStatus(status);
      expect(r.isInProgress).toBe(false);
      expect(r.isComplete).toBe(false);
    },
  );

  it.each([
    "refund_done",
    "refunded",
    "REFUNDED",
    "Refund Done",
    "Refund Completed",
    "completed",
  ])('classifies "%s" as refund-complete', (status) => {
    const r = classifyFyndRefundStatus(status);
    expect(r.isComplete).toBe(true);
  });

  it.each(["return_bag_picked", "delivery_done", "in_progress"])(
    'does NOT classify "%s" as refund-complete',
    (status) => {
      const r = classifyFyndRefundStatus(status);
      expect(r.isComplete).toBe(false);
    },
  );

  it("treats null / undefined status as neither in-progress nor complete", () => {
    expect(classifyFyndRefundStatus(null)).toEqual({ isInProgress: false, isComplete: false });
    expect(classifyFyndRefundStatus(undefined)).toEqual({
      isInProgress: false,
      isComplete: false,
    });
    expect(classifyFyndRefundStatus("")).toEqual({ isInProgress: false, isComplete: false });
  });
});
