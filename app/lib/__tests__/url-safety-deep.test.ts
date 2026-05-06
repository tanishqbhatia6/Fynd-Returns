/**
 * Deep SSRF guard tests — every "internal" address an attacker might point a
 * webhook at must be rejected. Public hostnames must pass. Covers HTTPS-only
 * enforcement, all RFC 1918 / loopback / link-local / CGNAT / metadata /
 * multicast / IPv6-ULA / IPv6 link-local / IPv4-mapped IPv6 paths, plus DNS
 * rebinding posture (same module re-resolves at fetch time; here we lock in
 * the literal-IP fast path).
 */
import { describe, it, expect } from "vitest";
import { isPrivateIPv4, isPrivateIPv6, isSafeOutboundUrl } from "../url-safety.server";

describe("isPrivateIPv4 — private ranges", () => {
  const PRIVATE: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback boundary"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.0", "RFC 1918 10/8 lo"],
    ["10.255.255.255", "RFC 1918 10/8 hi"],
    ["172.16.0.0", "RFC 1918 172.16/12 lo"],
    ["172.31.255.255", "RFC 1918 172.16/12 hi"],
    ["192.168.0.0", "RFC 1918 192.168/16 lo"],
    ["192.168.255.255", "RFC 1918 192.168/16 hi"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "AWS/GCP/Azure IMDS"],
    ["100.64.0.1", "CGNAT (RFC 6598)"],
    ["100.127.255.255", "CGNAT hi"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast hi"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["198.18.0.1", "benchmark"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
  ];
  for (const [ip, label] of PRIVATE) {
    it(`flags ${ip} as private (${label})`, () => {
      expect(isPrivateIPv4(ip)).toBe(true);
    });
  }
});

describe("isPrivateIPv4 — public ranges", () => {
  const PUBLIC: string[] = [
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1",
    "172.15.255.255", // just below RFC 1918 172.16/12
    "172.32.0.1", // just above RFC 1918 172.16/12
    "100.63.255.255", // just below CGNAT
    "100.128.0.0", // just above CGNAT
    "203.0.114.1", // just above TEST-NET-3
  ];
  for (const ip of PUBLIC) {
    it(`accepts ${ip} as public`, () => {
      expect(isPrivateIPv4(ip)).toBe(false);
    });
  }

  it("returns false for malformed IPv4 strings", () => {
    expect(isPrivateIPv4("not.an.ip.addr")).toBe(false);
    expect(isPrivateIPv4("999.0.0.1")).toBe(false);
    expect(isPrivateIPv4("1.2.3")).toBe(false);
    expect(isPrivateIPv4("")).toBe(false);
  });
});

describe("isPrivateIPv6", () => {
  it("flags ::1 loopback", () => expect(isPrivateIPv6("::1")).toBe(true));
  it("flags :: unspecified", () => expect(isPrivateIPv6("::")).toBe(true));
  it("flags fc00::/7 unique-local (fc prefix)", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fcab:cd::1")).toBe(true);
  });
  it("flags fd00::/8 unique-local (fd prefix)", () => {
    expect(isPrivateIPv6("fd12:3456:789a::1")).toBe(true);
  });
  it("flags fe80::/10 link-local", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("FE80::abcd")).toBe(true); // case-insensitive
  });
  it("flags ff00::/8 multicast", () => {
    expect(isPrivateIPv6("ff02::1")).toBe(true);
  });
  it("flags ::ffff: IPv4-mapped loopback", () => {
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
  });
  it("flags ::ffff: IPv4-mapped RFC 1918", () => {
    expect(isPrivateIPv6("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
  });
  it("treats global 2001:db8::/32 as public", () => {
    // Documentation prefix — not in our private set, so callable as "public".
    expect(isPrivateIPv6("2001:db8::1")).toBe(false);
  });
  it("treats global 2606:4700:: as public (Cloudflare)", () => {
    expect(isPrivateIPv6("2606:4700::1111")).toBe(false);
  });
});

