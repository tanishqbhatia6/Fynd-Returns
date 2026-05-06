import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * shop.server.ts tests.
 * ────────────────────────────────────────────────────────────────────
 * Covers the two helpers in app/lib/shop.server.ts:
 *
 *   - findOrCreateShop(shopDomain): upsert with fallback to findUniqueOrThrow
 *     when the upsert race-condition path fails.
 *   - syncShopLocaleAndCurrency(admin, shopDomain): pulls primaryLocale,
 *     currencyCode, ianaTimezone via Admin GraphQL and persists ShopSettings
 *     iff the values changed (or creates settings if absent).
 *
 * We mock Prisma + the Shopify Admin GraphQL client. No real DB or HTTP.
 */

/* ── Mocks ────────────────────────────────────────────────────────── */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    shopSettings: {
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

/* ── SUT imports (must come after vi.mock) ────────────────────────── */

import { findOrCreateShop, syncShopLocaleAndCurrency } from "../shop.server";

/* ── Helpers ──────────────────────────────────────────────────────── */

function makeAdmin(payload: unknown, opts: { rejectGraphql?: Error } = {}) {
  const graphql = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => {
    if (opts.rejectGraphql) throw opts.rejectGraphql;
    return {
      json: async () => payload,
    } as unknown as Response;
  });
  return { graphql };
}

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shop.findUniqueOrThrow.mockReset();
  prismaMock.shopSettings.update.mockReset();
  prismaMock.shopSettings.create.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ── findOrCreateShop ─────────────────────────────────────────────── */

