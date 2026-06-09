/**
 * Rate limiter for portal & external APIs.
 *
 * Two backends:
 *   - **Redis** (preferred when REDIS_URL is set): uses an atomic Lua
 *     script to INCR + EXPIRE in a single round-trip. Cluster-correct —
 *     all replicas see the same counter, so per-IP / per-principal limits
 *     enforce strictly across the fleet.
 *   - **In-memory** (default fallback): per-replica `Map`. Used when Redis
 *     is unset or unreachable. Effective per-IP limit becomes
 *     maxRequests × replica count, but every replica still throttles
 *     individually — defence-in-depth, not a single point of failure.
 *
 * The OTP brute-force gate (`portal.otp.send`, `portal.otp.verify`) has a
 * second, DB-backed lockout (`api.portal.lookup.ts` — `totalRecentFailures`
 * query) that IS cluster-correct regardless of which backend is active.
 *
 * Failure mode: if Redis is configured but throws on a request, the
 * limiter falls back to in-memory for THAT request only (logged once),
 * never blocks the user with a 5xx for an infrastructure issue.
 */

import { recordRateLimitCheck } from "./observability/security.server";
import { rateLimiterKeysActive, redisFailureCounter } from "./observability/metrics.server";
import { getRedis } from "./redis.server";
import { securityLogger } from "./observability/logger.server";

const DEFAULT_WINDOW_MS = 60_000;
const memStore = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup to prevent memory leaks.
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of memStore) {
    if (val.resetAt < now) memStore.delete(key);
  }
}, 5 * 60_000).unref?.();

rateLimiterKeysActive.addCallback((obs) => {
  obs.observe(memStore.size);
});

if (
  process.env.NODE_ENV === "production" &&
  Number(process.env.WEB_CONCURRENCY ?? "1") > 1 &&
  !process.env.REDIS_URL
) {
  securityLogger.warn(
    { webConcurrency: process.env.WEB_CONCURRENCY ?? "1" },
    "WEB_CONCURRENCY>1 detected with no REDIS_URL. In-memory rate limiting is per-replica.",
  );
}

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
  "portal.products": { maxRequests: 60 },
  "portal.fynd-enrich": { maxRequests: 60 },
  "portal.track": { maxRequests: 60 },
  "portal.cancel-return": { maxRequests: 10 },
  "admin.customers.search": { maxRequests: 60 },
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

function getClientKey(request: Request, endpoint: string, principal?: string): string {
  if (principal) return `principal:${principal}:${endpoint}`;
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  let shop = "global";
  try {
    shop = new URL(request.url).searchParams.get("shop") || "global";
  } catch {
    /* malformed URL */
  }
  return `${ip}:${shop}:${endpoint}`;
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

/**
 * Atomic Lua: INCR the key, set EXPIRE if it's the first hit, return the
 * count and the remaining TTL (ms). Single round-trip, race-free.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = window TTL in seconds
 *
 * Returns: { count, ttlSeconds }
 */
const ATOMIC_INCR_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return { count, pttl }
`;

let redisFailureLogged = false;

async function checkRedis(key: string, config: RateLimitConfig): Promise<RateLimitResult | null> {
  const redis = getRedis();
  if (!redis) return null;
  const window = config.windowMs ?? DEFAULT_WINDOW_MS;
  try {
    const result = (await redis.eval(ATOMIC_INCR_LUA, 1, `rl:${key}`, String(window))) as [
      number,
      number,
    ];
    const count = Number(result?.[0] ?? 0);
    const pttl = Number(result?.[1] ?? window);
    if (count > config.maxRequests) {
      return { allowed: false, remaining: 0, retryAfterMs: pttl };
    }
    return {
      allowed: true,
      remaining: Math.max(0, config.maxRequests - count),
      retryAfterMs: 0,
    };
  } catch (err) {
    redisFailureCounter.add(1, { operation: "rate_limit_eval" });
    if (!redisFailureLogged) {
      redisFailureLogged = true;

      securityLogger.warn(
        { err },
        "Rate limiter Redis unavailable on this request; falling back to in-memory",
      );
    }
    return null;
  }
}

function checkMemory(key: string, config: RateLimitConfig): RateLimitResult {
  const window = config.windowMs ?? DEFAULT_WINDOW_MS;
  const now = Date.now();
  let entry = memStore.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + window };
    memStore.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > config.maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }
  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    retryAfterMs: 0,
  };
}

export async function checkRateLimit(
  request: Request,
  endpoint: string,
  /** Optional authenticated principal — pass an API key id, shop id, or
   *  user id to switch from per-IP to per-principal limits. */
  principal?: string,
): Promise<RateLimitResult> {
  const config = DEFAULT_LIMITS[endpoint] ?? DEFAULT_LIMITS.default;
  const key = getClientKey(request, endpoint, principal);

  const fromRedis = await checkRedis(key, config);
  const result = fromRedis ?? checkMemory(key, config);

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
    },
  );
}

/** Test-only — drains in-memory store between tests. */
export function __resetRateLimitForTests(): void {
  memStore.clear();
  redisFailureLogged = false;
}
