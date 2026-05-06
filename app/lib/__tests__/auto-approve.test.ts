import { describe, it, expect } from "vitest";
import {
  evaluateAutoApproveRules,
  parseAutoApproveRules,
  type AutoApproveRule,
  type AutoApproveContext,
} from "../auto-approve.server";

describe("evaluateAutoApproveRules", () => {
  it("returns null for empty rules array", () => {
    const result = evaluateAutoApproveRules([], { orderValue: 100 });
    expect(result).toBeNull();
  });

  it("returns null for null/undefined rules", () => {
    const result = evaluateAutoApproveRules(null as unknown as AutoApproveRule[], {
      orderValue: 100,
    });
    expect(result).toBeNull();
  });

  it("first matching rule wins - approve action", () => {
    const rules: AutoApproveRule[] = [
      { field: "orderValue", operator: "lt", value: "50", action: "approve" },
      {
        field: "orderValue",
        operator: "lt",
        value: "200",
        action: "manual_review",
      },
    ];
    const result = evaluateAutoApproveRules(rules, { orderValue: 30 });
    expect(result).toBe("approve");
  });

  it("first matching rule wins - manual_review action", () => {
    const rules: AutoApproveRule[] = [
      {
        field: "orderValue",
        operator: "gt",
        value: "100",
        action: "manual_review",
      },
      { field: "orderValue", operator: "gt", value: "50", action: "approve" },
    ];
    const result = evaluateAutoApproveRules(rules, { orderValue: 150 });
    expect(result).toBe("manual_review");
  });

  it("skips non-matching rules and matches later rule", () => {
    const rules: AutoApproveRule[] = [
      { field: "orderValue", operator: "lt", value: "10", action: "approve" },
      {
        field: "orderValue",
        operator: "gt",
        value: "50",
        action: "manual_review",
      },
    ];
    const result = evaluateAutoApproveRules(rules, { orderValue: 100 });
    expect(result).toBe("manual_review");
  });

  it("returns null when no rule matches", () => {
    const rules: AutoApproveRule[] = [
      { field: "orderValue", operator: "gt", value: "1000", action: "approve" },
      {
        field: "returnReason",
        operator: "eq",
        value: "defective",
        action: "approve",
      },
    ];
    const result = evaluateAutoApproveRules(rules, {
      orderValue: 50,
      returnReason: "changed_mind",
    });
    expect(result).toBeNull();
  });

  describe("orderValue comparisons", () => {
    const makeRule = (operator: AutoApproveRule["operator"], value: string): AutoApproveRule => ({
      field: "orderValue",
      operator,
      value,
      action: "approve",
    });

    it("eq matches equal values", () => {
      expect(evaluateAutoApproveRules([makeRule("eq", "100")], { orderValue: 100 })).toBe(
        "approve",
      );
      expect(evaluateAutoApproveRules([makeRule("eq", "100")], { orderValue: 99 })).toBeNull();
    });

    it("neq matches unequal values", () => {
      expect(evaluateAutoApproveRules([makeRule("neq", "100")], { orderValue: 99 })).toBe(
        "approve",
      );
      expect(evaluateAutoApproveRules([makeRule("neq", "100")], { orderValue: 100 })).toBeNull();
    });

    it("gt matches greater values", () => {
      expect(evaluateAutoApproveRules([makeRule("gt", "100")], { orderValue: 101 })).toBe(
        "approve",
      );
      expect(evaluateAutoApproveRules([makeRule("gt", "100")], { orderValue: 100 })).toBeNull();
    });

    it("gte matches greater-or-equal values", () => {
      expect(evaluateAutoApproveRules([makeRule("gte", "100")], { orderValue: 100 })).toBe(
        "approve",
      );
      expect(evaluateAutoApproveRules([makeRule("gte", "100")], { orderValue: 99 })).toBeNull();
    });

    it("lt matches lesser values", () => {
      expect(evaluateAutoApproveRules([makeRule("lt", "100")], { orderValue: 99 })).toBe("approve");
      expect(evaluateAutoApproveRules([makeRule("lt", "100")], { orderValue: 100 })).toBeNull();
    });

    it("lte matches lesser-or-equal values", () => {
      expect(evaluateAutoApproveRules([makeRule("lte", "100")], { orderValue: 100 })).toBe(
        "approve",
      );
      expect(evaluateAutoApproveRules([makeRule("lte", "100")], { orderValue: 101 })).toBeNull();
    });

    it("returns false when orderValue is missing from context", () => {
      expect(evaluateAutoApproveRules([makeRule("gt", "100")], {})).toBeNull();
    });

    it("returns false when rule value is non-numeric", () => {
      expect(evaluateAutoApproveRules([makeRule("gt", "abc")], { orderValue: 100 })).toBeNull();
    });
  });

  describe("returnReason comparisons", () => {
    const makeRule = (operator: AutoApproveRule["operator"], value: string): AutoApproveRule => ({
      field: "returnReason",
      operator,
      value,
      action: "approve",
    });

    it("eq matches exact reason (case-insensitive)", () => {
      expect(
        evaluateAutoApproveRules([makeRule("eq", "defective")], {
          returnReason: "Defective",
        }),
      ).toBe("approve");
    });

    it("neq matches different reason", () => {
      expect(
        evaluateAutoApproveRules([makeRule("neq", "defective")], {
          returnReason: "changed_mind",
        }),
      ).toBe("approve");
    });

    it("contains matches substring", () => {
      expect(
        evaluateAutoApproveRules([makeRule("contains", "defect")], {
          returnReason: "Item is defective",
        }),
      ).toBe("approve");
    });

    it("not_contains matches when substring absent", () => {
      expect(
        evaluateAutoApproveRules([makeRule("not_contains", "defect")], {
          returnReason: "Changed my mind",
        }),
      ).toBe("approve");
    });

    it("returns false when returnReason is missing", () => {
      expect(evaluateAutoApproveRules([makeRule("eq", "defective")], {})).toBeNull();
    });
  });

  describe("productTag comparisons", () => {
    const makeRule = (operator: AutoApproveRule["operator"], value: string): AutoApproveRule => ({
      field: "productTag",
      operator,
      value,
      action: "approve",
    });

    it("contains matches tag substring", () => {
      expect(
        evaluateAutoApproveRules([makeRule("contains", "sale")], {
          productTags: ["clearance-sale", "new-arrival"],
        }),
      ).toBe("approve");
    });

    it("not_contains matches when no tag contains substring", () => {
      expect(
        evaluateAutoApproveRules([makeRule("not_contains", "final")], {
          productTags: ["sale", "new"],
        }),
      ).toBe("approve");
    });

    it("eq matches exact tag (case-insensitive)", () => {
      expect(
        evaluateAutoApproveRules([makeRule("eq", "sale")], {
          productTags: ["Sale", "new"],
        }),
      ).toBe("approve");
    });

    it("neq matches when tag not present", () => {
      expect(
        evaluateAutoApproveRules([makeRule("neq", "final-sale")], {
          productTags: ["sale", "new"],
        }),
      ).toBe("approve");
    });

    it("returns false when productTags is empty", () => {
      expect(
        evaluateAutoApproveRules([makeRule("contains", "sale")], {
          productTags: [],
        }),
      ).toBeNull();
    });
  });

  describe("customerReturnCount comparisons", () => {
    const makeRule = (operator: AutoApproveRule["operator"], value: string): AutoApproveRule => ({
      field: "customerReturnCount",
      operator,
      value,
      action: "manual_review",
    });

    it("gt matches when count exceeds threshold", () => {
      expect(
        evaluateAutoApproveRules([makeRule("gt", "3")], {
          customerReturnCount: 5,
        }),
      ).toBe("manual_review");
    });

    it("returns null when count is below threshold", () => {
      expect(
        evaluateAutoApproveRules([makeRule("gt", "3")], {
          customerReturnCount: 2,
        }),
      ).toBeNull();
    });

    it("returns null when customerReturnCount is missing", () => {
      expect(evaluateAutoApproveRules([makeRule("gt", "3")], {})).toBeNull();
    });
  });
});

