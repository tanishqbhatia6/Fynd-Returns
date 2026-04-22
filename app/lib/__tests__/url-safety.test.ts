/**
 * SSRF guard tests — every "internal" address an attacker might point a webhook at
 * must be rejected. Public hostnames must pass.
 */
import { describe, it, expect } from "vitest";
import { isPrivateIPv4, isPrivateIPv6, isSafeOutboundUrl } from "../url-safety.server";

describe("isPrivateIPv4", () => {
  const PRIVATE = [
    "127.0.0.1",        // loopback
    "0.0.0.0",          // unspecified
    "10.1.2.3",         // RFC 1918
    "172.16.0.1",       // RFC 1918
    "172.31.255.255",   // RFC 1918 boundary
    "192.168.0.1",      // RFC 1918
    "169.254.169.254",  // AWS/GCP/Azure metadata
    "100.64.0.1",       // CGNAT
    "224.0.0.1",        // multicast
    "255.255.255.255",  // broadcast
  ];
  for (const ip of PRIVATE) {
    it(`${ip} is private`, () => expect(isPrivateIPv4(ip)).toBe(true));
  }

  const PUBLIC = [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",       // just above RFC 1918
    "172.15.255.255",   // just below RFC 1918
    "11.0.0.1",
    "203.0.114.1",      // just outside TEST-NET-3
  ];
  for (const ip of PUBLIC) {
    it(`${ip} is public`, () => expect(isPrivateIPv4(ip)).toBe(false));
  }
});

describe("isPrivateIPv6", () => {
  it("loopback is private", () => expect(isPrivateIPv6("::1")).toBe(true));
  it("unique-local fc00:: is private", () => expect(isPrivateIPv6("fc00::1")).toBe(true));
  it("link-local fe80:: is private", () => expect(isPrivateIPv6("fe80::1")).toBe(true));
  it("ipv4-mapped loopback is private", () => expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true));
  it("global address 2001:db8 is public", () => {
    // 2001:db8 is documentation range but not in our private set; treat as public
    // for our purposes (we don't block documentation ranges since they're not
    // routable to internal services).
    expect(isPrivateIPv6("2001:db8::1")).toBe(false);
  });
});

describe("isSafeOutboundUrl", () => {
  it("rejects http:// (HTTPS required)", async () => {
    const r = await isSafeOutboundUrl("http://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("rejects javascript: scheme", async () => {
    const r = await isSafeOutboundUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
  });

  it("rejects literal private IPv4", async () => {
    const r = await isSafeOutboundUrl("https://192.168.1.1/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects AWS metadata IP", async () => {
    const r = await isSafeOutboundUrl("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects literal IPv6 loopback", async () => {
    const r = await isSafeOutboundUrl("https://[::1]/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv6");
  });

  it("rejects 'localhost' hostname", async () => {
    const r = await isSafeOutboundUrl("https://localhost/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname");
  });

  it("rejects malformed URL", async () => {
    const r = await isSafeOutboundUrl("not-a-url");
    expect(r.ok).toBe(false);
  });

  // Note: live DNS checks are non-deterministic in CI. We rely on the literal-IP
  // checks above for hermetic coverage. The DNS path is exercised in integration.
});
