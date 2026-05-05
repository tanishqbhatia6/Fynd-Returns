/**
 * Smoke tests for /api/admin/backfill-fynd-mappings — one-time admin tool to
 * write the Shopify metafield + FyndOrderMapping rows for historical orders.
 *
 * Tests focus on:
 *  - auth gate
 *  - shop-not-found 404
 *  - GraphQL error returns 500 with progress payload
 *  - happy path with maxPages limit honoured
 *  - extractAffiliateOrderId integration
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, extractAffiliateOrderIdMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  extractAffiliateOrderIdMock: vi.fn<(...args: unknown[]) => string | null>(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));

import { action } from "../api.admin.backfill-fynd-mappings";

function mkReq(body: unknown = {}) {
  return new Request("https://app.example/api/admin/backfill-fynd-mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset();
  extractAffiliateOrderIdMock.mockReset().mockReturnValue(null);
});

describe("POST /api/admin/backfill-fynd-mappings", () => {
  it("404 when shop not found", async () => {
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql: vi.fn() },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("requires authentication (auth throw propagates)", async () => {
    authenticateMock.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/auth?shop=x" } }));
    await expect(
      action({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBeInstanceOf(Response);
  });

  it("500 on GraphQL errors with progress payload", async () => {
    authenticateMock.mockResolvedValueOnce({
      admin: {
        graphql: vi.fn(async () => ({
          json: async () => ({ errors: [{ message: "rate limited" }] }),
        })),
      },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("GraphQL error");
    expect(body.progress).toBeDefined();
    expect(body.details).toContain("rate limited");
  });

  it("happy path: scans orders, writes mappings + metafields", async () => {
    const orderUpdateGraphql = vi.fn(async () => ({
      json: async () => ({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }),
    }));
    let pageNum = 0;
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("orderUpdate")) {
        return orderUpdateGraphql();
      }
      pageNum++;
      if (pageNum === 1) {
        return {
          json: async () => ({
            data: {
              orders: {
                nodes: [
                  { id: "gid://shopify/Order/1", name: "#1001", customAttributes: [{ key: "affiliate_order_id", value: "FYNDX1" }] },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        };
      }
      return { json: async () => ({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } }) };
    });
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("FYNDX1");

    const res = await action({ request: mkReq({ maxPages: 1 }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBeGreaterThan(0);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalled();
  });

  it("respects maxPages limit", async () => {
    const orderUpdateGraphql = vi.fn(async () => ({
      json: async () => ({ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }),
    }));
    let pageNum = 0;
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("orderUpdate")) return orderUpdateGraphql();
      pageNum++;
      // Always return more pages — only maxPages should stop the loop.
      return {
        json: async () => ({
          data: {
            orders: {
              nodes: [{ id: `gid://shopify/Order/${pageNum}`, name: `#100${pageNum}`, customAttributes: [{ key: "affiliate_order_id", value: `FX${pageNum}` }] }],
              pageInfo: { hasNextPage: true, endCursor: `c${pageNum}` },
            },
          },
        }),
      };
    });
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValue("FXVAL");

    await action({ request: mkReq({ maxPages: 2 }), params: {}, context: {} } as never);
    // We expect at most 2 BACKFILL_QUERY calls (maxPages=2). orderUpdate calls vary.
    const backfillCalls = graphql.mock.calls.filter((c) => String(c[0]).includes("backfillOrders"));
    expect(backfillCalls.length).toBeLessThanOrEqual(2);
  });

  it("tolerates malformed JSON body", async () => {
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql: vi.fn(async () => ({ json: async () => ({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } }) })) },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    const req = new Request("https://app.example/api/admin/backfill-fynd-mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
