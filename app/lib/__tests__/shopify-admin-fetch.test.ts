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
  fetchOrder,
  fetchOrderByGid,
  fetchOrderByOrderNumber,
  fetchOrderByFyndAffiliateId,
  withRestCredentials,
  type AdminGraphQL,
} from "../shopify-admin.server";

/** Build mock AdminGraphQL with canned (FIFO) responses */
function makeAdmin(responses: Array<unknown | Error | { status: number; body: unknown }>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const graphql = vi.fn(async () => {
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
  return { admin: { graphql } as AdminGraphQL, graphql };
}

/** Build a fully-shaped order node returned by Shopify. */
function fullOrderNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/1234",
    legacyResourceId: "1234",
    name: "#1001",
    createdAt: "2026-01-01T00:00:00Z",
    processedAt: "2026-01-01T01:00:00Z",
    closedAt: null,
    cancelledAt: null,
    email: "buyer@example.com",
    phone: "+15551234567",
    totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "USD" } },
    totalDiscountsSet: { shopMoney: { amount: "10.00" } },
    subtotalPriceSet: { shopMoney: { amount: "140.00" } },
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    discountCodes: ["SAVE10"],
    paymentGatewayNames: ["shopify_payments"],
    note: "Hello",
    sourceName: "web",
    shippingAddress: {
      address1: "1 King St",
      address2: "Suite 2",
      city: "Toronto",
      province: "Ontario",
      provinceCode: "ON",
      country: "Canada",
      countryCode: "CA",
      zip: "M5H1A1",
      firstName: "Jane",
      lastName: "Doe",
      name: "Jane Doe",
      company: null,
      phone: "+15555550100",
    },
    billingAddress: {
      address1: "2 Bay St",
      city: "Toronto",
      country: "Canada",
      countryCode: "CA",
      provinceCode: "ON",
      zip: "M5H1B2",
    },
    customAttributes: [{ key: "affiliate_order_id", value: "FYNDSHOPIFYX14126" }],
    fulfillments: [
      {
        id: "gid://shopify/Fulfillment/9",
        status: "SUCCESS",
        createdAt: "2026-01-02T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
        deliveredAt: "2026-01-04T00:00:00Z",
        displayStatus: "DELIVERED",
        estimatedDeliveryAt: null,
        inTransitAt: "2026-01-03T00:00:00Z",
        totalQuantity: 2,
        trackingInfo: [{ number: "TRK1", url: "https://track/1", company: "UPS" }],
      },
    ],
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Hat",
          variantTitle: "Red",
          sku: "SKU-1",
          quantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: "50.00" } },
          discountedUnitPriceSet: { shopMoney: { amount: "45.00" } },
          originalTotalSet: { shopMoney: { amount: "100.00" } },
          discountedTotalSet: { shopMoney: { amount: "90.00" } },
          image: { url: "https://cdn/img.jpg" },
          variant: {
            product: { id: "gid://shopify/Product/777", tags: ["t1"], productType: "Apparel" },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("fetchOrder (gid lookup via nodes())", () => {
  it("happy path: returns parsed OrderForPortal with mapped fields", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    const result = await fetchOrder(admin, "gid://shopify/Order/1234");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("gid://shopify/Order/1234");
    expect(result!.name).toBe("#1001");
    expect(result!.displayFinancialStatus).toBe("PAID");
    expect(result!.displayFulfillmentStatus).toBe("FULFILLED");
  });

  it("constructs a gid when given a numeric id", async () => {
    const { admin, graphql } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    await fetchOrder(admin, "1234");
    const call = graphql.mock.calls[0]?.[1] as { variables?: { ids?: string[] } };
    expect(call?.variables?.ids).toEqual(["gid://shopify/Order/1234"]);
  });

  it("returns null when nodes[0] is null/missing", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [null] } }]);
    expect(await fetchOrder(admin, "gid://shopify/Order/9")).toBeNull();
  });

  it("returns null when graphql throws (network error)", async () => {
    const { admin } = makeAdmin([new Error("ECONNRESET")]);
    expect(await fetchOrder(admin, "gid://shopify/Order/9")).toBeNull();
  });

  it("returns null on malformed JSON body (parse failure)", async () => {
    const graphql = vi.fn(
      async () =>
        new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const admin = { graphql } as AdminGraphQL;
    expect(await fetchOrder(admin, "1")).toBeNull();
  });

  it("maps customer info (email/phone) and currency", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    const order = await fetchOrder(admin, "1");
    expect(order!.email).toBe("buyer@example.com");
    expect(order!.phone).toBe("+15551234567");
    expect(order!.currencyCode).toBe("USD");
    expect(order!.totalPrice).toBe("150.00");
    expect(order!.subtotalPrice).toBe("140.00");
    expect(order!.totalDiscounts).toBe("10.00");
  });

  it("handles missing customer (email/phone null)", async () => {
    const node = fullOrderNode({ email: null, phone: null });
    const { admin } = makeAdmin([{ data: { nodes: [node] } }]);
    const order = await fetchOrder(admin, "1");
    expect(order!.email).toBeNull();
    expect(order!.phone).toBeNull();
  });

  it("normalizes line-item shape", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    const order = await fetchOrder(admin, "1");
    expect(order!.lineItems).toHaveLength(1);
    const li = order!.lineItems[0];
    expect(li).toMatchObject({
      id: "gid://shopify/LineItem/1",
      title: "Hat",
      variantTitle: "Red",
      sku: "SKU-1",
      quantity: 2,
      price: "50.00",
      discountedPrice: "45.00",
      originalTotal: "100.00",
      discountedTotal: "90.00",
      imageUrl: "https://cdn/img.jpg",
    });
  });

  it("normalizes fulfillments array with tracking info", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    const order = await fetchOrder(admin, "1");
    expect(order!.fulfillments).toHaveLength(1);
    const f = order!.fulfillments![0];
    expect(f.status).toBe("SUCCESS");
    expect(f.totalQuantity).toBe(2);
    expect(f.trackingInfo).toEqual([{ number: "TRK1", url: "https://track/1", company: "UPS" }]);
  });

  it("normalizes shipping/billing address fields", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [fullOrderNode()] } }]);
    const order = await fetchOrder(admin, "1");
    expect(order!.shippingAddress?.city).toBe("Toronto");
    expect(order!.shippingAddress?.countryCode).toBe("CA");
    expect(order!.shippingCountry).toBe("CA");
    expect(order!.shippingProvince).toBe("ON");
    expect(order!.billingAddress?.address1).toBe("2 Bay St");
  });

  it("maps financial status enums + defaults paymentGatewayNames to []", async () => {
    for (const status of ["PAID", "REFUNDED", "PARTIALLY_REFUNDED", "PENDING"]) {
      const node = fullOrderNode({ displayFinancialStatus: status });
      delete (node as Record<string, unknown>).paymentGatewayNames;
      const { admin } = makeAdmin([{ data: { nodes: [node] } }]);
      const order = await fetchOrder(admin, "1");
      expect(order!.displayFinancialStatus).toBe(status);
      expect(order!.paymentGatewayNames).toEqual([]);
    }
  });
});

