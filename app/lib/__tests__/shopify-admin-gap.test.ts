/**
 * Gap-coverage tests for `app/lib/shopify-admin.server.ts`.
 *
 * These tests target the branches not exercised by the existing
 * shopify-admin*.test.ts files — primarily:
 *   - createShopifyReturn (returnable fulfillments lookup, SKU fallback,
 *     in-flight subtraction, decision branches, error paths)
 *   - createRefund branches: zero-amount fallback for "original",
 *     guard for empty store_credit/both txns, location-error retry
 *   - fetchOrder / fetchOrderByGid / fetchOrderByOrderNumber error paths
 *   - fetchOrdersByFilter / fetchOrdersByCustomer
 *   - fetchOrderByFyndAffiliateId variants
 *   - fetchOrderLineItemsByName REST-credentials raw-fetch fallback
 *   - closeShopifyReturn / declineShopifyReturn error and exception paths
 *   - createAdminClient + withRestCredentials wiring
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_name: string, _attrs: unknown, fn: (span: unknown) => Promise<T>) =>
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
  withRestCredentials,
  createRefund,
  createShopifyReturn,
  closeShopifyReturn,
  declineShopifyReturn,
  closeShopifyReturnBestEffort,
  fetchOrder,
  fetchOrderByGid,
  fetchOrderByOrderNumber,
  fetchOrderByFyndAffiliateId,
  fetchOrdersByFilter,
  fetchOrdersByCustomer,
  fetchOrderLineItemsByName,
  fetchOrderLineItemsOnly,
  fetchAllLocations,
  fetchPrimaryLocationId,
  OrderAccessError,
  type AdminGraphQL,
} from "../shopify-admin.server";

/* ─── Helpers ───────────────────────────────────────────────────────── */

type Canned = unknown | Error | { status: number; body: unknown };

