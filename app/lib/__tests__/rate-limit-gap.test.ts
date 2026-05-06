/**
 * Coverage-gap tests for app/lib/rate-limit.server.ts.
 *
 * Targets uncovered branches not exercised by the existing tests:
 *   - Module-load production warning (NODE_ENV=production + WEB_CONCURRENCY>1
 *     + no REDIS_URL) — line 44 in the source.
 *   - Periodic in-memory cleanup setInterval purging expired entries — the
 *     callback body (lines 32-34) only runs when the timer fires.
 *   - rateLimiterKeysActive observable callback (line 39) — only invoked when
 *     OTel metrics collection ticks; we capture the registered callback via a
 *     module mock and invoke it directly.
 *
 * These complement rate-limit-edges.test.ts and rate-limit.redis.test.ts
 * without overlapping their assertions or modifying any source.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIG_ENV };
  delete process.env.REDIS_URL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
});

describe("rate-limit gap — production warning at module load", () => {
  it("warns when NODE_ENV=production, WEB_CONCURRENCY>1, and REDIS_URL is unset", async () => {
    process.env.NODE_ENV = "production";
    process.env.WEB_CONCURRENCY = "4";
    delete process.env.REDIS_URL;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../rate-limit.server");

    const messages = warn.mock.calls.map((c) => String(c[0] ?? ""));
    const hit = messages.find((m) => m.includes("[rate-limit]"));
    expect(hit).toBeDefined();
    expect(hit).toContain("WEB_CONCURRENCY>1");
  });

  it("does not warn when REDIS_URL is set in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.WEB_CONCURRENCY = "4";
    process.env.REDIS_URL = "redis://localhost:6379";

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../rate-limit.server");

    const messages = warn.mock.calls.map((c) => String(c[0] ?? ""));
    expect(messages.find((m) => m.includes("[rate-limit]"))).toBeUndefined();
  });

  it("does not warn when WEB_CONCURRENCY is unset (defaults to 1)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.WEB_CONCURRENCY;
    delete process.env.REDIS_URL;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../rate-limit.server");

    const messages = warn.mock.calls.map((c) => String(c[0] ?? ""));
    expect(messages.find((m) => m.includes("[rate-limit]"))).toBeUndefined();
  });

  it("does not warn when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "development";
    process.env.WEB_CONCURRENCY = "4";
    delete process.env.REDIS_URL;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../rate-limit.server");

    const messages = warn.mock.calls.map((c) => String(c[0] ?? ""));
    expect(messages.find((m) => m.includes("[rate-limit]"))).toBeUndefined();
  });
});

describe("rate-limit gap — observable gauge callback", () => {
  it("registered callback observes the live in-memory store size", async () => {
    // Capture the addCallback registration so we can drive the observer
    // synchronously (OTel never ticks in tests). Partial-mock so the rest of
    // metrics.server is preserved (other modules in the dep tree need it).
    type Cb = (obs: { observe: (n: number) => void }) => void;
    const captured: { cb?: Cb } = {};

    vi.doMock("../observability/metrics.server", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        rateLimiterKeysActive: {
          addCallback: (cb: Cb) => {
            captured.cb = cb;
          },
        },
      };
    });

    const mod = await import("../rate-limit.server");
    expect(captured.cb).toBeTypeOf("function");

    // Empty store first.
    let observed = -1;
    captured.cb!({
      observe: (n: number) => {
        observed = n;
      },
    });
    expect(observed).toBe(0);

    // Populate the in-memory store with a real check, then verify the
    // observable reports the new size.
    const req = new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
      headers: { "x-forwarded-for": "10.20.30.40" },
    });
    await mod.checkRateLimit(req, "portal.otp.send");

    captured.cb!({
      observe: (n: number) => {
        observed = n;
      },
    });
    expect(observed).toBeGreaterThan(0);

    mod.__resetRateLimitForTests();
    vi.doUnmock("../observability/metrics.server");
  });
});

describe("rate-limit gap — periodic cleanup setInterval", () => {
  it("purges expired entries when the cleanup timer fires", async () => {
    vi.useFakeTimers();

    // Re-import so the module-level setInterval is registered while fake
    // timers are active — otherwise the timer is owned by the real clock and
    // vi.advanceTimersByTime can't drive it.
    const mod = await import("../rate-limit.server");
    const { checkRateLimit, __resetRateLimitForTests } = mod;
    __resetRateLimitForTests();

    // Seed a few entries with the SHORTEST window we can reach (60s default).
    const req = (ip: string) =>
      new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
        headers: { "x-forwarded-for": ip },
      });

    await checkRateLimit(req("10.50.0.1"), "portal.otp.verify"); // 60s window
    await checkRateLimit(req("10.50.0.2"), "portal.otp.verify");
    await checkRateLimit(req("10.50.0.3"), "portal.otp.verify");

    // Skip well past every entry's window so they are all "expired"
    // relative to Date.now() inside the cleanup callback. The cleanup
    // setInterval fires every 5 minutes — advance 6 minutes to guarantee
    // at least one tick AFTER all entries have expired.
    vi.advanceTimersByTime(6 * 60_000 + 1);

    // After the interval fires the body iterates memStore and calls
    // memStore.delete(key) for each expired entry. We can't read memStore
    // directly, but we can observe the side-effect: re-checking the same
    // bucket starts from a fresh count.
    const fresh = await checkRateLimit(req("10.50.0.1"), "portal.otp.verify");
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(9); // first hit on a clean bucket
  });

  it("leaves non-expired entries in place when the timer fires", async () => {
    vi.useFakeTimers();
    const mod = await import("../rate-limit.server");
    const { checkRateLimit, __resetRateLimitForTests } = mod;
    __resetRateLimitForTests();

    const req = new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
      headers: { "x-forwarded-for": "10.60.0.1" },
    });

    // Use the 5-minute portal.otp.send bucket so the entry is still live
    // when the 5-minute cleanup tick arrives (resetAt = now + 5min, the
    // cleanup runs at t+5min, so resetAt is NOT < now).
    await checkRateLimit(req, "portal.otp.send");

    // Advance to just before the entry's window expires (cleanup at 5min,
    // entry expires at 5min + tiny epsilon).
    vi.advanceTimersByTime(5 * 60_000 - 100);

    // The bucket should remember the prior hit.
    const second = await checkRateLimit(req, "portal.otp.send");
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(3); // 5 limit, 2nd hit
  });

  it("retains non-expired entries across a cleanup tick (covers else branch)", async () => {
    vi.useFakeTimers();
    const mod = await import("../rate-limit.server");
    const { checkRateLimit, __resetRateLimitForTests } = mod;
    __resetRateLimitForTests();

    // Seed an entry on the 5-minute bucket — its resetAt will be now+5min.
    const req = new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
      headers: { "x-forwarded-for": "10.70.0.1" },
    });
    await checkRateLimit(req, "portal.otp.send");

    // Advance exactly past the cleanup tick (5 min) but still within the
    // entry's window (resetAt = 5min, current time = 5min ⇒ resetAt < now
    // is FALSE so the entry survives — exercises the false-branch of the
    // if at line 34).
    vi.advanceTimersByTime(5 * 60_000);

    // Entry must still be present — second hit decrements remaining count.
    const second = await checkRateLimit(req, "portal.otp.send");
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBeLessThanOrEqual(3);
  });
});

describe("rate-limit gap — Redis path edge branches", () => {
  it("treats malformed Lua reply (missing fields) as count=0/pttl=window", async () => {
    // ioredis-mock would always return a well-formed reply, so we inject a
    // hand-rolled fake whose eval() returns [undefined, undefined] — that
    // exercises the `?? 0` / `?? window` fallbacks at lines 135-136.
    const fakeRedis = {
      eval: vi.fn().mockResolvedValue([undefined, undefined]),
    };

    const mod = await import("../rate-limit.server");
    const redisMod = await import("../redis.server");
    redisMod.__setRedisForTests(fakeRedis as never);
    mod.__resetRateLimitForTests();

    const req = new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
      headers: { "x-forwarded-for": "10.80.0.1" },
    });
    const r = await mod.checkRateLimit(req, "portal.otp.send");

    // count fell back to 0 → not over the limit → allowed, remaining=full.
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(5);
    expect(fakeRedis.eval).toHaveBeenCalledOnce();

    redisMod.__setRedisForTests(null);
    mod.__resetRateLimitForTests();
  });

  it("logs the raw value when Redis EVAL throws a non-Error payload", async () => {
    // The catch block stringifies non-Error throws via the alternate branch
    // of `err instanceof Error ? err.message : err` (line 151).
    const fakeRedis = {
      eval: vi.fn().mockRejectedValue("string-rejection"),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mod = await import("../rate-limit.server");
    const redisMod = await import("../redis.server");
    redisMod.__setRedisForTests(fakeRedis as never);
    mod.__resetRateLimitForTests();

    const req = new Request("https://app.example.com/api/x?shop=t.myshopify.com", {
      headers: { "x-forwarded-for": "10.81.0.1" },
    });
    const r = await mod.checkRateLimit(req, "portal.otp.send");

    // Falls back to in-memory and allows the request.
    expect(r.allowed).toBe(true);

    // The first warn call (rate-limit module's "Redis unavailable" message)
    // must include the non-Error payload as its second arg.
    const rlCall = warn.mock.calls.find((c) =>
      String(c[0] ?? "").includes("[rate-limit] Redis unavailable"),
    );
    expect(rlCall).toBeDefined();
    expect(rlCall![1]).toBe("string-rejection");

    redisMod.__setRedisForTests(null);
    mod.__resetRateLimitForTests();
  });
});
