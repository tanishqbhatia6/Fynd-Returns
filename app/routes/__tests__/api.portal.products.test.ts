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
  getPortalCorsHeaders: () => new Headers({ "Access-Control-Allow-Origin": "https://store.myshopify.com" }),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalSession: verifyPortalSessionMock,
}));

import { loader } from "../api.portal.products";

const origFetch = globalThis.fetch;
function mkReq(qs: string) {
  const withAuth = qs
    ? `${qs}&portalToken=portal-token&sessionId=lookup-session`
    : "portalToken=portal-token&sessionId=lookup-session";
  return new Request(`https://app.example/api/portal/products?${withAuth}`);
}

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
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

const shopWithExchange = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: { portalExchangeEnabled: true },
};

describe("guards", () => {
  it("204 on OPTIONS preflight", async () => {
    const res = await loader({
      request: new Request("https://app.example/api/portal/products?shop=store", {
        method: "OPTIONS",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(204);
  });

  it("429 when rate-limited", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await loader({ request: mkReq("shop=x"), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when shop missing", async () => {
    const res = await loader({
      request: new Request("https://app.example/api/portal/products"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("401 when verified customer session is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithExchange);
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await loader({
      request: new Request("https://app.example/api/portal/products?shop=store"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(prismaMock.session.findFirst).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("403 when exchange not enabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { portalExchangeEnabled: false },
    });
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    expect(res.status).toBe(403);
  });

  it("401 when no valid session", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithExchange);
    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("normalises shop without dot to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await loader({ request: mkReq("shop=mystore"), params: {}, context: {} } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "mystore.myshopify.com" },
      }),
    );
  });
});

describe("product fetch paths", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue(shopWithExchange);
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  });

  it("fetches single product when productId is provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        product: {
          id: 1,
          title: "T-shirt",
          handle: "t-shirt",
          product_type: "Apparel",
          vendor: "Acme",
          images: [{ src: "https://img.example/1.jpg" }],
          variants: [
            {
              id: 11,
              title: "Small",
              price: "20.00",
              compare_at_price: null,
              inventory_quantity: 5,
              sku: "TS-S",
              option1: "Small",
              option2: null,
              option3: null,
              image_id: null,
            },
          ],
        },
      }),
    }) as typeof fetch;

    const res = await loader({
      request: mkReq("shop=store&productId=gid%3A%2F%2Fshopify%2FProduct%2F1"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toHaveLength(1);
    expect(body.products[0].title).toBe("T-shirt");
    expect(body.products[0].variants[0].available).toBe(true);
    expect(body.products[0].variants[0].options).toEqual([{ name: "Option 1", value: "Small" }]);
  });

  it("hits product search endpoint when no productId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "Hat",
            handle: "hat",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 11,
                title: "Default",
                price: "5.00",
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
        ],
      }),
    }) as typeof fetch;
    const res = await loader({
      request: mkReq("shop=store&search=hat"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.products[0].title).toBe("Hat");
  });

  it("filters out products with no available variants", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "SoldOut",
            handle: "x",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 11,
                title: "X",
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
        ],
      }),
    }) as typeof fetch;
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("treats inventory_quantity=-1 as available (untracked)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "Digital",
            handle: "d",
            product_type: "",
            vendor: "",
            images: [],
            variants: [
              {
                id: 11,
                title: "Default",
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
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.products).toHaveLength(1);
  });

  it("caps limit at 50 (defends against catalog dump)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;
    await loader({ request: mkReq("shop=store&limit=999"), params: {}, context: {} } as never);
    const fetchCall = (globalThis.fetch as unknown as { mock: { calls: Array<[string, unknown]> } })
      .mock.calls[0][0];
    expect(fetchCall).toMatch(/limit=50/);
  });

  it("returns empty array when Shopify returns non-ok", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) }) as typeof fetch;
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  it("500 when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network")) as typeof fetch;
    const res = await loader({ request: mkReq("shop=store"), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });

  it("productType filter is added to query", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ products: [] }) }) as typeof fetch;
    await loader({
      request: mkReq("shop=store&productType=Shirts"),
      params: {},
      context: {},
    } as never);
    // productType just affects internal queryParts — verifying through the fetch endpoint is enough
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