describe("isSafeOutboundUrl — scheme enforcement", () => {
  it("rejects http:// by default (HTTPS required)", async () => {
    const r = await isSafeOutboundUrl("http://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("permits http:// when allowHttp:true is set", async () => {
    const r = await isSafeOutboundUrl("http://example.com", { allowHttp: true });
    expect(r.ok).toBe(true);
  });

  it("rejects javascript: scheme", async () => {
    const r = await isSafeOutboundUrl("javascript:alert(1)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("rejects file: scheme", async () => {
    const r = await isSafeOutboundUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("rejects ftp: scheme even with allowHttp", async () => {
    const r = await isSafeOutboundUrl("ftp://example.com/x", { allowHttp: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("rejects gopher: scheme", async () => {
    const r = await isSafeOutboundUrl("gopher://example.com/");
    expect(r.ok).toBe(false);
  });

  it("accepts https:// to a public hostname", async () => {
    const r = await isSafeOutboundUrl("https://example.com/webhook");
    expect(r.ok).toBe(true);
  });
});

describe("isSafeOutboundUrl — malformed inputs", () => {
  it("rejects garbage strings", async () => {
    const r = await isSafeOutboundUrl("not-a-url");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects empty string", async () => {
    const r = await isSafeOutboundUrl("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects URL missing scheme (relative path)", async () => {
    const r = await isSafeOutboundUrl("//example.com/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });

  it("rejects bare scheme with no host (https://)", async () => {
    const r = await isSafeOutboundUrl("https://");
    expect(r.ok).toBe(false);
  });
});

describe("isSafeOutboundUrl — private hostnames", () => {
  it("rejects localhost", async () => {
    const r = await isSafeOutboundUrl("https://localhost/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname");
  });

  it("rejects ip6-localhost", async () => {
    const r = await isSafeOutboundUrl("https://ip6-localhost/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname");
  });

  it("rejects ip6-loopback", async () => {
    const r = await isSafeOutboundUrl("https://ip6-loopback/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname");
  });

  it("is case-insensitive for the hostname check", async () => {
    const r = await isSafeOutboundUrl("https://LOCALHOST/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_hostname");
  });
});

describe("isSafeOutboundUrl — IPv4 literals", () => {
  it("rejects 127.0.0.1 loopback", async () => {
    const r = await isSafeOutboundUrl("https://127.0.0.1/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects 10.0.0.1 RFC 1918", async () => {
    const r = await isSafeOutboundUrl("https://10.0.0.1/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects 172.16.0.1 RFC 1918", async () => {
    const r = await isSafeOutboundUrl("https://172.16.0.1/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects 192.168.1.1 RFC 1918", async () => {
    const r = await isSafeOutboundUrl("https://192.168.1.1/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects 169.254.169.254 cloud metadata IMDS", async () => {
    const r = await isSafeOutboundUrl("https://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("rejects 100.64.0.1 CGNAT", async () => {
    const r = await isSafeOutboundUrl("https://100.64.0.1/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });

  it("accepts a public IPv4 literal (8.8.8.8)", async () => {
    const r = await isSafeOutboundUrl("https://8.8.8.8/x");
    expect(r.ok).toBe(true);
  });
});

describe("isSafeOutboundUrl — IPv6 literals", () => {
  it("rejects [::1] bracketed loopback", async () => {
    const r = await isSafeOutboundUrl("https://[::1]/hook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv6");
  });

  it("rejects [fc00::1] unique-local", async () => {
    const r = await isSafeOutboundUrl("https://[fc00::1]/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv6");
  });

  it("rejects [fe80::1] link-local", async () => {
    const r = await isSafeOutboundUrl("https://[fe80::1]/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv6");
  });

  it("rejects [::ffff:127.0.0.1] IPv4-mapped loopback (rebinding bypass attempt)", async () => {
    const r = await isSafeOutboundUrl("https://[::ffff:127.0.0.1]/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv6");
  });

  it("accepts a public IPv6 literal (Cloudflare)", async () => {
    const r = await isSafeOutboundUrl("https://[2606:4700::1111]/x");
    expect(r.ok).toBe(true);
  });
});

describe("isSafeOutboundUrl — DNS rebinding posture", () => {
  // The DNS resolution step is intentionally short-circuited under NODE_ENV=test
  // / VITEST so unit tests are hermetic. We assert the contract: under test env,
  // unknown hostnames return ok:true (the literal-IP / private-hostname checks
  // already covered the SSRF surface; the live DNS path is exercised in
  // integration). This locks in the behaviour so a future change can't silently
  // start hitting real DNS during unit runs.
  it("public-looking hostname passes under test env (DNS path skipped)", async () => {
    const r = await isSafeOutboundUrl("https://example.com/webhook");
    expect(r.ok).toBe(true);
  });

  it("subdomain of a public host passes under test env", async () => {
    const r = await isSafeOutboundUrl("https://api.stripe.com/v1/webhooks");
    expect(r.ok).toBe(true);
  });

  it("URL with port passes when scheme + host are valid", async () => {
    const r = await isSafeOutboundUrl("https://example.com:8443/x");
    expect(r.ok).toBe(true);
  });

  it("rejects literal IP regardless of DNS — fast path before resolve", async () => {
    // A rebinding attacker can't slip a private IP past us by encoding it as a
    // literal: the regex match short-circuits the DNS path entirely.
    const r = await isSafeOutboundUrl("https://192.168.0.50/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private_ipv4");
  });
});