function makeAdmin(responses: Canned[]) {
  let i = 0;
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "status" in r && "body" in r) {
      return new Response(JSON.stringify((r as { body: unknown }).body), {
        status: (r as { status: number }).status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

/** Build a "broken JSON" response (text/html or truncated) — calling .json() throws. */
function brokenJsonResponse(status = 200): Response {
  return new Response("<html>not json</html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

const LOCATIONS_OK = {
  data: {
    locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true }] },
  },
};

function suggestedRefund(amount = "100.00", currency = "USD") {
  return {
    data: {
      order: {
        suggestedRefund: {
          amountSet: { shopMoney: { amount, currencyCode: currency } },
          subtotalSet: { shopMoney: { amount, currencyCode: currency } },
          suggestedTransactions: [
            {
              gateway: "shopify_payments",
              parentTransaction: { id: "gid://shopify/OrderTransaction/9001" },
              amountSet: { shopMoney: { amount, currencyCode: currency } },
              kind: "SUGGESTED_REFUND",
            },
          ],
        },
      },
    },
  };
}

function refundCreateOk(id = "gid://shopify/Refund/1", amount = "100.00", currency = "USD") {
  return {
    data: {
      refundCreate: {
        refund: {
          id,
          createdAt: "2026-05-01T00:00:00Z",
          totalRefundedSet: { presentmentMoney: { amount, currencyCode: currency } },
        },
        userErrors: [],
      },
    },
  };
}

function refundUserError(message: string) {
  return {
    data: {
      refundCreate: {
        refund: null,
        userErrors: [{ field: "input", message }],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ─── createAdminClient + withRestCredentials ───────────────────────── */

describe("createAdminClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("appends .myshopify.com when shop has no dot", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const c = createAdminClient("test-shop", "shpat_xxx");
    await c.graphql("query { shop { id } }");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("test-shop.myshopify.com");
    expect(url).toContain("/admin/api/");
  });

  it("uses domain as-is when shop already has a dot", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      void url;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const c = createAdminClient("custom.shopify.com", "shpat_xxx");
    await c.graphql("query { shop { id } }", { variables: { foo: "bar" } });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("custom.shopify.com");
  });

  it("includes empty variables when none given", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({});
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const c = createAdminClient("shop1", "tok");
    await c.graphql("query { x }");
  });
});

describe("withRestCredentials", () => {
  it("preserves graphql function and adds _rest", () => {
    const orig = makeAdmin([]).admin;
    const wrapped = withRestCredentials(orig, "shop", "token");
    expect(wrapped._rest).toEqual({ shopDomain: "shop", accessToken: "token" });
    expect(typeof wrapped.graphql).toBe("function");
  });
});

/* ─── fetchOrderByGid error / PCDA paths ────────────────────────────── */

describe("fetchOrderByGid", () => {
  it("returns null for non-gid input", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrderByGid(admin, "")).toBeNull();
    expect(await fetchOrderByGid(admin, "1234")).toBeNull();
  });

  it("throws OrderAccessError when 'not approved' message appears", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Order object is not approved" }] }]);
    await expect(fetchOrderByGid(admin, "gid://shopify/Order/1")).rejects.toBeInstanceOf(
      OrderAccessError,
    );
  });

  it("returns null for other GraphQL errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "internal server error" }] }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when node has no name", async () => {
    const { admin } = makeAdmin([{ data: { orderByIdentifier: { id: "x" } } }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when graphql throws (non-OrderAccessError)", async () => {
    const { admin } = makeAdmin([new Error("network")]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("parses a happy-path order node", async () => {
    const node = {
      id: "gid://shopify/Order/1",
      name: "#1001",
      createdAt: "2026-05-01T00:00:00Z",
      lineItems: { nodes: [] },
    };
    const { admin } = makeAdmin([{ data: { orderByIdentifier: node } }]);
    const r = await fetchOrderByGid(admin, "gid://shopify/Order/1");
    expect(r?.name).toBe("#1001");
  });
});

/* ─── fetchOrderByOrderNumber raw fetch + REST paths ────────────────── */

describe("fetchOrderByOrderNumber raw + REST", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null for empty/hash-only input", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrderByOrderNumber(admin, "")).toBeNull();
    expect(await fetchOrderByOrderNumber(admin, "#")).toBeNull();
  });

  it("delegates to fetchOrderByGid for gid input", async () => {
    const node = {
      id: "gid://shopify/Order/1",
      name: "#1001",
      createdAt: "x",
      lineItems: { nodes: [] },
    };
    const { admin } = makeAdmin([{ data: { orderByIdentifier: node } }]);
    const r = await fetchOrderByOrderNumber(admin, "gid://shopify/Order/1");
    expect(r?.name).toBe("#1001");
  });

  it("uses raw-fetch GraphQL search when REST creds present and finds match", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              orders: {
                nodes: [
                  {
                    id: "gid://shopify/Order/1",
                    name: "#1001",
                    createdAt: "2026-05-01",
                    lineItems: { nodes: [] },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { admin } = makeAdmin([]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    const r = await fetchOrderByOrderNumber(wrapped, "1001");
    expect(r?.name).toBe("#1001");
  });

  it("falls through raw fetch when nodes is empty and tries REST + SDK fallbacks", async () => {
    // 1st raw-fetch call: empty nodes
    // 2nd raw-fetch call: empty nodes
    // 3rd REST call: empty
    // 4th REST call (clean): empty
    // Then SDK searchOrders calls (graphql) — return empty too.
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      // REST path
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // SDK Strategy 2 #1
      { data: { orders: { nodes: [] } } }, // SDK Strategy 2 #2
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    const r = await fetchOrderByOrderNumber(wrapped, "ABC123");
    expect(r).toBeNull();
  });

  it("falls back to REST lookup when raw fetch returns no match", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      calls++;
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      // REST path: return matching order
      return new Response(JSON.stringify({ orders: [{ id: 12345, name: "#ABC123" }] }), {
        status: 200,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // After REST returns gid, fetchOrderByGid is called via admin.graphql
    const { admin } = makeAdmin([
      {
        data: {
          orderByIdentifier: {
            id: "gid://shopify/Order/12345",
            name: "#ABC123",
            createdAt: "2026-05-01",
            lineItems: { nodes: [] },
          },
        },
      },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    const r = await fetchOrderByOrderNumber(wrapped, "ABC123");
    expect(r?.name).toBe("#ABC123");
    expect(calls).toBeGreaterThan(0);
  });

  it("handles raw-fetch non-OK status gracefully", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response("error", { status: 500 });
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "ABC")).toBeNull();
  });

  it("handles raw-fetch broken JSON gracefully", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      n++;
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return brokenJsonResponse(200);
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "ABC")).toBeNull();
    expect(n).toBeGreaterThan(0);
  });

  it("handles raw-fetch GraphQL errors", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "ABC")).toBeNull();
  });

  it("returns null when raw-fetch network throws on both queries", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        throw new Error("network down");
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "ABC")).toBeNull();
  });

  it("falls back to metafield search for non-numeric clean", async () => {
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // SDK strategy 2 #1 (name:#)
      { data: { orders: { nodes: [] } } }, // SDK strategy 2 #2 (name:)
      // metafield search returns hit
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/9",
                name: "FYNDX9",
                createdAt: "x",
                lineItems: { nodes: [] },
              },
            ],
          },
        },
      },
    ]);
    // No REST creds — skip raw fetch entirely
    const r = await fetchOrderByOrderNumber(admin, "FYNDX9");
    expect(r?.name).toBe("FYNDX9");
  });

  it("returns null for pure numeric when no matches", async () => {
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const r = await fetchOrderByOrderNumber(admin, "12345");
    expect(r).toBeNull();
  });

  it("propagates OrderAccessError from SDK strategy 2", async () => {
    const { admin } = makeAdmin([
      { errors: [{ message: "Order object is not approved for use" }] },
    ]);
    await expect(fetchOrderByOrderNumber(admin, "1001")).rejects.toBeInstanceOf(OrderAccessError);
  });
});

/* ─── fetchOrderByFyndAffiliateId variants ─────────────────────────── */

describe("fetchOrderByFyndAffiliateId", () => {
  it("returns null when no variants found", async () => {
    const { admin } = makeAdmin([]);
    const r = await fetchOrderByFyndAffiliateId(admin, "");
    expect(r).toBeNull();
  });

  it("returns first matched variant", async () => {
    const { admin } = makeAdmin([
      // First variant — graphql returns empty
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      // Second variant — match
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/9",
                name: "FYND123",
                createdAt: "x",
                lineItems: { nodes: [] },
              },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFYX12345");
    expect(r).not.toBeNull();
  });

  it("propagates OrderAccessError from underlying lookup", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Order object is not approved" }] }]);
    await expect(fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFY1234")).rejects.toBeInstanceOf(
      OrderAccessError,
    );
  });
});

/* ─── fetchOrdersByFilter / fetchOrdersByCustomer ───────────────────── */

describe("fetchOrdersByFilter", () => {
  it("returns [] for empty query", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrdersByFilter(admin, "  ")).toEqual([]);
  });

  it("returns [] on GraphQL errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "rate limit" }] }]);
    expect(await fetchOrdersByFilter(admin, "tag:foo")).toEqual([]);
  });

  it("parses orders out of a happy response", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              { id: "gid://shopify/Order/1", name: "#1", createdAt: "x", lineItems: { nodes: [] } },
              null,
              { foo: "no-name" },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrdersByFilter(admin, "tag:vip");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("#1");
  });

  it("returns [] on thrown error", async () => {
    const { admin } = makeAdmin([new Error("boom")]);
    expect(await fetchOrdersByFilter(admin, "x:y")).toEqual([]);
  });
});

