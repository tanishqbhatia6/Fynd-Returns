/**
 * Deep tests for auto-approve.server.ts: covers parseAutoApproveRules JSON
 * sanitisation and evaluateAutoApproveRules across every supported
 * field/operator combination, including null context fallbacks, ordering
 * semantics ("first match wins"), case-insensitive string compare, NaN-safe
 * numeric parsing, and the productTag tag-array semantics.
 */
import { describe, it, expect } from "vitest";
import {
  parseAutoApproveRules,
  evaluateAutoApproveRules,
  type AutoApproveRule,
  type AutoApproveContext,
} from "../auto-approve.server";

const rule = (
  field: AutoApproveRule["field"],
  operator: AutoApproveRule["operator"],
  value: string,
  action: AutoApproveRule["action"] = "approve",
): AutoApproveRule => ({ field, operator, value, action });

describe("parseAutoApproveRules", () => {
  it("returns [] for null/undefined/empty/whitespace", () => {
    expect(parseAutoApproveRules(null)).toEqual([]);
    expect(parseAutoApproveRules(undefined)).toEqual([]);
    expect(parseAutoApproveRules("")).toEqual([]);
    expect(parseAutoApproveRules("   \n\t ")).toEqual([]);
  });

  it("returns [] for invalid JSON", () => {
    expect(parseAutoApproveRules("{not json")).toEqual([]);
  });

  it("returns [] for non-array JSON values (object/string/number)", () => {
    expect(parseAutoApproveRules('{"field":"orderValue"}')).toEqual([]);
    expect(parseAutoApproveRules('"oops"')).toEqual([]);
    expect(parseAutoApproveRules("42")).toEqual([]);
  });

  it("returns [] for an empty JSON array", () => {
    expect(parseAutoApproveRules("[]")).toEqual([]);
  });

  it("filters out non-object entries (null, string, number)", () => {
    const json = JSON.stringify([null, "x", 7, rule("orderValue", "gt", "100")]);
    const result = parseAutoApproveRules(json);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("orderValue");
  });

  it("filters out entries missing required string fields", () => {
    const json = JSON.stringify([
      { field: "orderValue", operator: "gt", value: 100, action: "approve" }, // value not string
      { field: "orderValue", operator: "gt", value: "100" }, // missing action
      { operator: "gt", value: "100", action: "approve" }, // missing field
      rule("orderValue", "gt", "100"),
    ]);
    expect(parseAutoApproveRules(json)).toHaveLength(1);
  });

  it("preserves rule order and accepts unknown enum values (validated at evaluate time)", () => {
    const rules = [
      rule("orderValue", "gt", "100", "approve"),
      rule("returnReason", "eq", "damaged", "manual_review"),
      { field: "bogusField", operator: "weirdOp", value: "x", action: "approve" } as unknown as AutoApproveRule,
    ];
    const result = parseAutoApproveRules(JSON.stringify(rules));
    expect(result).toEqual(rules);
  });
});

describe("evaluateAutoApproveRules — empty inputs", () => {
  it("returns null when rules is empty", () => {
    expect(evaluateAutoApproveRules([], { orderValue: 100 })).toBeNull();
  });

  it("returns null when rules is null-like (defensive)", () => {
    expect(evaluateAutoApproveRules(null as unknown as AutoApproveRule[], {})).toBeNull();
  });

  it("returns null when no rule matches", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "gt", "1000")], { orderValue: 50 })).toBeNull();
  });
});

describe("evaluateAutoApproveRules — orderValue (numeric)", () => {
  const ctx: AutoApproveContext = { orderValue: 100 };

  it("eq matches and mismatches correctly", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "eq", "100")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("orderValue", "eq", "99")], ctx)).toBeNull();
  });

  it("neq inverts eq", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "neq", "99")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("orderValue", "neq", "100")], ctx)).toBeNull();
  });

  it("gt is strict; gte allows equality", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "gt", "100")], ctx)).toBeNull();
    expect(evaluateAutoApproveRules([rule("orderValue", "gt", "50")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("orderValue", "gte", "100")], ctx)).toBe("approve");
  });

  it("lt is strict; lte allows equality", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "lt", "100")], ctx)).toBeNull();
    expect(evaluateAutoApproveRules([rule("orderValue", "lt", "200")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("orderValue", "lte", "100")], ctx)).toBe("approve");
  });

  it("returns null when orderValue is missing from context", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "gt", "0")], {})).toBeNull();
  });

  it("returns null when rule.value is not a finite number", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "gt", "abc")], ctx)).toBeNull();
  });

  it("parses decimal values correctly", () => {
    expect(
      evaluateAutoApproveRules([rule("orderValue", "gte", "99.99")], { orderValue: 99.99 }),
    ).toBe("approve");
  });

  it("contains/not_contains never match for numeric field", () => {
    expect(evaluateAutoApproveRules([rule("orderValue", "contains", "100")], ctx)).toBeNull();
    expect(evaluateAutoApproveRules([rule("orderValue", "not_contains", "100")], ctx)).toBeNull();
  });
});

