/**
 * Tests for customer-orders, variant info, draft-order invoice, and related
 * helpers in `shopify-admin.server.ts`. Each test mocks the admin.graphql
 * client (and global fetch where needed). No source modifications.
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
  fetchOrdersForCustomer,
  fetchVariantInfo,
  sendDraftOrderInvoice,
  fetchOrdersByCustomer,
  extractAffiliateOrderId,
  extractShopifyOrderNumberVariants,
  fetchOrderByFyndAffiliateId,
  closeShopifyReturnBestEffort,
  withRestCredentials,
  createAdminClient,
  type AdminGraphQL,
} from "../shopify-admin.server";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAdmin(
  responses: Array<unknown | Error | { status: number; body: unknown }>,
): { admin: AdminGraphQL; graphql: ReturnType<typeof vi.fn> } {
  let i = 0;
  const graphql = vi.fn(async () => {
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "status" in r && "body" in r) {
      return jsonResponse((r as { body: unknown }).body, (r as { status: number }).status);
    }
    return jsonResponse(r);
  });
  return { admin: { graphql } as AdminGraphQL, graphql };
}

describe("shopify-admin customer + variant + invoice helpers", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── fetchOrdersForCustomer ───────────────────────────────────────────────
  it("fetchOrdersForCustomer returns [] on non-OK response", async () => {
    const { admin } = makeAdmin([{ status: 500, body: { error: "boom" } }]);
    const out = await fetchOrdersForCustomer(admin, "buyer@example.com");
    expect(out).toEqual([]);
  });

  it("fetchOrdersForCustomer returns [] when admin.graphql throws", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await fetchOrdersForCustomer({ graphql } as AdminGraphQL, "x@y.com");
    expect(out).toEqual([]);
  });

  it("fetchOrdersForCustomer maps a fully-populated order node", async () => {
    const node = {
      id: "gid://shopify/Order/77",
      name: "#7007",
      email: "node@e.com",
      phone: "555",
      createdAt: "2026-01-01T00:00:00Z",
      totalPriceSet: { shopMoney: { amount: "120.50", currencyCode: "USD" } },
      currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
      totalRefundedSet: { shopMoney: { amount: "20.50", currencyCode: "USD" } },
      displayFinancialStatus: "PARTIALLY_REFUNDED",
      customer: {
        id: "gid://shopify/Customer/1",
        firstName: "Jane",
        lastName: "Doe",
        email: "cust@e.com",
        phone: "999",
        numberOfOrders: "5",
        amountSpent: { amount: "1000.00", currencyCode: "USD" },
        defaultAddress: { address1: "1 Rd", city: "TO", province: "ON", country: "CA", zip: "M1", phone: "888" },
      },
      shippingAddress: { firstName: "S", lastName: "H", name: "Ship Name", phone: "777", city: "Van", province: "BC", country: "CA", countryCode: "CA" },
      refunds: [{ id: "r1", createdAt: "2026-02-01", note: "n", totalRefundedSet: { shopMoney: { amount: "20.50", currencyCode: "USD" } } }],
    };
    const { admin } = makeAdmin([{ data: { orders: { nodes: [node] } } }]);
    const out = await fetchOrdersForCustomer(admin, "x@y.com");
    expect(out).toHaveLength(1);
    expect(out[0].orderName).toBe("#7007");
    expect(out[0].customerName).toBe("Jane Doe");
    expect(out[0].customerPhone).toBe("999");
    expect(out[0].lifetimeOrderCount).toBe(5);
    expect(out[0].lifetimeSpent).toBe(1000);
    expect(out[0].totalRefundedAmount).toBe(20.5);
    expect(out[0].refunds).toHaveLength(1);
  });

  it("fetchOrdersForCustomer falls back to shipping name + phone when customer is null", async () => {
    const node = {
      id: "gid://shopify/Order/8",
      name: "#8",
      email: null,
      phone: null,
      createdAt: "2026-01-01",
      totalPriceSet: { shopMoney: { amount: "10", currencyCode: "EUR" } },
      customer: null,
      shippingAddress: { name: "Ship Person", phone: "111", city: "Berlin", country: "DE" },
      refunds: [],
    };
    const { admin } = makeAdmin([{ data: { orders: { nodes: [node] } } }]);
    const out = await fetchOrdersForCustomer(admin, "anon@e.com");
    expect(out[0].customerName).toBe("Ship Person");
    expect(out[0].customerPhone).toBe("111");
    expect(out[0].customerCity).toBe("Berlin");
    expect(out[0].customerCountry).toBe("DE");
    expect(out[0].lifetimeOrderCount).toBeNull();
    expect(out[0].lifetimeSpent).toBeNull();
    expect(out[0].refundCurrency).toBe("EUR");
  });

  it("fetchOrdersForCustomer handles totally empty node defaults", async () => {
    const { admin } = makeAdmin([{ data: { orders: { nodes: [{}] } } }]);
    const out = await fetchOrdersForCustomer(admin, "x@y.com");
    expect(out).toHaveLength(1);
    expect(out[0].orderId).toBe("");
    expect(out[0].totalOrderAmount).toBe(0);
    expect(out[0].refundCurrency).toBe("USD");
    expect(out[0].customerName).toBeNull();
  });

  it("fetchOrdersForCustomer caps `first` at 50", async () => {
    const { admin, graphql } = makeAdmin([{ data: { orders: { nodes: [] } } }]);
    await fetchOrdersForCustomer(admin, "x@y.com", 5000);
    expect(graphql).toHaveBeenCalledTimes(1);
    const call = graphql.mock.calls[0]?.[1] as { variables?: { first?: number } } | undefined;
    expect(call?.variables?.first).toBe(50);
  });

  // ── fetchVariantInfo ─────────────────────────────────────────────────────
  it("fetchVariantInfo returns empty Map for empty/invalid input", async () => {
    const { admin, graphql } = makeAdmin([{ data: { nodes: [] } }]);
    const out = await fetchVariantInfo(admin, []);
    expect(out.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();

    const out2 = await fetchVariantInfo(admin, ["", "   "]);
    expect(out2.size).toBe(0);
  });

  it("fetchVariantInfo normalises numeric IDs into ProductVariant GIDs", async () => {
    const { admin, graphql } = makeAdmin([{ data: { nodes: [] } }]);
    await fetchVariantInfo(admin, ["12345", "gid://shopify/ProductVariant/99"]);
    const callVars = graphql.mock.calls[0]?.[1] as { variables?: { ids?: string[] } } | undefined;
    expect(callVars?.variables?.ids).toEqual([
      "gid://shopify/ProductVariant/12345",
      "gid://shopify/ProductVariant/99",
    ]);
  });

  it("fetchVariantInfo returns empty Map when admin.graphql throws", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("variant fetch boom");
    });
    const out = await fetchVariantInfo({ graphql } as AdminGraphQL, ["1"]);
    expect(out.size).toBe(0);
  });

  it("fetchVariantInfo returns empty Map on non-OK status", async () => {
    const { admin } = makeAdmin([{ status: 500, body: {} }]);
    const out = await fetchVariantInfo(admin, ["1"]);
    expect(out.size).toBe(0);
  });

  it("fetchVariantInfo logs but tolerates GraphQL errors[]", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [] }, errors: [{ message: "stale" }] }]);
    const out = await fetchVariantInfo(admin, ["1"]);
    expect(out.size).toBe(0);
  });

  it("fetchVariantInfo maps tracked + untracked variants", async () => {
    const tracked = {
      id: "gid://shopify/ProductVariant/1",
      sku: "SKU-1",
      title: "M",
      availableForSale: true,
      inventoryQuantity: 7,
      inventoryItem: { tracked: true },
      price: "29.99",
      compareAtPrice: "39.99",
      image: { url: "https://img.example/a.jpg" },
      product: { id: "gid://shopify/Product/100", title: "Tee", featuredImage: { url: "https://img.example/p.jpg" } },
    };
    const untracked = {
      id: "gid://shopify/ProductVariant/2",
      sku: null,
      title: null,
      availableForSale: false,
      inventoryQuantity: null,
      inventoryItem: { tracked: false },
      price: "9.50",
      compareAtPrice: null,
      image: null,
      product: null,
    };
    const { admin } = makeAdmin([{ data: { nodes: [tracked, untracked, null] } }]);
    const out = await fetchVariantInfo(admin, ["1", "2", "3"]);
    expect(out.size).toBe(2);
    const a = out.get("gid://shopify/ProductVariant/1")!;
    expect(a.inventoryAvailable).toBe(7);
    expect(a.imageUrl).toBe("https://img.example/a.jpg");
    expect(a.productId).toBe("gid://shopify/Product/100");
    const b = out.get("gid://shopify/ProductVariant/2")!;
    expect(b.inventoryAvailable).toBeNull();
    expect(b.availableForSale).toBe(false);
    expect(b.imageUrl).toBeNull();
  });

  // ── sendDraftOrderInvoice ───────────────────────────────────────────────
  it("sendDraftOrderInvoice succeeds and returns invoiceUrl", async () => {
    const { admin } = makeAdmin([
      { data: { draftOrderInvoiceSend: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D-1", invoiceUrl: "https://invoice/u" }, userErrors: [] } } },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", "buyer@e.com");
    expect(out.success).toBe(true);
    expect(out.invoiceUrl).toBe("https://invoice/u");
  });

  it("sendDraftOrderInvoice succeeds with null email + custom subject/body", async () => {
    const { admin, graphql } = makeAdmin([
      { data: { draftOrderInvoiceSend: { draftOrder: { id: "x", name: "X", invoiceUrl: null }, userErrors: [] } } },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/2", null, "Hi", "Pay please");
    expect(out.success).toBe(true);
    expect(out.invoiceUrl).toBeNull();
    const vars = graphql.mock.calls[0]?.[1] as { variables?: { email?: unknown } } | undefined;
    expect(vars?.variables?.email).toBeNull();
  });

  it("sendDraftOrderInvoice surfaces top-level GraphQL errors", async () => {
    const { admin } = makeAdmin([{ data: {}, errors: [{ message: "throttled" }, { message: "again" }] }]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/3", "x@y.com");
    expect(out.success).toBe(false);
    expect(out.error).toContain("throttled");
    expect(out.error).toContain("again");
  });

  it("sendDraftOrderInvoice surfaces userErrors[]", async () => {
    const { admin } = makeAdmin([
      { data: { draftOrderInvoiceSend: { draftOrder: null, userErrors: [{ field: ["email"], message: "Invalid email" }] } } },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/4", "bogus");
    expect(out.success).toBe(false);
    expect(out.error).toContain("Invalid email");
  });

  it("sendDraftOrderInvoice catches thrown errors", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("network gone");
    });
    const out = await sendDraftOrderInvoice({ graphql } as AdminGraphQL, "gid://draft/5", "a@b");
    expect(out.success).toBe(false);
    expect(out.error).toContain("network gone");
  });

  // ── fetchOrdersByCustomer ────────────────────────────────────────────────
  it("fetchOrdersByCustomer returns [] for empty/whitespace email", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await fetchOrdersByCustomer(admin, "    ");
    expect(out).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("fetchOrdersByCustomer lowercases email + delegates to fetchOrdersByFilter", async () => {
    const { admin, graphql } = makeAdmin([{ data: { orders: { nodes: [] } } }]);
    await fetchOrdersByCustomer(admin, "  Buyer@Example.COM  ");
    const vars = graphql.mock.calls[0]?.[1] as { variables?: { query?: string } } | undefined;
    expect(vars?.variables?.query).toBe("email:buyer@example.com");
  });

  // ── extractAffiliateOrderId ─────────────────────────────────────────────
  it("extractAffiliateOrderId picks first matching key (case-insensitive) and trims values", async () => {
    expect(extractAffiliateOrderId(null)).toBeNull();
    expect(extractAffiliateOrderId([])).toBeNull();
    expect(
      extractAffiliateOrderId([
        { key: "Other", value: "skip" },
        { key: "FYND_ORDER_ID", value: "  AB-123  " },
      ]),
    ).toBe("AB-123");
    // affiliate_order_id wins over the lower-priority fynd_order_id key
    expect(
      extractAffiliateOrderId([
        { key: "fynd_order_id", value: "second" },
        { key: "affiliate_order_id", value: "first" },
      ]),
    ).toBe("first");
    // empty values are skipped
    expect(
      extractAffiliateOrderId([
        { key: "affiliate_order_id", value: "   " },
        { key: "_fynd_order_id", value: "fallback" },
      ]),
    ).toBe("fallback");
  });

  // ── extractShopifyOrderNumberVariants ───────────────────────────────────
  it("extractShopifyOrderNumberVariants strips Fynd prefixes and explodes letter-prefixed numbers", () => {
    expect(extractShopifyOrderNumberVariants(null)).toEqual([]);
    expect(extractShopifyOrderNumberVariants("")).toEqual([]);
    expect(extractShopifyOrderNumberVariants("#")).toEqual([]);

    const variants1 = extractShopifyOrderNumberVariants("FYNDSHOPIFYX14126");
    expect(variants1).toContain("FYNDSHOPIFYX14126");
    expect(variants1).toContain("X14126");
    expect(variants1).toContain("14126");
    // de-duplication preserves first occurrence only
    expect(new Set(variants1).size).toBe(variants1.length);
    expect(extractShopifyOrderNumberVariants("#FYND_SHOPIFY_42")).toContain("42");
    // pure numeric stays as one variant
    expect(extractShopifyOrderNumberVariants("9001")).toEqual(["9001"]);
  });

  // ── fetchOrderByFyndAffiliateId ─────────────────────────────────────────
  it("fetchOrderByFyndAffiliateId returns null when no variant resolves", async () => {
    // Each variant attempts SDK fallback (2 queries) — return empty for all
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    const out = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFY999");
    expect(out).toBeNull();
  });

  // ── closeShopifyReturnBestEffort skip paths ─────────────────────────────
  it("closeShopifyReturnBestEffort skips when no shopifyReturnId", async () => {
    const { admin } = makeAdmin([]);
    const logEvent = vi.fn(async () => {});
    const out = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: null, shopifyOrderId: "gid://shopify/Order/1" },
      { logEvent },
    );
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "shopify_return_close_skipped" }),
    );
  });

  it("closeShopifyReturnBestEffort skips manual: orders without calling Shopify", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await closeShopifyReturnBestEffort(admin, {
      id: "rc-2",
      shopifyReturnId: "gid://shopify/Return/1",
      shopifyOrderId: "manual:abc",
    });
    expect(out.skipped).toBe(true);
    expect(out.ok).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("closeShopifyReturnBestEffort tolerates logEvent rejections", async () => {
    const { admin } = makeAdmin([]);
    const logEvent = vi.fn(async () => {
      throw new Error("logEvent down");
    });
    const out = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-3", shopifyReturnId: null, shopifyOrderId: null },
      { logEvent },
    );
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(true);
  });

  // ── withRestCredentials ─────────────────────────────────────────────────
  it("withRestCredentials returns a wrapper that exposes _rest and proxies graphql", async () => {
    const { admin, graphql } = makeAdmin([{ data: { ok: true } }]);
    const wrapped = withRestCredentials(admin, "demo-shop", "tok-123");
    expect(wrapped._rest?.shopDomain).toBe("demo-shop");
    expect(wrapped._rest?.accessToken).toBe("tok-123");
    await wrapped.graphql("query { x }");
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  // ── createAdminClient (uses global fetch) ────────────────────────────────
  it("createAdminClient appends .myshopify.com when missing and POSTs to admin GraphQL endpoint", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: { ok: true } }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = createAdminClient("acme", "shpat_TOKEN");
    const res = await client.graphql("query { x }", { variables: { foo: 1 } });
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://acme.myshopify.com/admin/api/");
    expect(url).toContain("/graphql.json");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Shopify-Access-Token"]).toBe("shpat_TOKEN");
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("query { x }");
    expect(body.variables).toEqual({ foo: 1 });
  });

  it("createAdminClient preserves a fully-qualified shop domain", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: {} }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = createAdminClient("custom.shop.domain.com", "tok");
    await client.graphql("query { y }");
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toContain("https://custom.shop.domain.com/");
    expect(url).not.toContain("myshopify.com");
  });

  it("createAdminClient defaults variables to {} when omitted", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: {} }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const client = createAdminClient("acme", "tok");
    await client.graphql("query { z }");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({});
  });
});
