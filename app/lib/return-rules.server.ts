import type { ShopSettings } from "@prisma/client";
import { parseJsonArray } from "./parse-json";

export interface ReturnEligibilityResult {
  eligible: boolean;
  reason?: string;
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
  }
): ReturnEligibilityResult {
  if (!settings) return { eligible: true };

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
    // No product policy matched -- use global return window
    const returnWindowDays = settings.returnWindowDays ?? 30;
    if (context.orderDate) {
      const windowEnd = new Date(context.orderDate);
      windowEnd.setDate(windowEnd.getDate() + returnWindowDays);
      if (new Date() > windowEnd) {
        return { eligible: false, reason: `Return window has expired. Returns are accepted within ${returnWindowDays} days of order date.` };
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

export function getReturnFee(settings: ShopSettings | null): { amount: number; currency: string } {
  if (!settings || settings.returnFeeAmount == null) return { amount: 0, currency: "USD" };
  return {
    amount: Number(settings.returnFeeAmount),
    currency: settings.returnFeeCurrency ?? "USD",
  };
}

export function isPhotoRequired(settings: ShopSettings | null): boolean {
  return settings?.photoRequired ?? false;
}
