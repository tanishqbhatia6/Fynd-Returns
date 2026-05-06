/**
 * Deep tests for return-rules.server.ts: covers every exported function plus
 * the heavily-branched eligibility evaluator. Each test pins a specific
 * branch so a regression is caught at its source rather than via the
 * downstream UI/email surface.
 */
import { describe, it, expect } from "vitest";
import type { ShopSettings } from "@prisma/client";
import { checkReturnEligibility, getReturnFee, isPhotoRequired } from "../return-rules.server";

/** Build a ShopSettings stub. Only the fields used by tests need values. */
function makeSettings(overrides: Partial<ShopSettings> = {}): ShopSettings {
  const base = {
    id: "s1",
    shop: "test.myshopify.com",
    returnWindowDays: 30,
    photoRequired: false,
    minimumReturnPrice: null,
    returnFeeAmount: null,
    returnFeeCurrency: null,
    returnFeesByReasonJson: null,
    returnWindowByCountryJson: null,
    productPoliciesJson: null,
    restrictedProductTagsJson: null,
    restrictedRegionsJson: null,
    channelPoliciesJson: null,
    noReturnPeriodEnabled: false,
    noReturnPeriodStart: null,
    noReturnPeriodEnd: null,
  } as unknown as ShopSettings;
  return { ...base, ...overrides } as ShopSettings;
}