describe("fetchOrdersByCustomer", () => {
  it("returns [] for empty email", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrdersByCustomer(admin, "  ")).toEqual([]);
  });

  it("delegates to fetchOrdersByFilter", async () => {
    const { admin, calls } = makeAdmin([{ data: { orders: { nodes: [] } } }]);
    await fetchOrdersByCustomer(admin, "Buyer@Example.COM");
    expect(calls[0].variables?.query).toBe("email:buyer@example.com");
  });
});

/* ─── fetchOrder error paths ────────────────────────────────────────── */

describe("fetchOrder error paths", () => {
  it("returns null when graphql throws", async () => {
    const { admin } = makeAdmin([new Error("conn reset")]);
    expect(await fetchOrder(admin, "1")).toBeNull();
  });

  it("returns null when JSON parsing throws", async () => {
    const graphql = vi.fn(async () => brokenJsonResponse(200));
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrder(admin, "1")).toBeNull();
  });

  it("warns but proceeds when GraphQL errors are present and node found", async () => {
    const node = {
      id: "gid://shopify/Order/1",
      name: "#1",
      createdAt: "x",
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/1",
            title: "T",
            sku: "sku",
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
            image: { url: "u" },
          },
        ],
      },
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "SUCCESS",
          createdAt: "y",
          trackingInfo: [{ number: "TR1", url: "u", company: "c" }],
        },
      ],
      shippingAddress: { countryCode: "US", provinceCode: "CA" },
    };
    const { admin } = makeAdmin([{ errors: [{ message: "partial" }], data: { nodes: [node] } }]);
    const r = await fetchOrder(admin, "1");
    expect(r?.name).toBe("#1");
    expect(r?.lineItems[0].imageUrl).toBe("u");
    expect(r?.fulfillments?.[0].trackingInfo[0].number).toBe("TR1");
    expect(r?.shippingCountry).toBe("US");
  });

  it("returns null when nodes[0] is undefined", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [] } }]);
    expect(await fetchOrder(admin, "1")).toBeNull();
  });

  it("returns null when nodes[0] has no name", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [{ foo: "bar" }] } }]);
    expect(await fetchOrder(admin, "1")).toBeNull();
  });
});

/* ─── fetchOrderLineItemsByName REST raw fetch fallback ─────────────── */

describe("fetchOrderLineItemsByName raw fetch", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses raw fetch when SDK queries return empty and REST creds present", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              orders: {
                nodes: [
                  {
                    id: "gid://shopify/Order/9",
                    name: "#1001",
                    lineItems: {
                      nodes: [
                        { id: "gid://shopify/LineItem/1", title: "T", sku: "s", quantity: 2 },
                      ],
                    },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    const r = await fetchOrderLineItemsByName(wrapped, "1001");
    expect(r?.lineItems[0].title).toBe("T");
  });

  it("returns null when raw fetch HTTP non-OK", async () => {
    const fetchMock = vi.fn(async () => new Response("err", { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderLineItemsByName(wrapped, "1001")).toBeNull();
  });

  it("returns null when raw fetch throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderLineItemsByName(wrapped, "1001")).toBeNull();
  });

  it("returns null when shop already contains a dot (covers shop branch)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop.myshopify.com", "tok");
    expect(await fetchOrderLineItemsByName(wrapped, "1001")).toBeNull();
  });
});

/* ─── fetchOrderLineItemsOnly minimal extra coverage ────────────────── */

describe("fetchOrderLineItemsOnly extra", () => {
  it("returns null when GraphQL errors but no node", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "boom" }], data: { nodes: [] } }]);
    expect(await fetchOrderLineItemsOnly(admin, "1")).toBeNull();
  });
});

/* ─── createRefund — additional branches ────────────────────────────── */

