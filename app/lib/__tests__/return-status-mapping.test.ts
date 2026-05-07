/**
 * Bug #13 — return-stage status mapping must NOT match forward-shipping events.
 *
 * Production symptom (screenshot): a return whose Fynd status was
 * `return_bag_picked` (Fynd UI: "RETURN PICKED") was rendered with the
 * timeline marker on stage 5 "Received" — wrong; should be stage 3
 * "Picked Up". Root cause: the journey array contains BOTH forward
 * (delivery_done, bag_picked, in_transit, out_for_delivery) AND return
 * events. The status-mapping function used `journeyHas("delivery_done")`
 * to detect "Return Received", matching the FORWARD delivery event
 * (when the order was originally delivered to the customer).
 *
 * Two-layer fix:
 *  1. extractFyndJourney heuristically rejects forward-side events when
 *     callers ask for "return" journey (when journey_type is missing on
 *     the event, fall back to the status name).
 *  2. computeAdminReturnState only matches return-prefixed status tokens
 *     for return-stage labels.
 */
import { describe, it, expect } from "vitest";
import { extractFyndJourney } from "../fynd-payload.server";

describe("Bug #13 — extractFyndJourney filters forward events out of return journey", () => {
  it("excludes forward-only statuses (delivery_done, bag_picked, in_transit) when missing journey_type", () => {
    // Real-world Fynd payload shape: bag_status entries without explicit
    // journey_type, mixing forward + return events on the same bag.
    const payload = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                { status: "bag_confirmed", updated_at: "2026-05-01T00:00:00Z" },
                { status: "bag_picked", updated_at: "2026-05-02T00:00:00Z" },
                { status: "in_transit", updated_at: "2026-05-03T00:00:00Z" },
                { status: "delivery_done", updated_at: "2026-05-04T00:00:00Z" }, // forward delivery to customer
                { status: "return_initiated", updated_at: "2026-05-05T00:00:00Z" },
                { status: "return_dp_assigned", updated_at: "2026-05-06T00:00:00Z" },
                { status: "return_bag_picked", updated_at: "2026-05-07T00:00:00Z" }, // current Fynd state
              ],
            },
          ],
        },
      ],
    });
    const returnJourney = extractFyndJourney(payload, "return");
    const statuses = returnJourney.map((s) => s.status);
    // Forward-side events MUST NOT appear
    expect(statuses).not.toContain("bag_confirmed");
    expect(statuses).not.toContain("bag_picked");
    expect(statuses).not.toContain("in_transit");
    expect(statuses).not.toContain("delivery_done");
    // Return-side events DO appear
    expect(statuses).toContain("return_initiated");
    expect(statuses).toContain("return_dp_assigned");
    expect(statuses).toContain("return_bag_picked");
  });

  it("excludes return-only statuses when caller asks for forward journey", () => {
    const payload = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                { status: "bag_picked", updated_at: "2026-05-02T00:00:00Z" },
                { status: "delivery_done", updated_at: "2026-05-04T00:00:00Z" },
                { status: "return_bag_picked", updated_at: "2026-05-07T00:00:00Z" },
              ],
            },
          ],
        },
      ],
    });
    const forwardJourney = extractFyndJourney(payload, "forward");
    const statuses = forwardJourney.map((s) => s.status);
    expect(statuses).toContain("bag_picked");
    expect(statuses).toContain("delivery_done");
    expect(statuses).not.toContain("return_bag_picked");
  });

  it("respects explicit bag_state_mapper.journey_type when present (legacy behavior)", () => {
    const payload = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                {
                  status: "custom_event",
                  updated_at: "2026-05-01T00:00:00Z",
                  bag_state_mapper: { journey_type: "return" },
                },
                {
                  status: "another_custom",
                  updated_at: "2026-05-02T00:00:00Z",
                  bag_state_mapper: { journey_type: "forward" },
                },
              ],
            },
          ],
        },
      ],
    });
    const returnJourney = extractFyndJourney(payload, "return");
    expect(returnJourney.map((s) => s.status)).toEqual(["custom_event"]);
  });

  it("sorts events chronologically", () => {
    const payload = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                { status: "return_bag_picked", updated_at: "2026-05-07T00:00:00Z" },
                { status: "return_initiated", updated_at: "2026-05-05T00:00:00Z" },
                { status: "return_dp_assigned", updated_at: "2026-05-06T00:00:00Z" },
              ],
            },
          ],
        },
      ],
    });
    const journey = extractFyndJourney(payload, "return");
    expect(journey.map((s) => s.status)).toEqual([
      "return_initiated",
      "return_dp_assigned",
      "return_bag_picked",
    ]);
  });
});
