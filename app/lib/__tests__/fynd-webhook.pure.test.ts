import { describe, it, expect } from "vitest";
import {
  classifyFyndRefundStatus,
  shouldAdvanceFyndStatus,
  unwrapFyndWebhookPayload,
} from "../fynd-webhook.server";

/* Pure helpers — no Prisma, no network. Pairs with
   fynd-webhook.e2e tests (not yet added — heavier mocking). */

describe("classifyFyndRefundStatus", () => {
  const inProgress = [
    "refund_pending",
    "refund processing",
    "refund_in_progress",
    "under_process",
    "UNDER PROCESS",
    "refund under process",
  ];
  it.each(inProgress)("flags %s as in-progress", (s) => {
    expect(classifyFyndRefundStatus(s).isInProgress).toBe(true);
    expect(classifyFyndRefundStatus(s).isComplete).toBe(false);
  });

  const complete = ["refund_done", "refund done", "REFUNDED", "refunded", "completed"];
  it.each(complete)("flags %s as complete", (s) => {
    expect(classifyFyndRefundStatus(s).isComplete).toBe(true);
    expect(classifyFyndRefundStatus(s).isInProgress).toBe(false);
  });

  const neither = [
    "return_initiated", // logistics event, not refund
    "refund_initiated", // ignored: Shopify app owns refund initiation
    "REFUND_INITIATED",
    "return_dp_assigned",
    "bag_picked",
    "delivery_done",
    "rto_initiated",
    "",
    null,
    undefined,
  ];
  it.each(neither as string[])("leaves %s unclassified", (s) => {
    const r = classifyFyndRefundStatus(s);
    expect(r.isInProgress).toBe(false);
    expect(r.isComplete).toBe(false);
  });
});

describe("shouldAdvanceFyndStatus", () => {
  it("always advances when current is null/undefined", () => {
    expect(shouldAdvanceFyndStatus(null, "bag_picked")).toBe(true);
    expect(shouldAdvanceFyndStatus(undefined, "refund_done")).toBe(true);
  });
  it("blocks when incoming is null/undefined", () => {
    expect(shouldAdvanceFyndStatus("bag_picked", null)).toBe(false);
    expect(shouldAdvanceFyndStatus("bag_picked", "")).toBe(false);
  });
  it("allows idempotent re-writes (same status)", () => {
    expect(shouldAdvanceFyndStatus("bag_picked", "bag_picked")).toBe(true);
  });
  it("advances within the forward journey", () => {
    expect(shouldAdvanceFyndStatus("bag_confirmed", "bag_picked")).toBe(true);
    expect(shouldAdvanceFyndStatus("dp_assigned", "delivery_done")).toBe(true);
  });
  it("blocks reversion within the forward journey", () => {
    expect(shouldAdvanceFyndStatus("delivery_done", "bag_confirmed")).toBe(false);
    expect(shouldAdvanceFyndStatus("bag_picked", "dp_assigned")).toBe(false);
  });
  it("advances from forward to return journey", () => {
    expect(shouldAdvanceFyndStatus("delivery_done", "return_initiated")).toBe(true);
    expect(shouldAdvanceFyndStatus("return_initiated", "refund_done")).toBe(true);
  });
  it("allows unknown statuses through (prefer unknown over silent drop)", () => {
    expect(shouldAdvanceFyndStatus("bag_picked", "some_novel_status")).toBe(true);
    expect(shouldAdvanceFyndStatus("some_novel_status", "bag_picked")).toBe(true);
  });
  it("handles case + whitespace normalisation", () => {
    expect(shouldAdvanceFyndStatus("Bag Picked", "delivery_done")).toBe(true);
    expect(shouldAdvanceFyndStatus("DELIVERY DONE", "bag_picked")).toBe(false);
  });
});

describe("unwrapFyndWebhookPayload", () => {
  it("returns inner payload when wrapped in { payload }", () => {
    const body = JSON.stringify({
      event: "shipment.updated",
      payload: { shipment_id: "SH1", status: "bag_picked" },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("SH1");
    expect(r.payload.status).toBe("bag_picked");
  });

  it("returns inner payload when wrapped in { data }", () => {
    const body = JSON.stringify({
      data: { shipment_id: "SH2", order_id: "OR2" },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("SH2");
    expect(r.payload.order_id).toBe("OR2");
  });

  it("returns inner payload when wrapped in { shipment }", () => {
    const body = JSON.stringify({
      shipment: { shipment_id: "SH3" },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("SH3");
  });

  it("keeps top-level fields that coexist with envelope", () => {
    // Fynd sometimes puts auth IDs at the top AND nested — we must not
    // lose the top level.
    const body = JSON.stringify({
      shipment_id: "TOP",
      payload: { status: "bag_picked" },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("TOP");
    expect(r.payload.status).toBe("bag_picked");
  });

  it("flattens shipment_status object onto inner", () => {
    const body = JSON.stringify({
      shipment_status: { shipment_id: "FLAT1", status: "delivery_done", order_id: "O1" },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("FLAT1");
    expect(r.payload.status).toBe("delivery_done");
    expect(r.payload.order_id).toBe("O1");
  });

  it("promotes first shipment's fields when shipments[] present", () => {
    const body = JSON.stringify({
      shipments: [
        {
          shipment_id: "S-FIRST",
          order_id: "O-FIRST",
          order: { affiliate_order_id: "AFF1" },
        },
      ],
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.shipment_id).toBe("S-FIRST");
    expect(r.payload.order_id).toBe("O-FIRST");
    expect(r.payload.affiliate_order_id).toBe("AFF1");
  });

  it("pulls identifiers from affiliate_details", () => {
    const body = JSON.stringify({
      affiliate_details: { affiliate_order_id: "AFF2", affiliate_bag_id: "BAG2" },
    });
    const r = unwrapFyndWebhookPayload(body) as {
      payload: { affiliate_order_id?: string; affiliate_bag_id?: string };
      eventType: string | undefined;
    };
    expect(r.payload.affiliate_order_id).toBe("AFF2");
    expect(r.payload.affiliate_bag_id).toBe("BAG2");
  });

  it("pulls AWB + tracking_url from delivery_partner_details", () => {
    const body = JSON.stringify({
      delivery_partner_details: {
        awb_no: "AB123",
        tracking_url: "https://track/ab123",
      },
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.awb_no).toBe("AB123");
    expect(r.payload.tracking_url).toBe("https://track/ab123");
  });

  it("pulls shop_domain and journey_type from bags[0].affiliate_bag_details", () => {
    const body = JSON.stringify({
      bags: [
        {
          affiliate_bag_details: {
            affiliate_order_id: "AFF3",
            affiliate_meta: { shop_domain: "my-store.myshopify.com" },
          },
          bag_status_history: [
            {
              bag_state_mapper: {
                name: "return_initiated",
                journey_type: "return",
              },
            },
          ],
        },
      ],
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload._shop_domain).toBe("my-store.myshopify.com");
    expect(r.payload._journey_type).toBe("return");
    expect(r.payload.status).toBe("return_initiated");
  });

  it("handles deeply-nested order.fynd_order_id from first shipment", () => {
    const body = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          order: { fynd_order_id: "FY100" },
        },
      ],
    });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.order_id).toBe("FY100");
  });

  it("propagates meta.order_id when not on inner", () => {
    const body = JSON.stringify({ meta: { order_id: "META_ORDER" } });
    const r = unwrapFyndWebhookPayload(body);
    expect(r.payload.order_id).toBe("META_ORDER");
  });
});