describe("createRefund extra branches", () => {
  it("amount-only refund with transactionAmount > 0 skips line items", async () => {
    const { admin, calls } = makeAdmin([
      suggestedRefund("100.00", "USD"),
      refundCreateOk("gid://shopify/Refund/X", "25.00", "USD"),
    ]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      undefined,
      undefined,
      undefined,
      { transactionAmount: 25 },
    );
    expect(r.success).toBe(true);
    const input = calls[1].variables?.input as {
      refundLineItems: unknown[];
      transactions: Array<{ amount: string }>;
    };
    expect(input.refundLineItems).toEqual([]);
    expect(input.transactions[0].amount).toBe("25.00");
  });

  it("amount-only with no normalized items still works", async () => {
    const { admin } = makeAdmin([
      suggestedRefund("100.00", "USD"),
      refundCreateOk("gid://shopify/Refund/X", "10.00", "USD"),
    ]);
    const r = await createRefund(admin, "1001", [], undefined, null, undefined, {
      transactionAmount: 10,
    });
    expect(r.success).toBe(true);
  });

  it("returns success=false when store_credit and no refundable amount + no transactions", async () => {
    // suggestedRefund returns 0 with no suggestedTransactions.
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      {
        data: {
          order: {
            suggestedRefund: {
              amountSet: { shopMoney: { amount: "0", currencyCode: "USD" } },
              suggestedTransactions: [],
            },
          },
        },
      },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "store_credit",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/zero refundable/i);
  });

  it("falls back to suggestedTransactions when method='original' and totalAmount=0", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      // method='original' suggested-refund: with suggestedTransactions
      {
        data: {
          order: {
            suggestedRefund: {
              suggestedTransactions: [
                {
                  gateway: "manual",
                  parentTransaction: { id: "gid://shopify/OrderTransaction/1" },
                  amountSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
                  kind: "SUGGESTED_REFUND",
                },
              ],
            },
          },
        },
      },
      refundCreateOk("gid://shopify/Refund/M", "50.00", "USD"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(true);
    const input = calls[2].variables?.input as {
      transactions: Array<{ amount: string; gateway: string }>;
    };
    expect(input.transactions[0].amount).toBe("50.00");
    expect(input.transactions[0].gateway).toBe("manual");
  });

  it("retries with NO_RESTOCK when first attempt fails with location error", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund("100.00", "USD"),
      refundUserError("Cannot restock to invalid location"),
      refundCreateOk("gid://shopify/Refund/R", "100.00", "USD"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(true);
    expect(r.refundMethod).toBe("original");
    // Last call should have NO_RESTOCK
    const retryInput = calls[3].variables?.input as {
      refundLineItems: Array<{ restockType: string }>;
    };
    expect(retryInput.refundLineItems[0].restockType).toBe("NO_RESTOCK");
  });

  it("retry with NO_RESTOCK fails -> returns retryResult error", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund(),
      refundUserError("location not found"),
      refundUserError("still bad"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/still bad/);
  });

  it("retry without restock surfaces invalid response error", async () => {
    let i = 0;
    const responses: Canned[] = [LOCATIONS_OK, suggestedRefund(), refundUserError("location bad")];
    const graphql = vi.fn(async () => {
      const r = responses[i++];
      if (r) {
        return new Response(JSON.stringify(r), { status: 200 });
      }
      // 4th call (retry) — broken JSON
      return brokenJsonResponse(200);
    });
    const admin = { graphql } as AdminGraphQL;
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Retry without restock failed/i);
  });

  it("non-location error returns refundMethod and result without retry", async () => {
    const { admin, graphql } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund(),
      refundUserError("Insufficient funds"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.refundMethod).toBe("original");
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("returns invalid-response error when refund mutation returns broken JSON", async () => {
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1) return new Response(JSON.stringify(LOCATIONS_OK), { status: 200 });
      if (i === 2) return new Response(JSON.stringify(suggestedRefund()), { status: 200 });
      return brokenJsonResponse(200);
    });
    const admin = { graphql } as AdminGraphQL;
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid response/i);
  });

  it("returns API-error string when refund returns HTTP 500", async () => {
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1) return new Response(JSON.stringify(LOCATIONS_OK), { status: 200 });
      if (i === 2) return new Response(JSON.stringify(suggestedRefund()), { status: 200 });
      return new Response(JSON.stringify({ data: { refundCreate: { userErrors: [] } } }), {
        status: 500,
      });
    });
    const admin = { graphql } as AdminGraphQL;
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify API error \(500\)/);
  });

  it("catches outer exception and returns error", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("graphql blew up");
    });
    const admin = { graphql } as AdminGraphQL;
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      "skip",
      undefined,
      { skipLocation: true },
    );
    // skip location skip — first call is suggested refund which throws
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/graphql blew up/);
  });

  it("returns error when 'both' has no refundMethods and empty transactions (zero amount + no suggestedTransactions)", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      {
        data: {
          order: {
            suggestedRefund: {
              amountSet: { shopMoney: { amount: "0", currencyCode: "USD" } },
              suggestedTransactions: [],
            },
          },
        },
      },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
    });
    expect(r.success).toBe(false);
  });

  it("'both' with zero originalAmount + zero scAmount triggers 'no refundable amount' guard", async () => {
    // method=both, suggested totalAmount > 0 but both split parts resolve to 0
    // (storeCreditAmount=0, originalAmount=0). origAmount=0 + scAmount=0 →
    // empty transactions array + no refundMethods → guard fires.
    const { admin } = makeAdmin([LOCATIONS_OK, suggestedRefund("100.00", "USD")]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
      storeCreditAmount: 0,
      originalAmount: 0,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No refundable amount found/i);
  });

  it("'both' with no suggestedTransactions sets transactions=[] then refundMethods only", async () => {
    // method=both, totalAmount>0, but suggestedTransactions empty
    // → covers the 1452-1454 (`else { refundInput.transactions = [] }`) branch.
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      {
        data: {
          order: {
            suggestedRefund: {
              amountSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
              suggestedTransactions: [], // empty
            },
          },
        },
      },
      refundCreateOk("gid://shopify/Refund/B", "60.00", "USD"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
      storeCreditAmount: 60,
      originalAmount: 40,
    });
    expect(r.success).toBe(true);
    const input = calls[2].variables?.input as {
      transactions: unknown[];
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
    };
    expect(input.transactions).toEqual([]);
    expect(input.refundMethods[0].storeCreditRefund.amount.amount).toBe("60.00");
  });
});

/* ─── parseOrderNode populated paths ───────────────────────────────── */

