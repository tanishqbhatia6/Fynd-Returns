/**
 * Redis-backed rate-limiter integration tests using ioredis-mock.
 *
 * Verifies:
 *  - cluster-correctness: a single counter shared across multiple Request
 *    objects (simulating multiple replicas hitting the same key).
 *  - atomic INCR + EXPIRE in the Lua script (TTL set on first hit, not reset
 *    on subsequent hits within the window).
 *  - graceful fallback to in-memory when Redis throws.
 *  - per-principal vs per-IP key isolation (matches the in-memory test).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import RedisMock from "ioredis-mock";
import { __setRedisForTests } from "../redis.server";
import { checkRateLimit, __resetRateLimitForTests } from "../rate-limit.server";

// ioredis-mock's default export is a runtime constructor whose own d.ts
// re-exports the type as a namespace. Use `InstanceType<typeof RedisMock>`
// to get a proper instance type.
type RedisMockInstance = InstanceType<typeof RedisMock>;

function makeRequest(ip: string, shop = "test.myshopify.com"): Request {
  return new Request(`https://app.example/api/x?shop=${shop}`, {
    headers: { "x-forwarded-for": ip },
  });
}

let ipCounter = 1000;
function uniqueIp(): string {
  ipCounter++;
  return `10.1.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

describe("checkRateLimit (Redis backend)", () => {
  let redis: RedisMockInstance;

  beforeEach(async () => {
    __resetRateLimitForTests();
    redis = new RedisMock();
    // ioredis-mock shares keyspace across instances by default; flush so
    // each test sees an empty store regardless of sibling test order.
    await redis.flushall();
    __setRedisForTests(redis as never);
  });

  it("uses Redis when available — counters shared across requests", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // limit 5

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(makeRequest(ip), endpoint);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4 - i);
    }
    const blocked = await checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("sets PEXPIRE on first hit only (TTL doesn't reset within window)", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.lookup"; // 30/min, window 60s

    await checkRateLimit(makeRequest(ip), endpoint);
    const ttlAfter1 = await redis
      .pttl(
        `rl:${(redis as never as { keys: (p: string) => Promise<string[]> }).constructor.name === "Redis" ? "" : ""}${ip}:test.myshopify.com:${endpoint}`,
      )
      .catch(() => -2);
    // ioredis-mock returns -2 for unknown keys; we expect the prefixed form
    const keys = await redis.keys("rl:*");
    expect(keys.length).toBe(1);

    const ttlNow = await redis.pttl(keys[0]);
    expect(ttlNow).toBeGreaterThan(0);
    expect(ttlNow).toBeLessThanOrEqual(60_000);

    // Second hit should not reset the TTL upward.
    await new Promise((res) => setTimeout(res, 20));
    await checkRateLimit(makeRequest(ip), endpoint);
    const ttlAfter2 = await redis.pttl(keys[0]);
    expect(ttlAfter2).toBeLessThanOrEqual(ttlNow);
    // unused-ttl placeholder reference to keep the lint happy
    void ttlAfter1;
  });

  it("isolates per-principal from per-IP keys", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest(ip), endpoint, "principal-A");
    }
    const blockedA = await checkRateLimit(makeRequest(ip), endpoint, "principal-A");
    expect(blockedA.allowed).toBe(false);

    const okB = await checkRateLimit(makeRequest(ip), endpoint, "principal-B");
    expect(okB.allowed).toBe(true);

    const okIp = await checkRateLimit(makeRequest(ip), endpoint);
    expect(okIp.allowed).toBe(true);
  });

  it("falls back to in-memory when Redis throws on EVAL", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    const evalSpy = vi.spyOn(redis, "eval").mockRejectedValue(new Error("CONNRESET"));

    // First five succeed via in-memory fallback, sixth blocks.
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(makeRequest(ip), endpoint);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
    expect(evalSpy).toHaveBeenCalled();
  });

  it("fallback stays in-memory across requests during outage", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.lookup";
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("ECONNREFUSED"));

    const a = await checkRateLimit(makeRequest(ip), endpoint);
    const b = await checkRateLimit(makeRequest(ip), endpoint);
    expect(a.remaining).toBeGreaterThan(b.remaining); // counter advanced in memory
  });
});
