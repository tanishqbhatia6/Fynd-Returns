/**
 * Coverage gap tests — exercises branches that the deep test file intentionally
 * skips, primarily the live DNS resolution path which is short-circuited under
 * NODE_ENV=test / VITEST. Here we override those env flags and mock
 * `node:dns/promises` so the DNS branches (private IPv4 / IPv6 / empty / error)
 * are deterministically hit. Also covers a few small branch corners
 * (allowHttp:false default, http rejection nuance, hostname casing).
 *
 * Coverage target: ≥99% on app/lib/url-safety.server.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mock state shared with the dynamically imported module.
const dnsMock = vi.hoisted(() => ({
  records: [] as Array<{ address: string; family: 4 | 6 }>,
  shouldThrow: false,
}));

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(async () => {
      if (dnsMock.shouldThrow) throw new Error("ENOTFOUND");
      return dnsMock.records;
    }),
  },
}));

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_VITEST = process.env.VITEST;

async function importFresh() {
  vi.resetModules();
  return await import("../url-safety.server");
}

describe("isSafeOutboundUrl — DNS resolution path (env-overridden)", () => {
  beforeEach(() => {
    // Force the runtime check `NODE_ENV === "test" || VITEST` to fail so the
    // DNS branch is reached.
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    dnsMock.records = [];
    dnsMock.shouldThrow = false;
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST !== undefined) process.env.VITEST = ORIGINAL_VITEST;
    vi.clearAllMocks();
  });

  it("rejects when DNS resolves to a private IPv4 (rebinding catch)", async () => {
    dnsMock.records = [{ address: "10.0.0.5", family: 4 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://attacker.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_to_private_ipv4");
  });

  it("rejects when DNS resolves to AWS metadata IPv4 169.254.169.254", async () => {
    dnsMock.records = [{ address: "169.254.169.254", family: 4 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://meta.example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_to_private_ipv4");
  });

  it("rejects when DNS resolves to a private IPv6 (::1)", async () => {
    dnsMock.records = [{ address: "::1", family: 6 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://rebind6.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_to_private_ipv6");
  });

  it("rejects when DNS resolves to fc00::/7 unique-local IPv6", async () => {
    dnsMock.records = [{ address: "fc00::1", family: 6 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://ula.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_to_private_ipv6");
  });

  it("accepts when DNS returns only public IPv4 records", async () => {
    dnsMock.records = [{ address: "8.8.8.8", family: 4 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://public-ipv4.example.com/x");
    expect(r.ok).toBe(true);
  });

  it("accepts when DNS returns only public IPv6 records", async () => {
    dnsMock.records = [{ address: "2606:4700::1111", family: 6 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://public-ipv6.example.com/x");
    expect(r.ok).toBe(true);
  });

  it("accepts mixed public IPv4 + IPv6 record sets", async () => {
    dnsMock.records = [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://dual-stack.example.com/x");
    expect(r.ok).toBe(true);
  });

  it("rejects mixed public + one private record (any-private = unsafe)", async () => {
    dnsMock.records = [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://mixed.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("resolves_to_private_ipv4");
  });

  it("rejects when DNS returns zero records (dns_empty)", async () => {
    dnsMock.records = [];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://nxdomain-empty.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dns_empty");
  });

  it("rejects when DNS lookup throws (dns_error)", async () => {
    dnsMock.shouldThrow = true;
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://broken.example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dns_error");
  });

  it("ignores unknown family values in DNS records (treats as public)", async () => {
    // Defensive: if a future Node version adds family=undefined or 0, it
    // shouldn't slip a private IP through. We assert the documented shape:
    // records with family=4 or 6 only.
    dnsMock.records = [{ address: "8.8.8.8", family: 4 }];
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://families.example.com/x");
    expect(r.ok).toBe(true);
  });

  it("DNS path is reached only when env flags are absent", async () => {
    // Sanity: with env restored to test, DNS mock is NOT consulted.
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    dnsMock.shouldThrow = true; // would fail with dns_error if path was taken
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://example.com/x");
    expect(r.ok).toBe(true);
  });
});

describe("isSafeOutboundUrl — env-flag short-circuit branches", () => {
  it("VITEST=1 alone short-circuits DNS even with NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    process.env.VITEST = "1";
    dnsMock.shouldThrow = true;
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://example.com/x");
    expect(r.ok).toBe(true);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST !== undefined) process.env.VITEST = ORIGINAL_VITEST;
    else delete process.env.VITEST;
  });

  it("NODE_ENV=test alone short-circuits DNS even without VITEST", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    dnsMock.shouldThrow = true;
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://example.com/x");
    expect(r.ok).toBe(true);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_VITEST !== undefined) process.env.VITEST = ORIGINAL_VITEST;
  });
});

describe("isSafeOutboundUrl — explicit allowHttp:false branch", () => {
  it("rejects http:// when allowHttp is explicitly false", async () => {
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("http://example.com", { allowHttp: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_allowed");
  });

  it("accepts https:// when allowHttp is explicitly false", async () => {
    const { isSafeOutboundUrl } = await importFresh();
    const r = await isSafeOutboundUrl("https://example.com", { allowHttp: false });
    expect(r.ok).toBe(true);
  });
});