describe("parseOrderNode via fetchOrdersByFilter (populated lineItems and fulfillments)", () => {
  it("parses a fully-populated order with lineItems and fulfillments", async () => {
    const node = {
      id: "gid://shopify/Order/123",
      legacyResourceId: "123",
      name: "#9999",
      createdAt: "2026-05-01T00:00:00Z",
      processedAt: "2026-05-01T00:00:00Z",
      closedAt: null,
      cancelledAt: null,
      email: "x@y.z",
      phone: "555-1212",
      totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
      totalDiscountsSet: { shopMoney: { amount: "5.00" } },
      subtotalPriceSet: { shopMoney: { amount: "95.00" } },
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "FULFILLED",
      discountCodes: ["WELCOME"],
      paymentGatewayNames: ["shopify_payments"],
      note: "deliver friday",
      sourceName: "web",
      customAttributes: [{ key: "affiliate_order_id", value: "FYNDX99" }],
      shippingAddress: {
        countryCode: "US",
        provinceCode: "CA",
        firstName: "A",
        lastName: "B",
      },
      billingAddress: { countryCode: "US" },
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/1",
            title: "Shoe",
            variantTitle: "M / Blue",
            sku: "SH-MB",
            quantity: 2,
            originalUnitPriceSet: { shopMoney: { amount: "60.00" } },
            discountedUnitPriceSet: { shopMoney: { amount: "55.00" } },
            originalTotalSet: { shopMoney: { amount: "120.00" } },
            discountedTotalSet: { shopMoney: { amount: "110.00" } },
            image: { url: "https://cdn/foo.jpg" },
            variant: {
              product: {
                id: "gid://shopify/Product/9",
                tags: ["new", "exchange"],
                productType: "Footwear",
              },
            },
          },
        ],
      },
      fulfillments: [
        {
          id: "gid://shopify/Fulfillment/1",
          status: "SUCCESS",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
          deliveredAt: "2026-05-02T00:00:00Z",
          displayStatus: "DELIVERED",
          estimatedDeliveryAt: "2026-05-02T00:00:00Z",
          inTransitAt: "2026-05-01T12:00:00Z",
          totalQuantity: 2,
          trackingInfo: [
            { number: "TRK1", url: "https://t/1", company: "FedEx" },
            { number: null, url: null, company: null },
          ],
        },
      ],
    };
    const { admin } = makeAdmin([{ data: { orders: { nodes: [node] } } }]);
    const r = await fetchOrdersByFilter(admin, "tag:vip");
    expect(r.length).toBe(1);
    expect(r[0].name).toBe("#9999");
    expect(r[0].lineItems[0].title).toBe("Shoe");
    expect(r[0].lineItems[0].productTags).toContain("exchange");
    expect(r[0].lineItems[0].productType).toBe("Footwear");
    expect(r[0].affiliateOrderId).toBe("FYNDX99");
    expect(r[0].fulfillments?.[0].displayStatus).toBe("DELIVERED");
    expect(r[0].fulfillments?.[0].trackingInfo[0].number).toBe("TRK1");
    expect(r[0].fulfillments?.[0].trackingInfo[1].number).toBeNull();
  });
});

/* ─── createShopifyReturn — full coverage ───────────────────────────── */

