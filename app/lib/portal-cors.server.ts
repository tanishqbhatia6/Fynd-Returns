/**
 * CORS headers for portal API.
 * Portal runs on store domain (e.g. store.myshopify.com) and fetches from app domain.
 */

const DEV_PATTERNS = [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];

function normalizeShopDomain(shop: string | null): string | null {
  const raw = (shop ?? "").trim().toLowerCase();
  if (!raw) return null;
  const hostname = raw
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .trim();
  if (!/^[a-z0-9][a-z0-9-]*(?:\.myshopify\.com)?$/i.test(hostname)) return null;
  return hostname.includes(".") ? hostname : `${hostname}.myshopify.com`;
}

function configuredPortalOrigins(): Set<string> {
  return new Set(
    (process.env.PORTAL_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function isAllowedOrigin(origin: string, request: Request): boolean {
  if (!origin) return false;
  const isDev = process.env.NODE_ENV !== "production";
  try {
    const parsedOrigin = new URL(origin);
    const originValue = parsedOrigin.origin;
    if (configuredPortalOrigins().has(originValue)) return true;
    const requestUrl = new URL(request.url);
    const shopDomain = normalizeShopDomain(requestUrl.searchParams.get("shop"));
    if (shopDomain && originValue === `https://${shopDomain}`) return true;
    if (isDev && DEV_PATTERNS.some((p) => p.test(origin))) return true;
  } catch {
    // malformed origin
  }
  return false;
}

export function getPortalCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") || "";
  if (isAllowedOrigin(origin, request)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Portal-Token");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

export function withCors(response: Response, request: Request): Response {
  const cors = getPortalCorsHeaders(request);
  const headers = new Headers(response.headers);
  cors.forEach((v, k) => headers.set(k, v));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
