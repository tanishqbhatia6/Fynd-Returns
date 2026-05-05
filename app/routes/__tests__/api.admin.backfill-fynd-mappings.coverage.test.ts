/**
 * Extra coverage tests for /api/admin/backfill-fynd-mappings.
 *
 * Complements the smoke tests in api.admin.backfill-fynd-mappings.test.ts.
 * Focus areas:
 *   - orderUpdate userErrors / mutation throws (route swallows + logs, continues)
 *   - large pagination loops with 250 nodes per page
 *   - cursor handling: missing endCursor stops the loop
 *   - mixed nodes (some with affiliate_order_id, some without)
 *   - DB upsert conflict swallowed without aborting the loop
 *   - empty page short-circuits the loop
 *   - default body (no maxPages) still terminates via hasNextPage:false
 *   - response counters reflect totalScanned vs metafieldsWritten vs totalMapped
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

type OrderNode = {
  id: string;
  name: string;
  customAttributes?: Array<{ key: string; value: string }>;
};

/**
 * Build a graphql fn that serves backfill pages from a list and forwards
 * orderUpdate mutations to the supplied handler.
 */
function makeGraphql(
  pages: Array<{ nodes: OrderNode[]; hasNextPage: boolean; endCursor: string | null }>,
  orderUpdateHandler: () => Promise<unknown>,
) {
  let pageIdx = 0;
  return vi.fn(async (query: string) => {
    if (query.includes("orderUpdate")) {
      const result = await orderUpdateHandler();
      return { json: async () => result };
    }
    const page = pages[pageIdx] ?? { nodes: [], hasNextPage: false, endCursor: null };
    pageIdx++;
    return {
      json: async () => ({
        data: {
          orders: {
            nodes: page.nodes,
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          },
        },
      }),
    };
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset();
  extractAffiliateOrderIdMock.mockReset().mockReturnValue(null);
});

describe("POST /api/admin/backfill-fynd-mappings (coverage)", () => {
  it("logs but continues when orderUpdate throws — DB upsert still runs", async () => {
    const orderUpdate = vi.fn(async () => {
      throw new Error("network blew up");
    });
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/1", name: "#1001", customAttributes: [{ key: "affiliate_order_id", value: "FY1" }] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("FY1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(1);
    expect(body.metafieldsWritten).toBe(0); // mutation threw
    expect(body.totalMapped).toBe(1); // DB upsert still ran
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("orderUpdate userErrors do NOT abort — route ignores them and continues", async () => {
    // The route currently does not inspect orderUpdate userErrors. Verify
    // that semantics: a non-throwing response with userErrors still counts
    // as a "metafield written" attempt and the loop proceeds.
    const orderUpdate = vi.fn(async () => ({
      data: {
        orderUpdate: {
          order: null,
          userErrors: [{ field: ["input", "id"], message: "Order not found" }],
        },
      },
    }));
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/1", name: "#1001", customAttributes: [{ key: "affiliate_order_id", value: "FA" }] },
          { id: "gid://shopify/Order/2", name: "#1002", customAttributes: [{ key: "affiliate_order_id", value: "FB" }] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("FA").mockReturnValueOnce("FB");

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(2);
    expect(body.metafieldsWritten).toBe(2);
    expect(body.totalMapped).toBe(2);
    expect(orderUpdate).toHaveBeenCalledTimes(2);
  });

  it("paginates a large batch: 250 nodes/page across 3 pages = 750 scanned", async () => {
    const mkNodes = (pageNum: number): OrderNode[] =>
      Array.from({ length: 250 }, (_, i) => ({
        id: `gid://shopify/Order/${pageNum}-${i}`,
        name: `#${pageNum}${String(i).padStart(3, "0")}`,
        customAttributes: [{ key: "affiliate_order_id", value: `FY-${pageNum}-${i}` }],
      }));
    const pages = [
      { nodes: mkNodes(1), hasNextPage: true, endCursor: "c1" },
      { nodes: mkNodes(2), hasNextPage: true, endCursor: "c2" },
      { nodes: mkNodes(3), hasNextPage: false, endCursor: null },
    ];
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
    }));
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    // Always return a fynd id so every node triggers an upsert
    extractAffiliateOrderIdMock.mockImplementation(() => "FYALL");

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(750);
    expect(body.metafieldsWritten).toBe(750);
    expect(body.totalMapped).toBe(750);
    expect(orderUpdate).toHaveBeenCalledTimes(750);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(750);
    // 3 backfill page fetches
    const backfillCalls = graphql.mock.calls.filter((c) => String(c[0]).includes("backfillOrders"));
    expect(backfillCalls).toHaveLength(3);
  });

  it("250-node page with mixed attributes only counts those with a fynd id as mapped", async () => {
    const nodes: OrderNode[] = Array.from({ length: 250 }, (_, i) => ({
      id: `gid://shopify/Order/${i}`,
      name: `#${i}`,
      customAttributes: i % 2 === 0 ? [{ key: "affiliate_order_id", value: `FX${i}` }] : [],
    }));
    const pages = [{ nodes, hasNextPage: false, endCursor: null }];
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
    }));
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockImplementation((attrs) => {
      const arr = attrs as Array<{ key: string; value: string }> | undefined;
      const hit = arr?.find((a) => a.key === "affiliate_order_id");
      return hit ? hit.value : null;
    });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(250); // every node bumped scan counter
    expect(body.metafieldsWritten).toBe(125); // only even indices had affiliate_order_id
    expect(body.totalMapped).toBe(125);
    expect(orderUpdate).toHaveBeenCalledTimes(125);
  });

  it("loop terminates when hasNextPage=true but endCursor is null", async () => {
    // Defensive case: Shopify says "more available" but doesn't give us a
    // cursor. The loop must NOT spin forever — it breaks on `if (!cursor)`.
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/1", name: "#1", customAttributes: [{ key: "affiliate_order_id", value: "F1" }] },
        ],
        hasNextPage: true,
        endCursor: null,
      },
    ];
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
    }));
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F1");

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(1);
    const backfillCalls = graphql.mock.calls.filter((c) => String(c[0]).includes("backfillOrders"));
    expect(backfillCalls).toHaveLength(1);
  });

  it("empty first page short-circuits the while loop (success, zeros)", async () => {
    const orderUpdate = vi.fn(async () => ({ data: {} }));
    const graphql = makeGraphql(
      [{ nodes: [], hasNextPage: false, endCursor: null }],
      orderUpdate,
    );
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.totalScanned).toBe(0);
    expect(body.totalMapped).toBe(0);
    expect(body.metafieldsWritten).toBe(0);
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(prismaMock.fyndOrderMapping.upsert).not.toHaveBeenCalled();
  });

  it("DB upsert conflict is swallowed; loop keeps scanning", async () => {
    prismaMock.fyndOrderMapping.upsert
      .mockRejectedValueOnce(new Error("unique constraint violation"))
      .mockResolvedValueOnce({ id: "ok" });
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/1", name: "#1", customAttributes: [{ key: "affiliate_order_id", value: "F1" }] },
          { id: "gid://shopify/Order/2", name: "#2", customAttributes: [{ key: "affiliate_order_id", value: "F2" }] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
    }));
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F1").mockReturnValueOnce("F2");

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(2);
    expect(body.metafieldsWritten).toBe(2); // both metafield writes succeeded
    expect(body.totalMapped).toBe(1); // only the second upsert resolved
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledTimes(2);
  });

  it("default body (no maxPages) honours hasNextPage:false to terminate", async () => {
    const pages = [
      {
        nodes: [{ id: "gid://shopify/Order/1", name: "#1", customAttributes: [] }],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const orderUpdate = vi.fn(async () => ({ data: {} }));
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    // No fynd id — extract returns null (default)

    // Send a request with no JSON body at all to exercise the catch branch
    const req = new Request("https://app.example/api/admin/backfill-fynd-mappings", {
      method: "POST",
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalScanned).toBe(1);
    expect(body.totalMapped).toBe(0); // no fynd id → no upsert
    expect(orderUpdate).not.toHaveBeenCalled();
    expect(body.pages).toBe(1); // page is 0-indexed inside loop, response reports page+1
  });

  it("metafield input shape matches the documented contract", async () => {
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } },
    }));
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/1", name: "#1", customAttributes: [{ key: "affiliate_order_id", value: "FY-EXACT" }] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    let capturedVars: unknown = null;
    const graphql = vi.fn(async (query: string, opts?: { variables?: unknown }) => {
      if (query.includes("orderUpdate")) {
        capturedVars = opts?.variables;
        return { json: async () => orderUpdate() };
      }
      const page = pages[0];
      return {
        json: async () => ({
          data: {
            orders: {
              nodes: page.nodes,
              pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
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
    extractAffiliateOrderIdMock.mockReturnValueOnce("FY-EXACT");

    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(capturedVars).toEqual({
      input: {
        id: "gid://shopify/Order/1",
        metafields: [
          {
            namespace: "$app",
            key: "fynd_order_id",
            value: "FY-EXACT",
            type: "single_line_text_field",
          },
        ],
      },
    });
  });

  it("upsert is called with the schema-correct compound key + searchStrategy", async () => {
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "gid://shopify/Order/77" }, userErrors: [] } },
    }));
    const pages = [
      {
        nodes: [
          { id: "gid://shopify/Order/77", name: "#1077", customAttributes: [{ key: "affiliate_order_id", value: "FY-77" }] },
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const graphql = makeGraphql(pages, orderUpdate);
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-xyz", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValueOnce("FY-77");

    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledWith({
      where: {
        shopId_shopifyOrderName: {
          shopId: "shop-xyz",
          shopifyOrderName: "#1077",
        },
      },
      create: {
        shopId: "shop-xyz",
        shopifyOrderName: "#1077",
        shopifyOrderId: "gid://shopify/Order/77",
        fyndOrderId: "FY-77",
        searchStrategy: "bulk_backfill",
      },
      update: {
        fyndOrderId: "FY-77",
        shopifyOrderId: "gid://shopify/Order/77",
      },
    });
  });

  it("GraphQL error mid-pagination returns 500 with progress reflecting prior pages", async () => {
    let pageNum = 0;
    const orderUpdate = vi.fn(async () => ({
      data: { orderUpdate: { order: { id: "x" }, userErrors: [] } },
    }));
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("orderUpdate")) return { json: async () => orderUpdate() };
      pageNum++;
      if (pageNum === 1) {
        return {
          json: async () => ({
            data: {
              orders: {
                nodes: [{ id: "gid://shopify/Order/1", name: "#1", customAttributes: [{ key: "affiliate_order_id", value: "F1" }] }],
                pageInfo: { hasNextPage: true, endCursor: "c1" },
              },
            },
          }),
        };
      }
      return { json: async () => ({ errors: [{ message: "throttled" }] }) };
    });
    authenticateMock.mockResolvedValueOnce({
      admin: { graphql },
      session: { shop: "store.myshopify.com" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    extractAffiliateOrderIdMock.mockReturnValue("F1");

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("GraphQL error");
    expect(body.details).toContain("throttled");
    // Progress from page 1 should be reflected
    expect(body.progress.totalScanned).toBe(1);
    expect(body.progress.metafieldsWritten).toBe(1);
    expect(body.progress.totalMapped).toBe(1);
    expect(body.progress.pages).toBe(1); // bumped after page 1, before failed page 2
  });
});
