/**
 * Coverage-focused tests for app/routes/api.portal.products.ts
 *
 * Complements api.portal.products.test.ts by drilling into:
 *   - Specific product fetch by id (gid normalisation, image fallback,
 *     compare_at_price, multi-option mapping).
 *   - Search by query + product_type filter (URL composition).
 *   - Fetch timeout (AbortController-driven 500 path).
 *   - Available variant filtering edge cases (mixed availability,
 *     mid-list out-of-stock products dropped).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, checkRateLimitMock, verifyPortalSessionMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  verifyPortalSessionMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalSession: verifyPortalSessionMock,
}));

import { loader } from "../api.portal.products";

const origFetch = globalThis.fetch;
function mkReq(qs: string) {
  return new Request(
    `https://app.example/api/portal/products?${qs}&portalToken=portal-token&sessionId=lookup-session`,
  );
}

const shopWithExchange = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: { portalExchangeEnabled: true },
};

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  verifyPortalSessionMock.mockReset().mockResolvedValue({
    id: "lookup-session",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "customer@example.com",
    matchedReturnIds: null,
  });
  prismaMock.shop.findUnique.mockResolvedValue(shopWithExchange);
  prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

function fetchCallUrl(idx = 0): string {
  const calls = (globalThis.fetch as unknown as { mock: { calls: Array<[string, unknown]> } }).mock
    .calls;
  return calls[idx][0];
}

function fetchCallBody(idx = 0): { query?: string; variables?: Record<string, unknown> } {
  const calls = (
    globalThis.fetch as unknown as { mock: { calls: Array<[string, { body?: string }]> } }
  ).mock.calls;
  return JSON.parse(calls[idx][1]?.body || "{}") as {
    query?: string;
    variables?: Record<string, unknown>;
  };
}

describe("specific product fetch by id", () => {
  it("sends product GID through Shopify Admin GraphQL", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          id: 9876,
          title: "P",
          handle: "p",
          product_type: "",
          vendor: "",
          images: [],
          variants: [
            {
              id: 1,
              title: "v",
              price: "1.00",
              compare_at_price: null,
              inventory_quantity: 1,
              sku: null,
              option1: null,
              option2: null,
              option3: null,
              image_id: null,
            },
          ],
        },
      }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store&productId=gid%3A%2F%2Fshopify%2FProduct%2F9876"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables?.id).toBe("gid://shopify/Product/9876");
  });

  it("normalizes bare numeric productId to a GID", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ product: null }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store&productId=42"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables?.id).toBe("gid://shopify/Product/42");
  });

  it("returns empty products[] when single-product response has no product field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store&productId=42"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("maps compare_at_price + multiple option columns on a single product fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          id: 5,
          title: "Boot",
          handle: "boot",
          product_type: "Footwear",
          vendor: "Acme",
          images: [{ src: "https://img/a.jpg" }, { src: "https://img/b.jpg" }],
          variants: [
            {
              id: 51,
              title: "Black / 10 / Wide",
              price: "120.00",
              compare_at_price: "150.00",
              inventory_quantity: 3,
              sku: "BT-B-10-W",
              option1: "Black",
              option2: "10",
              option3: "Wide",
              image_id: 999,
            },
          ],
        },
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store&productId=5"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products[0].imageUrl).toBe("https://img/a.jpg");
    expect(body.products[0].variants[0]).toMatchObject({
      id: "51",
      compareAtPrice: "150.00",
      sku: "BT-B-10-W",
      // image_id is intentionally ignored — mapper falls back to product main image
      imageUrl: "https://img/a.jpg",
      options: [
        { name: "Option 1", value: "Black" },
        { name: "Option 2", value: "10" },
        { name: "Option 3", value: "Wide" },
      ],
    });
  });

  it("imageUrl is null when Shopify returns no images array", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          id: 7,
          title: "NoImg",
          handle: "n",
          product_type: "",
          vendor: "",
          variants: [
            {
              id: 71,
              title: "v",
              price: "1.00",
              compare_at_price: null,
              inventory_quantity: 1,
              sku: null,
              option1: null,
              option2: null,
              option3: null,
              image_id: null,
            },
          ],
        },
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store&productId=7"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products[0].imageUrl).toBeNull();
    expect(body.products[0].variants[0].imageUrl).toBeNull();
  });
});

describe("search by query + product_type filter", () => {
  it("sends title search through GraphQL variables when search is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store&search=red%20shirt"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables?.query).toBe('title:"red shirt"');
  });

  it("sends product type search through GraphQL variables when productType is provided alone", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store&productType=Shirts"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables?.query).toBe('product_type:"Shirts"');
  });

  it("uses products GraphQL query without a search query when neither search nor productType given", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables).toMatchObject({ first: 20, query: null });
  });

  it("respects custom limit below the 50 cap", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store&limit=12"),
      params: {},
      context: {},
    } as never);

    expect(fetchCallUrl()).toContain("/graphql.json");
    expect(fetchCallBody().variables?.first).toBe(12);
  });

  it("sends X-Shopify-Access-Token header from the persisted session", async () => {
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "secret-token-abc" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);

    const calls = (
      globalThis.fetch as unknown as {
        mock: { calls: Array<[string, { headers: Record<string, string> }]> };
      }
    ).mock.calls;
    expect(calls[0][1].headers["X-Shopify-Access-Token"]).toBe("secret-token-abc");
  });
});

describe("fetch timeout", () => {
  it("aborts upstream call and returns 500 when the AbortController fires", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (signal) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const promise = loader({
        request: mkReq("shop=store"),
        params: {},
        context: {},
      } as never);
      // Trip the SHOPIFY_FETCH_TIMEOUT_MS (10s) timer.
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await promise;
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Failed to fetch products");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AbortSignal in the fetch init", async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return Promise.resolve({ ok: true, json: async () => ({ products: [] }) });
    }) as typeof fetch;

    await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // After a successful round-trip the timer was cleared, so signal stays unaborted.
    expect(capturedSignal?.aborted).toBe(false);
  });
});

describe("available variant filtering", () => {
  it("keeps only the available variants on a product with mixed inventory", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "Mixed",
            handle: "m",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 11,
                title: "InStock",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: 5,
                sku: null,
                option1: "S",
                option2: null,
                option3: null,
                image_id: null,
              },
              {
                id: 12,
                title: "SoldOut",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: 0,
                sku: null,
                option1: "M",
                option2: null,
                option3: null,
                image_id: null,
              },
              {
                id: 13,
                title: "Untracked",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: -1,
                sku: null,
                option1: "L",
                option2: null,
                option3: null,
                image_id: null,
              },
            ],
          },
        ],
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products).toHaveLength(1);
    const ids = body.products[0].variants.map((v: { id: string }) => v.id);
    expect(ids).toEqual(["11", "13"]);
  });

  it("drops a fully-out-of-stock product even when neighbours have stock", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "Live",
            handle: "l",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 11,
                title: "v",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: 2,
                sku: null,
                option1: null,
                option2: null,
                option3: null,
                image_id: null,
              },
            ],
          },
          {
            id: 2,
            title: "Dead",
            handle: "d",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 21,
                title: "v",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: 0,
                sku: null,
                option1: null,
                option2: null,
                option3: null,
                image_id: null,
              },
            ],
          },
          {
            id: 3,
            title: "AlsoLive",
            handle: "al",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 31,
                title: "v",
                price: "1.00",
                compare_at_price: null,
                inventory_quantity: -1,
                sku: null,
                option1: null,
                option2: null,
                option3: null,
                image_id: null,
              },
            ],
          },
        ],
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    const titles = body.products.map((p: { title: string }) => p.title);
    expect(titles).toEqual(["Live", "AlsoLive"]);
  });

  it("filters a single-product (productId) response that has no available variants", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          id: 9,
          title: "OOS",
          handle: "oos",
          product_type: "",
          vendor: "",
          images: [],
          variants: [
            {
              id: 91,
              title: "v",
              price: "1.00",
              compare_at_price: null,
              inventory_quantity: 0,
              sku: null,
              option1: null,
              option2: null,
              option3: null,
              image_id: null,
            },
          ],
        },
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store&productId=9"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("treats a product with an empty variants array as filtered out", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "NoVariants",
            handle: "nv",
            product_type: "",
            vendor: "",
            images: [],
            variants: [],
          },
        ],
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });
});