describe("createShopifyReturn", () => {
  function returnableFulfillments(
    opts: {
      fulfillments?: Array<{
        lineItems?: Array<{
          fliId?: string;
          lineItemGid?: string | null;
          sku?: string | null;
          quantity?: number;
        }>;
      }>;
      returns?: Array<{
        id?: string;
        status?: string;
        lineItems?: Array<{
          fliId?: string;
          lineItemGid?: string | null;
          sku?: string | null;
          quantity?: number;
        }>;
      }>;
      errors?: Array<{ message?: string }>;
    } = {},
  ) {
    return {
      data: {
        returnableFulfillments: {
          edges: (opts.fulfillments ?? []).map((f) => ({
            node: {
              returnableFulfillmentLineItems: {
                edges: (f.lineItems ?? []).map((li) => ({
                  node: {
                    quantity: li.quantity ?? 1,
                    fulfillmentLineItem: {
                      id: li.fliId ?? "gid://shopify/FulfillmentLineItem/1",
                      lineItem:
                        li.lineItemGid !== null
                          ? {
                              id: li.lineItemGid ?? "gid://shopify/LineItem/1",
                              sku: li.sku ?? null,
                            }
                          : null,
                    },
                  },
                })),
              },
            },
          })),
        },
        // Bug #15 final fix: returns is now scoped via order(id).returns,
        // not the top-level Query.returns. Mock the same nesting.
        order: {
          returns: {
            edges: (opts.returns ?? []).map((r) => ({
              node: {
                id: r.id ?? "gid://shopify/Return/1",
                status: r.status ?? "OPEN",
                returnLineItems: {
                  edges: (r.lineItems ?? []).map((li) => ({
                    node: {
                      quantity: li.quantity ?? 1,
                      fulfillmentLineItem: {
                        id: li.fliId ?? "gid://shopify/FulfillmentLineItem/1",
                        lineItem:
                          li.lineItemGid !== null
                            ? {
                                id: li.lineItemGid ?? "gid://shopify/LineItem/1",
                                sku: li.sku ?? null,
                              }
                            : null,
                      },
                    },
                  })),
                },
              },
            })),
          },
        },
      },
      errors: opts.errors,
    };
  }

  function returnCreateOk(id = "gid://shopify/Return/100") {
    return {
      data: { returnCreate: { return: { id }, userErrors: [] } },
    };
  }

  it("returns access-scope error when 'access denied' in errors", async () => {
    const { admin } = makeAdmin([
      { errors: [{ message: "access denied: write_returns required" }] },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/write_returns/);
  });

  it("returns generic error for non-access GraphQL errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "rate limited" }] }]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Failed to query returnable fulfillments/);
  });

  it("returns error when no returnable fulfillments found at all", async () => {
    const { admin } = makeAdmin([returnableFulfillments({})]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No returnable fulfillment/);
  });

  it("creates return successfully via lineItem GID match", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: "SKU-A",
                quantity: 3,
              },
            ],
          },
        ],
      }),
      returnCreateOk(),
    ]);
    const r = await createShopifyReturn(
      admin,
      "1",
      [{ shopifyLineItemId: "gid://shopify/LineItem/9", qty: 2, reasonCode: "defective" }],
      { notifyCustomer: true, requestedAt: "2026-05-01T00:00:00Z" },
    );
    expect(r.success).toBe(true);
    expect(r.shopifyReturnId).toBe("gid://shopify/Return/100");
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{
        fulfillmentLineItemId: string;
        quantity: number;
        returnReason: string;
      }>;
      notifyCustomer: boolean;
      requestedAt?: string;
    };
    expect(input.returnLineItems[0].quantity).toBe(2);
    expect(input.returnLineItems[0].returnReason).toBe("DEFECTIVE");
    expect(input.notifyCustomer).toBe(true);
    expect(input.requestedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("falls back to SKU match when lineItem GID has no entry", async () => {
    const { admin } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/B",
                lineItemGid: "gid://shopify/LineItem/77",
                sku: "MY-SKU",
                quantity: 5,
              },
            ],
          },
        ],
      }),
      returnCreateOk(),
    ]);
    const r = await createShopifyReturn(admin, "1", [
      // mismatched line-item GID, but SKU matches
      {
        shopifyLineItemId: "gid://shopify/LineItem/0",
        qty: 1,
        sku: "MY-SKU",
        reasonCode: "wrong product ordered",
      },
    ]);
    expect(r.success).toBe(true);
  });

  it("subtracts in-flight return quantities (consumes maxQty)", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/X",
                lineItemGid: "gid://shopify/LineItem/9",
                // no sku — so only the GID map gets the entry; in-flight decrement
                // hits the entry exactly once (otherwise the same entry instance
                // sits in both gid + sku maps and gets decremented twice).
                sku: null,
                quantity: 3,
              },
            ],
          },
        ],
        returns: [
          {
            status: "OPEN",
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/X",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 2,
              },
            ],
          },
        ],
      }),
      returnCreateOk(),
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 5, reasonCode: "too small" },
    ]);
    expect(r.success).toBe(true);
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{ quantity: number; returnReason: string }>;
    };
    // 3 - 2 = 1 remaining
    expect(input.returnLineItems[0].quantity).toBe(1);
    expect(input.returnLineItems[0].returnReason).toBe("SIZE_TOO_SMALL");
  });

  it("ignores in-flight returns with terminal status", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/X",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: "S1",
                quantity: 3,
              },
            ],
          },
        ],
        returns: [
          {
            status: "CLOSED",
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/X",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: "S1",
                quantity: 2,
              },
            ],
          },
        ],
      }),
      returnCreateOk(),
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 2, reasonCode: "too large" },
    ]);
    expect(r.success).toBe(true);
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{ quantity: number; returnReason: string }>;
    };
    expect(input.returnLineItems[0].quantity).toBe(2);
    expect(input.returnLineItems[0].returnReason).toBe("SIZE_TOO_LARGE");
  });

  it("returns error when no items can be matched to any fulfillment", async () => {
    const { admin } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/X",
                lineItemGid: "gid://shopify/LineItem/1",
                sku: "S1",
                quantity: 1,
              },
            ],
          },
        ],
      }),
    ]);
    const r = await createShopifyReturn(admin, "1", [
      // mismatched gid + no sku
      { shopifyLineItemId: "gid://shopify/LineItem/999", qty: 1, sku: null },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not match any return items/);
  });

  it("propagates userErrors from returnCreate mutation", async () => {
    const { admin } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
      }),
      {
        data: {
          returnCreate: {
            return: null,
            userErrors: [{ field: ["x"], message: "invalid input" }],
          },
        },
      },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid input/);
  });

  it("propagates GraphQL errors from returnCreate mutation", async () => {
    const { admin } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
      }),
      { errors: [{ message: "boom" }] },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify API error: boom/);
  });

  it("returns error when returnCreate returns no id", async () => {
    const { admin } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
      }),
      { data: { returnCreate: { return: null, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no ID was returned/);
  });

  it("catches thrown error and returns failure", async () => {
    const { admin } = makeAdmin([new Error("net")]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify Return creation error/);
  });

  it("uses notes (truncated) and OTHER fallback for unmatched reason", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
      }),
      {
        data: {
          returnCreate: { return: { id: "gid://shopify/Return/200" }, userErrors: [] },
        },
      },
    ]);
    const longNote = "x".repeat(500);
    const r = await createShopifyReturn(admin, "1", [
      {
        shopifyLineItemId: "gid://shopify/LineItem/9",
        qty: 1,
        reasonCode: "weird-reason",
        notes: longNote,
      },
    ]);
    expect(r.success).toBe(true);
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{ returnReason: string; returnReasonNote?: string }>;
    };
    expect(input.returnLineItems[0].returnReason).toBe("OTHER");
    expect(input.returnLineItems[0].returnReasonNote?.length).toBe(255);
  });

  it("uses reasonCode as fallback note when reason is OTHER and no notes", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/A",
                lineItemGid: "gid://shopify/LineItem/9",
                sku: null,
                quantity: 1,
              },
            ],
          },
        ],
      }),
      {
        data: { returnCreate: { return: { id: "gid://shopify/Return/300" }, userErrors: [] } },
      },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1, reasonCode: "weird-thing" },
    ]);
    expect(r.success).toBe(true);
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{ returnReason: string; returnReasonNote?: string }>;
    };
    expect(input.returnLineItems[0].returnReason).toBe("OTHER");
    expect(input.returnLineItems[0].returnReasonNote).toBe("weird-thing");
  });

  it("maps known reason codes (color, style, unwanted)", async () => {
    const { admin, calls } = makeAdmin([
      returnableFulfillments({
        fulfillments: [
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/1",
                lineItemGid: "gid://shopify/LineItem/1",
                sku: "X",
                quantity: 5,
              },
            ],
          },
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/2",
                lineItemGid: "gid://shopify/LineItem/2",
                sku: "Y",
                quantity: 5,
              },
            ],
          },
          {
            lineItems: [
              {
                fliId: "gid://shopify/FulfillmentLineItem/3",
                lineItemGid: "gid://shopify/LineItem/3",
                sku: "Z",
                quantity: 5,
              },
            ],
          },
        ],
      }),
      { data: { returnCreate: { return: { id: "gid://shopify/Return/4" }, userErrors: [] } } },
    ]);
    await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1, reasonCode: "color mismatch" },
      { shopifyLineItemId: "gid://shopify/LineItem/2", qty: 1, reasonCode: "the style is bad" },
      { shopifyLineItemId: "gid://shopify/LineItem/3", qty: 1, reasonCode: "unwanted gift" },
    ]);
    const input = calls[1].variables?.returnInput as {
      returnLineItems: Array<{ returnReason: string }>;
    };
    expect(input.returnLineItems[0].returnReason).toBe("COLOR");
    expect(input.returnLineItems[1].returnReason).toBe("STYLE");
    expect(input.returnLineItems[2].returnReason).toBe("UNWANTED");
  });
});

