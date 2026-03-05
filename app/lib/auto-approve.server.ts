export type AutoApproveRule = {
  field: "orderValue" | "returnReason" | "productTag" | "customerReturnCount";
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains";
  value: string;
  action: "approve" | "manual_review";
};

export type AutoApproveContext = {
  orderValue?: number;
  returnReason?: string;
  productTags?: string[];
  customerEmail?: string;
  customerReturnCount?: number;
};

export type AutoApproveResult = "approve" | "manual_review" | null;

function compareNumeric(actual: number, operator: string, target: number): boolean {
  switch (operator) {
    case "eq": return actual === target;
    case "neq": return actual !== target;
    case "gt": return actual > target;
    case "gte": return actual >= target;
    case "lt": return actual < target;
    case "lte": return actual <= target;
    default: return false;
  }
}

function compareString(actual: string, operator: string, target: string): boolean {
  const a = actual.toLowerCase();
  const t = target.toLowerCase();
  switch (operator) {
    case "eq": return a === t;
    case "neq": return a !== t;
    case "contains": return a.includes(t);
    case "not_contains": return !a.includes(t);
    default: return false;
  }
}

function evaluateRule(rule: AutoApproveRule, context: AutoApproveContext): boolean {
  switch (rule.field) {
    case "orderValue": {
      if (context.orderValue == null) return false;
      const target = parseFloat(rule.value);
      if (!Number.isFinite(target)) return false;
      return compareNumeric(context.orderValue, rule.operator, target);
    }
    case "returnReason": {
      if (!context.returnReason) return false;
      return compareString(context.returnReason, rule.operator, rule.value);
    }
    case "productTag": {
      if (!context.productTags || context.productTags.length === 0) return false;
      const target = rule.value.toLowerCase();
      if (rule.operator === "contains") {
        return context.productTags.some((t) => t.toLowerCase().includes(target));
      }
      if (rule.operator === "not_contains") {
        return !context.productTags.some((t) => t.toLowerCase().includes(target));
      }
      if (rule.operator === "eq") {
        return context.productTags.some((t) => t.toLowerCase() === target);
      }
      if (rule.operator === "neq") {
        return !context.productTags.some((t) => t.toLowerCase() === target);
      }
      return false;
    }
    case "customerReturnCount": {
      if (context.customerReturnCount == null) return false;
      const target = parseFloat(rule.value);
      if (!Number.isFinite(target)) return false;
      return compareNumeric(context.customerReturnCount, rule.operator, target);
    }
    default:
      return false;
  }
}

/**
 * Evaluate auto-approve rules against a return context.
 * Rules are evaluated in order; the first matching rule's action wins.
 * Returns null if no rule matches (caller should use default behavior).
 */
export function evaluateAutoApproveRules(
  rules: AutoApproveRule[],
  context: AutoApproveContext,
): AutoApproveResult {
  if (!rules || rules.length === 0) return null;

  for (const rule of rules) {
    if (evaluateRule(rule, context)) {
      return rule.action === "manual_review" ? "manual_review" : "approve";
    }
  }

  return null;
}

export function parseAutoApproveRules(json: string | null | undefined): AutoApproveRule[] {
  if (!json || !json.trim()) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AutoApproveRule =>
        r &&
        typeof r === "object" &&
        typeof r.field === "string" &&
        typeof r.operator === "string" &&
        typeof r.value === "string" &&
        typeof r.action === "string",
    );
  } catch {
    return [];
  }
}
