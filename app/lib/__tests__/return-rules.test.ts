import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the parse-json dependency inline (used by return-rules.server)
vi.mock("../parse-json", () => ({
  parseJsonArray: <T>(val: string | null | undefined, fallback: T[]): T[] => {
    if (!val || !val.trim()) return fallback;
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  },
}));

import {
  checkReturnEligibility,
  getReturnFee,
  isPhotoRequired,
  type ReturnEligibilityResult,
} from "../return-rules.server";
import type { ShopSettings } from "@prisma/client";

/**
 * Helper to create a minimal ShopSettings-like object.
 * Only the fields tested are filled; the rest default to null/0/false.
 */
function makeSettings(overrides: Partial<ShopSettings> = {}): ShopSettings {
  return {
    id: "settings-1",
    shopId: "shop-1",
    returnWindowDays: 30,
    noReturnPeriodEnabled: false,
    noReturnPeriodStart: null,
    noReturnPeriodEnd: null,
    minimumReturnPrice: null,
    restrictedProductTagsJson: null,
    restrictedRegionsJson: null,
    returnFeeAmount: null,
    returnFeeCurrency: null,
    photoRequired: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ShopSettings;
}

describe("checkReturnEligibility", () => {
  it("returns eligible when settings is null", () => {
    const result = checkReturnEligibility(null, {});
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns eligible when no restrictive conditions apply", () => {
    const settings = makeSettings({ returnWindowDays: 30 });
    const result = checkReturnEligibility(settings, {
      orderDate: new Date(), // today is within window
    });
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when return window has expired", () => {
    const settings = makeSettings({ returnWindowDays: 7 });
    // Order placed 30 days ago
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - 30);
    const result = checkReturnEligibility(settings, { orderDate });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Return window has expired");
    expect(result.reason).toContain("7 days");
  });

  it("returns eligible when within return window", () => {
    const settings = makeSettings({ returnWindowDays: 30 });
    // Order placed 5 days ago
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - 5);
    const result = checkReturnEligibility(settings, { orderDate });
    expect(result.eligible).toBe(true);
  });

  it("uses default 30-day window when returnWindowDays is null", () => {
    const settings = makeSettings({ returnWindowDays: null as unknown as number });
    // Order placed 25 days ago -> should be within default 30 window
    const orderDate = new Date();
    orderDate.setDate(orderDate.getDate() - 25);
    const result = checkReturnEligibility(settings, { orderDate });
    expect(result.eligible).toBe(true);
  });

  it("blocks restricted product tags", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["final-sale", "non-returnable"]),
    });
    const result = checkReturnEligibility(settings, {
      productTags: ["clothing", "Final-Sale"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("not eligible for return");
  });

  it("allows when product tags do not match restricted list", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["final-sale"]),
    });
    const result = checkReturnEligibility(settings, {
      productTags: ["clothing", "new-arrival"],
    });
    expect(result.eligible).toBe(true);
  });

  it("allows when product has no tags and restricted tags exist", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["final-sale"]),
    });
    const result = checkReturnEligibility(settings, { productTags: [] });
    expect(result.eligible).toBe(true);
  });

  it("blocks when product price is below minimum", () => {
    const settings = makeSettings({
      minimumReturnPrice: 25 as unknown as ShopSettings["minimumReturnPrice"],
    });
    const result = checkReturnEligibility(settings, { productPrice: 10 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("at least 25");
  });

  it("allows when product price meets minimum", () => {
    const settings = makeSettings({
      minimumReturnPrice: 25 as unknown as ShopSettings["minimumReturnPrice"],
    });
    const result = checkReturnEligibility(settings, { productPrice: 50 });
    expect(result.eligible).toBe(true);
  });

  it("blocks orders placed during no-return period", () => {
    // Use dates relative to today so the order also falls within the return window
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 5);
    const end = new Date(now);
    end.setDate(end.getDate() + 5);
    const orderDate = new Date(now); // today is within [start, end]

    const settings = makeSettings({
      noReturnPeriodEnabled: true,
      noReturnPeriodStart: start,
      noReturnPeriodEnd: end,
    });
    const result = checkReturnEligibility(settings, { orderDate });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("promotional period");
  });

  it("allows orders outside no-return period", () => {
    // Order placed today, but no-return period is in the future
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() + 10);
    const end = new Date(now);
    end.setDate(end.getDate() + 20);
    const orderDate = new Date(now); // today is before [start, end]

    const settings = makeSettings({
      noReturnPeriodEnabled: true,
      noReturnPeriodStart: start,
      noReturnPeriodEnd: end,
    });
    const result = checkReturnEligibility(settings, { orderDate });
    expect(result.eligible).toBe(true);
  });

  it("blocks restricted regions", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "IN", province: "Maharashtra" }]),
    });
    const result = checkReturnEligibility(settings, {
      customerCountry: "IN",
      customerProvince: "Maharashtra",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("region");
  });

  it("allows non-restricted regions", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "IN" }]),
    });
    const result = checkReturnEligibility(settings, {
      customerCountry: "US",
    });
    expect(result.eligible).toBe(true);
  });

  describe("product-level policy overrides", () => {
    it("uses product policy window instead of global window", () => {
      const settings = makeSettings({
        returnWindowDays: 7,
      });
      // Attach productPoliciesJson
      (settings as Record<string, unknown>).productPoliciesJson = JSON.stringify([
        {
          id: "p1",
          matchType: "tags",
          matchValue: "electronics",
          windowDays: 60,
          returnable: true,
        },
      ]);

      // Order placed 20 days ago - would fail global 7-day window, but product policy allows 60 days
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() - 20);
      const result = checkReturnEligibility(settings, {
        orderDate,
        productTags: ["electronics"],
      });
      expect(result.eligible).toBe(true);
    });

    it("marks non-returnable products as ineligible", () => {
      const settings = makeSettings();
      (settings as Record<string, unknown>).productPoliciesJson = JSON.stringify([
        {
          id: "p1",
          matchType: "tags",
          matchValue: "underwear",
          windowDays: 0,
          returnable: false,
          policyText: "Hygiene products cannot be returned.",
        },
      ]);
      const result = checkReturnEligibility(settings, {
        productTags: ["underwear"],
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe("Hygiene products cannot be returned.");
    });

    it("falls back to global window when no product policy matches", () => {
      const settings = makeSettings({ returnWindowDays: 7 });
      (settings as Record<string, unknown>).productPoliciesJson = JSON.stringify([
        {
          id: "p1",
          matchType: "tags",
          matchValue: "electronics",
          windowDays: 60,
          returnable: true,
        },
      ]);

      // Order 10 days ago, product tag doesn't match policy -> uses global 7 days
      const orderDate = new Date();
      orderDate.setDate(orderDate.getDate() - 10);
      const result = checkReturnEligibility(settings, {
        orderDate,
        productTags: ["clothing"],
      });
      expect(result.eligible).toBe(false);
      expect(result.reason).toContain("7 days");
    });

    it("matches product policy by product_type", () => {
      const settings = makeSettings();
      (settings as Record<string, unknown>).productPoliciesJson = JSON.stringify([
        {
          id: "p1",
          matchType: "product_type",
          matchValue: "Gift Card",
          windowDays: 0,
          returnable: false,
        },
      ]);
      const result = checkReturnEligibility(settings, {
        productType: "Gift Card",
      });
      expect(result.eligible).toBe(false);
    });
  });
});