/* ─── closeShopifyReturn / declineShopifyReturn error paths ─────────── */

describe("closeShopifyReturn errors", () => {
  it("returns error string for non-idempotent GraphQL error", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "rate limited" }] }]);
    const r = await closeShopifyReturn(admin, "999");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify API error/);
  });

  it("catches thrown error", async () => {
    const { admin } = makeAdmin([new Error("oh no")]);
    const r = await closeShopifyReturn(admin, "999");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/oh no/);
  });
});

describe("declineShopifyReturn errors", () => {
  it("treats already-declined GraphQL error as success", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Return is already DECLINED" }] }]);
    const r = await declineShopifyReturn(admin, "1");
    expect(r.success).toBe(true);
    expect(r.alreadyClosed).toBe(true);
  });

  it("returns error for non-idempotent GraphQL error", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "boom" }] }]);
    const r = await declineShopifyReturn(admin, "1");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify API error/);
  });

  it("catches thrown error", async () => {
    const { admin } = makeAdmin([new Error("net err")]);
    const r = await declineShopifyReturn(admin, "1");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/net err/);
  });

  it("uses default reason when none provided", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/1", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await declineShopifyReturn(admin, "gid://shopify/Return/1");
    expect(r.success).toBe(true);
    const input = calls[0].variables?.input as { declineReason: string };
    expect(input.declineReason).toBe("Return declined");
  });
});

/* ─── closeShopifyReturnBestEffort outer catch ──────────────────────── */

describe("closeShopifyReturnBestEffort outer catch", () => {
  it("catches synchronous errors from logEvent", async () => {
    // Force the wrapper to throw outside the inner try by making logEvent throw
    // synchronously and not be caught.
    const admin = { graphql: vi.fn() } as unknown as AdminGraphQL;
    // Using "no shopifyReturnId" path with a logEvent that throws synchronously.
    const logEvent = vi.fn(() => {
      throw new Error("sync throw");
    });
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc", shopifyReturnId: null, shopifyOrderId: null },
      { logEvent },
    );
    // Outer try-catch should set ok=false
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sync throw/);
  });
});

/* ─── searchOrders / fetchOrderByOrderNumber inner branches ─────────── */

describe("searchOrders inner-branch coverage (via fetchOrderByOrderNumber)", () => {
  it("Strategy 2: graphql throws — non-OrderAccessError swallowed, returns null", async () => {
    // No REST creds. SDK strategy 2 throws on first call (non-OrderAccess), we
    // should swallow it via the try/catch (line 640) and continue.
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1) throw new Error("net err"); // strategy 2 #1 throws
      // strategy 2 #2 returns empty
      return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
    });
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrderByOrderNumber(admin, "ABC")).toBeNull();
  });

  it("Strategy 2: malformed JSON response triggers searchOrders json-parse catch", async () => {
    // First call returns non-JSON, second returns empty.
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1) return brokenJsonResponse(200);
      return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
    });
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrderByOrderNumber(admin, "ABC")).toBeNull();
  });

  it("Strategy 2: GraphQL error with throwOnError=false returns null and continues", async () => {
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1) {
        // generic (non-PCDA) error → searchOrders returns null
        return new Response(JSON.stringify({ errors: [{ message: "some other error" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
    });
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrderByOrderNumber(admin, "ABC")).toBeNull();
  });

  it("Strategy 2: returns null when no exact match among candidates", async () => {
    const node = (name: string) => ({
      id: `gid://shopify/Order/${name}`,
      name,
      createdAt: "2026-05-01",
      lineItems: { nodes: [] },
    });
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [node("#OTHER1"), node("#OTHER2")] } } }, // no exact match
      { data: { orders: { nodes: [] } } }, // 2nd call empty
    ]);
    expect(await fetchOrderByOrderNumber(admin, "ABC")).toBeNull();
  });

  it("metafield search (strategy 3) throws non-PCDA error — swallowed", async () => {
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      // strategy 2 returns empty for both
      if (i === 1 || i === 2) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      // strategy 3 throws
      throw new Error("metafield boom");
    });
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrderByOrderNumber(admin, "ABCXY")).toBeNull();
  });

  it("metafield search (strategy 3) propagates OrderAccessError", async () => {
    let i = 0;
    const graphql = vi.fn(async () => {
      i++;
      if (i === 1 || i === 2) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      // strategy 3 returns PCDA error
      return new Response(
        JSON.stringify({ errors: [{ message: "Order object is not approved" }] }),
        { status: 200 },
      );
    });
    const admin = { graphql } as AdminGraphQL;
    await expect(fetchOrderByOrderNumber(admin, "ABCXY")).rejects.toBeInstanceOf(OrderAccessError);
  });
});