describe("fetchOrderByGid (orderByIdentifier)", () => {
  it("happy path: returns parsed order", async () => {
    const { admin } = makeAdmin([{ data: { orderByIdentifier: fullOrderNode() } }]);
    const order = await fetchOrderByGid(admin, "gid://shopify/Order/1234");
    expect(order!.name).toBe("#1001");
    expect(order!.affiliateOrderId).toBe("FYNDSHOPIFYX14126");
  });

  it("returns null for invalid gid (no gid:// prefix)", async () => {
    const { admin, graphql } = makeAdmin([]);
    const result = await fetchOrderByGid(admin, "1234");
    expect(result).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns null when orderByIdentifier returns null (missing order)", async () => {
    const { admin } = makeAdmin([{ data: { orderByIdentifier: null } }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/missing")).toBeNull();
  });

  it("throws OrderAccessError on PCDA error", async () => {
    const { admin } = makeAdmin([
      { data: null, errors: [{ message: "App is not approved to access the Order object." }] },
    ]);
    await expect(fetchOrderByGid(admin, "gid://shopify/Order/1")).rejects.toMatchObject({
      name: "OrderAccessError",
      code: "PCDA",
    });
  });

  it("returns null on non-PCDA graphql errors", async () => {
    const { admin } = makeAdmin([{ data: null, errors: [{ message: "rate limited" }] }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });
});

describe("fetchOrderByOrderNumber", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips leading # and routes a gid value through fetchOrderByGid", async () => {
    const { admin } = makeAdmin([{ data: { orderByIdentifier: fullOrderNode() } }]);
    const order = await fetchOrderByOrderNumber(admin, "gid://shopify/Order/1234");
    expect(order!.name).toBe("#1001");
  });

  it("uses raw GraphQL fetch when raw-fetch credentials are attached (#-prefix name)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            orders: { nodes: [fullOrderNode({ name: "#X14126" })] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const baseAdmin = makeAdmin([]).admin;
    const admin = withRestCredentials(baseAdmin, "shop.myshopify.com", "token-abc");
    const order = await fetchOrderByOrderNumber(admin, "#X14126");
    expect(order!.name).toBe("#X14126");
    expect(fetchSpy).toHaveBeenCalled();
    const callUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(callUrl).toContain("graphql.json");
  });

  it("falls back to SDK GraphQL search when raw GraphQL returns no nodes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // Strategy 1 attempt 1: empty results
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 }),
      )
      // Strategy 1 attempt 2: empty results
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { orders: { nodes: [] } } }), { status: 200 }),
      )
    const { admin: baseAdmin, graphql } = makeAdmin([
      { data: { orders: { nodes: [fullOrderNode({ name: "#X14126" })] } } },
    ]);
    const admin = withRestCredentials(baseAdmin, "shop.myshopify.com", "token-abc");
    const order = await fetchOrderByOrderNumber(admin, "X14126");
    expect(order).not.toBeNull();
    expect(order!.name).toBe("#X14126");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("treats raw GraphQL 5xx responses as misses and falls through", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // raw GraphQL: 502 (treated as HTTP error -> null)
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }))
      // raw GraphQL retry: 502
      .mockResolvedValueOnce(new Response("upstream error", { status: 502 }));
    const { admin: baseAdmin } = makeAdmin([
      // SDK fallback Strategy 2: name:#X — empty
      { data: { orders: { nodes: [] } } },
      // SDK fallback Strategy 2: name:X — empty
      { data: { orders: { nodes: [] } } },
      // Strategy 3: metafield search — empty
      { data: { orders: { nodes: [] } } },
    ]);
    const admin = withRestCredentials(baseAdmin, "shop.myshopify.com", "token-abc");
    const order = await fetchOrderByOrderNumber(admin, "X9999");
    expect(order).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses SDK fallback (Strategy 2) when no raw-fetch credentials are present", async () => {
    const { admin } = makeAdmin([
      // name:#1001 search hit
      { data: { orders: { nodes: [fullOrderNode({ name: "#1001" })] } } },
    ]);
    const order = await fetchOrderByOrderNumber(admin, "1001");
    expect(order!.name).toBe("#1001");
  });

  it("uses metafield fallback for non-numeric names when other strategies fail", async () => {
    const { admin, graphql } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // name:#FYNDX
      { data: { orders: { nodes: [] } } }, // name:FYNDX
      // metafield hit
      { data: { orders: { nodes: [fullOrderNode({ name: "#5000" })] } } },
    ]);
    const order = await fetchOrderByOrderNumber(admin, "FYNDX");
    expect(order!.name).toBe("#5000");
    expect(graphql).toHaveBeenCalledTimes(3);
    const lastCallVars = graphql.mock.calls[2]?.[1] as { variables?: { query?: string } };
    expect(lastCallVars?.variables?.query).toContain("metafields.$app.fynd_order_id");
  });
});

