import { describe, it, expect } from "vitest";
import { getReturnFee } from "../return-rules.server";
import type { ShopSettings } from "@prisma/client";

const baseSettings = {
  id: "s1",
  shopId: "shop-1",
  returnWindowDays: 30,
  returnFeeAmount: 5,
  returnFeeCurrency: "USD",
  returnFeesByReasonJson: null, // <-- triggers `if (!json) return [];` path
  returnWindowByCountryJson: null,
  productPoliciesJson: null,
  restrictedProductTagsJson: null,
  restrictedRegionsJson: null,
  channelPoliciesJson: null,
  noReturnPeriodEnabled: false,
  noReturnPeriodStart: null,
  noReturnPeriodEnd: null,
  minimumReturnPrice: null,
  photoRequired: false,
} as unknown as ShopSettings;

/**
 * Coverage closure: hits `parseReasonFees` line 22 (`if (!json) return []`)
 * — this is only reachable when `getReturnFee` is invoked WITH a reason
 * (so `parseReasonFees` actually runs) AND `returnFeesByReasonJson` is null.
 */
describe("return-rules getReturnFee parseReasonFees null-json branch", () => {
  it("falls back to global fee when reason given but per-reason JSON is null", () => {
    const fee = getReturnFee(baseSettings, "Damaged");
    expect(fee).toEqual({ amount: 5, currency: "USD" });
  });
});
