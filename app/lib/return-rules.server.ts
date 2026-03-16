import type { ShopSettings } from "@prisma/client";
import { parseJsonArray } from "./parse-json";
import { parseChannelPolicies, getChannelPolicy } from "./source-channel.server";

export interface ReturnEligibilityResult {
  eligible: boolean;
  reason?: string;
}

export type ReasonFee = {
  reason: string;
  feeAmount: number;
};

export type CountryWindow = {
  country: string;
  days: number;
};

function parseReasonFees(settings: ShopSettings): ReasonFee[] {
  const json = (settings as { returnFeesByReasonJson?: string | null }).returnFeesByReasonJson;
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (f): f is ReasonFee =>
          f && typeof f === "object" && typeof f.reason === "string" && typeof f.feeAmount === "number",
      );
    }
  } catch { /* ignore */ }
  return [];
}

function parseCountryWindows(settings: ShopSettings): CountryWindow[] {
  const json = (settings as { returnWindowByCountryJson?: string | null }).returnWindowByCountryJson;
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (w): w is CountryWindow =>
          w && typeof w === "object" && typeof w.country === "string" && typeof w.days === "number",
      );
    }
  } catch { /* ignore */ }
  return [];
}

export type ProductPolicyRule = {
  id: string;
  matchType: "tags" | "product_type" | "collection";
  matchValue: string;
  windowDays: number;
  policyText?: string;
  returnable: boolean;
};

function matchesProductPolicy(
  rule: ProductPolicyRule,
  productTags?: string[],
  productType?: string | null,
): boolean {
  if (rule.matchType === "tags") {
    if (!productTags?.length) return false;
    const ruleValues = rule.matchValue.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
    return ruleValues.some((rv) => productTags.some((t) => t.toLowerCase() === rv));
  }
  if (rule.matchType === "product_type") {
    if (!productType) return false;
    return rule.matchValue.trim().toLowerCase() === productType.trim().toLowerCase();
  }
  if (rule.matchType === "collection") {
    if (!productTags?.length) return false;
    const collectionHandle = rule.matchValue.trim().toLowerCase();
    return productTags.some((t) => t.toLowerCase() === collectionHandle);
  }
  return false;
}

function findMatchingProductPolicy(
  settings: ShopSettings,
  productTags?: string[],
  productType?: string | null,
): ProductPolicyRule | null {
  const policiesJson = (settings as { productPoliciesJson?: string | null }).productPoliciesJson;
  if (!policiesJson) return null;

  let rules: ProductPolicyRule[] = [];
  try {
    const parsed = JSON.parse(policiesJson);
    if (Array.isArray(parsed)) rules = parsed;
  } catch { return null; }

  for (const rule of rules) {
    if (matchesProductPolicy(rule, productTags, productType)) {
      return rule;
    }
  }
  return null;
}

