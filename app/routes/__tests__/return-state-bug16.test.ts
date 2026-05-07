/**
 * Bug #16 — computeAdminReturnState must trust the live Fynd journey
 * state when the DB's `refundStatus` is stuck at "in_progress" but the
 * actual Fynd shipment is at a pre-refund logistics stage.
 *
 * Production symptom (screenshot): Fynd UI shows return_bag_picked, our
 * admin shows "Refund Processing — stage 5 (Received)". Should be
 * "Picked Up — stage 3".
 *
 * This is the third defence layer in the bug #16 fix. The first two
 * (extractRefundStatus + REFUND_IN_PROGRESS list) prevent the DB from
 * being poisoned in the first place. This layer makes the rendering
 * resilient to legacy data that's already poisoned.
 */
import { describe, it, expect } from "vitest";

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));
vi.mock("../../db.server", () => ({ default: {} }));

import { vi } from "vitest";
import { computeAdminReturnState } from "../app.returns.$id";

const journey = (
  ...statuses: Array<{ status: string; time?: string; displayName?: string; journeyType?: string }>
) =>
  statuses.map((s) => ({
    status: s.status,
    time: s.time ?? "2026-05-07T05:50:00Z",
    displayName: s.displayName ?? s.status,
    journeyType: (s.journeyType ?? "return") as "forward" | "return",
  }));

describe("Bug #16 — computeAdminReturnState honours live Fynd state over stale refundStatus", () => {
  it('shows "Picked Up" stage 3 when Fynd is at return_bag_picked, even if DB says refundStatus="in_progress"', () => {
    // Production reproduction. Order is genuinely at return_bag_picked.
    // DB has stale refundStatus="in_progress" (e.g. from an earlier
    // mis-classified webhook). Old code returned step 5; new code must
    // fall through to the journey check and return step 3.
    const state = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "return_bag_picked" }),
      "return_bag_picked",
    );
    expect(state.label).toBe("Picked Up");
    expect(state.step).toBe(3);
  });

  it('shows "In Transit" stage 4 when Fynd is at return_bag_in_transit + stale refundStatus', () => {
    const state = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "return_bag_in_transit" }),
      "return_bag_in_transit",
    );
    expect(state.label).toBe("In Transit");
    expect(state.step).toBe(4);
  });

  it('shows "Out for Delivery" stage 4 when Fynd is at out_for_delivery_to_store + stale refundStatus', () => {
    const state = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "out_for_delivery_to_store" }),
      "out_for_delivery_to_store",
    );
    expect(state.label).toBe("Out for Delivery");
    expect(state.step).toBe(4);
  });

  it("STILL shows Refund Processing when Fynd state is genuinely a refund token", () => {
    // refund_initiated is a genuine refund-stage Fynd token; we MUST show
    // "Refund Processing" here regardless of journey contents.
    const state = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "refund_initiated" }),
      "refund_initiated",
    );
    expect(state.label).toMatch(/Refund Processing|Refund is being processed/i);
    expect(state.step).toBe(5);
  });

  it("STILL shows Refund Processing when refundStatus=in_progress and journey is empty (no Fynd state)", () => {
    // Edge case: shop without Fynd integration. refundStatus is the only
    // signal. We must still surface "Refund Processing" so the admin sees
    // SOMETHING is happening.
    const state = computeAdminReturnState("approved", "in_progress", [], null);
    expect(state.label).toMatch(/Refund Processing|Refund is being processed/i);
    expect(state.step).toBe(5);
  });

  it('shows "Refund Completed" stage 6 when refundStatus=refunded regardless of journey', () => {
    const state = computeAdminReturnState(
      "completed",
      "refunded",
      journey({ status: "return_bag_picked" }),
      "return_bag_picked",
    );
    expect(state.label).toMatch(/Refund Completed|Exchange Completed/i);
    expect(state.step).toBe(6);
  });

  it('handles return_initiated / return_dp_assigned correctly (early stages, not "Refund Processing")', () => {
    const initiated = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "return_initiated" }),
      "return_initiated",
    );
    expect(initiated.step).toBeLessThanOrEqual(3); // not 5
    expect(initiated.label).not.toMatch(/Refund Processing/i);

    const dpAssigned = computeAdminReturnState(
      "approved",
      "in_progress",
      journey({ status: "return_dp_assigned" }),
      "return_dp_assigned",
    );
    expect(dpAssigned.step).toBeLessThanOrEqual(3);
    expect(dpAssigned.label).not.toMatch(/Refund Processing/i);
  });
});
