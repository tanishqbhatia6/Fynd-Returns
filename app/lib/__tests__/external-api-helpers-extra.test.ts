/**
 * Extra edge tests for external-api-helpers.server.ts.
 *
 * Complements the main external-api-helpers.test.ts with:
 *   - checkPerKeyRateLimit: delegates to checkRateLimit + responds 429 when blocked.
 *   - buildMeta: pathological pageSize=0 / totalCount=0 inputs (NaN/Infinity guard).
 *   - sanitizeReturnDetail: covers item/event mapping for nullish, partial, and
 *     mixed-type entries to lock the canonical external shape.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  checkPerKeyRateLimit,
  buildMeta,
  sanitizeReturnDetail,
} from "../external-api-helpers.server";
import { __resetRateLimitForTests } from "../rate-limit.server";

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter++;
  return `192.168.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function makeRequest(ip: string, shop = "extra-shop.myshopify.com"): Request {
  return new Request(`https://app.example.com/api/external/test?shop=${shop}`, {
    headers: { "x-forwarded-for": ip },
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
});

describe("checkPerKeyRateLimit", () => {
  it("returns null when the key is under the limit (delegates to checkRateLimit)", async () => {
    const req = makeRequest(uniqueIp());
    const res = await checkPerKeyRateLimit(req, "external.returns.list", "key-allowed-1");
    expect(res).toBeNull();
  });

  it("returns null repeatedly until the principal-bucket fills", async () => {
    // external.returns.refund: maxRequests=30. Hit a few times — all should pass.
    const keyId = "key-allowed-2";
    for (let i = 0; i < 5; i++) {
      const req = makeRequest(uniqueIp());
      const res = await checkPerKeyRateLimit(req, "external.returns.refund", keyId);
      expect(res).toBeNull();
    }
  });

  it("returns a 429 Response with Retry-After when the key is over the limit", async () => {
    const keyId = "key-blocked-1";
    // external.webhooks: maxRequests=10. Saturate, then expect a 429.
    for (let i = 0; i < 10; i++) {
      const req = makeRequest(uniqueIp());
      const res = await checkPerKeyRateLimit(req, "external.webhooks", keyId);
      expect(res).toBeNull();
    }
    const blockedReq = makeRequest(uniqueIp());
    const blocked = await checkPerKeyRateLimit(blockedReq, "external.webhooks", keyId);
    expect(blocked).toBeInstanceOf(Response);
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).toBeTruthy();
    const body = await blocked!.json();
    expect(body.error).toMatch(/too many requests/i);
  });

  it("scopes per keyId — different keys have independent buckets", async () => {
    // Saturate keyA on external.postman (maxRequests=10).
    for (let i = 0; i < 10; i++) {
      const req = makeRequest(uniqueIp());
      const res = await checkPerKeyRateLimit(req, "external.postman", "key-A");
      expect(res).toBeNull();
    }
    const blockedA = await checkPerKeyRateLimit(makeRequest(uniqueIp()), "external.postman", "key-A");
    expect(blockedA?.status).toBe(429);

    // key-B should still have a fresh bucket.
    const okB = await checkPerKeyRateLimit(makeRequest(uniqueIp()), "external.postman", "key-B");
    expect(okB).toBeNull();
  });

  it("scopes per endpoint — same key on a different endpoint has its own bucket", async () => {
    const keyId = "key-cross-endpoint";
    // Saturate on external.webhooks (maxRequests=10).
    for (let i = 0; i < 10; i++) {
      await checkPerKeyRateLimit(makeRequest(uniqueIp()), "external.webhooks", keyId);
    }
    const blocked = await checkPerKeyRateLimit(makeRequest(uniqueIp()), "external.webhooks", keyId);
    expect(blocked?.status).toBe(429);

    // Same keyId, different endpoint → fresh bucket.
    const otherEndpoint = await checkPerKeyRateLimit(
      makeRequest(uniqueIp()),
      "external.returns.list",
      keyId,
    );
    expect(otherEndpoint).toBeNull();
  });
});

describe("buildMeta — edge cases", () => {
  it("totalCount=0 with pageSize=0 still returns hasNextPage=false (Infinity guard)", () => {
    // pageSize=0 would yield NaN/Infinity in ceil(0/0). Math.max(1, …) clamps
    // totalPages to 1 when ceil produces NaN, so hasNextPage stays false.
    const meta = buildMeta(1, 0, 0);
    expect(meta.pageSize).toBe(0);
    expect(meta.totalCount).toBe(0);
    // Math.ceil(0/0) === NaN; Math.max(1, NaN) === NaN — the guard becomes "page < NaN" === false.
    expect(meta.hasNextPage).toBe(false);
  });

  it("totalCount=0 returns totalPages=1 and hasNextPage=false (typical empty list)", () => {
    const meta = buildMeta(1, 25, 0);
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.totalCount).toBe(0);
  });

  it("page beyond totalPages still reports hasNextPage=false", () => {
    const meta = buildMeta(99, 10, 25);
    expect(meta.totalPages).toBe(3);
    expect(meta.hasNextPage).toBe(false);
  });

  it("exact-fit totalCount produces no extra page", () => {
    const meta = buildMeta(2, 25, 50);
    expect(meta.totalPages).toBe(2);
    expect(meta.hasNextPage).toBe(false);
  });
});

describe("sanitizeReturnDetail — items and events shapes", () => {
  it("maps every canonical item field, dropping unknown fields", () => {
    const result = sanitizeReturnDetail({
      id: "rc-detail-1",
      items: [
        {
          id: "i-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          title: "Shoe",
          variantTitle: "Red / 10",
          sku: "SHOE-RED-10",
          price: "49.99",
          qty: 2,
          reasonCode: "WRONG_SIZE",
          condition: "unworn",
          notes: "Pinches at heel",
          // Unknown / internal fields that must NOT leak:
          rawDbBlob: "INTERNAL",
          merchantOnlyHints: { secret: true },
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    const it0 = result.items[0];
    expect(it0).toEqual({
      id: "i-1",
      shopifyLineItemId: "gid://shopify/LineItem/1",
      title: "Shoe",
      variantTitle: "Red / 10",
      sku: "SHOE-RED-10",
      price: "49.99",
      qty: 2,
      reasonCode: "WRONG_SIZE",
      condition: "unworn",
      notes: "Pinches at heel",
    });
    expect(it0).not.toHaveProperty("rawDbBlob");
    expect(it0).not.toHaveProperty("merchantOnlyHints");
  });

  it("maps every canonical event field, dropping unknown fields", () => {
    const result = sanitizeReturnDetail({
      id: "rc-detail-2",
      events: [
        {
          id: "e-1",
          source: "fynd",
          eventType: "shipment.created",
          happenedAt: "2026-01-15T10:00:00Z",
          // Internal / large fields that must NOT leak:
          payloadJson: '{"big":"blob"}',
          rawWebhookHeaders: { "x-secret": "shh" },
          internalNotes: "do-not-send",
        },
      ],
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      id: "e-1",
      source: "fynd",
      eventType: "shipment.created",
      happenedAt: "2026-01-15T10:00:00Z",
    });
    expect(result.events[0]).not.toHaveProperty("payloadJson");
    expect(result.events[0]).not.toHaveProperty("rawWebhookHeaders");
    expect(result.events[0]).not.toHaveProperty("internalNotes");
  });

  it("preserves item field order across multiple items with mixed nullish values", () => {
    const result = sanitizeReturnDetail({
      id: "rc-detail-3",
      items: [
        // Partial — most fields undefined.
        { id: "i-a" },
        // Full — all fields populated.
        {
          id: "i-b",
          shopifyLineItemId: "gid://shopify/LineItem/2",
          title: "T-Shirt",
          variantTitle: null,
          sku: null,
          price: "19.00",
          qty: 1,
          reasonCode: "DAMAGED",
          condition: "used",
          notes: null,
        },
        // Explicit nulls — should be passed through verbatim, not dropped.
        {
          id: "i-c",
          shopifyLineItemId: null,
          title: null,
          variantTitle: null,
          sku: null,
          price: null,
          qty: 0,
          reasonCode: null,
          condition: null,
          notes: null,
        },
      ],
    });
    expect(result.items).toHaveLength(3);
    expect(result.items[0].id).toBe("i-a");
    expect(result.items[0].title).toBeUndefined();
    expect(result.items[1].title).toBe("T-Shirt");
    expect(result.items[1].variantTitle).toBeNull();
    expect(result.items[2].qty).toBe(0);
    expect(result.items[2].title).toBeNull();
  });

  it("supports multiple events of differing source/type and preserves order", () => {
    const result = sanitizeReturnDetail({
      id: "rc-detail-4",
      events: [
        { id: "e-1", source: "admin", eventType: "approved", happenedAt: "2026-01-01T00:00:00Z" },
        { id: "e-2", source: "portal", eventType: "submitted", happenedAt: "2026-01-02T00:00:00Z" },
        { id: "e-3", source: "fynd", eventType: "delivered", happenedAt: "2026-01-03T00:00:00Z" },
        { id: "e-4", source: "system", eventType: "auto-refunded", happenedAt: "2026-01-04T00:00:00Z" },
      ],
    });
    expect(result.events).toHaveLength(4);
    expect(result.events.map((e) => e.eventType)).toEqual([
      "approved",
      "submitted",
      "delivered",
      "auto-refunded",
    ]);
    expect(result.events.map((e) => e.source)).toEqual(["admin", "portal", "fynd", "system"]);
  });

  it("returns events: [] when events is explicitly null/undefined", () => {
    const result1 = sanitizeReturnDetail({ id: "rc-detail-5", events: undefined });
    expect(result1.events).toEqual([]);
    const result2 = sanitizeReturnDetail({ id: "rc-detail-6" });
    expect(result2.events).toEqual([]);
  });

  it("does not leak fyndPayloadJson, customerMediaJson, or other large blobs even when items/events are present", () => {
    const result = sanitizeReturnDetail({
      id: "rc-detail-7",
      fyndPayloadJson: "BLOB",
      customerMediaJson: '["url1","url2"]',
      items: [{ id: "i-1", title: "thing" }],
      events: [{ id: "e-1", source: "admin", eventType: "approved" }],
    });
    expect(result).not.toHaveProperty("fyndPayloadJson");
    expect(result).not.toHaveProperty("customerMediaJson");
    expect(result.items).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});
