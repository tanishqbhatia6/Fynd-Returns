/**
 * Extra coverage tests for app/routes/api.debug.order-lookup.ts
 *
 * Focus areas:
 *  - Strategy 1 (GraphQL search) success / partial-success across the 7 query variants
 *  - Strategy 2 (Raw GraphQL search) success / failure / non-200 / throw individually
 *  - Strategy 3 (Pagination scan) hit / miss / GraphQL errors / throw
 *  - Strategy 4 (Metafield search) success / failure / throw
 *  - durationMs is a finite non-negative number on every result
 *  - Default order name fallback when no `name` query param is provided
 *  - Diagnostics fields (apiVersion, accessTokenLength, recentOrderNames, returnCase=null)
 *  - Shop domain without dot is left as-is in session.shop diagnostic
 *  - Leading "#" + whitespace in name is stripped to cleanedName
 *  - Raw GraphQL URL builds correctly when shop domain has no dot (appends .myshopify.com)
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

/**
 * Build a graphql mock that returns a different result for each call in
 * the order strategies are invoked:
 *   calls 0..6  → 7 GraphQL search variants (Strategy 1)
 *   call  7     → Pagination scan (Strategy 3)
 *   call  8     → Metafield search (Strategy 4)
 */
function makeGraphql(seq: Array<unknown>) {
  const m = vi.fn();
  for (const r of seq) {
    if (r instanceof Error) m.mockRejectedValueOnce(r);
    else m.mockResolvedValueOnce({ json: async () => r });
  }
  return m;
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

describe("api.debug.order-lookup — extra coverage", () => {
  it("uses default order name FYNDSHOPIFYX14126 when name param missing", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.diagnostics.orderNameInput).toBe("FYNDSHOPIFYX14126");
    expect(body.diagnostics.cleanedName).toBe("FYNDSHOPIFYX14126");
  });

  it("strips leading '#' and trims whitespace into cleanedName", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=" + encodeURIComponent("#  1234  ")),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.diagnostics.orderNameInput).toBe("#  1234  ");
    // route does .replace(/^#/, "").trim() — leading '#' stripped first, then trimmed
    expect(body.diagnostics.cleanedName).toBe("1234");
  });

  it("reports the first GraphQL variant as success and surfaces orderId/orderName", async () => {
    // Variant 1 (name:"#X") returns a hit; remaining return empty
    const graphqlMock = makeGraphql([
      { data: { orders: { nodes: [{ id: "gid://shopify/Order/100", name: "#1001" }] } } },
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      { data: { orders: { nodes: [] } } }, // pagination scan
      EMPTY_GQL, // metafield
    ]);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const gql = body.results.filter((r: { strategy: string }) => r.strategy === "GraphQL search");
    expect(gql).toHaveLength(7);
    expect(gql[0]).toMatchObject({
      success: true,
      orderId: "gid://shopify/Order/100",
      orderName: "#1001",
      query: 'name:"#1001"',
    });
    // Other variants empty → success: false, no error (data present)
    expect(gql[1].success).toBe(false);
    expect(gql[1].error).toBeUndefined();
    expect(body.summary.firstSuccessful).toMatchObject({
      strategy: "GraphQL search",
      success: true,
    });
  });

  it("Raw GraphQL search: first variant succeeds (#cleaned) → orderId is gid form", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ orders: [{ id: 555, name: "#1001" }] }) };
      }
      return { ok: true, json: async () => ({ orders: [] }) };
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest).toHaveLength(2);
    expect(rest[0]).toMatchObject({
      success: true,
      orderId: "gid://shopify/Order/555",
      orderName: "#1001",
      query: "name:#1001",
    });
    expect(rest[1].success).toBe(false);
  });

  it("Raw GraphQL search: throw is captured per-variant (does not abort other strategies)", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest).toHaveLength(2);
    rest.forEach((r: { success: boolean; error?: string }) => {
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ECONNRESET/);
    });
    // Other strategies still ran
    expect(
      body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan"),
    ).toBeDefined();
    expect(
      body.results.find((r: { strategy: string }) => r.strategy === "Metafield search"),
    ).toBeDefined();
  });

  it("Raw GraphQL search: non-string body for non-200 is gracefully truncated to <=200 chars", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    const longBody = "x".repeat(500);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longBody,
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest[0].error).toMatch(/^HTTP 500: x{200}$/);
  });

  it("Raw GraphQL search: shop without dot gets .myshopify.com appended in URL", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "barestore", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const urls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.length).toBe(2);
    urls.forEach((u: string) =>
      expect(u).toMatch(/^https:\/\/barestore\.myshopify\.com\/admin\/api\/2026-01\/graphql\.json/),
    );
  });

  it("Pagination scan: no match → success false, populates recentOrderNames diagnostic", async () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({
      id: `gid://shopify/Order/${i}`,
      name: `#100${i}`,
    }));
    const graphqlMock = makeGraphql([
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      { data: { orders: { nodes } } }, // pagination scan
      EMPTY_GQL, // metafield
    ]);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=NOTPRESENT"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan.success).toBe(false);
    expect(scan.orderId).toBeUndefined();
    expect(body.diagnostics.recentOrderNames).toHaveLength(10);
    expect(body.diagnostics.recentOrderNames[0]).toBe("#1000");
  });

  it("Pagination scan: case-insensitive match strips '#' from order names", async () => {
    const graphqlMock = makeGraphql([
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      {
        data: {
          orders: {
            nodes: [
              { id: "gid://shopify/Order/A", name: "#Other" },
              { id: "gid://shopify/Order/B", name: "#abc-99" },
            ],
          },
        },
      },
      EMPTY_GQL,
    ]);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("name=ABC-99"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan.success).toBe(true);
    expect(scan.orderId).toBe("gid://shopify/Order/B");
    expect(scan.orderName).toBe("#abc-99");
  });

  it("Pagination scan: GraphQL errors propagate as result.error and success=false", async () => {
    const graphqlMock = makeGraphql([
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      { data: { orders: { nodes: [] } }, errors: [{ message: "scope missing" }] },
      EMPTY_GQL,
    ]);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan).toMatchObject({ success: false, error: "scope missing" });
  });

  it("Pagination scan: throw in admin.graphql is captured", async () => {
    const seq = [
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      new Error("paginate boom"),
      EMPTY_GQL,
    ];
    const graphqlMock = makeGraphql(seq);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const scan = body.results.find((r: { strategy: string }) => r.strategy === "Pagination scan");
    expect(scan).toMatchObject({
      success: false,
      error: "paginate boom",
      query: "orders(first: 50)",
    });
  });

  it("Metafield search: success populates orderId/orderName", async () => {
    const graphqlMock = makeGraphql([
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      { data: { orders: { nodes: [{ id: "gid://shopify/Order/MF1", name: "#MF-OK" }] } } },
    ]);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=ABC"), params: {}, context: {} } as never);
    const body = await res.json();
    const mf = body.results.find((r: { strategy: string }) => r.strategy === "Metafield search");
    expect(mf).toMatchObject({
      success: true,
      orderId: "gid://shopify/Order/MF1",
      orderName: "#MF-OK",
      query: 'metafields.$app.fynd_order_id:"ABC"',
    });
  });

  it("Metafield search: throw recorded with rejection message", async () => {
    const seq = [
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      EMPTY_GQL,
      new Error("mf boom"),
    ];
    const graphqlMock = makeGraphql(seq);
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const mf = body.results.find((r: { strategy: string }) => r.strategy === "Metafield search");
    expect(mf).toMatchObject({ success: false, error: "mf boom" });
  });

  it("durationMs is a finite, non-negative number on every result", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThanOrEqual(11); // 7 + 2 + 1 + 1
    for (const r of body.results as Array<{ durationMs: number }>) {
      expect(typeof r.durationMs).toBe("number");
      expect(Number.isFinite(r.durationMs)).toBe(true);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("diagnostics: apiVersion, accessTokenLength, and returnCase=null when not found", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "abcdef" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;
    prismaMock.returnCase.findUnique.mockResolvedValueOnce(null);

    const res = await loader({
      request: mkReq("name=1001&returnCaseId=missing-rc"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.diagnostics.apiVersion).toBe("2026-01");
    expect(body.diagnostics.accessTokenLength).toBe(6);
    expect(body.diagnostics.hasAccessToken).toBe(true);
    expect(body.diagnostics.returnCase).toBeNull();
  });

  it("hasAccessToken=false and accessTokenLength=0 when session has no accessToken", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com" }, // no accessToken
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.diagnostics.hasAccessToken).toBe(false);
    expect(body.diagnostics.accessTokenLength).toBe(0);
    // Raw GraphQL should still have run (with empty token), 2 results recorded
    const rest = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(rest).toHaveLength(2);
  });

  it("summary aggregates totals/successful/failed/firstSuccessful=null when nothing matches", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({ json: async () => EMPTY_GQL });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.summary.totalStrategies).toBe(body.results.length);
    expect(body.summary.successful).toBe(0);
    expect(body.summary.failed).toBe(body.results.length);
    expect(body.summary.firstSuccessful).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});
