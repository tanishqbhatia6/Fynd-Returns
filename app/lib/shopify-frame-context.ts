export const SHOPIFY_FRAME_CONTEXT_STORAGE_KEY = "returnpromax.shopifyFrameContext.v1";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const HOST_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const OPTIONAL_CONTEXT_PARAMS = ["embedded", "locale"] as const;

function isValidShop(shop: string | null): shop is string {
  return Boolean(shop && SHOP_RE.test(shop));
}

function isValidHost(host: string | null): host is string {
  return Boolean(host && HOST_RE.test(host));
}

export function getShopifyFrameContextSearch(search: string): string | null {
  const source = new URLSearchParams(search);
  const shop = source.get("shop");
  const host = source.get("host");
  if (!isValidShop(shop) || !isValidHost(host)) return null;

  const context = new URLSearchParams();
  context.set("shop", shop);
  context.set("host", host);

  for (const key of OPTIONAL_CONTEXT_PARAMS) {
    const value = source.get(key);
    if (value) context.set(key, value);
  }

  if (!context.has("embedded")) {
    context.set("embedded", "1");
  }

  return context.toString();
}

export function addShopifyFrameContext(to: string, contextSearch: string | null): string {
  if (!contextSearch) return to;

  const url = new URL(to, "https://returnpromax.local");
  if (!isAdminAppPath(url.pathname)) return to;

  const context = new URLSearchParams(contextSearch);
  context.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  return `${url.pathname}${url.search}${url.hash}`;
}

export function readShopifyFrameContext(storage: Pick<Storage, "getItem">): string | null {
  try {
    return getShopifyFrameContextSearch(storage.getItem(SHOPIFY_FRAME_CONTEXT_STORAGE_KEY) ?? "");
  } catch {
    return null;
  }
}

export function writeShopifyFrameContext(
  storage: Pick<Storage, "setItem">,
  contextSearch: string,
): void {
  try {
    storage.setItem(SHOPIFY_FRAME_CONTEXT_STORAGE_KEY, contextSearch);
  } catch {
    // Storage can be blocked in strict browser privacy modes. Losing this cache
    // only disables same-tab recovery; Shopify's normal OAuth flow still works.
  }
}

export function getSafeAppPathFromReferrer(referrer: string, currentOrigin: string): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.origin !== currentOrigin || !isAdminAppPath(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function isAdminAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}
