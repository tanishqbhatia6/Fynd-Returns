/**
 * App Proxy route - Customer returns portal
 * Accessed at: https://store.myshopify.com/apps/returns
 * Shopify App Proxy adds ?shop=store.myshopify.com to the request
 */
import type { LoaderFunctionArgs } from "react-router";
import { readFileSync } from "fs";
import { join } from "path";
import prisma from "../db.server";
import {
  parsePortalTheme,
  applyPortalThemeToHtml,
} from "../lib/portal-theme.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop") || "";
  const shopDomain = shopParam.includes(".")
    ? shopParam
    : `${shopParam}.myshopify.com`;
  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  let theme = parsePortalTheme(null);
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (shop?.settings?.portalThemeJson) {
      theme = parsePortalTheme(shop.settings.portalThemeJson);
    }
  } catch (err) {
    console.error("Portal theme load error:", err);
  }

  let portalHtml = readFileSync(
    join(process.cwd(), "app", "portal", "index.html"),
    "utf-8"
  );
  portalHtml = applyPortalThemeToHtml(portalHtml, theme);
  portalHtml = portalHtml.replace("%SHOP%", shopDomain).replace("%APP_URL%", appUrl);

  return new Response(portalHtml, {
    headers: { "Content-Type": "text/html" },
  });
};