describe("getReturnFee", () => {
  it("returns 0 amount and USD when settings is null", () => {
    const fee = getReturnFee(null);
    expect(fee.amount).toBe(0);
    expect(fee.currency).toBe("USD");
  });

  it("returns 0 amount when returnFeeAmount is null", () => {
    const settings = makeSettings({ returnFeeAmount: null });
    const fee = getReturnFee(settings);
    expect(fee.amount).toBe(0);
    expect(fee.currency).toBe("USD");
  });

  it("returns correct fee amount and currency", () => {
    const settings = makeSettings({
      returnFeeAmount: 5.99 as unknown as ShopSettings["returnFeeAmount"],
      returnFeeCurrency: "EUR",
    });
    const fee = getReturnFee(settings);
    expect(fee.amount).toBe(5.99);
    expect(fee.currency).toBe("EUR");
  });

  it("defaults currency to USD when returnFeeCurrency is null", () => {
    const settings = makeSettings({
      returnFeeAmount: 10 as unknown as ShopSettings["returnFeeAmount"],
      returnFeeCurrency: null,
    });
    const fee = getReturnFee(settings);
    expect(fee.amount).toBe(10);
    expect(fee.currency).toBe("USD");
  });
});

describe("isPhotoRequired", () => {
  it("returns false when settings is null", () => {
    expect(isPhotoRequired(null)).toBe(false);
  });

  it("returns false when photoRequired is false", () => {
    const settings = makeSettings({ photoRequired: false });
    expect(isPhotoRequired(settings)).toBe(false);
  });

  it("returns true when photoRequired is true", () => {
    const settings = makeSettings({ photoRequired: true });
    expect(isPhotoRequired(settings)).toBe(true);
  });
});
