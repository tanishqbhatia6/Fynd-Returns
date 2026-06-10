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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("GET /api/debug/order-lookup", () => {
  it("runs every strategy and summarises results", async () => {
    // admin.graphql returns different results for each call
    const graphqlMock = vi.fn();
    // 7 GraphQL search queries + 1 pagination scan + 1 metafield search = 9 calls
    for (let i = 0; i < 7; i++) {
      graphqlMock.mockResolvedValueOnce({
        json: async () => ({ data: { orders: { nodes: [] } } }),
      });
    }
    // Pagination scan returns some orders
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({
        data: {
          orders: {
            nodes: [
              { id: "gid://shopify/Order/1", name: "#1001" },
              { id: "gid://shopify/Order/2", name: "#CLEANED" },
            ],
          },
        },
      }),
    });
    // Metafield search hits
    graphqlMock.mockResolvedValueOnce({
      json: async () => ({
        data: { orders: { nodes: [{ id: "gid://shopify/Order/MF", name: "#MF" }] } },
      }),
    });

    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    // Raw GraphQL calls — 2 iterations
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orders: [] }),
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=CLEANED"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.totalStrategies).toBeGreaterThan(5);
    expect(body.diagnostics.shopDomain).toBe("store.myshopify.com");
    expect(body.diagnostics.hasAccessToken).toBe(true);
    expect(body.diagnostics.cleanedName).toBe("CLEANED");
    // Pagination scan should have found the #CLEANED match
    const paginationResult = body.results.find(
      (r: { strategy: string }) => r.strategy === "Pagination scan",
    );
    expect(paginationResult.success).toBe(true);
    // Metafield search should also have succeeded
    const metafieldResult = body.results.find(
      (r: { strategy: string }) => r.strategy === "Metafield search",
    );
    expect(metafieldResult.success).toBe(true);
  });

  it("includes DB return case when returnCaseId provided", async () => {
    const graphqlMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ data: { orders: { nodes: [] } } }) });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) }) as typeof fetch;
    prismaMock.returnCase.findUnique.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderId: "gid://shopify/Order/9",
      shopifyOrderName: "#1001",
      returnRequestNo: "R-1",
    });

    const res = await loader({
      request: mkReq("name=1001&returnCaseId=rc-1"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.diagnostics.returnCase).toEqual(expect.objectContaining({ id: "rc-1" }));
  });

  it("captures GraphQL errors in strategy results", async () => {
    const graphqlMock = vi.fn().mockResolvedValue({
      json: async () => ({ errors: [{ message: "throttled" }] }),
    });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) }) as typeof fetch;
    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const graphqlResults = body.results.filter(
      (r: { strategy: string }) => r.strategy === "GraphQL search",
    );
    expect(graphqlResults.length).toBeGreaterThan(0);
    expect(graphqlResults[0].error).toMatch(/throttled/);
  });

  it("captures Raw GraphQL non-200 responses", async () => {
    const graphqlMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ data: { orders: { nodes: [] } } }) });
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limit exceeded",
    }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    const restResults = body.results.filter((r: { strategy: string }) => r.strategy === "Raw GraphQL search");
    expect(restResults[0].error).toMatch(/HTTP 429/);
  });

  it("records GraphQL call throw as a strategy failure", async () => {
    const graphqlMock = vi.fn().mockRejectedValue(new Error("network"));
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com", accessToken: "tok" },
      admin: { graphql: graphqlMock },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ orders: [] }) }) as typeof fetch;

    const res = await loader({ request: mkReq("name=1001"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results.every((r: { success: boolean }) => r.success === false)).toBe(true);
  });
});
