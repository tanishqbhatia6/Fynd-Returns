/**
 * Prod-readiness audit — regression coverage for all six fix layers added
 * after bugs #15 + #16 surfaced. Each `describe` block pins one of the
 * audit fixes so a future drift back toward the loose / cross-domain
 * behaviour fails loudly here.
 *
 *   #1  FYND_STATUS_PRECEDENCE narrowed (no bare `in_progress` / `processing`)
 *   #2  Silent catches replaced with logged catches (covered by integration
 *       tests downstream — not unit-testable without a DB mock)
 *   #3  extractAffiliateOrderId no longer falls back to external/channel ids
 *   #4  Timeline RETURN_JOURNEY_MAP uses exact match, not substring
 *   #5  extractCustomerFromWebhookPayload uses per-field delivery → billing
 *       fallback so an empty delivery_address {} doesn't silently drop the
 *       billing data
 *   #6  classifyFyndWebhookEvent dispatches webhooks into the right
 *       category (forward / return / refund / rto / unknown)
 */
import { describe, it, expect } from "vitest";
import {
  classifyFyndRefundStatus,
  shouldAdvanceFyndStatus,
  classifyFyndWebhookEvent,
  extractAffiliateOrderId,
  extractExternalOrderId,
  extractChannelOrderId,
  extractCustomerFromWebhookPayload,
  type FyndWebhookPayload,
} from "../fynd-webhook.server";

describe("Audit #1 — FYND_STATUS_PRECEDENCE narrowed (no bare lifecycle keys)", () => {
  it("does NOT lock fyndCurrentStatus when payload.status='in_progress' arrives", () => {
    // Before the audit: payload.status='in_progress' would advance
    // fyndCurrentStatus to 'in_progress' (rank 32). A subsequent
    // return_bag_picked (rank 23) would NOT advance because 23 < 32 →
    // visible journey froze. After the audit: 'in_progress' is unknown
    // (no key in precedence table), so the unknown-passthrough rule lets
    // it through, and the rank check no longer blocks return_bag_picked.
    expect(shouldAdvanceFyndStatus("in_progress", "return_bag_picked")).toBe(true);
    expect(shouldAdvanceFyndStatus("processing", "return_bag_picked")).toBe(true);
  });

  it("still blocks downgrades among genuine refund-stage tokens", () => {
    expect(shouldAdvanceFyndStatus("refund_done", "refund_pending")).toBe(false);
    expect(shouldAdvanceFyndStatus("refund_pending", "refund_done")).toBe(true);
  });
});

describe("Audit #6 — classifyFyndWebhookEvent dispatches by category", () => {
  it.each([
    ["bag_picked", null, "forward"],
    ["delivery_done", null, "forward"],
    ["return_bag_picked", null, "return"],
    ["return_initiated", null, "return"],
    ["return_bag_in_transit", null, "return"],
    ["rto_initiated", null, "rto"],
    ["rto_bag_delivered", null, "rto"],
    [null, "refund_initiated", "unknown"],
    [null, "refund_done", "refund"],
    ["return_bag_picked", "refund_initiated", "return"], // ignored refund_initiated must not override logistics
    ["delivery_done", null, "forward"],
    ["unknown_status", null, "unknown"],
    [null, null, "unknown"],
    ["", "", "unknown"],
  ])("classify(lifecycle=%s, refund=%s) → %s", (lifecycle, refund, expected) => {
    expect(classifyFyndWebhookEvent(lifecycle, refund)).toBe(expected);
  });

  it("uses lifecycle as refund-source except ignored refund_initiated", () => {
    // Some Fynd payloads put `refund_initiated` in the `status` field
    // (the lifecycle slot) rather than in `refund_status`. That one is
    // ignored because Shopify owns refund initiation.
    expect(classifyFyndWebhookEvent("refund_initiated", null)).toBe("unknown");
    expect(classifyFyndWebhookEvent("credit_note_generated", null)).toBe("refund");
  });

  it("normalises whitespace + case before matching", () => {
    expect(classifyFyndWebhookEvent("Return Bag Picked", null)).toBe("return");
    expect(classifyFyndWebhookEvent(null, "Refund Pending")).toBe("refund");
    expect(classifyFyndWebhookEvent(null, "Refund Initiated")).toBe("unknown");
  });
});

