/**
 * Edge-case tests for app/lib/rate-limit.server.ts.
 *
 * Complements rate-limit.test.ts and rate-limit.redis.test.ts by exercising:
 *   - in-memory window expiry / reset behaviour
 *   - principal vs IP key isolation (and principal isolation across endpoints)
 *   - x-forwarded-for parsing edge cases (multiple IPs, missing header,
 *     leading/trailing whitespace, IPv6, empty string)
 *   - unknown endpoint falls through to the default config
 *   - malformed URL / missing shop param fallback to "global"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit, rateLimitResponse, __resetRateLimitForTests } from "../rate-limit.server";

let ipCounter = 5000;
function uniqueIp(): string {
  ipCounter++;
  return `10.9.${Math.floor(ipCounter / 256) % 256}.${ipCounter % 256}`;
}

function makeRequest(
  headers: Record<string, string> = {},
  url = "https://app.example.com/api/x?shop=edge-shop.myshopify.com",
): Request {
  return new Request(url, { headers });
}

beforeEach(() => {
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("rate-limit edges — window expiry / reset", () => {
  it("resets the counter after the window elapses", async () => {
    vi.useFakeTimers();
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // 5 per 5min

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blocked.allowed).toBe(false);

    // Advance past the 5-minute window.
    vi.advanceTimersByTime(5 * 60_000 + 1);

    const fresh = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(4);
  });

  it("retryAfterMs decreases as time advances within the window", async () => {
    vi.useFakeTimers();
    const ip = uniqueIp();
    const endpoint = "portal.otp.verify"; // 10/min

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    }
    const first = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(first.allowed).toBe(false);
    const firstRetry = first.retryAfterMs;
    expect(firstRetry).toBeGreaterThan(0);

    vi.advanceTimersByTime(20_000);

    const second = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeLessThan(firstRetry);
  });

  it("does not reset before the window has fully elapsed", async () => {
    vi.useFakeTimers();
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // 5 per 5min

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    }
    // Just shy of the window boundary.
    vi.advanceTimersByTime(5 * 60_000 - 1);
    const stillBlocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(stillBlocked.allowed).toBe(false);
  });

  it("uses default 60s window for endpoints without explicit windowMs", async () => {
    vi.useFakeTimers();
    const ip = uniqueIp();
    const endpoint = "portal.otp.verify"; // 10/min, default window

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    }
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blocked.allowed).toBe(false);

    // Cross the 60s default window boundary.
    vi.advanceTimersByTime(60_001);

    const fresh = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(9);
  });
});

describe("rate-limit edges — principal vs IP key isolation", () => {
  it("principal counter is independent from IP-only counter on same endpoint", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // limit 5

    // Exhaust IP-keyed bucket.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    }
    const blockedIp = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blockedIp.allowed).toBe(false);

    // A principal key from the same IP should be untouched.
    const principalRes = await checkRateLimit(
      makeRequest({ "x-forwarded-for": ip }),
      endpoint,
      "tenant-42",
    );
    expect(principalRes.allowed).toBe(true);
    expect(principalRes.remaining).toBe(4);
  });

  it("same principal across different endpoints maintains separate counters", async () => {
    const ip = uniqueIp();

    // Exhaust principal "x" on portal.otp.send (5 limit).
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(
        makeRequest({ "x-forwarded-for": ip }),
        "portal.otp.send",
        "principal-x",
      );
    }
    const blocked = await checkRateLimit(
      makeRequest({ "x-forwarded-for": ip }),
      "portal.otp.send",
      "principal-x",
    );
    expect(blocked.allowed).toBe(false);

    // Same principal on a different endpoint is unaffected.
    const onOther = await checkRateLimit(
      makeRequest({ "x-forwarded-for": ip }),
      "portal.lookup",
      "principal-x",
    );
    expect(onOther.allowed).toBe(true);
    expect(onOther.remaining).toBe(29); // limit 30, first hit
  });

  it("principal key ignores shop and IP entirely (different IPs share a principal bucket)", async () => {
    const endpoint = "portal.otp.send";
    const principal = "shared-principal";

    // First IP — 3 hits.
    for (let i = 0; i < 3; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": uniqueIp() }), endpoint, principal);
    }
    // Different IP, different shop — counter should continue to advance.
    const next = await checkRateLimit(
      new Request("https://app.example.com/api/x?shop=other.myshopify.com", {
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      endpoint,
      principal,
    );
    // 4th hit overall — limit 5, so remaining 1.
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(1);
  });

  it("empty-string principal falls through to the IP-keyed branch", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      // Empty string is falsy in JS — the helper takes the IP path.
      await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint, "");
    }
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blocked.allowed).toBe(false);
  });
});

describe("rate-limit edges — x-forwarded-for parsing", () => {
  it("uses the first IP from a comma-separated x-forwarded-for chain", async () => {
    const endpoint = "portal.otp.send";
    const clientIp = uniqueIp();

    // Exhaust budget under the FIRST ip in the chain.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(
        makeRequest({
          "x-forwarded-for": `${clientIp}, 10.0.0.1, 10.0.0.2`,
        }),
        endpoint,
      );
    }
    // A request whose first XFF entry matches must be blocked even with a
    // different proxy chain trailing it.
    const blocked = await checkRateLimit(
      makeRequest({ "x-forwarded-for": `${clientIp}, 192.168.1.1` }),
      endpoint,
    );
    expect(blocked.allowed).toBe(false);

    // A request whose first XFF entry differs must NOT be blocked (proves
    // we only key on the first hop).
    const allowed = await checkRateLimit(
      makeRequest({
        "x-forwarded-for": `10.0.0.1, ${clientIp}, 10.0.0.2`,
      }),
      endpoint,
    );
    expect(allowed.allowed).toBe(true);
  });

  it("trims surrounding whitespace from the first XFF entry", async () => {
    const endpoint = "portal.otp.send";
    const ip = uniqueIp();

    // Exhaust with a whitespace-padded XFF.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": `   ${ip}   , 10.0.0.5` }), endpoint);
    }
    // Same IP, no whitespace, should hit the same bucket.
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blocked.allowed).toBe(false);
  });

  it("falls back to 'unknown' bucket when x-forwarded-for is missing", async () => {
    const endpoint = "portal.otp.send";

    // Five hits with no XFF header — all go to the same `unknown` bucket.
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(makeRequest({}), endpoint);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(makeRequest({}), endpoint);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("treats empty x-forwarded-for value as 'unknown'", async () => {
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": "" }), endpoint);
    }
    // Missing header maps to the same `unknown` bucket — should be blocked.
    const blocked = await checkRateLimit(makeRequest({}), endpoint);
    expect(blocked.allowed).toBe(false);
  });

  it("handles IPv6 addresses in x-forwarded-for", async () => {
    const endpoint = "portal.otp.send";
    const ipv6 = "2001:db8::1";

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(makeRequest({ "x-forwarded-for": ipv6 }), endpoint);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ipv6 }), endpoint);
    expect(blocked.allowed).toBe(false);

    // A different IPv6 must not be affected.
    const otherV6 = await checkRateLimit(
      makeRequest({ "x-forwarded-for": "2001:db8::2" }),
      endpoint,
    );
    expect(otherV6.allowed).toBe(true);
  });

  it("comma-only XFF resolves the first segment to 'unknown' (empty after trim)", async () => {
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest({ "x-forwarded-for": ", 10.0.0.1" }), endpoint);
    }
    // Bucket key is "unknown" — a no-XFF request should land in same bucket.
    const blocked = await checkRateLimit(makeRequest({}), endpoint);
    expect(blocked.allowed).toBe(false);
  });
});

describe("rate-limit edges — unknown endpoint default", () => {
  it("uses default config (60/min) for an endpoint not present in DEFAULT_LIMITS", async () => {
    const ip = uniqueIp();
    const endpoint = "totally.unmapped.endpoint";

    const first = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(59); // default maxRequests = 60

    // Burn through the remaining budget.
    for (let i = 0; i < 59; i++) {
      const r = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
      expect(r.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), endpoint);
    expect(blocked.allowed).toBe(false);
  });

  it("two distinct unknown endpoints use independent buckets despite sharing default config", async () => {
    const ip = uniqueIp();

    const r1 = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), "unknown.endpoint.one");
    const r2 = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), "unknown.endpoint.two");
    // Each endpoint sees its own first hit.
    expect(r1.remaining).toBe(59);
    expect(r2.remaining).toBe(59);
  });

  it("explicit 'default' endpoint name resolves to the default config", async () => {
    const ip = uniqueIp();
    const r = await checkRateLimit(makeRequest({ "x-forwarded-for": ip }), "default");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(59);
  });
});

describe("rate-limit edges — URL / shop fallback", () => {
  it("uses 'global' shop when the URL has no shop search param", async () => {
    const endpoint = "portal.otp.send";
    const ip = uniqueIp();

    // No `shop` query param — both requests hit the `global` bucket.
    for (let i = 0; i < 5; i++) {
      await checkRateLimit(
        new Request("https://app.example.com/api/x", {
          headers: { "x-forwarded-for": ip },
        }),
        endpoint,
      );
    }
    const blocked = await checkRateLimit(
      new Request("https://app.example.com/api/y", {
        headers: { "x-forwarded-for": ip },
      }),
      endpoint,
    );
    expect(blocked.allowed).toBe(false);
  });
});

describe("rate-limit edges — rateLimitResponse", () => {
  it("rounds up zero-ms retry to a 0 second header", async () => {
    const r = rateLimitResponse(0);
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("0");
  });

  it("rounds 999ms up to 1 second", async () => {
    const r = rateLimitResponse(999);
    expect(r.headers.get("Retry-After")).toBe("1");
  });
});
