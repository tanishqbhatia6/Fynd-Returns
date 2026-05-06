import { describe, it, expect } from "vitest";
import { getFyndShipmentDisplayFields } from "../fynd-payload.server";

/**
 * Coverage closure: hits the `return String(v)` fallthrough in valueToString
 * (line 85) by feeding a bigint (not handled by any of the prior branches).
 * Public API getFyndShipmentDisplayFields → collectFields → push → valueToString.
 */
describe("fynd-payload valueToString fallback (bigint)", () => {
  it("stringifies a bigint property via String() fallback", () => {
    const fields = getFyndShipmentDisplayFields({ ledger_id: 12345n });
    const f = fields.find((x) => x.key === "ledger_id");
    expect(f).toBeDefined();
    expect(f!.value).toBe("12345");
  });
});