describe("findOrCreateShop", () => {
  it("returns the upserted shop with settings included", async () => {
    const shop = {
      id: "shop-1",
      shopDomain: "my-shop.myshopify.com",
      settings: { id: "s1", shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC" },
    };
    prismaMock.shop.upsert.mockResolvedValue(shop);

    const res = await findOrCreateShop("my-shop.myshopify.com");

    expect(res).toEqual(shop);
    expect(prismaMock.shop.upsert).toHaveBeenCalledWith({
      where: { shopDomain: "my-shop.myshopify.com" },
      update: {},
      create: { shopDomain: "my-shop.myshopify.com" },
      include: { settings: true },
    });
    expect(prismaMock.shop.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("returns shop with null settings when no ShopSettings row exists", async () => {
    prismaMock.shop.upsert.mockResolvedValue({
      id: "shop-1",
      shopDomain: "my-shop.myshopify.com",
      settings: null,
    });

    const res = await findOrCreateShop("my-shop.myshopify.com");
    expect(res.settings).toBeNull();
    expect(res.shopDomain).toBe("my-shop.myshopify.com");
  });

  it("falls back to findUniqueOrThrow when upsert throws (race condition)", async () => {
    const fallbackShop = {
      id: "shop-2",
      shopDomain: "race.myshopify.com",
      settings: null,
    };
    prismaMock.shop.upsert.mockRejectedValue(new Error("Unique constraint failed"));
    prismaMock.shop.findUniqueOrThrow.mockResolvedValue(fallbackShop);

    const res = await findOrCreateShop("race.myshopify.com");

    expect(res).toEqual(fallbackShop);
    expect(prismaMock.shop.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { shopDomain: "race.myshopify.com" },
      include: { settings: true },
    });
  });

  it("propagates the fallback error when findUniqueOrThrow also fails", async () => {
    prismaMock.shop.upsert.mockRejectedValue(new Error("upsert failed"));
    prismaMock.shop.findUniqueOrThrow.mockRejectedValue(new Error("not found"));

    await expect(findOrCreateShop("missing.myshopify.com")).rejects.toThrow("not found");
  });
});

/* ── syncShopLocaleAndCurrency ────────────────────────────────────── */

describe("syncShopLocaleAndCurrency", () => {
  const SHOP_DOMAIN = "my-shop.myshopify.com";

  it("updates ShopSettings when fetched values differ from stored", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "fr" },
          currencyCode: "EUR",
          ianaTimezone: "Europe/Paris",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });
    prismaMock.shopSettings.update.mockResolvedValue({});

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "fr", currency: "EUR", timezone: "Europe/Paris" });
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { shopLocale: "fr", shopCurrency: "EUR", shopTimezone: "Europe/Paris" },
    });
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
  });

  it("does not write when stored values already match", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "en" },
          currencyCode: "USD",
          ianaTimezone: "UTC",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
  });

  it("creates ShopSettings when shop exists but settings are absent", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "ja" },
          currencyCode: "JPY",
          ianaTimezone: "Asia/Tokyo",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-9",
      shopDomain: SHOP_DOMAIN,
      settings: null,
    });
    prismaMock.shopSettings.create.mockResolvedValue({});

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "ja", currency: "JPY", timezone: "Asia/Tokyo" });
    expect(prismaMock.shopSettings.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-9",
        shopLocale: "ja",
        shopCurrency: "JPY",
        shopTimezone: "Asia/Tokyo",
      },
    });
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("returns defaults and writes nothing when shop record itself is missing", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "de" },
          currencyCode: "EUR",
          ianaTimezone: "Europe/Berlin",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue(null);

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    // The function still returns the *fetched* values (locale/currency/tz),
    // it just can't persist them without a shop row.
    expect(res).toEqual({ locale: "de", currency: "EUR", timezone: "Europe/Berlin" });
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("falls back to defaults when GraphQL response has no shop data", async () => {
    const admin = makeAdmin({ data: {} });

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("uses defaults for individual missing fields in shop payload", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          // primaryLocale missing entirely → default "en"
          currencyCode: "GBP",
          // ianaTimezone missing → default "UTC"
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });
    prismaMock.shopSettings.update.mockResolvedValue({});

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "GBP", timezone: "UTC" });
    // Only currency changed, so we still write because at least one field differs.
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { shopLocale: "en", shopCurrency: "GBP", shopTimezone: "UTC" },
    });
  });

  it("treats empty primaryLocale.locale as missing and uses default", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "" },
          currencyCode: "",
          ianaTimezone: "",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("returns defaults when admin.graphql throws", async () => {
    const admin = makeAdmin(null, { rejectGraphql: new Error("network down") });

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
  });

  it("returns defaults when response.json() throws", async () => {
    const admin = {
      graphql: vi.fn(
        async () =>
          ({
            json: async () => {
              throw new Error("bad json");
            },
          }) as unknown as Response,
      ),
    };

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });

  it("returns defaults when prisma.shop.findUnique throws (and does not write)", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "es" },
          currencyCode: "EUR",
          ianaTimezone: "Europe/Madrid",
        },
      },
    });
    prismaMock.shop.findUnique.mockRejectedValue(new Error("db down"));

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
  });

  it("writes when only timezone changed", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "en" },
          currencyCode: "USD",
          ianaTimezone: "America/New_York",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });
    prismaMock.shopSettings.update.mockResolvedValue({});

    await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { shopLocale: "en", shopCurrency: "USD", shopTimezone: "America/New_York" },
    });
  });

  it("issues the expected GraphQL query for shop locale/currency/timezone", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "en" },
          currencyCode: "USD",
          ianaTimezone: "UTC",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });

    await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    expect(admin.graphql).toHaveBeenCalledOnce();
    const query = admin.graphql.mock.calls[0][0] as unknown as string;
    expect(query).toContain("primaryLocale");
    expect(query).toContain("currencyCode");
    expect(query).toContain("ianaTimezone");
  });

  it("returns defaults and swallows error when shopSettings.update rejects", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "fr" },
          currencyCode: "EUR",
          ianaTimezone: "Europe/Paris",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: SHOP_DOMAIN,
      settings: {
        id: "s1",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
      },
    });
    prismaMock.shopSettings.update.mockRejectedValue(new Error("write failed"));

    const res = await syncShopLocaleAndCurrency(admin, SHOP_DOMAIN);

    // The catch block swallows persistence failures and returns defaults.
    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });
});