describe("evaluateAutoApproveRules — returnReason (string)", () => {
  const ctx: AutoApproveContext = { returnReason: "Damaged on Arrival" };

  it("eq is case-insensitive; neq inverts it", () => {
    expect(
      evaluateAutoApproveRules([rule("returnReason", "eq", "damaged on arrival")], ctx),
    ).toBe("approve");
    expect(
      evaluateAutoApproveRules([rule("returnReason", "neq", "wrong size")], ctx),
    ).toBe("approve");
    expect(
      evaluateAutoApproveRules([rule("returnReason", "neq", "DAMAGED ON ARRIVAL")], ctx),
    ).toBeNull();
  });

  it("contains/not_contains are case-insensitive substring checks", () => {
    expect(
      evaluateAutoApproveRules([rule("returnReason", "contains", "DAMAGED")], ctx),
    ).toBe("approve");
    expect(
      evaluateAutoApproveRules([rule("returnReason", "not_contains", "size")], ctx),
    ).toBe("approve");
    expect(
      evaluateAutoApproveRules([rule("returnReason", "not_contains", "damaged")], ctx),
    ).toBeNull();
  });

  it("returns null when returnReason missing or empty (falsy guard)", () => {
    expect(evaluateAutoApproveRules([rule("returnReason", "eq", "x")], {})).toBeNull();
    expect(
      evaluateAutoApproveRules([rule("returnReason", "eq", "")], { returnReason: "" }),
    ).toBeNull();
  });

  it("numeric operators on string field default to false", () => {
    expect(evaluateAutoApproveRules([rule("returnReason", "gt", "x")], ctx)).toBeNull();
  });
});

describe("evaluateAutoApproveRules — productTag (array)", () => {
  const ctx: AutoApproveContext = { productTags: ["Final-Sale", "Summer", "Clearance"] };

  it("eq matches an exact tag (case-insensitive); not a substring", () => {
    expect(evaluateAutoApproveRules([rule("productTag", "eq", "summer")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("productTag", "eq", "sum")], ctx)).toBeNull();
  });

  it("neq matches when no tag equals value; fails when one does", () => {
    expect(evaluateAutoApproveRules([rule("productTag", "neq", "winter")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("productTag", "neq", "summer")], ctx)).toBeNull();
  });

  it("contains is partial, case-insensitive, across any tag", () => {
    expect(evaluateAutoApproveRules([rule("productTag", "contains", "final")], ctx)).toBe("approve");
  });

  it("not_contains matches only when no tag includes the substring", () => {
    expect(
      evaluateAutoApproveRules([rule("productTag", "not_contains", "winter")], ctx),
    ).toBe("approve");
    expect(
      evaluateAutoApproveRules([rule("productTag", "not_contains", "sale")], ctx),
    ).toBeNull();
  });

  it("returns null when productTags is missing or empty", () => {
    expect(evaluateAutoApproveRules([rule("productTag", "contains", "x")], {})).toBeNull();
    expect(
      evaluateAutoApproveRules([rule("productTag", "contains", "x")], { productTags: [] }),
    ).toBeNull();
  });

  it("numeric operators on tag field default to false", () => {
    expect(evaluateAutoApproveRules([rule("productTag", "gt", "x")], ctx)).toBeNull();
  });
});

describe("evaluateAutoApproveRules — customerReturnCount (numeric)", () => {
  it("supports the full numeric operator set", () => {
    const ctx: AutoApproveContext = { customerReturnCount: 3 };
    expect(evaluateAutoApproveRules([rule("customerReturnCount", "gt", "2")], ctx)).toBe("approve");
    expect(evaluateAutoApproveRules([rule("customerReturnCount", "lte", "3")], ctx)).toBe("approve");
    expect(
      evaluateAutoApproveRules(
        [rule("customerReturnCount", "eq", "0")],
        { customerReturnCount: 0 },
      ),
    ).toBe("approve");
  });

  it("returns null when missing or non-finite rule.value", () => {
    expect(evaluateAutoApproveRules([rule("customerReturnCount", "gt", "0")], {})).toBeNull();
    expect(
      evaluateAutoApproveRules(
        [rule("customerReturnCount", "gt", "lots")],
        { customerReturnCount: 3 },
      ),
    ).toBeNull();
  });
});

describe("evaluateAutoApproveRules — ordering & action semantics", () => {
  it("returns 'manual_review' when rule.action is manual_review", () => {
    const rules = [rule("orderValue", "gt", "10", "manual_review")];
    expect(evaluateAutoApproveRules(rules, { orderValue: 50 })).toBe("manual_review");
  });

  it("treats unknown action strings as 'approve' (only manual_review is special)", () => {
    const rules = [
      { field: "orderValue", operator: "gt", value: "10", action: "weird" } as unknown as AutoApproveRule,
    ];
    expect(evaluateAutoApproveRules(rules, { orderValue: 50 })).toBe("approve");
  });

  it("first matching rule wins (later rules ignored)", () => {
    const rules = [
      rule("orderValue", "lt", "1000", "manual_review"),
      rule("orderValue", "gt", "0", "approve"),
    ];
    expect(evaluateAutoApproveRules(rules, { orderValue: 100 })).toBe("manual_review");
  });

  it("non-matching rules are skipped to find a later match", () => {
    const rules = [
      rule("returnReason", "eq", "fraud", "manual_review"),
      rule("orderValue", "gt", "0", "approve"),
    ];
    expect(evaluateAutoApproveRules(rules, { orderValue: 50 })).toBe("approve");
  });

  it("unknown field never matches and falls through to null", () => {
    const bogus = { field: "nope", operator: "eq", value: "x", action: "approve" } as unknown as AutoApproveRule;
    expect(evaluateAutoApproveRules([bogus], { orderValue: 50 })).toBeNull();
  });

  it("integrates parse + evaluate end-to-end", () => {
    const json = JSON.stringify([
      rule("productTag", "contains", "final-sale", "manual_review"),
      rule("orderValue", "lte", "500", "approve"),
    ]);
    const rules = parseAutoApproveRules(json);
    const ctx: AutoApproveContext = {
      orderValue: 250,
      productTags: ["final-sale", "summer"],
    };
    expect(evaluateAutoApproveRules(rules, ctx)).toBe("manual_review");
  });
});
