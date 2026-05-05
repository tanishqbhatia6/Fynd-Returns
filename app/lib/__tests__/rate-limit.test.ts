import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, rateLimitResponse, __resetRateLimitForTests } from "../rate-limit.server";

/**
 * Helper to create a minimal Request object with a given IP and optional shop param.
 */
function makeRequest(ip: string, shop = "test-shop.myshopify.com"): Request {
  return new Request(`https://app.example.com/api/test?shop=${shop}`, {
    headers: { "x-forwarded-for": ip },
  });
}

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

beforeEach(() => {
  __resetRateLimitForTests();
});

describe("checkRateLimit", () => {
  it("allows requests under the limit", async () => {
    const ip = uniqueIp();
    const req = makeRequest(ip);
    const result = await checkRateLimit(req, "default");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBe(0);
  });

  it("blocks requests over the limit", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send"; // limit: 5 per 5min

    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit(makeRequest(ip), endpoint);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("returns correct remaining count", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.verify"; // limit: 10/min

    const first = await checkRateLimit(makeRequest(ip), endpoint);
    expect(first.remaining).toBe(9);

    const second = await checkRateLimit(makeRequest(ip), endpoint);
    expect(second.remaining).toBe(8);
  });

  it("uses endpoint-specific limits for portal.otp.send (5 per 5min)", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit(makeRequest(ip), endpoint);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4 - i);
    }

    const blocked = await checkRateLimit(makeRequest(ip), endpoint);
    expect(blocked.allowed).toBe(false);
  });

  it("falls back to default limits for unknown endpoints", async () => {
    const ip = uniqueIp();
    const result = await checkRateLimit(makeRequest(ip), "some.unknown.endpoint");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(59);
  });

  it("tracks different IPs separately", async () => {
    const ip1 = uniqueIp();
    const ip2 = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest(ip1), endpoint);
    }
    const blockedIp1 = await checkRateLimit(makeRequest(ip1), endpoint);
    expect(blockedIp1.allowed).toBe(false);

    const ip2Result = await checkRateLimit(makeRequest(ip2), endpoint);
    expect(ip2Result.allowed).toBe(true);
  });

  it("tracks different shops separately for the same IP", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest(ip, "shop-a.myshopify.com"), endpoint);
    }
    const blockedShopA = await checkRateLimit(makeRequest(ip, "shop-a.myshopify.com"), endpoint);
    expect(blockedShopA.allowed).toBe(false);

    const shopBResult = await checkRateLimit(makeRequest(ip, "shop-b.myshopify.com"), endpoint);
    expect(shopBResult.allowed).toBe(true);
  });

  it("isolates per-principal limits from per-IP limits", async () => {
    const ip = uniqueIp();
    const endpoint = "portal.otp.send";

    for (let i = 0; i < 5; i++) {
      await checkRateLimit(makeRequest(ip), endpoint, "principal-A");
    }
    const blockedA = await checkRateLimit(makeRequest(ip), endpoint, "principal-A");
    expect(blockedA.allowed).toBe(false);

    const okB = await checkRateLimit(makeRequest(ip), endpoint, "principal-B");
    expect(okB.allowed).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 response with Retry-After header", async () => {
    const response = rateLimitResponse(30000);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("rounds Retry-After up to the nearest second", async () => {
    const response = rateLimitResponse(1500);
    expect(response.headers.get("Retry-After")).toBe("2");
  });

  it("includes error message in the body", async () => {
    const response = rateLimitResponse(5000);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Too many requests");
  });
});
