/**
 * CORS headers for portal API.
 * Portal runs on store domain (e.g. store.myshopify.com) and fetches from app domain.
 */

const ALLOWED_ORIGIN_PATTERNS = [
  /\.myshopify\.com$/,
  /\.shopify\.com$/,
];

const DEV_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  const isDev = process.env.NODE_ENV !== "production";
  try {
    const { hostname } = new URL(origin);
    if (ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(hostname))) return true;
    if (isDev && DEV_PATTERNS.some((p) => p.test(origin))) return true;
  } catch {
    // malformed origin
  }
  return false;
}

export function getPortalCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") || "";
  if (isAllowedOrigin(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
