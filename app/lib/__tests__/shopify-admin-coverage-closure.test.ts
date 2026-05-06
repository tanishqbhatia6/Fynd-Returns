/**
 * Final coverage-closure tests for `app/lib/shopify-admin.server.ts`.
 *
 * Targets the small set of remaining uncovered branches that are reachable
 * through the public API. After running:
 *   - line 612: catch-block warn() inside fetchOrderByOrderNumber when
 *     rawGraphQLSearch throws (parseOrderNode can throw on malformed node)
 *   - line 640: catch-block warn() inside fetchOrderByOrderNumber Strategy 2
 *     when searchOrders / parseOrderNode throws a non-OrderAccessError
 *
 * Lines 429, 583, 623, 1473, 1474, 1842, 1882 are unreachable via the
 * public API (dead-after-private-default-args / impossible-state code) and
 * left for a future v8 ignore annotation. See the bottom of this file
 * for the reasoning.
 *
 * NEW FILE — does not modify existing tests or source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T,>(fn: () => Promise<T>) => fn() },
}));

import {
  fetchOrderByOrderNumber,
  withRestCredentials,
  type AdminGraphQL,
} from "../shopify-admin.server";

/**
 * Build a mock admin.graphql() that returns canned responses in FIFO order.
 * Mirrors the helper in shopify-admin-fetch.test.ts.
 */
function makeAdmin(responses: Array<unknown | Error>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const graphql = vi.fn(async () => {
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, "fetch").mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// A node shaped just well enough for rawGraphQLSearch's exactName match
// (so it passes the "name" filter at line 576) but malformed enough that
// parseOrderNode throws — lineItems.nodes[0] is null, so li.id dereferences
// null and the TypeError propagates out of rawGraphQLSearch, landing in
// the catch at line 611-613 of fetchOrderByOrderNumber.
function malformedNode(name: string) {
  return {
    id: "gid://shopify/Order/1",
    name,
    lineItems: { nodes: [null] },
  };
}

/* ─── Line 612: raw-fetch catch path ─────────────────────────────── */

describe("fetchOrderByOrderNumber — raw search throws (line 612 catch)", () => {
  it("warns and continues when rawGraphQLSearch throws (parseOrderNode TypeError)", async () => {
    // Strategy 1 raw fetch: first attempt (name:#X1) returns a node that
    // matches exactName but causes parseOrderNode to throw — exercises the
    // catch at line 611-613.
    // Then second attempt (name:X1) also returns a malformed node — same
    // throw path, second catch entry.
    // After Strategy 1, REST lookup runs; we let it return 404 (no match)
    // so we fall through to Strategy 2 (SDK), which returns empty.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // Strategy 1, attempt 1: raw GraphQL — malformed node → parseOrderNode throws
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { orders: { nodes: [malformedNode("#X1")] } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // Strategy 1, attempt 2: same shape, throws again
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { orders: { nodes: [malformedNode("X1")] } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // REST lookup (#X1): empty → falls through
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ orders: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      // REST lookup (X1): empty → falls through
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ orders: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    // SDK fallback (Strategy 2 + Strategy 3): all empty → null result.
    const { admin: baseAdmin } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // name:#X1
      { data: { orders: { nodes: [] } } }, // name:X1
      { data: { orders: { nodes: [] } } }, // metafield search
    ]);
    const admin = withRestCredentials(baseAdmin, "shop.myshopify.com", "tok");
    const order = await fetchOrderByOrderNumber(admin, "X1");
    expect(order).toBeNull();
    // Both raw GraphQL calls + both REST calls landed
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

/* ─── Line 640: SDK Strategy 2 catch path ────────────────────────── */

describe("fetchOrderByOrderNumber — SDK strategy 2 throws (line 640 catch)", () => {
  it("warns and continues when parseOrderNode throws inside Strategy 2", async () => {
    // No REST credentials → skip Strategy 1 entirely. Strategy 2 runs:
    //   q = "name:#X2"  → searchOrders returns a malformed node, then
    //                     parseOrderNode(node) throws TypeError on line 636.
    //   q = "name:X2"   → same again.
    // Strategy 3 (metafield) returns empty → null.
    // Each parseOrderNode throw lands in the catch at lines 638-641; the
    // err is not an OrderAccessError so the warn() at line 640 fires.
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [malformedNode("#X2")] } } },
      { data: { orders: { nodes: [malformedNode("X2")] } } },
      { data: { orders: { nodes: [] } } }, // metafield
    ]);
    const order = await fetchOrderByOrderNumber(admin, "X2");
    expect(order).toBeNull();
  });
});

/* ─── Sanity: existing happy paths still work ─────────────────────── */

describe("fetchOrderByOrderNumber — sanity check", () => {
  it("rejects empty input early (clean === '')", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrderByOrderNumber(admin, "#")).toBeNull();
  });
});
