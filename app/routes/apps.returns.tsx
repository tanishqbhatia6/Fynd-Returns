import type { LoaderFunctionArgs } from "react-router";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import prisma from "../db.server";
import {
  parsePortalTheme,
  applyPortalThemeToHtml,
} from "../lib/portal-theme.server";
import { parsePortalConfig } from "../lib/portal-config.server";

let cachedTemplate: string | null = null;

function getPortalTemplate(): string {
  if (cachedTemplate && process.env.NODE_ENV === "production") return cachedTemplate;
  const dir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const paths = [
    join(dir, "..", "portal", "index.html"),
    join(process.cwd(), "app", "portal", "index.html"),
  ];
  for (const p of paths) {
    try {
      cachedTemplate = readFileSync(p, "utf-8");
      return cachedTemplate;
    } catch {
      continue;
    }
  }
  throw new Error("Portal template not found");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJsonInHtml(s: string): string {
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

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
    portalHtml = getPortalTemplate();
  } catch (fsErr) {
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    return new Response(`Portal template not found: ${msg}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  portalHtml = applyPortalThemeToHtml(portalHtml, theme);
  portalHtml = portalHtml
    .replace("%SHOP%", escapeHtmlAttr(shopDomain))
    .replace("%APP_URL%", escapeHtmlAttr(appUrl))
    .replace("%RETURN_WINDOW%", String(returnWindowDays))
    .replace("%RETURN_POLICY%", escapeHtmlContent(returnPolicyText))
    .replace("%RETURN_REASONS_JSON%", escapeJsonInHtml(returnReasonsJson))
    .replace("%RETURN_REASONS_BY_CATEGORY_JSON%", escapeJsonInHtml(returnReasonsByCategoryJson || "{}"))
    .replace("%PORTAL_CONFIG%", escapeJsonInHtml(JSON.stringify(portalConfig)));

  return new Response(portalHtml, {
    headers: { "Content-Type": "text/html" },
  });
};
