import { describe, it, expect } from "vitest";
import {
  createAdminClient,
  extractShopifyOrderNumberVariants,
  extractAffiliateOrderId,
} from "../shopify-admin.server";

/* Pure exports — no network required. The GraphQL-calling exports live
   in shopify-admin.integration.test.ts (with MSW). */

describe("createAdminClient", () => {
  it("returns an object with a graphql method", () => {
    const c = createAdminClient("myshop.myshopify.com", "shpat_test");
    expect(typeof c.graphql).toBe("function");
  });

  it("accepts short form and appends .myshopify.com", () => {
    // The client is opaque — there's no public way to read the URL back.
    // But we can verify it doesn't throw and the method exists for both
    // canonical and shorthand forms of the shop domain.
    expect(() => createAdminClient("myshop", "shpat_x")).not.toThrow();
    expect(() => createAdminClient("myshop.myshopify.com", "shpat_x")).not.toThrow();
  });
});

describe("extractShopifyOrderNumberVariants", () => {
  it("returns empty array for null/empty input", () => {
    expect(extractShopifyOrderNumberVariants(null)).toEqual([]);
    expect(extractShopifyOrderNumberVariants(undefined)).toEqual([]);
    expect(extractShopifyOrderNumberVariants("")).toEqual([]);
    expect(extractShopifyOrderNumberVariants("#")).toEqual([]);
  });

  it("returns the input itself for a plain numeric order number", () => {
    expect(extractShopifyOrderNumberVariants("1001")).toEqual(["1001"]);
  });

  it("strips leading # prefix", () => {
    expect(extractShopifyOrderNumberVariants("#1001")).toEqual(["1001"]);
  });

  it("strips FYNDSHOPIFY prefix", () => {
    const v = extractShopifyOrderNumberVariants("FYNDSHOPIFY14126");
    expect(v).toContain("FYNDSHOPIFY14126");
    expect(v).toContain("14126");
  });

  it("handles X-prefixed order IDs (FYNDSHOPIFYX14126 → 14126)", () => {
    const v = extractShopifyOrderNumberVariants("FYNDSHOPIFYX14126");
    expect(v).toContain("X14126");
    expect(v).toContain("14126");
  });

  it("handles underscored variants (FYND_SHOPIFY_X14126)", () => {
    const v = extractShopifyOrderNumberVariants("FYND_SHOPIFY_X14126");
    expect(v).toContain("X14126");
  });

  it("handles dashed variants (FYND-SHOPIFY-14126)", () => {
    const v = extractShopifyOrderNumberVariants("FYND-SHOPIFY-14126");
    expect(v).toContain("14126");
  });

  it("strips FYND- prefix too (FYND12345 → 12345)", () => {
    const v = extractShopifyOrderNumberVariants("FYND12345");
    expect(v).toContain("FYND12345");
    expect(v).toContain("12345");
  });

  it("trims whitespace", () => {
    expect(extractShopifyOrderNumberVariants("  1001  ")).toEqual(["1001"]);
  });

  it("handles lowercase prefix variants", () => {
    const v = extractShopifyOrderNumberVariants("fyndshopify12345");
    expect(v).toContain("12345");
  });
});

describe("extractAffiliateOrderId", () => {
  it("returns null for null/empty attributes", () => {
    expect(extractAffiliateOrderId(null)).toBe(null);
    expect(extractAffiliateOrderId(undefined)).toBe(null);
    expect(extractAffiliateOrderId([])).toBe(null);
  });

  it("pulls from affiliate_order_id key", () => {
    expect(extractAffiliateOrderId([{ key: "affiliate_order_id", value: "FY12345" }])).toBe(
      "FY12345",
    );
  });

  it("is case-insensitive on the key lookup", () => {
    expect(extractAffiliateOrderId([{ key: "AFFILIATE_ORDER_ID", value: "FY12345" }])).toBe(
      "FY12345",
    );
  });

  it("falls back through alternate keys in priority order", () => {
    // _fynd_order_id comes later in the list than affiliate_order_id.
    expect(
      extractAffiliateOrderId([
        { key: "_fynd_order_id", value: "FY_OLD" },
        { key: "affiliate_order_id", value: "FY_NEW" },
      ]),
    ).toBe("FY_NEW");
  });

  it("skips empty / whitespace-only values", () => {
    expect(
      extractAffiliateOrderId([
        { key: "affiliate_order_id", value: "   " },
        { key: "fyndOrderId", value: "FY12345" },
      ]),
    ).toBe("FY12345");
  });

  it("trims whitespace from returned value", () => {
    expect(extractAffiliateOrderId([{ key: "affiliate_order_id", value: "  FY12345  " }])).toBe(
      "FY12345",
    );
  });

  it("returns null when none of the known keys match", () => {
    expect(extractAffiliateOrderId([{ key: "some_other_key", value: "X" }])).toBe(null);
  });
});
