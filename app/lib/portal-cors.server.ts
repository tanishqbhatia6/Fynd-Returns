/**
 * CORS headers for portal API.
 * Portal runs on store domain (e.g. store.myshopify.com) and fetches from app domain.
 */
export function getPortalCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") || "";
  const allowed =
    origin.endsWith(".myshopify.com") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1");
  headers.set("Access-Control-Allow-Origin", allowed ? origin : "*");
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