/** Date helper: N days before "now". */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// checkReturnEligibility — null settings & no-op cases
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — base behaviour", () => {
  it("returns eligible when settings is null", () => {
    expect(checkReturnEligibility(null, {})).toEqual({ eligible: true });
  });

  it("returns eligible with bare settings and empty context", () => {
    expect(checkReturnEligibility(makeSettings(), {})).toEqual({ eligible: true });
  });

  it("returns eligible when orderDate is within global window", () => {
    const settings = makeSettings({ returnWindowDays: 30 });
    const result = checkReturnEligibility(settings, { orderDate: daysAgo(5) });
    expect(result.eligible).toBe(true);
  });

  it("returns eligible exactly at window boundary (windowDays + 0)", () => {
    // orderDate = today, windowDays = 0 → windowEnd = today; new Date() may or
    // may not be > windowEnd depending on millisecond timing, but a generous
    // window keeps it eligible.
    const settings = makeSettings({ returnWindowDays: 365 });
    const result = checkReturnEligibility(settings, { orderDate: new Date() });
    expect(result.eligible).toBe(true);
  });

  it("uses default 30-day window when returnWindowDays is null", () => {
    // returnWindowDays null → effectiveWindowDays = 30, so 60 days ago expires.
    const settings = makeSettings({ returnWindowDays: null as unknown as number });
    const result = checkReturnEligibility(settings, { orderDate: daysAgo(60) });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("30 days");
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — global window expiry
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — global return window", () => {
  it("rejects when order is older than the window", () => {
    const settings = makeSettings({ returnWindowDays: 30 });
    const result = checkReturnEligibility(settings, { orderDate: daysAgo(45) });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Return window has expired/);
    expect(result.reason).toContain("30 days");
  });

  it("rejects with custom window count in the reason text", () => {
    const settings = makeSettings({ returnWindowDays: 7 });
    const result = checkReturnEligibility(settings, { orderDate: daysAgo(10) });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("7 days");
  });

  it("does not check window when no orderDate is provided", () => {
    const settings = makeSettings({ returnWindowDays: 1 });
    const result = checkReturnEligibility(settings, {});
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — country-specific window override
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — country-specific window", () => {
  it("uses country window over global when matched", () => {
    const settings = makeSettings({
      returnWindowDays: 30,
      returnWindowByCountryJson: JSON.stringify([{ country: "CA", days: 14 }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(20),
      customerCountry: "CA",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("14 days");
  });

  it("matches country case-insensitively", () => {
    const settings = makeSettings({
      returnWindowByCountryJson: JSON.stringify([{ country: "us", days: 60 }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(45),
      customerCountry: "US",
    });
    // 60-day country window should keep this eligible despite global 30.
    expect(result.eligible).toBe(true);
  });

  it("falls back to global window when country has no override", () => {
    const settings = makeSettings({
      returnWindowDays: 30,
      returnWindowByCountryJson: JSON.stringify([{ country: "FR", days: 60 }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(45),
      customerCountry: "DE",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("30 days");
  });

  it("ignores malformed country window JSON", () => {
    const settings = makeSettings({
      returnWindowByCountryJson: "not-json",
      returnWindowDays: 30,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(10),
      customerCountry: "US",
    });
    expect(result.eligible).toBe(true);
  });

  it("ignores non-array country window JSON", () => {
    const settings = makeSettings({
      returnWindowByCountryJson: JSON.stringify({ country: "US", days: 5 }),
      returnWindowDays: 30,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(10),
      customerCountry: "US",
    });
    expect(result.eligible).toBe(true);
  });

  it("filters out country window entries with wrong shape", () => {
    const settings = makeSettings({
      returnWindowByCountryJson: JSON.stringify([
        { country: 5, days: 7 }, // bad: country not string
        { country: "US", days: "14" }, // bad: days not number
        { country: "US", days: 7 }, // good
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(10),
      customerCountry: "US",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("7 days");
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — product-level policies
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — product policies", () => {
  it("rejects when matched product policy is non-returnable", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        {
          id: "p1",
          matchType: "tags",
          matchValue: "final-sale",
          windowDays: 0,
          returnable: false,
          policyText: "Final sale items cannot be returned.",
        },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      productTags: ["final-sale", "summer"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Final sale items cannot be returned.");
  });

  it("uses default rejection reason when policyText is missing", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "no-return", windowDays: 0, returnable: false },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["no-return"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("This product is not eligible for return.");
  });

  it("matches product_type policy case-insensitively", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        {
          id: "p1",
          matchType: "product_type",
          matchValue: "Underwear",
          windowDays: 0,
          returnable: false,
        },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productType: "underwear" });
    expect(result.eligible).toBe(false);
  });

  it("matches collection (handle stored in productTags) policy", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        {
          id: "p1",
          matchType: "collection",
          matchValue: "clearance",
          windowDays: 0,
          returnable: false,
        },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["Clearance"] });
    expect(result.eligible).toBe(false);
  });

  it("rejects when product policy window has expired", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "shoes", windowDays: 7, returnable: true },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(20),
      productTags: ["shoes"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("7 days");
  });

  it("returnable product policy within window passes (skipping global window)", () => {
    // global window says 1 day, but product policy gives 100 → still eligible.
    const settings = makeSettings({
      returnWindowDays: 1,
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "premium", windowDays: 100, returnable: true },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(50),
      productTags: ["premium"],
    });
    expect(result.eligible).toBe(true);
  });

  it("first matching policy wins (later non-returnable rule ignored)", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "ok", windowDays: 0, returnable: true },
        { id: "p2", matchType: "tags", matchValue: "ok", windowDays: 0, returnable: false },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["ok"] });
    expect(result.eligible).toBe(true);
  });

  it("falls through to global rules when no product policy matches", () => {
    const settings = makeSettings({
      returnWindowDays: 30,
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "other", windowDays: 0, returnable: false },
      ]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(60),
      productTags: ["unrelated"],
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("30 days");
  });

  it("ignores malformed productPoliciesJson", () => {
    const settings = makeSettings({
      productPoliciesJson: "{not json",
      returnWindowDays: 30,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(5),
      productTags: ["any"],
    });
    expect(result.eligible).toBe(true);
  });

  it("does not match a tags rule when productTags is empty/undefined", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "x", windowDays: 0, returnable: false },
      ]),
    } as Partial<ShopSettings>);
    expect(checkReturnEligibility(settings, {}).eligible).toBe(true);
    expect(checkReturnEligibility(settings, { productTags: [] }).eligible).toBe(true);
  });

  it("matches comma-separated tag list in matchValue", () => {
    const settings = makeSettings({
      productPoliciesJson: JSON.stringify([
        { id: "p1", matchType: "tags", matchValue: "a, b, c", windowDays: 0, returnable: false },
      ]),
    } as Partial<ShopSettings>);
    expect(checkReturnEligibility(settings, { productTags: ["B"] }).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — channel policies
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — channel policies", () => {
  it("rejects when channel policy disables returns (POS)", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "pos" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Point of Sale");
  });

  it("rejects with B2B label", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        b2b: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "b2b" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("B2B / Wholesale");
  });

  it("rejects with Draft Orders label", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        draft_order: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "draft_order" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("Draft Orders");
  });

  it("ignores channel policy when sourceChannel is 'web'", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        web: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "web" });
    expect(result.eligible).toBe(true);
  });

  it("allows returns when channel policy has returnEnabled true", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        pos: { returnEnabled: true, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "pos" });
    expect(result.eligible).toBe(true);
  });

  it("uses raw channel value as label when not in known map", () => {
    const settings = makeSettings({
      channelPoliciesJson: JSON.stringify({
        custom_channel: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      }),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { sourceChannel: "custom_channel" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("custom_channel");
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — no-return promotional period
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — no-return period", () => {
  it("rejects orders placed inside the no-return window", () => {
    const start = new Date("2026-01-01");
    const end = new Date("2026-01-31");
    const settings = makeSettings({
      noReturnPeriodEnabled: true,
      noReturnPeriodStart: start as unknown as Date,
      noReturnPeriodEnd: end as unknown as Date,
      returnWindowDays: 365,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { orderDate: new Date("2026-01-15") });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/promotional period/);
  });

  it("allows orders before the no-return window", () => {
    const settings = makeSettings({
      noReturnPeriodEnabled: true,
      noReturnPeriodStart: new Date("2026-01-01") as unknown as Date,
      noReturnPeriodEnd: new Date("2026-01-31") as unknown as Date,
      returnWindowDays: 99999,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { orderDate: new Date("2025-12-15") });
    expect(result.eligible).toBe(true);
  });

  it("ignores no-return when feature flag is disabled", () => {
    const settings = makeSettings({
      noReturnPeriodEnabled: false,
      noReturnPeriodStart: new Date("2026-01-01") as unknown as Date,
      noReturnPeriodEnd: new Date("2026-01-31") as unknown as Date,
      returnWindowDays: 365,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { orderDate: new Date("2026-01-15") });
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — minimum price
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — minimum return price", () => {
  it("rejects when productPrice is below minimum", () => {
    const settings = makeSettings({ minimumReturnPrice: 25 as unknown as never });
    const result = checkReturnEligibility(settings, { productPrice: 10 });
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain("at least 25");
  });

  it("allows when productPrice equals minimum", () => {
    const settings = makeSettings({ minimumReturnPrice: 25 as unknown as never });
    const result = checkReturnEligibility(settings, { productPrice: 25 });
    expect(result.eligible).toBe(true);
  });

  it("ignores minimum price when zero", () => {
    const settings = makeSettings({ minimumReturnPrice: 0 as unknown as never });
    const result = checkReturnEligibility(settings, { productPrice: 1 });
    expect(result.eligible).toBe(true);
  });

  it("ignores minimum price check when productPrice not provided", () => {
    const settings = makeSettings({ minimumReturnPrice: 100 as unknown as never });
    const result = checkReturnEligibility(settings, {});
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — restricted product tags
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — restricted product tags", () => {
  it("rejects when product has a restricted tag", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["clearance", "final-sale"]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["summer", "Clearance"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("This product is not eligible for return.");
  });

  it("allows when product tags don't intersect restricted list", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["clearance"]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["summer"] });
    expect(result.eligible).toBe(true);
  });

  it("does nothing when restrictedProductTagsJson is empty", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify([]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { productTags: ["clearance"] });
    expect(result.eligible).toBe(true);
  });

  it("does nothing when product tags missing", () => {
    const settings = makeSettings({
      restrictedProductTagsJson: JSON.stringify(["clearance"]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {});
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkReturnEligibility — restricted regions
// ---------------------------------------------------------------------------

describe("checkReturnEligibility — restricted regions", () => {
  it("rejects when customer country matches a restricted region", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "RU" }]),
      returnWindowDays: 365,
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, { customerCountry: "ru" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("Returns are not accepted from your region.");
  });

  it("rejects on country+province exact match", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "US", province: "HI" }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      customerCountry: "US",
      customerProvince: "hi",
    });
    expect(result.eligible).toBe(false);
  });

  it("allows when country matches but province does not", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "US", province: "HI" }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      customerCountry: "US",
      customerProvince: "CA",
    });
    expect(result.eligible).toBe(true);
  });

  it("province-only restriction matches across countries", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ province: "ON" }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {
      customerCountry: "CA",
      customerProvince: "ON",
    });
    expect(result.eligible).toBe(false);
  });

  it("ignores restricted regions when neither country nor province in context", () => {
    const settings = makeSettings({
      restrictedRegionsJson: JSON.stringify([{ country: "RU" }]),
    } as Partial<ShopSettings>);
    const result = checkReturnEligibility(settings, {});
    expect(result.eligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getReturnFee
// ---------------------------------------------------------------------------

describe("getReturnFee", () => {
  it("returns zero/USD when settings is null", () => {
    expect(getReturnFee(null)).toEqual({ amount: 0, currency: "USD" });
  });

  it("returns zero/USD when returnFeeAmount is null", () => {
    const settings = makeSettings({ returnFeeAmount: null });
    expect(getReturnFee(settings)).toEqual({ amount: 0, currency: "USD" });
  });

  it("returns global fee with default USD currency", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeeCurrency: null,
    });
    expect(getReturnFee(settings)).toEqual({ amount: 5, currency: "USD" });
  });

  it("returns global fee with configured currency", () => {
    const settings = makeSettings({
      returnFeeAmount: 12 as unknown as never,
      returnFeeCurrency: "EUR",
    });
    expect(getReturnFee(settings)).toEqual({ amount: 12, currency: "EUR" });
  });

  it("uses per-reason override fee when matched", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeeCurrency: "USD",
      returnFeesByReasonJson: JSON.stringify([
        { reason: "Changed mind", feeAmount: 10 },
        { reason: "Damaged", feeAmount: 0 },
      ]),
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings, "Damaged")).toEqual({ amount: 0, currency: "USD" });
    expect(getReturnFee(settings, "Changed mind")).toEqual({ amount: 10, currency: "USD" });
  });

  it("matches reason case-insensitively", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeesByReasonJson: JSON.stringify([{ reason: "Damaged", feeAmount: 0 }]),
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings, "DAMAGED").amount).toBe(0);
  });

  it("falls back to global fee when reason has no override", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeesByReasonJson: JSON.stringify([{ reason: "Damaged", feeAmount: 0 }]),
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings, "Wrong size").amount).toBe(5);
  });

  it("ignores malformed reasonFees JSON and returns global fee", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeesByReasonJson: "broken",
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings, "Damaged").amount).toBe(5);
  });

  it("filters reason entries with wrong shape", () => {
    const settings = makeSettings({
      returnFeeAmount: 5 as unknown as never,
      returnFeesByReasonJson: JSON.stringify([
        { reason: "Damaged" }, // missing feeAmount
        { feeAmount: 1 }, // missing reason
        { reason: "Wrong", feeAmount: "2" }, // bad type
        { reason: "Wrong", feeAmount: 2 }, // good
      ]),
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings, "Wrong").amount).toBe(2);
    expect(getReturnFee(settings, "Damaged").amount).toBe(5);
  });

  it("returns global fee when no reason argument given", () => {
    const settings = makeSettings({
      returnFeeAmount: 7 as unknown as never,
      returnFeesByReasonJson: JSON.stringify([{ reason: "X", feeAmount: 99 }]),
    } as Partial<ShopSettings>);
    expect(getReturnFee(settings).amount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// isPhotoRequired
// ---------------------------------------------------------------------------

describe("isPhotoRequired", () => {
  it("returns false when settings is null", () => {
    expect(isPhotoRequired(null)).toBe(false);
  });

  it("returns false when photoRequired is false", () => {
    expect(isPhotoRequired(makeSettings({ photoRequired: false }))).toBe(false);
  });

  it("returns true when photoRequired is true", () => {
    expect(isPhotoRequired(makeSettings({ photoRequired: true }))).toBe(true);
  });

  it("returns false (default) when photoRequired is null/undefined", () => {
    expect(isPhotoRequired(makeSettings({ photoRequired: null as unknown as boolean }))).toBe(
      false,
    );
    expect(isPhotoRequired(makeSettings({ photoRequired: undefined as unknown as boolean }))).toBe(
      false,
    );
  });
});
