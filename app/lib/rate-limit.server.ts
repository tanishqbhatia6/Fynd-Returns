/**
 * Simple in-memory rate limiter for portal APIs.
 * Uses a sliding window counter per key (IP + endpoint).
 * Enterprise deployments should swap this for Redis-backed rate limiting.
 */

const windowMs = 60_000; // 1-minute window
const store = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (val.resetAt < now) store.delete(key);
  }
}, 5 * 60_000);

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
  default: { maxRequests: 60 },
};

function getClientKey(request: Request, endpoint: string): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  const shop = new URL(request.url).searchParams.get("shop") || "global";
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

  if (entry.count > config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: entry.resetAt - now,
    };
  }

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    retryAfterMs: 0,
  };
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
