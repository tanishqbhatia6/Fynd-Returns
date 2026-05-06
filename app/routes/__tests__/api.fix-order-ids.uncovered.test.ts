/**
 * Targeted coverage for the two error-swallow `catch` returns in
 * app/routes/api.fix-order-ids.ts:
 *
 *   • line 231 — `fetchShopifyOrderCustomerInfo`: when the GraphQL fetch
 *     itself rejects (network error / abort), the helper must return null
 *     and the enrich loop falls through to the Fynd payload source.
 *   • line 266 — `fetchShopifyOrderLineItems`: when the GraphQL fetch
 *     rejects, the helper returns null and the fix path leaves line items
 *     untouched.
 *
 * These branches are otherwise unreachable from the smoke + happy-path
 * coverage tests (which only cover non-OK responses, not raw rejections).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, extractAffiliateMock, extractCustomerMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  extractAffiliateMock: vi.fn(() => null as string | null),
  extractCustomerMock: vi.fn(() => null as Record<string, string | undefined> | null),
}));
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
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
  prismaMock.session.findFirst.mockResolvedValue({ shop: "store.myshopify.com", accessToken: "tok" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchShopifyOrderCustomerInfo: catch returns null (line 231)", () => {
  it("returns null when the GraphQL fetch rejects, then falls back to Fynd payload", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-throw-cust",
        returnRequestNo: "R-throw-cust",
        // gid:// triggers the Shopify customer-info GraphQL call.
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
    // Force the GraphQL fetch to throw → exercises the `catch { return null }`
    // branch at line 231. The function returns null, so no Shopify data is
    // applied. Fynd payload still enriches.
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    extractCustomerMock.mockReturnValueOnce({
      name: "Fallback",
      email: "fallback@ex.com",
    });

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fynd-only data was written because Shopify branch returned null.
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-throw-cust" },
      data: { customerName: "Fallback", customerEmailNorm: "fallback@ex.com" },
    });
    expect(body.message).toMatch(/Enriched 1 of 1/);
    // Confirm the GraphQL endpoint was indeed attempted (and rejected).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as string;
    expect(url).toContain("/admin/api/");
    expect(url).toContain("/graphql.json");
  });

  it("returns null when fetch rejects and there is no Fynd payload — no DB update", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-throw-noop",
        returnRequestNo: "R-throw-noop",
        shopifyOrderId: "gid://shopify/Order/456",
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: null,
      },
    ]);
    fetchMock.mockRejectedValueOnce(new Error("AbortError"));

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // No fields were enriched → no update written.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(body.results[0].source).toBe("none");
  });
});

describe("fetchShopifyOrderCustomerInfo: full Shopify data populates every enrich field", () => {
  // Hits the per-field assignment statements (366–370) inside the Shopify
  // enrich branch by giving the GraphQL response a value for every field
  // and leaving every rc.* column null.
  it("writes every customer field from Shopify when all are missing on the case", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-full-shop",
        returnRequestNo: "R-full-shop",
        shopifyOrderId: "gid://shopify/Order/9",
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: null,
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            node: {
              email: "shop@ex.com",
              phone: "+15550000",
              shippingAddress: {
                name: "ShipName",
                firstName: null,
                lastName: null,
                city: "C",
                country: "Co",
                address1: "A1",
                address2: "A2",
                province: "P",
                zip: "Z1",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-full-shop" },
      data: {
        customerName: "ShipName",
        customerEmailNorm: "shop@ex.com",
        customerPhoneNorm: "+15550000",
        customerCity: "C",
        customerCountry: "Co",
        customerAddress1: "A1",
        customerAddress2: "A2",
        customerProvince: "P",
        customerZip: "Z1",
      },
    });
  });

  // Hits the `if (!order) return null;` branch (line 216) by returning a
  // GraphQL payload with `data: {}` (no `node`).
  it("returns null from helper when GraphQL has no node, then enrich falls through", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-nonode",
        returnRequestNo: "R-nonode",
        shopifyOrderId: "gid://shopify/Order/9",
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        customerAddress1: null,
        customerAddress2: null,
        customerProvince: null,
        customerZip: null,
        fyndPayloadJson: null,
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?action=enrich"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // Shopify produced nothing, no Fynd payload → no update.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });
});

describe("fix path: misc branch coverage", () => {
  // Hits line 475 — `data.shopifyOrderName = resolvedOrder.name` when the
  // case has no existing shopifyOrderName but Shopify resolves one.
  it("writes both shopifyOrderId AND shopifyOrderName when name was previously null", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-newname",
        returnRequestNo: "R-newname",
        shopifyOrderId: "BAD",
        // null name → resolution should backfill it.
        shopifyOrderName: null,
        fyndPayloadJson: { x: 1 },
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce("1001");
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ orders: [{ id: 88, name: "#1001" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-newname" },
      data: { shopifyOrderId: "gid://shopify/Order/88", shopifyOrderName: "#1001" },
    });
  });

  // Hits `where.id = specificId` (line 406) — the action passes ?id=… on
  // the fix path so the where-clause is augmented before the findMany.
  it("scopes fix to a specific case id when ?id= is provided", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await action({
      request: mkReq("POST", "/api/fix-order-ids?id=rc-pin"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // Confirm the where clause carried `id: "rc-pin"`.
    const call = prismaMock.returnCase.findMany.mock.calls[0]?.[0] as { where?: { id?: string } } | undefined;
    expect(call?.where?.id).toBe("rc-pin");
  });

  // Hits matchLineItems' early `continue` (line 288) — items already with
  // valid GID/`manual` are skipped without trying to match.
  it("skips return items that already have valid LineItem GIDs during matching", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-skip",
        returnRequestNo: "R-skip",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [
          // Mix: one already-good GID and one bag-id needing fix.
          { id: "i-good", shopifyLineItemId: "gid://shopify/LineItem/already", sku: "G", title: "Good" },
          { id: "i-bad", shopifyLineItemId: "bag-1", sku: "B", title: "Bad" },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            node: {
              lineItems: {
                edges: [
                  { node: { id: "gid://shopify/LineItem/new", title: "Bad", sku: "B" } },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // Only i-bad should be updated; i-good skipped via the early continue.
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.returnItem.update).toHaveBeenCalledWith({
      where: { id: "i-bad" },
      data: { shopifyLineItemId: "gid://shopify/LineItem/new" },
    });
  });
});

describe("isValidShopifyId: cover all return paths via loader", () => {
  // The loader runs `isValidShopifyId` for every case it returns. By
  // shaping a single findMany with three rows we hit:
  //   • `if (!id) return false`     — null shopifyOrderId         (line 35)
  //   • numeric branch `return true` — purely-digit shopifyOrderId (line 37)
  //   • `manual:` branch `return true` — manual:* shopifyOrderId   (line 38)
  it("returns false for null id, true for numeric id, true for manual: prefix", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-null",
        returnRequestNo: "R-null",
        shopifyOrderId: null,
        shopifyOrderName: null,
        status: "open",
        refundStatus: null,
        fyndPayloadJson: null,
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        items: [],
      },
      {
        id: "rc-num",
        returnRequestNo: "R-num",
        shopifyOrderId: "1234567890",
        shopifyOrderName: "#1",
        status: "open",
        refundStatus: null,
        fyndPayloadJson: null,
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        items: [],
      },
      {
        id: "rc-manual",
        returnRequestNo: "R-manual",
        shopifyOrderId: "manual:abc",
        shopifyOrderName: null,
        status: "open",
        refundStatus: null,
        fyndPayloadJson: null,
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        items: [],
      },
    ]);

    const res = await loader({
      request: new Request("https://app.example/api/fix-order-ids"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const byId = Object.fromEntries(body.cases.map((c: { id: string }) => [c.id, c]));
    expect(byId["rc-null"].isValidShopifyId).toBe(false);
    expect(byId["rc-num"].isValidShopifyId).toBe(true);
    expect(byId["rc-manual"].isValidShopifyId).toBe(true);
  });
});

describe("getOrderNameVariants + candidate loop: empty-string short-circuits", () => {
  // Hits two statements at once:
  //   • Line 475 `if (!candidate) continue;` — when the candidate set
  //     contains an empty string (here from shopifyOrderName "#" reducing
  //     to "" after `replace(/^#/, "").trim()`).
  //   • Line 74 `return []` in getOrderNameVariants — fed a "#"-only
  //     candidate sourced from shopifyOrderId "##" which trims to "#",
  //     reduces to "" inside the helper.
  it("treats empty/'#'-only candidate names as no-op and continues to next variant", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-empty-cand",
        returnRequestNo: "R-empty-cand",
        // "##" survives the FY-pattern guard (not matching FY[A-Z0-9]{10,})
        // and is added to candidateNames as "#" (truthy → passes the
        // `if (!candidate) continue` guard at line 475).
        shopifyOrderId: "##",
        // shopifyOrderName "#" reduces to "" → caught by line 475.
        shopifyOrderName: "#",
        fyndPayloadJson: null,
        items: [],
      },
    ]);
    extractAffiliateMock.mockReturnValueOnce(null);
    // No fetch call expected because:
    //   • shopifyOrderName "#" → "" → continue
    //   • shopifyOrderId "##" → "#" → getOrderNameVariants("#") returns []
    //   → inner variant loop has nothing to iterate
    // → resolution misses → falls through to NOT_FOUND_IN_SHOPIFY.

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Resolution failed: no order found, name fallback equals existing id ("##")?
    // bestName = affiliate "" → falsy → NOT_FOUND_IN_SHOPIFY (no DB write).
    expect(body.results[0].status).toBe("NOT_FOUND_IN_SHOPIFY");
    // No Shopify REST call should have been made.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("shopifyFetch: timeout aborts the request", () => {
  // Hits the AbortController-based timeout callback inside `shopifyFetch`
  // (the `controller.abort()` call passed to setTimeout, line 26). With
  // fake timers we let the timer fire while a hanging `fetch` is in
  // flight; the abort signal rejects the await with an AbortError, which
  // the line-items helper swallows via its try/catch and returns null.
  it("aborts the upstream fetch when the timeout elapses", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that resolves only when its abort signal fires — this
      // mirrors what real `fetch` does on AbortController abort.
      fetchMock.mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          const sig = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
          if (sig) {
            sig.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }
        });
      });

      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        {
          id: "rc-timeout",
          returnRequestNo: "R-timeout",
          // Order GID is valid → only the line-items GraphQL fetch runs,
          // and that's the call we want to time out.
          shopifyOrderId: "gid://shopify/Order/1",
          shopifyOrderName: "#1",
          fyndPayloadJson: null,
          items: [
            { id: "i-timeout", shopifyLineItemId: "bag-timeout", sku: "S", title: "T" },
          ],
        },
      ]);

      const promise = action({ request: mkReq(), params: {}, context: {} } as never);
      // Advance past the 15 s SHOPIFY_FETCH_TIMEOUT_MS to fire the abort.
      await vi.advanceTimersByTimeAsync(20_000);
      const res = await promise;
      expect(res.status).toBe(200);
      const body = await res.json();
      // Helper returned null → no line item updates.
      expect(body.totalLineItemsFixed).toBe(0);
      expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchShopifyOrderLineItems: catch returns null (line 266)", () => {
  it("returns null when the GraphQL fetch rejects — line items are not updated", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-throw-li",
        returnRequestNo: "R-throw-li",
        // Order GID is already valid → action skips order-resolution and
        // jumps straight to the line-items GraphQL call.
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1",
        fyndPayloadJson: null,
        items: [
          { id: "i-throw", shopifyLineItemId: "bag-throw", sku: "S", title: "T" },
        ],
      },
    ]);
    // Force the line-items GraphQL fetch to throw → exercises the
    // `catch { return null }` branch at line 266. The fix path then sees
    // null and skips updating line items.
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalLineItemsFixed).toBe(0);
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    // The GraphQL endpoint was reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = (fetchMock.mock.calls[0]?.[0] ?? "") as string;
    expect(url).toContain("/admin/api/");
    expect(url).toContain("/graphql.json");
    // Result still records the case as LINE_ITEMS_FIXED status with zero fixes.
    expect(body.results[0]).toMatchObject({
      id: "rc-throw-li",
      status: "LINE_ITEMS_FIXED",
      lineItemsFixed: 0,
    });
  });
});
