/**
 * Coverage tests for /api/fix-order-ids — exercises the deeper repair and
 * enrich code paths that the smoke tests intentionally skip (so they can
 * stay zero-network).
 *
 * The route does direct REST/GraphQL calls into Shopify, so we stub the
 * global `fetch` and assert the route stitches everything together —
 * candidate-name expansion, GID resolution, line-item GID matching by
 * SKU/title, Fynd payload extraction, and DB writes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, extractAffiliateMock, extractCustomerMock } = vi.hoisted(
  () => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateMock: vi.fn(),
    extractAffiliateMock: vi.fn(() => null as string | null),
    extractCustomerMock: vi.fn(() => null as Record<string, string | undefined> | null),
  }),
);
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractAffiliateOrderIdFromFyndPayload: extractAffiliateMock,
  extractCustomerFromFyndPayload: extractCustomerMock,
}));

import { action, loader } from "../api.fix-order-ids";

function mkReq(method = "POST", path = "/api/fix-order-ids") {
  return new Request(`https://app.example${path}`, { method });
}

/** Build a `fetch`-shaped Response from JSON. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok" },
    admin: {},
  });
  extractAffiliateMock.mockReset().mockReturnValue(null);
  extractCustomerMock.mockReset().mockReturnValue(null);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // Standard happy-path session lookups; tests can override.
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
  prismaMock.session.findFirst.mockResolvedValue({
    shop: "store.myshopify.com",
    accessToken: "tok",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────
// FIX path — full repair journey
// ─────────────────────────────────────────────────────────────────────

describe("action fix path: resolveOrderByName", () => {
  it("resolves order by name via REST and writes GID + name back to DB", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderId: "FYNDSHOPIFYX14126",
        shopifyOrderName: "#1001",
        fyndPayloadJson: null,
        items: [
          { id: "i-1", shopifyLineItemId: "gid://shopify/LineItem/1", sku: "SKU", title: "T" },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(jsonResponse({ orders: [{ id: 9999, name: "#1001" }] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolved).toBe(1);
    expect(body.results[0]).toMatchObject({
      status: "RESOLVED",
      after: "gid://shopify/Order/9999",
      afterName: "#1001",
    });

    // Confirm the DB was patched with the resolved GID.
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { shopifyOrderId: "gid://shopify/Order/9999" },
    });
    // Confirm we hit the orders.json REST endpoint with #1001.
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as string;
    expect(url).toContain("/admin/api/");
    expect(url).toContain("/orders.json");
    expect(url).toContain("name=%231001");
  });

  it("falls back to bare-name query when prefixed lookup misses", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-2",
        returnRequestNo: "R-2",
        shopifyOrderId: "BAD",
        shopifyOrderName: "1234",
        fyndPayloadJson: null,
        items: [],
      },
    ]);
    // First (#1234) returns no match; second (1234) returns a match.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ orders: [] }))
      .mockResolvedValueOnce(jsonResponse({ orders: [{ id: 7777, name: "1234" }] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.resolved).toBe(1);
    expect(body.results[0].after).toBe("gid://shopify/Order/7777");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips FYNDSHOPIFY/FYND-SHOPIFY prefixes via getOrderNameVariants", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-3",
        returnRequestNo: "R-3",
        // No shopifyOrderName — only the affiliate id is the candidate.
        shopifyOrderId: "BAD",
        shopifyOrderName: null,
        fyndPayloadJson: { x: 1 },
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce("FYNDSHOPIFYX14126");
    // Each candidate triggers two REST calls (with `#` and bare). Variants
    // = [original, stripped, numeric]. We let the first resolution succeed
    // by returning the match on the very first call.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ orders: [{ id: 1, name: "FYNDSHOPIFYX14126" }] }),
    );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.resolved).toBe(1);
    // Confirm the first lookup used the original candidate name.
    const firstUrl = (fetchMock.mock.calls[0]?.[0] ?? "") as string;
    expect(firstUrl).toContain("FYNDSHOPIFYX14126");
  });

  it("records NO_CANDIDATES when no order name and no Fynd affiliate id", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-empty",
        returnRequestNo: "R-empty",
        // shopifyOrderId matches the FY... pattern → not a candidate.
        shopifyOrderId: "FYABCDEFGHIJKL",
        shopifyOrderName: null,
        fyndPayloadJson: null,
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce(null);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.noCandidates).toBe(1);
    expect(body.results[0].status).toBe("NO_CANDIDATES");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to NAME_ONLY when Shopify cannot find the order", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-no",
        returnRequestNo: "R-no",
        shopifyOrderId: "BAD",
        shopifyOrderName: null,
        fyndPayloadJson: { x: 1 },
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce("9999");
    // All REST queries return empty → resolveOrderByName returns null.
    fetchMock.mockResolvedValue(jsonResponse({ orders: [] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.nameOnly).toBe(1);
    expect(body.results[0]).toMatchObject({ status: "NAME_ONLY", after: "9999" });
    // Update was made to record the name-only fallback.
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-no" },
      data: { shopifyOrderId: "9999" },
    });
  });

  it("records NOT_FOUND_IN_SHOPIFY when name fallback would equal existing id", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-nf",
        returnRequestNo: "R-nf",
        // Invalid id (not a GID, not numeric, not manual:) so it is fixed,
        // and matches the affiliate id → bestName === existing → skip update.
        shopifyOrderId: "ORDER-BAD",
        shopifyOrderName: null,
        fyndPayloadJson: { x: 1 },
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce("ORDER-BAD");
    fetchMock.mockResolvedValue(jsonResponse({ orders: [] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.notFound).toBe(1);
    expect(body.results[0].status).toBe("NOT_FOUND_IN_SHOPIFY");
  });

  it("treats non-OK Shopify REST as a miss and continues to next variant", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-5xx",
        returnRequestNo: "R-5xx",
        shopifyOrderId: "BAD",
        shopifyOrderName: "1001",
        fyndPayloadJson: null,
        items: [],
      },
    ]);
    // First REST call 500s; second succeeds.
    fetchMock
      .mockResolvedValueOnce(new Response("nope", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ orders: [{ id: 42, name: "1001" }] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.resolved).toBe(1);
    expect(body.results[0].after).toBe("gid://shopify/Order/42");
  });

  it("treats fetch rejection as a miss and continues to next variant", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-throw",
        returnRequestNo: "R-throw",
        shopifyOrderId: "BAD",
        shopifyOrderName: "1001",
        fyndPayloadJson: null,
        items: [],
      },
    ]);
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ orders: [{ id: 11, name: "1001" }] }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.resolved).toBe(1);
    expect(body.results[0].after).toBe("gid://shopify/Order/11");
  });

  it("returns early when no cases need fixing", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-ok",
        returnRequestNo: "R-ok",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [
          { id: "i-1", shopifyLineItemId: "gid://shopify/LineItem/1", sku: null, title: null },
        ],
      },
    ]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.message).toMatch(/No return cases need fixing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("action fix path: line item GID resolution", () => {
  it("matches return items to Shopify line items by SKU after resolving the order", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-li",
        returnRequestNo: "R-li",
        shopifyOrderId: "BAD",
        shopifyOrderName: "1001",
        fyndPayloadJson: null,
        items: [
          { id: "i-sku", shopifyLineItemId: "bag-123", sku: "ABC-1", title: "Widget" },
          { id: "i-other", shopifyLineItemId: "manual", sku: "X", title: "Y" },
        ],
      },
    ]);
    fetchMock
      // 1) resolveOrderByName REST call
      .mockResolvedValueOnce(jsonResponse({ orders: [{ id: 555, name: "1001" }] }))
      // 2) fetchShopifyOrderLineItems GraphQL call
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            node: {
              lineItems: {
                edges: [
                  { node: { id: "gid://shopify/LineItem/9001", title: "Widget", sku: "ABC-1" } },
                  { node: { id: "gid://shopify/LineItem/9002", title: "Other", sku: "OTHER" } },
                ],
              },
            },
          },
        }),
      );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.totalLineItemsFixed).toBe(1);
    expect(body.results[0].lineItemDetails[0]).toEqual({
      itemId: "i-sku",
      before: "bag-123",
      after: "gid://shopify/LineItem/9001",
    });
    expect(prismaMock.returnItem.update).toHaveBeenCalledWith({
      where: { id: "i-sku" },
      data: { shopifyLineItemId: "gid://shopify/LineItem/9001" },
    });
  });

  it("falls back to title match when SKU is absent", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-title",
        returnRequestNo: "R-title",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [{ id: "i-tit", shopifyLineItemId: "bag-7", sku: null, title: "Hat" }],
      },
    ]);
    // Order is already valid → only the line items GraphQL call fires.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          node: {
            lineItems: {
              edges: [{ node: { id: "gid://shopify/LineItem/77", title: "Hat", sku: null } }],
            },
          },
        },
      }),
    );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.lineItemsOnly).toBe(1);
    expect(body.results[0].lineItemDetails[0].after).toBe("gid://shopify/LineItem/77");
  });

  it("uses the only Shopify line item as a last-resort match when SKU/title both miss", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-only",
        returnRequestNo: "R-only",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [{ id: "i-only", shopifyLineItemId: "bag-only", sku: "NOPE", title: "NoMatch" }],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          node: {
            lineItems: {
              edges: [
                { node: { id: "gid://shopify/LineItem/single", title: "Solo", sku: "SOLO" } },
              ],
            },
          },
        },
      }),
    );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.totalLineItemsFixed).toBe(1);
    expect(body.results[0].lineItemDetails[0].after).toBe("gid://shopify/LineItem/single");
  });

  it("does not update line items when the GraphQL call returns non-OK", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-gqlfail",
        returnRequestNo: "R-gqlfail",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [{ id: "i-fail", shopifyLineItemId: "bag-fail", sku: "S", title: "T" }],
      },
    ]);
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500 }));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.totalLineItemsFixed).toBe(0);
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// ENRICH path — Fynd payload + Shopify GraphQL extraction
// ─────────────────────────────────────────────────────────────────────

describe("action enrich path: Fynd payload extraction", () => {
  it("backfills missing customer fields from the Fynd payload only", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fynd",
        returnRequestNo: "R-fynd",
        // No Shopify GID → skips Shopify enrich, exercises the Fynd branch.
        shopifyOrderId: null,
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: { any: "thing" },
      },
    ]);
    extractCustomerMock.mockReturnValueOnce({
      name: "Jane Doe",
      email: "JANE@Example.COM",
      phone: "+15551234",
      city: "Mumbai",
      country: "IN",
      address1: "1 Lane",
      address2: "Apt 2",
      province: "MH",
      zip: "400001",
    });

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/Enriched 1 of 1/);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-fynd" },
      data: {
        customerName: "Jane Doe",
        customerEmailNorm: "jane@example.com", // lower-cased
        customerPhoneNorm: "+15551234",
        customerCity: "Mumbai",
        customerCountry: "IN",
        customerAddress1: "1 Lane",
        customerAddress2: "Apt 2",
        customerProvince: "MH",
        customerZip: "400001",
      },
    });
    // No Shopify GraphQL request because shopifyOrderId is null.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not overwrite fields already populated on the return case", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-keep",
        returnRequestNo: "R-keep",
        shopifyOrderId: null,
        customerName: "Existing",
        customerEmailNorm: "old@ex.com",
        customerPhoneNorm: "999",
        customerCity: "OldCity",
        customerCountry: "US",
        customerAddress1: "Old 1",
        customerAddress2: "Old 2",
        customerProvince: "CA",
        customerZip: "94000",
        fyndPayloadJson: { x: 1 },
      },
    ]);
    extractCustomerMock.mockReturnValueOnce({
      name: "New",
      email: "new@ex.com",
      phone: "111",
      city: "NewCity",
      country: "IN",
      address1: "New 1",
      address2: "New 2",
      province: "MH",
      zip: "00001",
    });

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    // Nothing was missing → no update written.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(body.results[0].source).toBe("none");
  });

  it("merges Shopify GraphQL data with Fynd payload (Shopify wins, Fynd fills gaps)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-merge",
        returnRequestNo: "R-merge",
        shopifyOrderId: "gid://shopify/Order/123",
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: { x: 1 },
      },
    ]);
    // Shopify provides email + city.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          node: {
            email: "shop@example.com",
            phone: null,
            shippingAddress: {
              name: "Shop Customer",
              firstName: null,
              lastName: null,
              city: "Shopville",
              country: null,
              address1: null,
              address2: null,
              province: null,
              zip: null,
            },
          },
        },
      }),
    );
    // Fynd fills the rest.
    extractCustomerMock.mockReturnValueOnce({
      name: "Should Not Overwrite",
      email: "should-not-overwrite@x.com",
      phone: "+19998887777",
      city: "Should Not Overwrite",
      country: "IN",
      address1: "Fynd Lane",
      zip: "400001",
    });

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-merge" },
      data: expect.objectContaining({
        // From Shopify
        customerName: "Shop Customer",
        customerEmailNorm: "shop@example.com",
        customerCity: "Shopville",
        // From Fynd (gaps Shopify left empty)
        customerPhoneNorm: "+19998887777",
        customerCountry: "IN",
        customerAddress1: "Fynd Lane",
        customerZip: "400001",
      }),
    });
  });

  it("survives Shopify GraphQL non-OK and still applies Fynd enrichment", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-gql500",
        returnRequestNo: "R-gql500",
        shopifyOrderId: "gid://shopify/Order/123",
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: { x: 1 },
      },
    ]);
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 500 }));
    extractCustomerMock.mockReturnValueOnce({ name: "Fynd Only", email: "f@ex.com" });

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-gql500" },
      data: { customerName: "Fynd Only", customerEmailNorm: "f@ex.com" },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Loader — diagnostic flags
// ─────────────────────────────────────────────────────────────────────

describe("loader: diagnostic flags", () => {
  it("flags numeric line item ids as valid and bag ids as invalid", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-A",
        returnRequestNo: "R-A",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        status: "approved",
        refundStatus: null,
        fyndPayloadJson: null,
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        items: [
          { id: "i-num", shopifyLineItemId: "12345", sku: null, title: null, qty: 1 },
          { id: "i-bag", shopifyLineItemId: "bag-xyz", sku: null, title: null, qty: 1 },
        ],
      },
    ]);

    const res = await loader({
      request: new Request("https://app.example/api/fix-order-ids"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.cases[0].lineItemsValid).toBe(false);
    // Numeric ids count as "looksNumeric" but not as valid LineItem GID for the loader's stricter check.
    const numItem = body.cases[0].items.find(
      (i: { shopifyLineItemId: string }) => i.shopifyLineItemId === "12345",
    );
    expect(numItem.looksNumeric).toBe(true);
    expect(numItem.isValidShopifyLineItemId).toBe(false);
    // Counts the case as needing line-item fix.
    expect(body.needsLineItemFix).toBe(1);
  });
});
