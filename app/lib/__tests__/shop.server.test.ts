import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    shopSettings: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

import { findOrCreateShop, syncShopLocaleAndCurrency } from "../shop.server";

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shop.findUniqueOrThrow.mockReset();
  prismaMock.shopSettings.update.mockReset().mockResolvedValue({});
  prismaMock.shopSettings.create.mockReset().mockResolvedValue({});
});

describe("findOrCreateShop", () => {
  it("returns shop from upsert on the happy path", async () => {
    const shop = { id: "shop-1", shopDomain: "x.myshopify.com", settings: null };
    prismaMock.shop.upsert.mockResolvedValue(shop);
    expect(await findOrCreateShop("x.myshopify.com")).toEqual(shop);
    expect(prismaMock.shop.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopDomain: "x.myshopify.com" },
      include: { settings: true },
    }));
  });

  it("falls back to findUniqueOrThrow when upsert races (race condition recovery)", async () => {
    prismaMock.shop.upsert.mockRejectedValue(new Error("unique constraint"));
    const shop = { id: "shop-2", shopDomain: "y.myshopify.com", settings: null };
    prismaMock.shop.findUniqueOrThrow.mockResolvedValue(shop);
    expect(await findOrCreateShop("y.myshopify.com")).toEqual(shop);
  });
});

describe("syncShopLocaleAndCurrency", () => {
  function makeAdmin(response: object | null = null) {
    return {
      graphql: vi.fn().mockImplementation(async () => ({
        json: async () => response ?? {},
      })),
    } as const;
  }

  it("returns defaults when Shopify returns no shop data", async () => {
    const admin = makeAdmin({ data: {} });
    const res = await syncShopLocaleAndCurrency(admin, "x.myshopify.com");
    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });

  it("returns defaults on GraphQL exception", async () => {
    const admin = {
      graphql: vi.fn().mockRejectedValue(new Error("network")),
    };
    const res = await syncShopLocaleAndCurrency(admin as Parameters<typeof syncShopLocaleAndCurrency>[0], "x.myshopify.com");
    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });

  it("parses Shopify response + writes to existing settings when values changed", async () => {
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
      id: "shop-1",
      settings: { id: "s1", shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC" },
    });
    const res = await syncShopLocaleAndCurrency(admin, "x.myshopify.com");
    expect(res).toEqual({ locale: "ja", currency: "JPY", timezone: "Asia/Tokyo" });
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { shopLocale: "ja", shopCurrency: "JPY", shopTimezone: "Asia/Tokyo" },
    });
  });

  it("skips write when values unchanged (idempotent)", async () => {
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
      settings: { id: "s1", shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC" },
    });
    await syncShopLocaleAndCurrency(admin, "x.myshopify.com");
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("creates settings when shop exists but has no settings", async () => {
    const admin = makeAdmin({
      data: {
        shop: {
          primaryLocale: { locale: "fr" },
          currencyCode: "EUR",
          ianaTimezone: "Europe/Paris",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-2", settings: null });
    await syncShopLocaleAndCurrency(admin, "y.myshopify.com");
    expect(prismaMock.shopSettings.create).toHaveBeenCalledWith({
      data: {
        shopId: "shop-2",
        shopLocale: "fr",
        shopCurrency: "EUR",
        shopTimezone: "Europe/Paris",
      },
    });
  });

  it("falls back to defaults for each missing field", async () => {
    const admin = makeAdmin({ data: { shop: { primaryLocale: null, currencyCode: null, ianaTimezone: null } } });
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", settings: null });
    const res = await syncShopLocaleAndCurrency(admin, "x.myshopify.com");
    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });

  it("returns parsed values even when shop record doesn't exist in our DB", async () => {
    const admin = makeAdmin({
      data: { shop: { primaryLocale: { locale: "de" }, currencyCode: "EUR", ianaTimezone: "Europe/Berlin" } },
    });
    prismaMock.shop.findUnique.mockResolvedValue(null);
    const res = await syncShopLocaleAndCurrency(admin, "missing.myshopify.com");
    expect(res).toEqual({ locale: "de", currency: "EUR", timezone: "Europe/Berlin" });
    expect(prismaMock.shopSettings.create).not.toHaveBeenCalled();
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });
});
