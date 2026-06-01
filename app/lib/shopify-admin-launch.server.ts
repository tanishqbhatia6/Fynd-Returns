const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const SHOP_HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/i;

export function normalizeShop(shop: string | null): string | null {
  if (!shop) return null;
  const withoutProtocol = shop.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return MYSHOPIFY_RE.test(withoutProtocol) ? withoutProtocol : null;
}

export function inferShopFromShopifyAdmin(request: Request): string | null {
  const referer = request.headers.get("referer") || request.headers.get("referrer");
  if (!referer) return null;

  try {
    const url = new URL(referer);
    if (MYSHOPIFY_RE.test(url.hostname)) {
      return url.hostname;
    }

    if (url.hostname !== "admin.shopify.com") return null;
    const storeHandle = url.pathname.match(/\/store\/([^/?#]+)/i)?.[1];
    if (!storeHandle || !SHOP_HANDLE_RE.test(storeHandle)) return null;
    return `${storeHandle}.myshopify.com`;
  } catch {
    return null;
  }
}

export function buildAdminHostParam(shop: string): string {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return Buffer.from(`admin.shopify.com/store/${storeHandle}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function getEmbeddedAdminLaunchParams(
  request: Request,
  searchParams: URLSearchParams,
): URLSearchParams | null {
  const shop = normalizeShop(searchParams.get("shop")) ?? inferShopFromShopifyAdmin(request);
  if (!shop) return null;

  const hasSignedQuery = searchParams.has("hmac") || searchParams.has("signature");
  const params = new URLSearchParams(searchParams);
  params.set("shop", shop);
  if (!params.get("host") && !hasSignedQuery) {
    params.set("host", buildAdminHostParam(shop));
  }
  if (!params.get("embedded") && !hasSignedQuery) {
    params.set("embedded", "1");
  }
  return params;
}
