/**
 * Extra parametric coverage for shouldBlockOrderForExistingReturn.
 *
 * Companion to portal-order-block-gate.test.ts — exhaustively walks 30+ scenario
 * combinations of line-items vs returnedQtyMap to lock down the gate's truth table.
 *
 * Rule under test (see api.portal.order.ts):
 *   block === lineItems.length > 0 && every(li => (returnedQtyMap[li.id] ?? 0) >= (li.quantity ?? 1))
 */
import { describe, it, expect, vi } from "vitest";

// The api.portal.order module pulls in the Shopify SDK, which throws at import
// time if SHOPIFY_API_KEY / SHOPIFY_API_SECRET are unset. Stub a minimal env
// before the import so this pure-function test can run without real credentials.
vi.stubEnv("SHOPIFY_API_KEY", "test-key");
vi.stubEnv("SHOPIFY_API_SECRET", "test-secret");
vi.stubEnv("SHOPIFY_APP_URL", "https://app.example");
vi.stubEnv("SCOPES", "read_orders");

const { shouldBlockOrderForExistingReturn } = await import("../api.portal.order");

type LineItem = { id: string; quantity?: number };
type ReturnedMap = Record<string, number>;

interface Scenario {
  name: string;
  items: LineItem[];
  returnedQtyMap: ReturnedMap;
  expected: boolean;
}