export function checkReturnEligibility(
  settings: ShopSettings | null,
  context: {
    orderDate?: Date;
    productPrice?: number;
    productTags?: string[];
    productType?: string | null;
    customerCountry?: string;
    customerProvince?: string;
    sourceChannel?: string | null; // "pos" | "draft_order" | "b2b" | "web" | null
  }
): ReturnEligibilityResult {
  if (!settings) return { eligible: true };

  // Per-channel policy check (runs before all other rules)
  if (context.sourceChannel && context.sourceChannel !== "web") {
    const channelPolicies = parseChannelPolicies(
      (settings as unknown as Record<string, unknown>).channelPoliciesJson as string | null
    );
    const channelPolicy = getChannelPolicy(channelPolicies, context.sourceChannel);
    if (channelPolicy) {
      if (channelPolicy.returnEnabled === false) {
        const channelLabels: Record<string, string> = {
          pos: "Point of Sale",
          draft_order: "Draft Orders",
          b2b: "B2B / Wholesale",
        };
        const label = channelLabels[context.sourceChannel] ?? context.sourceChannel;
        return {
          eligible: false,
          reason: `Returns are not available for orders placed via ${label}.`,
        };
      }
    }
  }

  // Product-level policy check (first match wins, before global window)
  const productPolicy = findMatchingProductPolicy(settings, context.productTags, context.productType);
  if (productPolicy) {
    if (!productPolicy.returnable) {
      return {
        eligible: false,
        reason: productPolicy.policyText || "This product is not eligible for return.",
      };
    }
    if (context.orderDate && productPolicy.windowDays > 0) {
      const windowEnd = new Date(context.orderDate);
      windowEnd.setDate(windowEnd.getDate() + productPolicy.windowDays);
      if (new Date() > windowEnd) {
        return {
          eligible: false,
          reason: productPolicy.policyText || `Return window has expired. Returns for this product are accepted within ${productPolicy.windowDays} days of order date.`,
        };
      }
    }
    // Product matched a policy that says returnable and within window -- skip global window check
  } else {
    // Check country-specific return window first
    let effectiveWindowDays = settings.returnWindowDays ?? 30;
    if (context.customerCountry) {
      const countryWindows = parseCountryWindows(settings);
      const countryMatch = countryWindows.find(
        (w) => w.country.toLowerCase() === context.customerCountry!.toLowerCase(),
      );
      if (countryMatch) {
        effectiveWindowDays = countryMatch.days;
      }
    }

    // No product policy matched -- use global (or country-specific) return window
    if (context.orderDate) {
      const windowEnd = new Date(context.orderDate);
      windowEnd.setDate(windowEnd.getDate() + effectiveWindowDays);
      if (new Date() > windowEnd) {
        return { eligible: false, reason: `Return window has expired. Returns are accepted within ${effectiveWindowDays} days of order date.` };
      }
    }
  }

  // No-return period
  if (settings.noReturnPeriodEnabled && settings.noReturnPeriodStart && settings.noReturnPeriodEnd && context.orderDate) {
    const start = new Date(settings.noReturnPeriodStart);
    const end = new Date(settings.noReturnPeriodEnd);
    if (context.orderDate >= start && context.orderDate <= end) {
      return { eligible: false, reason: "Returns are not accepted for orders placed during the promotional period." };
    }
  }

  // Minimum price
  const minPrice = settings.minimumReturnPrice != null ? Number(settings.minimumReturnPrice) : 0;
  if (minPrice > 0 && context.productPrice != null && context.productPrice < minPrice) {
    return { eligible: false, reason: `Product price must be at least ${minPrice} to be eligible for return.` };
  }

  // Restricted product tags
  const restrictedTags = parseJsonArray<string>(settings.restrictedProductTagsJson, []);
  if (restrictedTags.length > 0 && context.productTags?.length) {
    const hasRestricted = context.productTags.some((t) =>
      restrictedTags.some((r) => r.toLowerCase() === t.toLowerCase())
    );
    if (hasRestricted) {
      return { eligible: false, reason: "This product is not eligible for return." };
    }
  }

  // Restricted regions
  const regions = parseJsonArray<{ country?: string; province?: string }>(settings.restrictedRegionsJson, []);
  if (regions.length > 0 && (context.customerCountry || context.customerProvince)) {
    const match = regions.some((r) => {
      const countryMatch = !r.country || r.country.toLowerCase() === (context.customerCountry ?? "").toLowerCase();
      const provinceMatch = !r.province || r.province.toLowerCase() === (context.customerProvince ?? "").toLowerCase();
      return countryMatch && provinceMatch;
    });
    if (match) {
      return { eligible: false, reason: "Returns are not accepted from your region." };
    }
  }

  return { eligible: true };
}

export function getReturnFee(settings: ShopSettings | null, returnReason?: string): { amount: number; currency: string } {
  if (!settings || settings.returnFeeAmount == null) return { amount: 0, currency: "USD" };

  // Check per-reason fee first (overrides global fee)
  if (returnReason) {
    const reasonFees = parseReasonFees(settings);
    const match = reasonFees.find((f) => f.reason.toLowerCase() === returnReason.toLowerCase());
    if (match) {
      return { amount: match.feeAmount, currency: settings.returnFeeCurrency ?? "USD" };
    }
  }

  // Fall back to global fee
  return {
    amount: Number(settings.returnFeeAmount),
    currency: settings.returnFeeCurrency ?? "USD",
  };
}

export function isPhotoRequired(settings: ShopSettings | null): boolean {
  return settings?.photoRequired ?? false;
}
