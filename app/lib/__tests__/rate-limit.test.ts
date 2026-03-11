import { describe, it, expect } from "vitest";
import { checkRateLimit, rateLimitResponse } from "../rate-limit.server";

/**
 * Helper to create a minimal Request object with a given IP and optional shop param.
 */
function makeRequest(ip: string, shop = "test-shop.myshopify.com"): Request {
  return new Request(`https://app.example.com/api/test?shop=${shop}`, {
    headers: { "x-forwarded-for": ip },
  });
}

/**
 * Each test uses a unique IP to avoid state leaking between tests,
 * since the rate limiter uses a module-level Map.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    const ip = uniqueIp();
    const req = makeRequest(ip);
    // Default limit is 60/min; first request should be allowed
    const result = checkRateLimit(req, "default");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBe(0);
  });

  it("blocks requests over the limit", () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // limit: 5 per 5min

    // Send 5 allowed requests
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(makeRequest(ip), endpoint);
      expect(result.allowed).toBe(true);
    }

    // 6th request should be blocked
    const blocked = checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns correct remaining count", () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.verify"; // limit: 10/min

    const first = checkRateLimit(makeRequest(ip), endpoint);
    expect(first.remaining).toBe(9); // 10 - 1

    const second = checkRateLimit(makeRequest(ip), endpoint);
    expect(second.remaining).toBe(8); // 10 - 2
  });

  it("uses endpoint-specific limits for portal.otp.send (5 per 5min)", () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    // Should allow exactly 5 requests
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit(makeRequest(ip), endpoint);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }

    // 6th should be blocked
    const blocked = checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
  });

  it("falls back to default limits for unknown endpoints", () => {
    const ip = uniqueIp();
    const result = checkRateLimit(makeRequest(ip), "some.unknown.endpoint");
    expect(result.allowed).toBe(true);
    // Default is 60; after 1 request, remaining is 59
    expect(result.remaining).toBe(59);
  });

  it("tracks different IPs separately", () => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();
    const endpoint = "portal.otp.send"; // limit 5

    // Exhaust ip1
    for (let i = 0; i < 5; i++) {
      checkRateLimit(makeRequest(ip1), endpoint);
    }
    const blockedIp1 = checkRateLimit(makeRequest(ip1), endpoint);
    expect(blockedIp1.allowed).toBe(false);

    // ip2 should still be allowed
    const ip2Result = checkRateLimit(makeRequest(ip2), endpoint);
    expect(ip2Result.allowed).toBe(true);
  });

  it("tracks different shops separately for the same IP", () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // limit 5

    // Exhaust limit for shop A
    for (let i = 0; i < 5; i++) {
      checkRateLimit(makeRequest(ip, "shop-a.myshopify.com"), endpoint);
    }
    const blockedShopA = checkRateLimit(makeRequest(ip, "shop-a.myshopify.com"), endpoint);
    expect(blockedShopA.allowed).toBe(false);

    // shop B should still be allowed
    const shopBResult = checkRateLimit(makeRequest(ip, "shop-b.myshopify.com"), endpoint);
    expect(shopBResult.allowed).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 response with Retry-After header", async () => {
    const response = rateLimitResponse(30000); // 30 seconds
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("rounds Retry-After up to the nearest second", async () => {
    const response = rateLimitResponse(1500); // 1.5 seconds
    expect(response.headers.get("Retry-After")).toBe("2");
  });

  it("includes error message in the body", async () => {
    const response = rateLimitResponse(5000);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Too many requests");
  });
});
