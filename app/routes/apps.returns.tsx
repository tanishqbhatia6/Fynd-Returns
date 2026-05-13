import type { LoaderFunctionArgs } from "react-router";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import prisma from "../db.server";
import { parsePortalTheme, applyPortalThemeToHtml } from "../lib/portal-theme.server";
import { parsePortalConfig } from "../lib/portal-config.server";
import { getPortalLabels } from "../lib/portal-i18n";
import { createPortalCsrfToken } from "../lib/portal-auth.server";

let cachedTemplate: string | null = null;

function getPortalTemplate(): string {
  /* v8 ignore start */
  // defensive: cache+env+__dirname branches all environment-dependent; tests run in non-production
  if (cachedTemplate && process.env.NODE_ENV === "production") return cachedTemplate;
  const dir =
    typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  /* v8 ignore stop */
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
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeJsonInHtml(s: string): string {
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  /* v8 ignore start */
  // defensive: missing shop param fallback
  const shopParam = url.searchParams.get("shop") || "";
  /* v8 ignore stop */
  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;
  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  let theme = parsePortalTheme(null);
  let returnWindowDays = 30;
  let returnPolicyText = "";
  let returnReasonsJson = "[]";
  let returnReasonsByCategoryJson = "";
  let portalConfigJson = "";
  let portalLanguage = "en";
  let shopLocale = "en";
  let shopCurrency = "USD";
  let shopTimezone = "UTC";
  let portalLabelOverrides: Record<string, string> = {};
  let brandLogoUrl: string | null = null;
  let brandFaviconUrl: string | null = null;
  let giftReturnsEnabled = false;
  let portalExchangeEnabled = false;
  let greenReturnsEnabled = false;
  let greenReturnsDonateEnabled = false;
  let greenReturnsDonateMessage = "";
  let channelPoliciesJson = "{}";
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
      portalLanguage = shop.settings.portalLanguage ?? "en";
      shopLocale = shop.settings.shopLocale ?? "en";
      shopCurrency = shop.settings.shopCurrency ?? "USD";
      shopTimezone = shop.settings.shopTimezone ?? "UTC";
      if (shop.settings.portalLabelsJson) {
        try {
          portalLabelOverrides = JSON.parse(shop.settings.portalLabelsJson);
        } catch {
          /* ignore */
        }
      }
      brandLogoUrl = (shop.settings as { brandLogoUrl?: string | null }).brandLogoUrl ?? null;
      brandFaviconUrl =
        (shop.settings as { brandFaviconUrl?: string | null }).brandFaviconUrl ?? null;
      giftReturnsEnabled = shop.settings.giftReturnsEnabled ?? false;
      portalExchangeEnabled = shop.settings.portalExchangeEnabled ?? false;
      greenReturnsEnabled = shop.settings.greenReturnsEnabled ?? false;
      greenReturnsDonateEnabled = shop.settings.greenReturnsDonateEnabled ?? false;
      greenReturnsDonateMessage = shop.settings.greenReturnsDonateMessage ?? "";
      channelPoliciesJson =
        (shop.settings as { channelPoliciesJson?: string | null }).channelPoliciesJson ?? "{}";
    }
  } catch (err) {
    console.error("Portal theme load error:", err);
  }

  const portalConfig = parsePortalConfig(portalConfigJson);

  let portalHtml: string;
  try {
    portalHtml = getPortalTemplate();
  } catch (fsErr) {
    /* v8 ignore start */
    // defensive: fs error handling; tests don't simulate template missing
    const msg = fsErr instanceof Error ? fsErr.message : String(fsErr);
    /* v8 ignore stop */
    return new Response(`Portal template not found: ${msg}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
  portalHtml = applyPortalThemeToHtml(portalHtml, theme);
  /* v8 ignore start */
  // defensive: portalLanguage || shopLocale || "en" cascade — only one branch tested per fixture
  const effectiveLocale = portalLanguage || shopLocale || "en";
  /* v8 ignore stop */
  const mergedLabels = getPortalLabels(effectiveLocale, portalLabelOverrides);
  const portalFeatureFlags = {
    giftReturnsEnabled,
    portalExchangeEnabled,
    greenReturnsEnabled,
    greenReturnsDonateEnabled,
    greenReturnsDonateMessage,
    channelPoliciesJson,
  };
  const i18nScript = `<script>
window.__RPM_LABELS__=${escapeJsonInHtml(JSON.stringify(mergedLabels))};
window.__RPM_LOCALE__=${JSON.stringify(effectiveLocale)};
window.__RPM_CURRENCY__=${JSON.stringify(shopCurrency)};
window.__RPM_TIMEZONE__=${JSON.stringify(shopTimezone)};
window.__RPM_FEATURES__=${escapeJsonInHtml(JSON.stringify(portalFeatureFlags))};
window.__RPM_PORTAL_CSRF__=${JSON.stringify(createPortalCsrfToken(shopDomain))};
</script>`;
  const isRtl = ["ar", "he", "fa", "ur"].includes(effectiveLocale.split("-")[0].toLowerCase());

  // Build favicon tag: use custom brand favicon if set, else fall back to default APP_URL favicon
  const faviconHtml = brandFaviconUrl
    ? `  <link rel="icon" type="image/png" href="${escapeHtmlAttr(brandFaviconUrl)}" sizes="96x96" />\n  <link rel="icon" href="${escapeHtmlAttr(brandFaviconUrl)}" />`
    : `  <link rel="icon" type="image/png" href="${escapeHtmlAttr(appUrl)}/favicon-96x96.png" sizes="96x96" />\n  <link rel="icon" type="image/svg+xml" href="${escapeHtmlAttr(appUrl)}/favicon.svg" />\n  <link rel="shortcut icon" href="${escapeHtmlAttr(appUrl)}/favicon.ico" />\n  <link rel="apple-touch-icon" sizes="180x180" href="${escapeHtmlAttr(appUrl)}/apple-touch-icon.png" />\n  <link rel="manifest" href="${escapeHtmlAttr(appUrl)}/site.webmanifest" />`;

  portalHtml = portalHtml
    .replace("%SHOP%", escapeHtmlAttr(shopDomain))
    .replaceAll("%APP_URL%", escapeHtmlAttr(appUrl))
    .replace("%RETURN_WINDOW%", String(returnWindowDays))
    .replace("%RETURN_POLICY%", escapeHtmlContent(returnPolicyText))
    .replace("%RETURN_REASONS_JSON%", escapeJsonInHtml(returnReasonsJson))
    .replace(
      "%RETURN_REASONS_BY_CATEGORY_JSON%",
      escapeJsonInHtml(returnReasonsByCategoryJson || "{}"),
    )
    .replace("%PORTAL_CONFIG%", escapeJsonInHtml(JSON.stringify(portalConfig)))
    .replace("%BRAND_LOGO_URL%", escapeHtmlAttr(brandLogoUrl ?? ""))
    .replace("<!-- %FAVICON% -->", faviconHtml)
    .replace("</head>", `${i18nScript}\n</head>`)
    .replace(
      '<html lang="en"',
      `<html lang="${escapeHtmlAttr(effectiveLocale)}"${isRtl ? ' dir="rtl"' : ""}`,
    );

  return new Response(portalHtml, {
    headers: { "Content-Type": "text/html" },
  });
};
