/**
 * Final 100% statement-coverage closure for app/lib/shopify-admin.server.ts.
 * Covers the residual lines that prior suites don't reach:
 *   - line 22: shopifyFetch — setTimeout abort callback fires (timeout path)
 *   - line ~2137: declineShopifyReturn — userError without "already declined" pattern
 *   - line ~2208: closeAllOpenReturnsOnOrder — successful close pushes onto `closed`
 *
 * No source modification beyond /* v8 ignore *\/ blocks for genuinely-unreachable lines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T>(fn: () => Promise<T>) => fn() },
}));

import {
  createAdminClient,
  declineShopifyReturn,
  closeShopifyReturnBestEffort,
  type AdminGraphQL,
} from "../shopify-admin.server";

type GraphqlCall = { query: string; variables?: Record<string, unknown> };
function makeAdmin(responses: Array<unknown | Error>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let i = 0;
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

beforeEach(() => vi.clearAllMocks());

/* ─────────────────────────────────────────────────────────────────────
 * 1. shopifyFetch timeout — abort callback fires (covers line 22)
 *    Drive via createAdminClient(...).graphql which calls shopifyFetch.
 * ───────────────────────────────────────────────────────────────────── */
describe("shopifyFetch — timeout abort callback", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("invokes controller.abort() when the timer fires", async () => {
    vi.useFakeTimers();
    // fetch resolves only after we manually advance timers; signal abort triggers
    // the callback at line 22 of shopify-admin.server.ts.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      return new Promise((resolve) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            // Resolve with a synthetic 408 response so we don't trigger an
            // unhandled rejection in the test runner — the only thing under
            // test here is that controller.abort() ran.
            resolve(new Response("aborted", { status: 408 }));
          });
        }
      });
    });
    const client = createAdminClient("acme", "shpat_TOKEN");
    const promise = client.graphql("{ __typename }");
    // Fire the 15s default timeout — fires the abort callback.
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await promise;
    expect(res.status).toBe(408);
    expect(fetchSpy).toHaveBeenCalled();
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * 2. declineShopifyReturn — userError that does NOT match the
 *    "already declined / cannot decline / closed" pattern. Falls through
 *    to the generic error return (line ~2137).
 * ───────────────────────────────────────────────────────────────────── */
describe("declineShopifyReturn — generic userError path", () => {
  it("returns success:false with prefixed message when userError doesn't match the dismissable patterns", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: null,
            userErrors: [{ field: ["id"], message: "Refund still pending" }],
          },
        },
      },
    ]);
    const r = await declineShopifyReturn(admin, "gid://shopify/Return/9");
    expect(r.success).toBe(false);
    expect(r.error).toBe("Return decline failed: Refund still pending");
  });
});

/* ─────────────────────────────────────────────────────────────────────
 * 3. closeAllOpenReturnsOnOrder — successful sweep push (line ~2208).
 *    The existing closure suite tested the failed-push branch; here we
 *    feed a successful child returnClose so closed.push(ret.id) fires.
 * ───────────────────────────────────────────────────────────────────── */
describe("closeAllOpenReturnsOnOrder — success push branch", () => {
  it("records swept return id in `closed` when child close succeeds", async () => {
    const { admin } = makeAdmin([
      // 1) primary returnClose (best-effort target)
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
      // 2) openReturns sweep query — returns one OPEN sibling
      {
        data: {
          order: {
            returns: {
              edges: [{ node: { id: "gid://shopify/Return/SIB", status: "OPEN" } }],
            },
          },
        },
      },
      // 3) returnClose for the swept sibling — succeeds (no userErrors)
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/SIB", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi.fn(async (_e: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc-1",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    const payload = JSON.parse(logEvent.mock.calls[0]?.[0].payloadJson as string);
    expect(payload.sweepClosed).toEqual(["gid://shopify/Return/SIB"]);
    expect(payload.sweepFailed ?? []).toEqual([]);
  });
});
