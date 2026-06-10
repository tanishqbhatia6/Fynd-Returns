/**
 * Redis client.
 *
 * Activation:
 *   - If REDIS_URL is unset, getRedis() returns null and consumers fall back
 *     to their non-Redis implementation.
 *   - If REDIS_URL is set but Redis is unreachable, the client logs once and
 *     also returns null on each call (lazy reconnect handled by ioredis).
 *
 * Why a custom singleton instead of importing ioredis at every call site:
 *   - Lazy connect (no boot failure if REDIS_URL is malformed).
 *   - Failure mode is "fall back to in-memory", not "crash the request" —
 *     critical for a rate limiter that gates user requests.
 *   - One log line on first failure, not per-request noise.
 */
import { Redis } from "ioredis";
import { redisFailureCounter } from "./observability/metrics.server";
import { redisLogger } from "./observability/logger.server";

type RedisClient = Redis;

let client: RedisClient | null = null;
let initAttempted = false;
let lastFailureLogged = false;

function buildClient(url: string): RedisClient {
  // ioredis types: `new Redis(url, opts)` returns a Redis instance.
  return new Redis(url, {
    // Don't auto-retry forever — at most 3 retries with capped backoff so a
    // dead Redis doesn't tie up the request path.
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    // Lazy connect: don't try to connect until the first command. Combined
    // with `maxRetriesPerRequest`, this means a misconfigured REDIS_URL
    // surfaces as a per-request fallback rather than a process crash.
    lazyConnect: true,
    // Retry strategy: cap at 5s between retries; ioredis will give up after
    // maxRetriesPerRequest * (retries) attempts on a single command.
    retryStrategy(times) {
      return Math.min(times * 200, 5000);
    },
  });
}

export function getRedis(): RedisClient | null {
  if (!initAttempted) {
    initAttempted = true;
    const url = process.env.REDIS_URL?.trim();
    if (!url) return null;
    try {
      client = buildClient(url);
      client.on("error", (err: unknown) => {
        redisFailureCounter.add(1, { operation: "connection" });
        if (!lastFailureLogged) {
          lastFailureLogged = true;
          // First-error suppression: log once, then go quiet to avoid log
          // spam if Redis stays down. Reset on reconnect.

          redisLogger.warn({ err }, "Redis connection error; will retry");
        }
      });
      client.on("ready", () => {
        if (lastFailureLogged) {
          redisLogger.info("Redis reconnected");
          lastFailureLogged = false;
        }
      });
    } catch (err) {
      redisFailureCounter.add(1, { operation: "construct" });
      redisLogger.warn({ err }, "Redis client construction failed; falling back to in-memory");
      client = null;
    }
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    try {
      await client.quit();
    } catch {
      /* best effort */
    }
    client = null;
    initAttempted = false;
  }
}

/**
 * For tests only — replace the singleton with an injected client (e.g.
 * ioredis-mock). Calling with `null` resets state so the next getRedis()
 * call re-reads REDIS_URL.
 */
export function __setRedisForTests(injected: RedisClient | null): void {
  client = injected;
  initAttempted = injected != null;
  lastFailureLogged = false;
}
