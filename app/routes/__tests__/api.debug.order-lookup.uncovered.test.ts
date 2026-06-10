/**
 * Uncovered-branch tests for app/routes/api.debug.order-lookup.ts.
 *
 * Targets:
 *  - Line 144: GraphQL search catch where the thrown value is NOT an Error
 *    (exercises the `String(err)` branch of the ternary).
 *  - Line 170: Raw GraphQL search catch where the thrown value is NOT an Error
 *    (exercises the `String(err)` branch of the ternary).
 *  - Lines 193, 195, 200, 201: pagination scan node mapping where node.name
 *    is undefined (exercises the `?? ""` branch and the `?.` optional chain
 *    for `match?.id` / `match?.name`).
 *  - Line 202: pagination scan with NO errors array (json.errors?.[0]?.message
 *    fallback — undefined error).
 *  - Lines 205-236: metafield search catch where the thrown value is NOT an
 *    Error AND a non-array `nodes` shape that yields `.length === 0`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrderByGid: vi.fn(),
  withRestCredentials: vi.fn((a: unknown) => a),
}));

import { loader } from "../api.debug.order-lookup";

const origFetch = globalThis.fetch;

function mkReq(qs: string = "") {
  return new Request(`https://app.example/api/debug/order-lookup${qs ? "?" + qs : ""}`);
}

const EMPTY_GQL = { data: { orders: { nodes: [] } } };

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("api.debug.order-lookup — uncovered branches", () => {
  it("GraphQL search: non-Error throw is stringified via String(err) (line 144)", async () => {
    // First variant rejects with a non-Error value (a plain string), the rest
    // resolve normally. Pagination and metafield each consume one call.
    const graphqlMock = vi.fn();

    graphqlMock.mockRejectedValueOnce("plain-string-rejection");
    for (let i = 0; i < 6; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // pagination
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    // metafield
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const gql = body.results.filter((r: { strategy: string }) => r.strategy === "GraphQL search");
    expect(gql[0]).toMatchObject({
      success: false,
      error: "plain-string-rejection",
    });
    // Other variants succeeded reaching the resolved branch
    expect(gql[1].success).toBe(false);
    expect(gql[1].error).toBeUndefined();
  });

  it("GraphQL search: non-Error throw with object (uses String(err) → '[object Object]')", async () => {
    const graphqlMock = vi.fn();
    graphqlMock.mockRejectedValueOnce({ weird: "shape" });
    for (let i = 0; i < 6; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const gql = body.results.filter((r: { strategy: string }) => r.strategy === "GraphQL search");
    expect(gql[0].success).toBe(false);
    expect(gql[0].error).toBe("[object Object]");
  });

  it("Raw GraphQL search: non-Error throw is stringified via String(err) (line 170)", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        // Throw a non-Error rejection — exercises String(err) branch.

        throw "rest-string-fail";
      }
      return { ok: true, json: async () => ({ orders: [] }) };
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest[0]).toMatchObject({
      success: false,
      error: "rest-string-fail",
    });
    expect(rest[1].success).toBe(false); // empty orders
  });

  it("Pagination scan: nodes with undefined name fall through `name ?? ''` and no match (lines 193, 195)", async () => {
    const graphqlMock = vi.fn();
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // pagination scan: nodes whose `name` is undefined or absent
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({
        data: {
          orders: {
            nodes: [
              { id: "gid://shopify/Order/X" }, // no name
              { id: "gid://shopify/Order/Y", name: undefined },
              { id: "gid://shopify/Order/Z", name: "#NOTME" },
            ],
          },
        },
      }),
    });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=TARGET"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan.success).toBe(false);
    // Match was undefined — so orderId/orderName should be undefined (lines 200,201)
    expect(scan.orderId).toBeUndefined();
    expect(scan.orderName).toBeUndefined();
    // recentOrderNames slice should include both undefined and string entries
    expect(Array.isArray(body.diagnostics.recentOrderNames)).toBe(true);
    expect(body.diagnostics.recentOrderNames).toHaveLength(3);
  });

  it("Pagination scan: response with no `errors` key → result.error stays undefined (line 202)", async () => {
    const graphqlMock = vi.fn();
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // no `errors` key, no nodes
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({ data: { orders: { nodes: [] } } }),
    });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan.success).toBe(false);
    expect(scan.error).toBeUndefined();
  });

  it("Pagination scan: data.orders is missing → nodes default to []", async () => {
    const graphqlMock = vi.fn();
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // data exists but orders is missing entirely
    graphqlMock.mockResolvedValueOnce({ json: async () => ({ data: {} }) });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan.success).toBe(false);
    expect(body.diagnostics.recentOrderNames).toEqual([]);
  });

  it("Metafield search: non-Error throw stringified via String(err)", async () => {
    const graphqlMock = vi.fn();
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // pagination ok
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    // metafield rejected with non-Error
    graphqlMock.mockRejectedValueOnce(42);

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=ABC"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const mf = body.results.find((r: { strategy: string }) => r.strategy === "Metafield search");
    expect(mf).toMatchObject({ success: false, error: "42" });
  });

  it("GraphQL search: nodes with undefined id/name fall through to '' defaults", async () => {
    // Variant 1 returns nodes whose id and name are both missing — exercises
    // the `n.id ?? ""` and `n.name ?? ""` defaults inside testGraphQLSearch.
    const graphqlMock = vi.fn();
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({
        data: { orders: { nodes: [{}, { id: "gid://shopify/Order/Z" }] } },
      }),
    });
    for (let i = 0; i < 6; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=ABC"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const gql = body.results.filter((r: { strategy: string }) => r.strategy === "GraphQL search");
    // First variant: nodes.length > 0 → success true; orderId/orderName from
    // the first node which had no id/name → defaults to "".
    expect(gql[0].success).toBe(true);
    expect(gql[0].orderId).toBe("");
    expect(gql[0].orderName).toBe("");
  });

  it("Raw GraphQL search: orders array contains entries with missing id/name → defaults applied", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      // First call: order with no id, no name → defaults to 0 / ""
      json: async () => ({ orders: [{}] }),
    })) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    // success because orders.length > 0 — but orderId is undefined because
    // res.orders[0]?.id is 0 which is falsy → orderId branch chooses undefined.
    expect(rest[0].success).toBe(true);
    expect(rest[0].orderId).toBeUndefined();
    expect(rest[0].orderName).toBe("");
  });

  it("Raw GraphQL search: data.orders is missing → orders default to []", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}), // no orders key at all
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest[0].success).toBe(false);
    expect(rest[1].success).toBe(false);
  });

  it("GraphQL search: response with missing data.orders.nodes triggers `?? []` fallback (line 55)", async () => {
    const graphqlMock = vi.fn();
    // Variant 1: json.data.orders has no `nodes` key at all
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({ data: { orders: {} } }),
    });
    // Variant 2: json.data has no `orders` key
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({ data: {} }),
    });
    // Variant 3: json has no `data` key
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({}),
    });
    for (let i = 0; i < 4; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const gql = body.results.filter((r: { strategy: string }) => r.strategy === "GraphQL search");
    expect(gql[0].success).toBe(false);
    expect(gql[1].success).toBe(false);
    expect(gql[2].success).toBe(false);
  });

  it("Pagination scan: non-Error throw stringified via String(err) (line 210)", async () => {
    const graphqlMock = vi.fn();
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });
    }
    // pagination scan: rejects with non-Error
    graphqlMock.mockRejectedValueOnce("paginate-string");
    // metafield
    graphqlMock.mockResolvedValueOnce({ json: async () => EMPTY_GQL });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan).toMatchObject({
      success: false,
      error: "paginate-string",
      query: "orders(first: 50)",
    });
  });

  it("shopifyFetch: timeout triggers AbortController.abort callback (line 20)", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });

    // Force fetch to honour AbortSignal: reject as soon as the signal fires.
    // The abort listener is registered synchronously inside the fetch impl
    // so the abort callback (line 20) firing causes immediate rejection.
    globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) return;
        if (sig.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        sig.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    // Stub setTimeout so the 15s "abort" timer fires immediately (synchronous
    // call). We restore the original after the loader completes.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
      // Fire on next microtask so the fetch() Promise has been created and
      // its abort listener is wired up before we abort.
      Promise.resolve().then(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = (() =>
      undefined) as typeof clearTimeout;

    try {
      const res = await loader({
        request: mkReq("name=1001"),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
      expect(rest).toHaveLength(2);
      rest.forEach((r: { success: boolean; error?: string }) => {
        expect(r.success).toBe(false);
        expect(typeof r.error).toBe("string");
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it("Raw GraphQL search: text() rejection during non-200 still yields HTTP <status>: '' error", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error("body-read-failed");
      },
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=1001"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    // body.text() throws → catch returns ""; error is "HTTP 503: "
    expect(rest[0].error).toBe("HTTP 503: ");
  });
});
