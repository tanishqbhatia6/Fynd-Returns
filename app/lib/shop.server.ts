import prisma from "../db.server";
import type { Shop, ShopSettings } from "@prisma/client";
import { appLogger } from "./observability/logger.server";

type ShopWithSettings = Shop & { settings: ShopSettings | null };

/**
 * Find or create a Shop record with settings.
 * Consolidates the repeated pattern used across all settings routes.
 */
export async function findOrCreateShop(shopDomain: string): Promise<ShopWithSettings> {
  try {
    return await prisma.shop.upsert({
      where: { shopDomain },
      update: {},
      create: { shopDomain },
      include: { settings: true },
    });
  } catch {
    return await prisma.shop.findUniqueOrThrow({
      where: { shopDomain },
      include: { settings: true },
    });
  }
}

type AdminGraphQL = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const SHOP_LOCALE_QUERY = `{
  shop {
    primaryLocale { locale }
    currencyCode
    ianaTimezone
  }
}`;

/**
 * Fetch shop locale, currency, and timezone from Shopify and persist to ShopSettings.
 * Safe to call on every admin load — only writes if values changed.
 */
export async function syncShopLocaleAndCurrency(
  admin: AdminGraphQL,
  shopDomain: string,
): Promise<{ locale: string; currency: string; timezone: string }> {
  const defaults = { locale: "en", currency: "USD", timezone: "UTC" };
  try {
    const res = await admin.graphql(SHOP_LOCALE_QUERY);
    const json = (await res.json()) as {
      data?: {
        shop?: {
          primaryLocale?: { locale?: string };
          currencyCode?: string;
          ianaTimezone?: string;
        };
      };
    };
    const shopData = json.data?.shop;
    if (!shopData) return defaults;

    const locale = shopData.primaryLocale?.locale || defaults.locale;
    const currency = shopData.currencyCode || defaults.currency;
    const timezone = shopData.ianaTimezone || defaults.timezone;

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (shop?.settings) {
      const s = shop.settings;
      if (s.shopLocale !== locale || s.shopCurrency !== currency || s.shopTimezone !== timezone) {
        await prisma.shopSettings.update({
          where: { id: s.id },
          data: { shopLocale: locale, shopCurrency: currency, shopTimezone: timezone },
        });
      }
    } else if (shop) {
      await prisma.shopSettings.create({
        data: {
          shopId: shop.id,
          shopLocale: locale,
          shopCurrency: currency,
          shopTimezone: timezone,
        },
      });
    }
    return { locale, currency, timezone };
  } catch (err) {
    appLogger.error({ err, shopDomain }, "Failed to sync Shopify shop locale and currency");
    return defaults;
  }
}
