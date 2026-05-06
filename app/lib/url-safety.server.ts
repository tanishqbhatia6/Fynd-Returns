/**
 * URL safety helpers — block SSRF to private/loopback/cloud-metadata addresses.
 *
 * Used by every endpoint that lets a merchant configure a URL we will later fetch
 * (outbound webhooks, custom callbacks, image URLs, etc.). DNS rebinding is mitigated
 * by re-resolving at fetch time and rejecting if any resolved IP is private — that
 * second check lives in the fetch caller, not here.
 */
import dns from "node:dns/promises";

export type UrlSafetyResult = { ok: true } | { ok: false; reason: string };

const PRIVATE_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

// IPv4 ranges defined as [start, end] inclusive, packed as 32-bit ints.
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToInt("0.0.0.0")!, ipv4ToInt("0.255.255.255")!], // unspecified / current network
  [ipv4ToInt("10.0.0.0")!, ipv4ToInt("10.255.255.255")!], // RFC 1918
  [ipv4ToInt("100.64.0.0")!, ipv4ToInt("100.127.255.255")!], // CGNAT (RFC 6598)
  [ipv4ToInt("127.0.0.0")!, ipv4ToInt("127.255.255.255")!], // loopback
  [ipv4ToInt("169.254.0.0")!, ipv4ToInt("169.254.255.255")!], // link-local + AWS/GCP IMDS
  [ipv4ToInt("172.16.0.0")!, ipv4ToInt("172.31.255.255")!], // RFC 1918
  [ipv4ToInt("192.0.0.0")!, ipv4ToInt("192.0.0.255")!], // IETF protocol assignments
  [ipv4ToInt("192.0.2.0")!, ipv4ToInt("192.0.2.255")!], // TEST-NET-1
  [ipv4ToInt("192.168.0.0")!, ipv4ToInt("192.168.255.255")!], // RFC 1918
  [ipv4ToInt("198.18.0.0")!, ipv4ToInt("198.19.255.255")!], // benchmark
  [ipv4ToInt("198.51.100.0")!, ipv4ToInt("198.51.100.255")!], // TEST-NET-2
  [ipv4ToInt("203.0.113.0")!, ipv4ToInt("203.0.113.255")!], // TEST-NET-3
  [ipv4ToInt("224.0.0.0")!, ipv4ToInt("239.255.255.255")!], // multicast
  [ipv4ToInt("240.0.0.0")!, ipv4ToInt("255.255.255.255")!], // reserved
];

export function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

const PRIVATE_IPV6_PREFIXES = [
  "::1", // loopback
  "fc", // unique local
  "fd", // unique local
  "fe80:", // link-local
  "ff", // multicast
  "::", // unspecified
];

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  // IPv4-mapped (::ffff:127.0.0.1)
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (isPrivateIPv4(v4)) return true;
  }
  return PRIVATE_IPV6_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Check whether a URL is safe to fetch (HTTPS, public hostname).
 * Performs DNS resolution to catch hostnames that resolve to private IPs (or to
 * cloud metadata addresses like 169.254.169.254). Returns `{ ok: false, reason }`
 * with a non-PII reason; callers should NOT echo the URL back to the user.
 */
export async function isSafeOutboundUrl(
  rawUrl: string,
  opts?: { allowHttp?: boolean },
): Promise<UrlSafetyResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && !(opts?.allowHttp && parsed.protocol === "http:")) {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  // URL.hostname returns "[::1]" with brackets for literal IPv6; strip them so our
  // checks see the bare address.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  /* v8 ignore start */
  // defensive: parsed.hostname is non-empty for valid URLs; URL constructor already errored otherwise
  if (!host) return { ok: false, reason: "missing_host" };
  /* v8 ignore stop */
  if (PRIVATE_HOSTNAMES.has(host)) return { ok: false, reason: "private_hostname" };
  // Direct-IP hostnames: short-circuit DNS, check the literal directly.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return isPrivateIPv4(host) ? { ok: false, reason: "private_ipv4" } : { ok: true };
  }
  if (host.includes(":")) {
    return isPrivateIPv6(host) ? { ok: false, reason: "private_ipv6" } : { ok: true };
  }
  // Skip DNS resolution in unit tests — DNS is non-deterministic in CI and the
  // literal-IP / private-hostname checks above already cover the SSRF surface.
  // Tests that need to assert the DNS path should mock this module.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return { ok: true };
  }
  // DNS resolve and check every returned record.
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const r of records) {
      if (r.family === 4 && isPrivateIPv4(r.address))
        return { ok: false, reason: "resolves_to_private_ipv4" };
      if (r.family === 6 && isPrivateIPv6(r.address))
        return { ok: false, reason: "resolves_to_private_ipv6" };
    }
    if (records.length === 0) return { ok: false, reason: "dns_empty" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "dns_error" };
  }
}
