/**
 * Simple in-memory rate limiter for portal APIs.
 * Uses a sliding window counter per key (IP + endpoint).
 * Enterprise deployments should swap this for Redis-backed rate limiting.
 */

import { recordRateLimitCheck } from "./observability/security.server";
import { rateLimiterKeysActive } from "./observability/metrics.server";

const windowMs = 60_000; // 1-minute window
const store = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (val.resetAt < now) store.delete(key);
  }
}, 5 * 60_000);

// Report the number of active rate-limiter keys as an observable gauge
rateLimiterKeysActive.addCallback((obs) => {
  obs.observe(store.size);
});

export type RateLimitConfig = {
  maxRequests: number;
  windowMs?: number;
};

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  "portal.lookup": { maxRequests: 30 },
  "portal.order": { maxRequests: 30 },
  "portal.create-return": { maxRequests: 5, windowMs: 5 * 60_000 },
  "portal.otp.send": { maxRequests: 5, windowMs: 5 * 60_000 },
  "portal.otp.verify": { maxRequests: 10 },
  "portal.returns": { maxRequests: 30 },
  // Catalog enumeration limit — was unlimited (P0). Used by the exchange variant
  // picker; legitimate flows hit this 1-2 times per item, so 60/min is generous.
  "portal.products": { maxRequests: 60 },
  // Admin customer search — guards against a compromised admin session being used
  // to bulk-enumerate the customer list. 60/min easily covers normal pagination
  // (typing "joh" then "john" then "john s" etc.) but throttles automated dumps.
  "admin.customers.search": { maxRequests: 60 },
  // External API endpoints
  "external.returns.list": { maxRequests: 120 },
  "external.returns.detail": { maxRequests: 120 },
  "external.settings": { maxRequests: 120 },
  "external.returns.approve": { maxRequests: 30 },
  "external.returns.reject": { maxRequests: 30 },
  "external.returns.refund": { maxRequests: 30 },
  "external.webhooks": { maxRequests: 10 },
  "external.postman": { maxRequests: 10 },
  default: { maxRequests: 60 },
};

function getClientKey(request: Request, endpoint: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  let shop = "global";
  try { shop = new URL(request.url).searchParams.get("shop") || "global"; } catch { /* malformed URL */ }
  return `${ip}:${shop}:${endpoint}`;
}

export function checkRateLimit(
  request: Request,
  endpoint: string
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const config = DEFAULT_LIMITS[endpoint] || DEFAULT_LIMITS.default;
  const window = config.windowMs ?? windowMs;
  const key = getClientKey(request, endpoint);
  const now = Date.now();

  let entry = store.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + window };
    store.set(key, entry);
  }

  entry.count++;

  let result: { allowed: boolean; remaining: number; retryAfterMs: number };

  if (entry.count > config.maxRequests) {
    result = {
      allowed: false,
      remaining: 0,
      retryAfterMs: entry.resetAt - now,
    };
  } else {
    result = {
      allowed: true,
      remaining: config.maxRequests - entry.count,
      retryAfterMs: 0,
    };
  }

  recordRateLimitCheck(request, endpoint, result.allowed, result.remaining);
  return result;
}

export function rateLimitResponse(retryAfterMs: number): Response {
  return Response.json(
    { error: "Too many requests. Please try again shortly." },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      },
    }
  );
}
