/**
 * Regression tests for shouldBlockOrderForExistingReturn — the gate that decides whether
 * the customer portal hard-blocks a new return ("Return already submitted" screen) or
 * lets the user through to step 2 with already-returned items disabled.
 *
 * Bug repro: Order FYNDSHOPIFYX14294 had two articles. After returning one, the portal
 * blocked any further returns. The gate must only block when EVERY line item is fully
 * returned.
 */
import { describe, it, expect } from "vitest";
import { shouldBlockOrderForExistingReturn } from "../api.portal.order";

describe("shouldBlockOrderForExistingReturn", () => {
  it("does NOT block when no items have been returned yet", () => {
    const items = [{ id: "li_1", quantity: 1 }, { id: "li_2", quantity: 1 }];
    expect(shouldBlockOrderForExistingReturn(items, {})).toBe(false);
  });

  it("does NOT block when only some items have been returned (multi-item order)", () => {
    const items = [{ id: "li_1", quantity: 1 }, { id: "li_2", quantity: 1 }];
    const returnedQtyMap = { li_1: 1 }; // li_2 still returnable
    expect(shouldBlockOrderForExistingReturn(items, returnedQtyMap)).toBe(false);
  });

  it("does NOT block when an item has partial return quantity remaining", () => {
    const items = [{ id: "li_1", quantity: 3 }];
    const returnedQtyMap = { li_1: 1 }; // 2 still returnable
    expect(shouldBlockOrderForExistingReturn(items, returnedQtyMap)).toBe(false);
  });

  it("BLOCKS only when every line item is fully returned", () => {
    const items = [{ id: "li_1", quantity: 2 }, { id: "li_2", quantity: 1 }];
    const returnedQtyMap = { li_1: 2, li_2: 1 };
    expect(shouldBlockOrderForExistingReturn(items, returnedQtyMap)).toBe(true);
  });

  it("BLOCKS when returned quantity equals or exceeds ordered quantity", () => {
    const items = [{ id: "li_1", quantity: 1 }];
    expect(shouldBlockOrderForExistingReturn(items, { li_1: 1 })).toBe(true);
    // Defensive: if accounting drifts and returned > ordered, still block (no items left)
    expect(shouldBlockOrderForExistingReturn(items, { li_1: 5 })).toBe(true);
  });

  it("treats undefined quantity as 1 (Shopify default)", () => {
    const items = [{ id: "li_1" }, { id: "li_2" }];
    expect(shouldBlockOrderForExistingReturn(items, { li_1: 1 })).toBe(false);
    expect(shouldBlockOrderForExistingReturn(items, { li_1: 1, li_2: 1 })).toBe(true);
  });

  it("does NOT block when the order has no items (defensive)", () => {
    expect(shouldBlockOrderForExistingReturn([], {})).toBe(false);
  });
});
