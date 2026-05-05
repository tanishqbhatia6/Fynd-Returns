/**
 * Direct unit tests for external-api-helpers.server.ts. These pure-ish
 * helpers are exercised end-to-end by the external API route tests, but
 * locking in the contract directly catches drift in:
 *   - pagination clamping (max 100, min 1)
 *   - meta.hasNextPage logic at the boundary
 *   - sanitization fields (no fyndPayloadJson, customerMediaJson leaks)
 */
import { describe, it, expect } from "vitest";
import {
  apiSuccess,
  apiCreated,
  apiError,
  parsePagination,
  buildMeta,
  sanitizeReturn,
  sanitizeReturnSummary,
  sanitizeReturnDetail,
  sanitizeSettings,
} from "../external-api-helpers.server";

describe("apiSuccess", () => {
  it("wraps data in { data, errors: [], meta? }", async () => {
    const res = apiSuccess({ id: "rc-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { id: "rc-1" }, errors: [] });
  });

  it("includes meta when provided", async () => {
    const res = apiSuccess([{ id: "rc-1" }], { page: 1, pageSize: 25, totalCount: 1, totalPages: 1, hasNextPage: false });
    const body = await res.json();
    expect(body.meta).toBeDefined();
    expect(body.meta.totalCount).toBe(1);
  });
});

describe("apiCreated", () => {
  it("returns 201", async () => {
    const res = apiCreated({ id: "x" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toEqual({ id: "x" });
  });
});

describe("apiError", () => {
  it("returns the requested status with { error: { code, message } }", async () => {
    const res = apiError(400, "BAD_REQUEST", "missing field");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toEqual({ code: "BAD_REQUEST", message: "missing field" });
  });
});

describe("parsePagination", () => {
  it("defaults to page=1, pageSize=25", () => {
    const url = new URL("https://x/y");
    expect(parsePagination(url)).toEqual({ page: 1, pageSize: 25, skip: 0 });
  });

  it("respects valid query params", () => {
    const url = new URL("https://x/y?page=3&pageSize=50");
    expect(parsePagination(url)).toEqual({ page: 3, pageSize: 50, skip: 100 });
  });

  it("clamps pageSize to max 100", () => {
    const url = new URL("https://x/y?pageSize=500");
    const out = parsePagination(url);
    expect(out.pageSize).toBe(100);
  });

  it("clamps page to min 1", () => {
    const url = new URL("https://x/y?page=0");
    expect(parsePagination(url).page).toBe(1);
    const url2 = new URL("https://x/y?page=-5");
    expect(parsePagination(url2).page).toBe(1);
  });

  it("clamps pageSize to min 1", () => {
    const url = new URL("https://x/y?pageSize=0");
    expect(parsePagination(url).pageSize).toBe(25);
    const url2 = new URL("https://x/y?pageSize=-3");
    expect(parsePagination(url2).pageSize).toBe(25);
  });

  it("falls back when params are NaN", () => {
    const url = new URL("https://x/y?page=abc&pageSize=xyz");
    expect(parsePagination(url)).toEqual({ page: 1, pageSize: 25, skip: 0 });
  });

  it("computes skip correctly for page=2 pageSize=50", () => {
    const url = new URL("https://x/y?page=2&pageSize=50");
    expect(parsePagination(url).skip).toBe(50);
  });
});

describe("buildMeta", () => {
  it("sets totalPages = ceil(total/pageSize) when total > 0", () => {
    const meta = buildMeta(1, 10, 25);
    expect(meta.totalPages).toBe(3);
    expect(meta.hasNextPage).toBe(true);
  });

  it("clamps totalPages to min 1 when totalCount is 0", () => {
    const meta = buildMeta(1, 25, 0);
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
  });

  it("hasNextPage=false on the last page", () => {
    const meta = buildMeta(3, 10, 25);
    expect(meta.hasNextPage).toBe(false);
  });

  it("hasNextPage=true when more pages remain", () => {
    const meta = buildMeta(1, 10, 100);
    expect(meta.hasNextPage).toBe(true);
  });

  it("includes page, pageSize, totalCount in returned meta", () => {
    const meta = buildMeta(2, 50, 200);
    expect(meta).toEqual(expect.objectContaining({
      page: 2,
      pageSize: 50,
      totalCount: 200,
      totalPages: 4,
      hasNextPage: true,
    }));
  });
});

describe("sanitizeReturn", () => {
  it("strips fyndPayloadJson and customerMediaJson", () => {
    const result = sanitizeReturn({
      id: "rc-1",
      fyndPayloadJson: '{"big": "blob"}',
      customerMediaJson: '["url1"]',
      status: "approved",
    });
    expect(result).not.toHaveProperty("fyndPayloadJson");
    expect(result).not.toHaveProperty("customerMediaJson");
    expect(result.id).toBe("rc-1");
    expect(result.status).toBe("approved");
  });
});

describe("sanitizeReturnSummary", () => {
  it("returns canonical summary fields only", () => {
    const result = sanitizeReturnSummary({
      id: "rc-1",
      returnRequestNo: "R-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      status: "approved",
      resolutionType: "refund",
      customerName: "Jane",
      customerEmailNorm: "u@example.com",
      currency: "USD",
      items: [{ id: "i-1" }, { id: "i-2" }],
      createdAt: "2025-01-01",
      updatedAt: "2025-01-02",
      // Fields that must NOT leak into summary:
      fyndPayloadJson: "blob",
      adminNotes: "secret",
    });
    expect(result.itemCount).toBe(2);
    expect(result.customerEmail).toBe("u@example.com");
    expect(result).not.toHaveProperty("adminNotes");
    expect(result).not.toHaveProperty("fyndPayloadJson");
  });

  it("itemCount=0 when items is missing", () => {
    const result = sanitizeReturnSummary({ id: "rc-1" });
    expect(result.itemCount).toBe(0);
  });

  it("CRM fields default to null when absent", () => {
    const result = sanitizeReturnSummary({ id: "rc-1" });
    expect(result.createdByChannel).toBeNull();
    expect(result.createdByStaff).toBeNull();
    expect(result.crmTicketId).toBeNull();
    expect(result.crmNotes).toBeNull();
  });
});

describe("sanitizeReturnDetail", () => {
  it("includes mapped items and events", () => {
    const result = sanitizeReturnDetail({
      id: "rc-1",
      items: [{ id: "i-1", shopifyLineItemId: "gid://1", title: "T", variantTitle: "V", sku: "S", price: "10", qty: 1, reasonCode: "DAMAGED", condition: "open", notes: null, INTERNAL: "leaked?" }],
      events: [{ id: "e-1", source: "admin", eventType: "approved", happenedAt: "2025-01-01", payloadJson: "leaked?" }],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("INTERNAL");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).not.toHaveProperty("payloadJson");
  });

  it("works with empty items/events", () => {
    const result = sanitizeReturnDetail({ id: "rc-1" });
    expect(result.items).toEqual([]);
    expect(result.events).toEqual([]);
  });

  it("does not leak fyndPayloadJson", () => {
    const result = sanitizeReturnDetail({
      id: "rc-1",
      fyndPayloadJson: "huge blob",
    });
    expect(result).not.toHaveProperty("fyndPayloadJson");
  });
});

describe("sanitizeSettings", () => {
  it("stringifies returnFeeAmount to preserve decimal precision", () => {
    const result = sanitizeSettings({ returnFeeAmount: 5.5 });
    expect(result.returnFeeAmount).toBe("5.5");
  });

  it("returnFeeAmount is null when absent", () => {
    const result = sanitizeSettings({});
    expect(result.returnFeeAmount).toBeNull();
  });

  it("does not leak SMTP/Fynd credentials", () => {
    const result = sanitizeSettings({
      smtpPassword: "secret",
      fyndCredentials: "encrypted-blob",
      returnWindowDays: 30,
    });
    expect(result).not.toHaveProperty("smtpPassword");
    expect(result).not.toHaveProperty("fyndCredentials");
    expect(result.returnWindowDays).toBe(30);
  });

  it("preserves canonical settings keys", () => {
    const input = {
      returnWindowDays: 30,
      autoApproveEnabled: true,
      autoRefundEnabled: false,
      photoRequired: true,
      refundPaymentMethod: "store_credit",
      returnFeeCurrency: "USD",
      bonusCreditEnabled: true,
      bonusCreditPct: 10,
      greenReturnsEnabled: true,
      portalExchangeEnabled: false,
      shopCurrency: "USD",
      shopTimezone: "America/Los_Angeles",
      discountCodeRefundEnabled: false,
    };
    const result = sanitizeSettings(input);
    expect(result).toEqual({ ...input, returnFeeAmount: null });
  });
});