describe("Audit #3 — extractAffiliateOrderId no longer falls back to external/channel ids", () => {
  it("returns the affiliate_order_id when present", () => {
    const p = { affiliate_order_id: "AOID-1" } as FyndWebhookPayload;
    expect(extractAffiliateOrderId(p)).toBe("AOID-1");
  });

  it("does NOT return external_order_id from extractAffiliateOrderId (semantic separation)", () => {
    const p = {
      external_order_id: "EXT-1",
      // no affiliate_order_id
    } as FyndWebhookPayload;
    // Audit #3: affiliate-id extractor is now narrow. external_order_id
    // must come from extractExternalOrderId, NOT from a hidden fallback
    // inside the affiliate extractor.
    expect(extractAffiliateOrderId(p)).toBeNull();
    expect(extractExternalOrderId(p)).toBe("EXT-1");
  });

  it("does NOT return channel_order_id from extractAffiliateOrderId", () => {
    const p = { channel_order_id: "CH-1" } as FyndWebhookPayload;
    expect(extractAffiliateOrderId(p)).toBeNull();
    expect(extractChannelOrderId(p)).toBe("CH-1");
  });

  it("falls through to meta.affiliate_order_id when set", () => {
    const p = {
      meta: { affiliate_order_id: "META-AOID" },
    } as unknown as FyndWebhookPayload;
    expect(extractAffiliateOrderId(p)).toBe("META-AOID");
  });
});

describe("Audit #5 — extractCustomerFromWebhookPayload per-field delivery → billing fallback", () => {
  it("uses billing fields when delivery_address is empty {} (not just null)", () => {
    // The pre-audit bug: top-level `delivery_address ?? billing_address`
    // returned the empty {} as truthy, so billing was never consulted —
    // and the customer came back as null even though billing held all
    // the data. After the audit: per-field fallback finds the billing
    // values for each missing key.
    const p = {
      delivery_address: {},
      billing_address: {
        name: "Jane",
        email: "jane@example.com",
        phone: "+1-555-0100",
        city: "Toronto",
        country: "CA",
      },
    } as FyndWebhookPayload;
    const result = extractCustomerFromWebhookPayload(p);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Jane");
    expect(result?.email).toBe("jane@example.com");
    expect(result?.phone).toBe("+1-555-0100");
  });

  it("prefers delivery over billing on a per-field basis", () => {
    const p = {
      delivery_address: { name: "Delivery Name", email: "delivery@example.com" },
      billing_address: {
        name: "Billing Name",
        email: "billing@example.com",
        phone: "+1-555-0200",
      },
    } as FyndWebhookPayload;
    const result = extractCustomerFromWebhookPayload(p);
    // Delivery wins where it has a value
    expect(result?.name).toBe("Delivery Name");
    expect(result?.email).toBe("delivery@example.com");
    // Billing fills the gap for fields delivery doesn't have
    expect(result?.phone).toBe("+1-555-0200");
  });

  it("returns null when neither address has a name/email/phone", () => {
    const p = {
      delivery_address: { city: "Empty" },
      billing_address: {},
    } as FyndWebhookPayload;
    expect(extractCustomerFromWebhookPayload(p)).toBeNull();
  });

  it("uses meta.email/phone when both addresses lack contact fields", () => {
    const p = {
      delivery_address: { name: "Just a Name" },
      meta: { email: "from-meta@example.com", phone: "+1-555-0300" },
    } as unknown as FyndWebhookPayload;
    const result = extractCustomerFromWebhookPayload(p);
    expect(result?.name).toBe("Just a Name");
    expect(result?.email).toBe("from-meta@example.com");
    expect(result?.phone).toBe("+1-555-0300");
  });

  it("composes name from first_name + last_name when name is absent", () => {
    const p = {
      delivery_address: { first_name: "Alice", last_name: "Smith" },
    } as FyndWebhookPayload;
    expect(extractCustomerFromWebhookPayload(p)?.name).toBe("Alice Smith");
  });
});

describe("Audit #6 (cont.) — classifyFyndRefundStatus is namespaced-only after audit", () => {
  it.each(["in_progress", "processing", "completed"])(
    'bare lifecycle keyword "%s" is NOT classified as refund-in-progress',
    (s) => {
      expect(classifyFyndRefundStatus(s).isInProgress).toBe(false);
    },
  );

  it.each([
    "refund_pending",
    "refund_processing",
    "refund_in_progress",
    "refund_under_process",
  ])('namespaced refund token "%s" IS classified as refund-in-progress', (s) => {
    expect(classifyFyndRefundStatus(s).isInProgress).toBe(true);
  });

  it("does not classify Fynd refund_initiated as app refund progress", () => {
    expect(classifyFyndRefundStatus("refund_initiated").isInProgress).toBe(false);
  });
});
