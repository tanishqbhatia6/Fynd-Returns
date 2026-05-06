import { describe, it, expect } from "vitest";
import { unwrapFyndWebhookPayload } from "../fynd-webhook.server";

/**
 * Coverage closure for the `inner.shipment` fallback block (lines ~472-508).
 * This block runs only when, after the primary envelope unwrap, `inner.shipment`
 * still exists as an object — typically when an outer envelope ("payload") was
 * used AND the merchant ALSO put a `shipment` object alongside it. Exercises
 * promotion of order_id, sMeta.affiliate_order_id/order_id/shipment_id, and
 * bags[0].affiliate_bag_details.{affiliate_order_id, affiliate_meta.shop_domain}.
 */
describe("unwrapFyndWebhookPayload — inner.shipment fallback promotion", () => {
  it("promotes sOrder.order_id when neither outer nor envelope set it", () => {
    const raw = JSON.stringify({
      // Use `payload` envelope so `shipment` is NOT consumed by the unwrap branch
      payload: {
        // intentionally empty — primary envelope provides nothing
        evt: "x",
      },
      // Top-level shipment object with NO outer order_id / affiliate_order_id
      shipment: {
        order: {
          // Only `order_id` set — neither fynd_order_id nor outer order_id present
          order_id: "FY-FALLBACK-ORDER-1",
        },
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.order_id).toBe("FY-FALLBACK-ORDER-1");
  });

  it("promotes sMeta.{affiliate_order_id, order_id, shipment_id} from inner.shipment.meta", () => {
    const raw = JSON.stringify({
      payload: { evt: "x" },
      shipment: {
        // No outer affiliate/order/shipment ids on `shipment` itself
        affiliate_details: {},
        meta: {
          affiliate_order_id: "AFF-META-1",
          order_id: "ORD-META-1",
          shipment_id: "SHP-META-1",
        },
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.affiliate_order_id).toBe("AFF-META-1");
    expect(payload.order_id).toBe("ORD-META-1");
    expect(payload.shipment_id).toBe("SHP-META-1");
  });

  it("promotes inner.shipment.bags[0].affiliate_bag_details.affiliate_order_id and affiliate_meta.shop_domain", () => {
    const raw = JSON.stringify({
      payload: { evt: "x" },
      shipment: {
        bags: [
          {
            affiliate_bag_details: {
              affiliate_order_id: "AFF-BAG-1",
              affiliate_meta: { shop_domain: "shop-from-bag.myshopify.com" },
            },
          },
        ],
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.affiliate_order_id).toBe("AFF-BAG-1");
    expect((payload as Record<string, unknown>)._shop_domain).toBe(
      "shop-from-bag.myshopify.com",
    );
  });
});