describe("fetchOrderByFyndAffiliateId", () => {
  it("tries variants from extractShopifyOrderNumberVariants and returns first hit", async () => {
    // Variants for FYNDSHOPIFYX14126 include the full string, X14126, 14126.
    // First lookup (full) returns nothing; second (X14126) returns hit.
    const { admin } = makeAdmin([
      // attempt 1 (full) — name:#FYNDSHOPIFYX14126
      { data: { orders: { nodes: [] } } },
      // attempt 1 — name:FYNDSHOPIFYX14126
      { data: { orders: { nodes: [] } } },
      // attempt 1 — metafield
      { data: { orders: { nodes: [] } } },
      // attempt 2 (X14126) — name:#X14126 hit
      { data: { orders: { nodes: [fullOrderNode({ name: "#X14126" })] } } },
    ]);
    const order = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFYX14126");
    expect(order!.name).toBe("#X14126");
  });

  it("returns null when no variant matches anywhere", async () => {
    // All variants exhaust (3 fallback calls each — non-numeric names hit metafield path)
    // FYND_X has variants ["FYND_X", "X"] — "X" is non-numeric so 3 calls each = 6.
    const empty = { data: { orders: { nodes: [] } } };
    const { admin } = makeAdmin([empty, empty, empty, empty, empty, empty]);
    const order = await fetchOrderByFyndAffiliateId(admin, "FYND_X");
    expect(order).toBeNull();
  });
});
