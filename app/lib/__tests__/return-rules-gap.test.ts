/**
 * Gap-coverage tests for return-rules.server.ts.
 *
 * Targets the few branches not exercised by return-rules.test.ts and
 * return-rules-deep.test.ts:
 *   - matchesProductPolicy fallthrough for unknown matchType (line 78)
 *   - findMatchingProductPolicy when JSON.parse yields a non-array
 *   - parseReasonFees when JSON.parse yields a non-array
 *   - matchesProductPolicy collection branch when productTags missing
 *
 * Plus a few defensive parametric tests pinning documented contracts:
 *   - per-country window resolution
 *   - per-reason fee resolution
 *   - region restriction matching
 *
 * NOTE: Source must not be modified. Tests rely only on public exports.
 */
import { describe, it, expect } from "vitest";
import type { ShopSettings } from "@prisma/client";
import { checkReturnEligibility, getReturnFee } from "../return-rules.server";

function makeSettings(overrides: Partial<ShopSettings> = {}): ShopSettings {
  const base = {
    id: "s1",
    shop: "gap.myshopify.com",
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

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// Uncovered branches
// ---------------------------------------------------------------------------

describe("return-rules.server — uncovered branches", () => {
  it("matchesProductPolicy returns false for an unknown matchType (line 78)", () => {
    // An unrecognised matchType should not match any product, so the rule
    // is skipped and the global window applies. We use an order well within
    // the global window to assert eligible.
    const settings = makeSettings({
      returnWindowDays: 30,
      productPoliciesJson: JSON.stringify([
        {
          id: "weird",
          // intentionally not "tags" | "product_type" | "collection"
          matchType: "vendor",
          matchValue: "acme",
          windowDays: 0,
          returnable: false,
          policyText: "should never reject because matchType is unknown",
        },
      ]),
    } as Partial<ShopSettings>);

    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(5),
      productTags: ["acme"],
      productType: "acme",
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("findMatchingProductPolicy ignores productPoliciesJson that parses to a non-array", () => {
    // JSON.parse succeeds but yields an object, so rules stays []. Falls
    // through to the global window, which is generous → eligible.
    const settings = makeSettings({
      returnWindowDays: 30,
      productPoliciesJson: JSON.stringify({
        id: "p1",
        matchType: "tags",
        matchValue: "x",
        windowDays: 0,
        returnable: false,
      }),
    } as Partial<ShopSettings>);

    const result = checkReturnEligibility(settings, {
      orderDate: daysAgo(5),
      productTags: ["x"],
    });
    expect(result.eligible).toBe(true);
  });

  it("parseReasonFees ignores returnFeesByReasonJson that parses to a non-array", () => {
    // Object instead of array → no per-reason match → global fee applies.
    const settings = makeSettings({
      returnFeeAmount: 9 as unknown as never,
      returnFeeCurrency: "GBP",
      returnFeesByReasonJson: JSON.stringify({ reason: "Damaged", feeAmount: 0 }),
    } as Partial<ShopSettings>);

    expect(getReturnFee(settings, "Damaged")).toEqual({ amount: 9, currency: "GBP" });
  });

  it("collection-type product policy does not match when productTags is undefined", () => {
    // Collection rules read from productTags (handles propagated as tags).
    // No tags → no match → global window applies.
    const settings = makeSettings({
      returnWindowDays: 30,
      productPoliciesJson: JSON.stringify([
        {
          id: "p1",
          matchType: "collection",
          matchValue: "summer",
          windowDays: 0,
          returnable: false,
        },
      ]),
    } as Partial<ShopSettings>);

    const result = checkReturnEligibility(settings, { orderDate: daysAgo(2) });
    expect(result.eligible).toBe(true);
  });

  it("product_type policy does not match when productType is null/undefined", () => {
    const settings = makeSettings({
      returnWindowDays: 30,
      productPoliciesJson: JSON.stringify([
        {
          id: "p1",
          matchType: "product_type",
          matchValue: "Gift Card",
          windowDays: 0,
          returnable: false,
        },
      ]),
    } as Partial<ShopSettings>);

    expect(checkReturnEligibility(settings, { orderDate: daysAgo(2) }).eligible).toBe(true);
    expect(
      checkReturnEligibility(settings, { orderDate: daysAgo(2), productType: null }).eligible,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Defensive parametric contracts
// ---------------------------------------------------------------------------

describe("return-rules.server — country window resolution contract", () => {
  const cases: Array<{
    label: string;
    customer: string;
    expectedDays: number;
    eligibleAfter5Days: boolean;
  }> = [
    {
      label: "matched country uses override (3-day)",
      customer: "JP",
      expectedDays: 3,
      eligibleAfter5Days: false,
    },
    {
      label: "matched country uses override (90-day)",
      customer: "DE",
      expectedDays: 90,
      eligibleAfter5Days: true,
    },
    {
      label: "unmatched country falls back to global 30-day",
      customer: "ZZ",
      expectedDays: 30,
      eligibleAfter5Days: true,
    },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const settings = makeSettings({
        returnWindowDays: 30,
        returnWindowByCountryJson: JSON.stringify([
          { country: "JP", days: 3 },
          { country: "DE", days: 90 },
        ]),
      } as Partial<ShopSettings>);

      const result = checkReturnEligibility(settings, {
        orderDate: daysAgo(5),
        customerCountry: c.customer,
      });
      expect(result.eligible).toBe(c.eligibleAfter5Days);
      if (!c.eligibleAfter5Days) {
        expect(result.reason).toContain(`${c.expectedDays} days`);
      }
    });
  }
});

describe("return-rules.server — fee-by-reason contract", () => {
  const settings = makeSettings({
    returnFeeAmount: 5 as unknown as never,
    returnFeeCurrency: "USD",
    returnFeesByReasonJson: JSON.stringify([
      { reason: "Damaged", feeAmount: 0 },
      { reason: "Wrong size", feeAmount: 2.5 },
      { reason: "Changed mind", feeAmount: 7 },
    ]),
  } as Partial<ShopSettings>);

  const cases: Array<{ reason: string | undefined; expected: number }> = [
    { reason: "Damaged", expected: 0 },
    { reason: "damaged", expected: 0 },
    { reason: "Wrong size", expected: 2.5 },
    { reason: "Changed mind", expected: 7 },
    { reason: "Other reason", expected: 5 },
    { reason: undefined, expected: 5 },
  ];

  for (const c of cases) {
    it(`reason=${String(c.reason)} resolves to ${c.expected}`, () => {
      const fee = getReturnFee(settings, c.reason);
      expect(fee.amount).toBe(c.expected);
      expect(fee.currency).toBe("USD");
    });
  }
});

describe("return-rules.server — region restriction matching contract", () => {
  const settings = makeSettings({
    returnWindowDays: 365,
    restrictedRegionsJson: JSON.stringify([
      { country: "RU" }, // country-only block
      { country: "US", province: "HI" }, // country+province block
      { province: "ON" }, // province-only block
    ]),
  } as Partial<ShopSettings>);

  const cases: Array<{
    label: string;
    country?: string;
    province?: string;
    eligible: boolean;
  }> = [
    { label: "country-only match (RU)", country: "RU", eligible: false },
    { label: "country-only match case-insensitive (ru)", country: "ru", eligible: false },
    { label: "country+province exact match", country: "US", province: "HI", eligible: false },
    {
      label: "country matches but province does not",
      country: "US",
      province: "CA",
      eligible: true,
    },
    {
      label: "province-only match across countries",
      country: "CA",
      province: "ON",
      eligible: false,
    },
    { label: "no restricted region matches", country: "FR", province: "75", eligible: true },
    { label: "no country/province in context = no match", eligible: true },
  ];

  for (const c of cases) {
    it(c.label, () => {
      const result = checkReturnEligibility(settings, {
        customerCountry: c.country,
        customerProvince: c.province,
      });
      expect(result.eligible).toBe(c.eligible);
      if (!c.eligible) {
        expect(result.reason).toBe("Returns are not accepted from your region.");
      }
    });
  }
});
