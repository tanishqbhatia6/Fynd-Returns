/**
 * Tests for observability/request-context.server.ts: setRequestContext (request
 * ID extraction + baggage/span propagation), getSourceIp (x-forwarded-for
 * parsing for proxied requests), and hashIp (privacy-preserving, deterministic
 * hashing). These helpers underpin log/trace correlation across the app — a
 * regression here breaks debuggability of every request.
 */
import crypto from "crypto";
import { describe, it, expect } from "vitest";
import { setRequestContext, getSourceIp, hashIp } from "../observability/request-context.server";

describe("setRequestContext", () => {
  it("returns the x-request-id header value when present", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-request-id": "req-abc-123" },
    });
    const id = setRequestContext(req);
    expect(id).toBe("req-abc-123");
  });

  it("falls back to x-amzn-trace-id when x-request-id is absent", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-amzn-trace-id": "Root=1-abc-def" },
    });
    const id = setRequestContext(req);
    expect(id).toBe("Root=1-abc-def");
  });

  it("generates a UUID when no correlation headers are present", () => {
    const req = new Request("https://example.com/");
    const id = setRequestContext(req);
    // crypto.randomUUID() shape: 8-4-4-4-12 hex
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("generates a unique ID per call when headers are absent", () => {
    const a = setRequestContext(new Request("https://example.com/"));
    const b = setRequestContext(new Request("https://example.com/"));
    expect(a).not.toBe(b);
  });

  it("does not throw when extra context is provided without an active span", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-request-id": "req-xyz" },
    });
    const id = setRequestContext(req, {
      shopDomain: "shop.myshopify.com",
      shopId: "gid://shopify/Shop/1",
      userType: "admin",
      returnId: "ret-1",
      returnRequestNo: "RR-100",
    });
    expect(id).toBe("req-xyz");
  });

  it("prefers x-request-id over x-amzn-trace-id when both are set", () => {
    const req = new Request("https://example.com/", {
      headers: {
        "x-request-id": "req-primary",
        "x-amzn-trace-id": "Root=1-secondary",
      },
    });
    expect(setRequestContext(req)).toBe("req-primary");
  });
});

describe("getSourceIp", () => {
  it("returns 'unknown' when the x-forwarded-for header is absent", () => {
    const req = new Request("https://example.com/");
    expect(getSourceIp(req)).toBe("unknown");
  });

  it("returns the only IP when x-forwarded-for has a single value", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(getSourceIp(req)).toBe("203.0.113.7");
  });

  it("returns the first (client) IP when multiple are chained by proxies", () => {
    const req = new Request("https://example.com/", {
      headers: {
        "x-forwarded-for": "203.0.113.7, 198.51.100.1, 10.0.0.5",
      },
    });
    expect(getSourceIp(req)).toBe("203.0.113.7");
  });

  it("trims surrounding whitespace from the client IP", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "   203.0.113.7  , 198.51.100.1" },
    });
    expect(getSourceIp(req)).toBe("203.0.113.7");
  });

  it("returns 'unknown' when x-forwarded-for is an empty string", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "" },
    });
    expect(getSourceIp(req)).toBe("unknown");
  });

  it("supports IPv6 addresses", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "2001:db8::1, 198.51.100.1" },
    });
    expect(getSourceIp(req)).toBe("2001:db8::1");
  });
});

describe("hashIp", () => {
  it("produces an 8-character hex string", () => {
    const out = hashIp("203.0.113.7");
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — the same IP hashes to the same value", () => {
    expect(hashIp("203.0.113.7")).toBe(hashIp("203.0.113.7"));
  });

  it("produces different hashes for different IPs (privacy-preserving spread)", () => {
    expect(hashIp("203.0.113.7")).not.toBe(hashIp("203.0.113.8"));
  });

  it("does not return the raw IP (privacy-preserving)", () => {
    const ip = "203.0.113.7";
    const out = hashIp(ip);
    expect(out).not.toContain(ip);
    expect(out).not.toContain("203");
  });

  it("matches the first 8 chars of a SHA-256 digest", () => {
    const ip = "198.51.100.42";
    const expected = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 8);
    expect(hashIp(ip)).toBe(expected);
  });

  it("hashes the 'unknown' sentinel value without throwing", () => {
    const out = hashIp("unknown");
    expect(out).toMatch(/^[0-9a-f]{8}$/);
  });
});