describe("parseAutoApproveRules", () => {
  it("returns empty array for null input", () => {
    expect(parseAutoApproveRules(null)).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(parseAutoApproveRules(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAutoApproveRules("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseAutoApproveRules("   ")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAutoApproveRules("{bad json")).toEqual([]);
  });

  it("returns empty array when JSON is not an array", () => {
    expect(parseAutoApproveRules('{"field":"orderValue"}')).toEqual([]);
  });

  it("parses valid rules JSON", () => {
    const rules: AutoApproveRule[] = [
      { field: "orderValue", operator: "lt", value: "50", action: "approve" },
    ];
    const result = parseAutoApproveRules(JSON.stringify(rules));
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("orderValue");
    expect(result[0].operator).toBe("lt");
    expect(result[0].value).toBe("50");
    expect(result[0].action).toBe("approve");
  });

  it("filters out invalid rule objects", () => {
    const input = [
      { field: "orderValue", operator: "lt", value: "50", action: "approve" },
      { bad: "object" },
      null,
      42,
      { field: "returnReason", operator: "eq", value: "defect", action: "manual_review" },
    ];
    const result = parseAutoApproveRules(JSON.stringify(input));
    expect(result).toHaveLength(2);
    expect(result[0].field).toBe("orderValue");
    expect(result[1].field).toBe("returnReason");
  });
});