/* ─── REST order lookup branches ────────────────────────────────────── */

describe("restOrderLookupByName branches (via fetchOrderByOrderNumber)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("REST returns non-OK for first nameQuery, then OK with no match", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      if (u.includes("name=%23")) {
        // first nameQuery (#ABC) — non-OK
        return new Response("err", { status: 500 });
      }
      // second nameQuery (without #) — OK but empty
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    const r = await fetchOrderByOrderNumber(wrapped, "ABC");
    expect(r).toBeNull();
  });

  it("REST throws for one nameQuery — caught, second nameQuery still tried", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 });
      }
      n++;
      if (n === 1) throw new Error("rest network");
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "ABC")).toBeNull();
  });

  it("REST returns empty for empty cleaned name (delegated to fetchOrderByOrderNumber early null)", async () => {
    // Just covers the very early return branch in restOrderLookupByName's
    // cleaned-name guard via fetchOrderByOrderNumber's input cleanup.
    const { admin } = makeAdmin([]);
    expect(await fetchOrderByOrderNumber(admin, "  #  ")).toBeNull();
  });
});

/* ─── rawGraphQLSearch with no exact match ──────────────────────────── */

describe("rawGraphQLSearch returns null when exactName has no match", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when nodes have no name matching exactName", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/graphql.json")) {
        return new Response(
          JSON.stringify({
            data: {
              orders: {
                nodes: [
                  {
                    id: "gid://shopify/Order/1",
                    name: "#WRONG",
                    createdAt: "x",
                    lineItems: { nodes: [] },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ orders: [] }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const wrapped = withRestCredentials(admin, "shop", "tok");
    expect(await fetchOrderByOrderNumber(wrapped, "RIGHT")).toBeNull();
  });
});

/* ─── fetchOrderLineItemsByName SDK throw branch ────────────────────── */

describe("fetchOrderLineItemsByName SDK throw", () => {
  it("returns null when SDK graphql throws on both name queries", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("sdk boom");
    });
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrderLineItemsByName(admin, "1001")).toBeNull();
  });
});

/* ─── createShopifyReturn — extra inner branches ────────────────────── */

describe("createShopifyReturn extra inner branches", () => {
  it("skips edges with missing fulfillmentLineItem.id", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      // missing id
                      {
                        node: {
                          quantity: 1,
                          fulfillmentLineItem: { lineItem: { id: "gid://shopify/LineItem/1" } },
                        },
                      },
                      // qty 0
                      {
                        node: {
                          quantity: 0,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/2" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          returns: {
            edges: [
              // null node
              { node: null },
              // node with non-terminal status but no fli id
              {
                node: {
                  id: "gid://shopify/Return/1",
                  status: "OPEN",
                  returnLineItems: {
                    edges: [
                      { node: { quantity: 1, fulfillmentLineItem: null } },
                      // qty 0 should be ignored
                      {
                        node: {
                          quantity: 0,
                          fulfillmentLineItem: { id: "gid://shopify/FulfillmentLineItem/X" },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No returnable fulfillment/);
  });

  it("skips returnItems whose qty resolves to 0 after flooring", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 5,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/9", sku: "S1" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          returns: { edges: [] },
        },
      },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 0 },
    ]);
    // qty=0 → no returnLineItems added → empty result error
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not match any return items/);
  });

  it("uses pickBest fallback when entries map is initially missing for an item", async () => {
    // Provide a fulfillment that has NO lineItem.id but has SKU, so the gid map
    // won't have an entry for the request's gid; the fallback path runs.
    // Then for the item, supply the matching SKU so pickBest finds something.
    const { admin } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 2,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/10", sku: "DUPE-SKU" },
                          },
                        },
                      },
                      {
                        node: {
                          quantity: 4,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/B",
                            lineItem: { id: "gid://shopify/LineItem/10", sku: "DUPE-SKU" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          returns: { edges: [] },
        },
      },
      { data: { returnCreate: { return: { id: "gid://shopify/Return/55" }, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      // Both gid + SKU resolve. pickBest path — the qty=4 entry has more remaining.
      { shopifyLineItemId: "gid://shopify/LineItem/10", qty: 1, sku: "DUPE-SKU" },
    ]);
    expect(r.success).toBe(true);
  });
});

/* ─── fetchAllLocations / fetchPrimaryLocationId ───────────────────── */

describe("fetchPrimaryLocationId", () => {
  it("returns first location id", async () => {
    const { admin } = makeAdmin([LOCATIONS_OK]);
    expect(await fetchPrimaryLocationId(admin)).toBe("gid://shopify/Location/1");
  });

  it("returns null when none found", async () => {
    const { admin } = makeAdmin([{ data: { locations: { nodes: [] } } }]);
    expect(await fetchPrimaryLocationId(admin)).toBeNull();
  });
});

describe("fetchAllLocations isActive defaulting", () => {
  it("defaults isActive to true when omitted", async () => {
    const { admin } = makeAdmin([
      { data: { locations: { nodes: [{ id: "gid://shopify/Location/2", name: "Backup" }] } } },
    ]);
    const r = await fetchAllLocations(admin);
    expect(r[0].isActive).toBe(true);
  });

  it("respects explicit isActive=false", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: { nodes: [{ id: "gid://shopify/Location/3", name: "Off", isActive: false }] },
        },
      },
    ]);
    const r = await fetchAllLocations(admin);
    expect(r[0].isActive).toBe(false);
  });
});
