/**
 * Tests for unwrapFyndWebhookPayload — the critical envelope parsing logic.
 * Ensures top-level IDs are never lost when envelope keys (payload, data, shipment) exist.
 */
import { describe, it, expect } from "vitest";
import { unwrapFyndWebhookPayload } from "../fynd-webhook.server";

describe("unwrapFyndWebhookPayload", () => {
  it("preserves top-level shipment_id and order_id when body.shipment exists", () => {
    const raw = JSON.stringify({
      shipment: {
        status: "return_bag_out_for_delivery",
        bag_list: ["3787992"],
        meta: { request_meta: {} },
        id: 5628267,
        display_name: "Out for Delivery to Store",
        current_shipment_status: "return_bag_out_for_delivery",
      },
      shipment_id: "17732669795541343843",
      order_id: "FYMP69B039D201063966",
      application_id: "67a09b70c8ea7c9123f00fab",
      company_id: 2263,
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("17732669795541343843");
    expect(payload.order_id).toBe("FYMP69B039D201063966");
    expect(payload.application_id).toBe("67a09b70c8ea7c9123f00fab");
    // Nested fields should also be accessible
    expect(payload.status).toBe("return_bag_out_for_delivery");
    expect(payload.current_shipment_status).toBe("return_bag_out_for_delivery");
  });

  it("preserves top-level IDs when body.payload exists", () => {
    const raw = JSON.stringify({
      payload: {
        status: "refund_done",
        bags: [],
      },
      shipment_id: "SHIP123",
      order_id: "ORDER456",
      event: { type: "shipment_update" },
    });

    const { payload, eventType } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("SHIP123");
    expect(payload.order_id).toBe("ORDER456");
    expect(payload.status).toBe("refund_done");
    expect(eventType).toBe("shipment_update");
  });

  it("preserves top-level IDs when body.data exists", () => {
    const raw = JSON.stringify({
      data: {
        status: "return_initiated",
        meta: { some: "info" },
      },
      shipment_id: "SHIP789",
      affiliate_order_id: "AFF001",
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("SHIP789");
    expect(payload.affiliate_order_id).toBe("AFF001");
    expect(payload.status).toBe("return_initiated");
  });

  it("handles direct body without envelope wrapper", () => {
    const raw = JSON.stringify({
      shipment_id: "DIRECT123",
      order_id: "DIRECT456",
      status: "bag_picked",
      refund_status: "in_progress",
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("DIRECT123");
    expect(payload.order_id).toBe("DIRECT456");
  });

  it("top-level IDs win over nested IDs on conflict", () => {
    const raw = JSON.stringify({
      shipment: {
        shipment_id: "NESTED_ID",
        order_id: "NESTED_ORDER",
        status: "return_delivered",
      },
      shipment_id: "TOP_LEVEL_ID",
      order_id: "TOP_LEVEL_ORDER",
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    // Top-level values should win
    expect(payload.shipment_id).toBe("TOP_LEVEL_ID");
    expect(payload.order_id).toBe("TOP_LEVEL_ORDER");
  });

  it("uses nested IDs when top-level IDs are absent", () => {
    const raw = JSON.stringify({
      shipment: {
        shipment_id: "NESTED_ONLY",
        status: "bag_confirmed",
      },
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("NESTED_ONLY");
  });

  it("handles shipment_status object flattening", () => {
    const raw = JSON.stringify({
      shipment_id: "FLAT123",
      shipment_status: {
        status: "refund_initiated",
        order_id: "ORDER_FROM_STATUS",
      },
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("FLAT123");
    expect(payload.order_id).toBe("ORDER_FROM_STATUS");
  });

  it("promotes fields from affiliate_details", () => {
    const raw = JSON.stringify({
      shipment_id: "SHIP_AFF",
      affiliate_details: {
        affiliate_order_id: "AFF_ORDER_123",
      },
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("SHIP_AFF");
    expect(payload.affiliate_order_id).toBe("AFF_ORDER_123");
  });

  it("keeps lifecycle status separate from refund_status (bug #16 follow-up)", () => {
    // Old behaviour: unwrap leaked `current_shipment_status` into refund_status.
    // New behaviour: refund_status stays undefined when no genuine refund_status
    // field was provided. Lifecycle goes to current_shipment_status only.
    const raw = JSON.stringify({
      shipment: {
        current_shipment_status: "return_bag_out_for_delivery",
      },
      shipment_id: "SHIP999",
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("SHIP999");
    expect(payload.refund_status).toBeUndefined();
    expect(payload.current_shipment_status).toBe("return_bag_out_for_delivery");
  });

  it("does not treat array body.shipment as envelope", () => {
    const raw = JSON.stringify({
      shipment: [{ id: 1 }, { id: 2 }],
      shipment_id: "ARRAY_SHIP",
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("ARRAY_SHIP");
  });

  it("handles deeply nested Fynd payload with bags and bag_status_history", () => {
    const raw = JSON.stringify({
      shipment: {
        status: "return_bag_delivered",
      },
      shipment_id: "DEEP123",
      order_id: "DEEP_ORDER",
      bags: [
        {
          affiliate_bag_details: {
            affiliate_order_id: "DEEP_AFF",
          },
          bag_status_history: [
            {
              bag_state_mapper: {
                journey_type: "return",
                name: "return_bag_delivered",
              },
            },
          ],
        },
      ],
    });

    const { payload } = unwrapFyndWebhookPayload(raw);

    expect(payload.shipment_id).toBe("DEEP123");
    expect(payload.order_id).toBe("DEEP_ORDER");
    expect(payload.affiliate_order_id).toBe("DEEP_AFF");
  });
});
