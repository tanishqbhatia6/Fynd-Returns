/**
 * App Proxy route - Customer returns portal
 * Accessed at: https://store.myshopify.com/apps/returns
 */
import type { LoaderFunctionArgs } from "react-router";
import { readFileSync } from "fs";
import { join } from "path";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  const portalHtml = readFileSync(
    join(process.cwd(), "app", "portal", "index.html"),
    "utf-8"
  )
    .replace("%SHOP%", shop)
    .replace("%APP_URL%", appUrl);

  return new Response(portalHtml, {
    headers: { "Content-Type": "text/html" },
  });
};
