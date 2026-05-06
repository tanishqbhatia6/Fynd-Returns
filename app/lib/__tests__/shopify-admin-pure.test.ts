import { describe, it, expect } from "vitest";
import {
  extractShopifyOrderNumberVariants,
  extractAffiliateOrderId,
  OrderAccessError,
} from "../shopify-admin.server";

describe("extractShopifyOrderNumberVariants", () => {
  it("returns empty array for null / undefined / empty", () => {
    expect(extractShopifyOrderNumberVariants(null)).toEqual([]);
    expect(extractShopifyOrderNumberVariants(undefined)).toEqual([]);
    expect(extractShopifyOrderNumberVariants("")).toEqual([]);
    expect(extractShopifyOrderNumberVariants("   ")).toEqual([]);
    expect(extractShopifyOrderNumberVariants("#")).toEqual([]);
  });

  it("returns pure number input unchanged (no prefix stripping needed)", () => {
    expect(extractShopifyOrderNumberVariants("1001")).toEqual(["1001"]);
  });

  it("strips leading # only at start-of-string (not after whitespace)", () => {
    expect(extractShopifyOrderNumberVariants("#1001")).toEqual(["1001"]);
    // Leading whitespace means ^ no longer matches the #; stays as "#1001" after trim
    expect(extractShopifyOrderNumberVariants("  #1001  ")).toEqual(["#1001"]);
  });

  it("strips FYNDSHOPIFY prefix and yields multiple variants", () => {
    const result = extractShopifyOrderNumberVariants("FYNDSHOPIFYX14126");
    expect(result).toContain("FYNDSHOPIFYX14126");
    expect(result).toContain("X14126");
    expect(result).toContain("14126"); // numMatch stripped the X
  });

  it("strips FYND_SHOPIFY_ prefix with separator", () => {
    const result = extractShopifyOrderNumberVariants("FYND_SHOPIFY_O14126");
    expect(result).toContain("O14126");
  });

  it("strips FYND-SHOPIFY- prefix with dashes", () => {
    const result = extractShopifyOrderNumberVariants("FYND-SHOPIFY-X7000");
    expect(result).toContain("X7000");
    expect(result).toContain("7000");
  });

  it("strips plain FYND_ prefix", () => {
    const result = extractShopifyOrderNumberVariants("FYND_12345");
    expect(result).toContain("12345");
  });

  it("is case-insensitive on the prefix", () => {
    const result = extractShopifyOrderNumberVariants("fyndshopify1001");
    expect(result).toContain("1001");
  });

  it("deduplicates variants while preserving first-seen order", () => {
    // "FYND_1001" produces "1001" from both FYND[_-]? pattern and (potentially) sub-variants
    const result = extractShopifyOrderNumberVariants("FYND_1001");
    expect(result).toEqual([...new Set(result)]);
  });

  it("doesn't add a letter+digit sub-variant when no letter prefix present", () => {
    const result = extractShopifyOrderNumberVariants("FYND_1001");
    // stripped is "1001" — no leading letter, so no extra sub-variant
    expect(result).toEqual(["FYND_1001", "1001"]);
  });

  it("doesn't crash on weird unicode / special chars", () => {
    const result = extractShopifyOrderNumberVariants("FYND你好1001");
    // The FYND prefix gets stripped; rest preserved
    expect(result[0]).toBe("FYND你好1001");
  });

  it("doesn't treat arbitrary orders (no FYND prefix) as needing stripping", () => {
    expect(extractShopifyOrderNumberVariants("ORD-1234")).toEqual(["ORD-1234"]);
  });
});

describe("extractAffiliateOrderId", () => {
  it("returns null for null / undefined / empty array", () => {
    expect(extractAffiliateOrderId(null)).toBe(null);
    expect(extractAffiliateOrderId(undefined)).toBe(null);
    expect(extractAffiliateOrderId([])).toBe(null);
  });

  it("finds 'affiliate_order_id' as the canonical key", () => {
    expect(extractAffiliateOrderId([{ key: "affiliate_order_id", value: "AFF-1" }])).toBe("AFF-1");
  });

  it("finds underscore-prefixed variant", () => {
    expect(extractAffiliateOrderId([{ key: "_affiliate_order_id", value: "AFF-2" }])).toBe("AFF-2");
  });

  it("finds fynd_affiliate_order_id and fynd_order_id fallbacks", () => {
    expect(extractAffiliateOrderId([{ key: "fynd_affiliate_order_id", value: "F-1" }])).toBe("F-1");
    expect(extractAffiliateOrderId([{ key: "fynd_order_id", value: "F-2" }])).toBe("F-2");
    expect(extractAffiliateOrderId([{ key: "_fynd_order_id", value: "F-3" }])).toBe("F-3");
  });

  it("finds camelCase variants", () => {
    expect(extractAffiliateOrderId([{ key: "fyndOrderId", value: "F-4" }])).toBe("F-4");
    expect(extractAffiliateOrderId([{ key: "affiliateOrderId", value: "A-5" }])).toBe("A-5");
  });

  it("is case-insensitive on the key", () => {
    expect(extractAffiliateOrderId([{ key: "AFFILIATE_ORDER_ID", value: "X" }])).toBe("X");
    expect(extractAffiliateOrderId([{ key: "Fynd_Order_Id", value: "Y" }])).toBe("Y");
  });

  it("trims whitespace from the value", () => {
    expect(extractAffiliateOrderId([{ key: "affiliate_order_id", value: "   AFF-1   " }])).toBe(
      "AFF-1",
    );
  });

  it("skips empty / whitespace-only values and checks the next attribute", () => {
    expect(
      extractAffiliateOrderId([
        { key: "affiliate_order_id", value: "" },
        { key: "fynd_order_id", value: "fallback-ok" },
      ]),
    ).toBe("fallback-ok");
  });

  it("prefers the first matching key from the priority list", () => {
    // affiliate_order_id appears first in AFFILIATE_ORDER_ID_KEYS → wins over fynd_order_id
    expect(
      extractAffiliateOrderId([
        { key: "fynd_order_id", value: "later" },
        { key: "affiliate_order_id", value: "winner" },
      ]),
    ).toBe("winner");
  });

  it("returns null when no recognised key is present", () => {
    expect(extractAffiliateOrderId([{ key: "some_other_key", value: "ignored" }])).toBe(null);
  });
});

describe("OrderAccessError", () => {
  it("defaults code to PCDA + keeps message", () => {
    const err = new OrderAccessError("protected data");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OrderAccessError");
    expect(err.code).toBe("PCDA");
    expect(err.message).toBe("protected data");
  });

  it("accepts NOT_FOUND code", () => {
    const err = new OrderAccessError("gone", "NOT_FOUND");
    expect(err.code).toBe("NOT_FOUND");
  });

  it("works with instanceof in error-handling branches", () => {
    try {
      throw new OrderAccessError("not_approved");
    } catch (e) {
      expect(e instanceof OrderAccessError).toBe(true);
    }
  });
});