const scenarios: Scenario[] = [
  // -------- Empty / defensive --------
  { name: "empty items, empty map -> not blocked", items: [], returnedQtyMap: {}, expected: false },
  {
    name: "empty items, populated map -> not blocked",
    items: [],
    returnedQtyMap: { ghost: 99 },
    expected: false,
  },

  // -------- Single item, qty 1 --------
  {
    name: "1 item qty=1, no returns -> not blocked",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: {},
    expected: false,
  },
  {
    name: "1 item qty=1, returned 0 explicit -> not blocked",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: { a: 0 },
    expected: false,
  },
  {
    name: "1 item qty=1, returned 1 -> BLOCKED",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: { a: 1 },
    expected: true,
  },
  {
    name: "1 item qty=1, returned 9 (over-return) -> BLOCKED",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: { a: 9 },
    expected: true,
  },

  // -------- Single item, higher qty (partial returns) --------
  {
    name: "1 item qty=3, returned 1 -> not blocked (2 left)",
    items: [{ id: "a", quantity: 3 }],
    returnedQtyMap: { a: 1 },
    expected: false,
  },
  {
    name: "1 item qty=3, returned 2 -> not blocked (1 left)",
    items: [{ id: "a", quantity: 3 }],
    returnedQtyMap: { a: 2 },
    expected: false,
  },
  {
    name: "1 item qty=3, returned 3 -> BLOCKED",
    items: [{ id: "a", quantity: 3 }],
    returnedQtyMap: { a: 3 },
    expected: true,
  },
  {
    name: "1 item qty=10, returned 9 -> not blocked (1 left)",
    items: [{ id: "a", quantity: 10 }],
    returnedQtyMap: { a: 9 },
    expected: false,
  },
  {
    name: "1 item qty=10, returned 10 -> BLOCKED",
    items: [{ id: "a", quantity: 10 }],
    returnedQtyMap: { a: 10 },
    expected: true,
  },

  // -------- Undefined quantity defaults to 1 --------
  {
    name: "1 item qty=undefined, no returns -> not blocked",
    items: [{ id: "a" }],
    returnedQtyMap: {},
    expected: false,
  },
  {
    name: "1 item qty=undefined, returned 1 -> BLOCKED",
    items: [{ id: "a" }],
    returnedQtyMap: { a: 1 },
    expected: true,
  },
  {
    name: "2 items qty=undefined each, only one returned -> not blocked",
    items: [{ id: "a" }, { id: "b" }],
    returnedQtyMap: { a: 1 },
    expected: false,
  },
  {
    name: "2 items qty=undefined each, both returned -> BLOCKED",
    items: [{ id: "a" }, { id: "b" }],
    returnedQtyMap: { a: 1, b: 1 },
    expected: true,
  },

  // -------- Two items (the reported bug surface) --------
  {
    name: "2 items, neither returned -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
    returnedQtyMap: {},
    expected: false,
  },
  {
    name: "2 items, only first returned -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
    returnedQtyMap: { a: 1 },
    expected: false,
  },
  {
    name: "2 items, only second returned -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
    returnedQtyMap: { b: 1 },
    expected: false,
  },
  {
    name: "2 items, both fully returned -> BLOCKED",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ],
    returnedQtyMap: { a: 1, b: 1 },
    expected: true,
  },

  // -------- Mixed quantities --------
  {
    name: "2 items mixed qty (2,3), partial on both -> not blocked",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 3 },
    ],
    returnedQtyMap: { a: 1, b: 1 },
    expected: false,
  },
  {
    name: "2 items mixed qty (2,3), one fully returned -> not blocked",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 3 },
    ],
    returnedQtyMap: { a: 2 },
    expected: false,
  },
  {
    name: "2 items mixed qty (2,3), both fully returned -> BLOCKED",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 3 },
    ],
    returnedQtyMap: { a: 2, b: 3 },
    expected: true,
  },
  {
    name: "2 items mixed qty (2,3), over-returned on one only -> not blocked",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 3 },
    ],
    returnedQtyMap: { a: 5, b: 1 },
    expected: false,
  },
  {
    name: "2 items mixed qty (2,3), over-returned on both -> BLOCKED",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 3 },
    ],
    returnedQtyMap: { a: 5, b: 99 },
    expected: true,
  },

  // -------- Three items --------
  {
    name: "3 items, none returned -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
      { id: "c", quantity: 1 },
    ],
    returnedQtyMap: {},
    expected: false,
  },
  {
    name: "3 items, two returned -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
      { id: "c", quantity: 1 },
    ],
    returnedQtyMap: { a: 1, b: 1 },
    expected: false,
  },
  {
    name: "3 items, all returned -> BLOCKED",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
      { id: "c", quantity: 1 },
    ],
    returnedQtyMap: { a: 1, b: 1, c: 1 },
    expected: true,
  },
  {
    name: "3 items mixed qty (1,2,3), all fully returned -> BLOCKED",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 2 },
      { id: "c", quantity: 3 },
    ],
    returnedQtyMap: { a: 1, b: 2, c: 3 },
    expected: true,
  },
  {
    name: "3 items mixed qty (1,2,3), middle one short by 1 -> not blocked",
    items: [
      { id: "a", quantity: 1 },
      { id: "b", quantity: 2 },
      { id: "c", quantity: 3 },
    ],
    returnedQtyMap: { a: 1, b: 1, c: 3 },
    expected: false,
  },

  // -------- Stranger / defensive shapes --------
  {
    name: "map contains unrelated ids; nothing returned for actual items -> not blocked",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: { other_id: 5 },
    expected: false,
  },
  {
    name: "map contains unrelated ids AND full return for actual items -> BLOCKED",
    items: [{ id: "a", quantity: 1 }],
    returnedQtyMap: { other_id: 5, a: 1 },
    expected: true,
  },
  {
    name: "qty=0 (degenerate); returned=0 -> BLOCKED (0 >= 0)",
    items: [{ id: "a", quantity: 0 }],
    returnedQtyMap: {},
    expected: true,
  },
  {
    name: "large order (5 items) one short -> not blocked",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 2 },
      { id: "c", quantity: 2 },
      { id: "d", quantity: 2 },
      { id: "e", quantity: 2 },
    ],
    returnedQtyMap: { a: 2, b: 2, c: 2, d: 2, e: 1 },
    expected: false,
  },
  {
    name: "large order (5 items) all fully returned -> BLOCKED",
    items: [
      { id: "a", quantity: 2 },
      { id: "b", quantity: 2 },
      { id: "c", quantity: 2 },
      { id: "d", quantity: 2 },
      { id: "e", quantity: 2 },
    ],
    returnedQtyMap: { a: 2, b: 2, c: 2, d: 2, e: 2 },
    expected: true,
  },
  {
    name: "FYNDSHOPIFYX14294 regression: 2-article order, only first returned -> not blocked",
    items: [
      { id: "li_article_1", quantity: 1 },
      { id: "li_article_2", quantity: 1 },
    ],
    returnedQtyMap: { li_article_1: 1 },
    expected: false,
  },
];

describe("shouldBlockOrderForExistingReturn — parametric coverage", () => {
  it("scenario table covers at least 30 combinations", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
  });

  it.each(scenarios)("$name", ({ items, returnedQtyMap, expected }) => {
    expect(shouldBlockOrderForExistingReturn(items, returnedQtyMap)).toBe(expected);
  });
});
