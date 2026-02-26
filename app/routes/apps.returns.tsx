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
import { parsePortalConfig } from "../lib/portal-config.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop") || "";
  const shopDomain = shopParam.includes(".")
    ? shopParam
    : `${shopParam}.myshopify.com`;
  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  let theme = parsePortalTheme(null);
  let returnWindowDays = 30;
  let returnPolicyText = "";
  let returnReasonsJson = "[]";
  let returnReasonsByCategoryJson = "";
  let portalConfigJson = "";
  try {
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (shop?.settings) {
      if (shop.settings.portalThemeJson) {
        theme = parsePortalTheme(shop.settings.portalThemeJson);
      }
      returnWindowDays = shop.settings.returnWindowDays ?? 30;
      returnPolicyText = shop.settings.returnPolicyText ?? "";
      returnReasonsJson = shop.settings.returnReasonsJson ?? "[]";
      returnReasonsByCategoryJson = shop.settings.returnReasonsByCategoryJson ?? "";
      portalConfigJson = shop.settings.portalConfigJson ?? "";
    }
  } catch (err) {
    console.error("Portal theme load error:", err);
  }

  const portalConfig = parsePortalConfig(portalConfigJson);

  let portalHtml: string;
  try {
    portalHtml = readFileSync(
      join(process.cwd(), "app", "portal", "index.html"),
      "utf-8"
    );
  } catch (fsErr) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    return new Response(`Portal template not found: ${msg}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  portalHtml = applyPortalThemeToHtml(portalHtml, theme);
  portalHtml = portalHtml
    .replace("%SHOP%", shopDomain)
    .replace("%APP_URL%", appUrl)
    .replace("%RETURN_WINDOW%", String(returnWindowDays))
    .replace("%RETURN_POLICY%", returnPolicyText.replace(/</g, "&lt;").replace(/>/g, "&gt;"))
    .replace("%RETURN_REASONS_JSON%", returnReasonsJson)
    .replace("%RETURN_REASONS_BY_CATEGORY_JSON%", (returnReasonsByCategoryJson || "{}").replace(/</g, "\\u003c").replace(/>/g, "\\u003e"))
    .replace("%PORTAL_CONFIG%", JSON.stringify(portalConfig));

  return new Response(portalHtml, {
    headers: { "Content-Type": "text/html" },
  });
};
