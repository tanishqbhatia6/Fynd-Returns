import { timingSafeEqual } from "crypto";

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function safeCompareSecret(a: string, b: string): boolean {
  if (!a || !b) return false;

  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);

  if (aBuf.length !== bBuf.length) {
    const dummyLength = Math.max(aBuf.length, bBuf.length, 1);
    timingSafeEqual(Buffer.alloc(dummyLength, 0), Buffer.alloc(dummyLength, 0));
    return false;
  }

  return timingSafeEqual(aBuf, bBuf);
}

export function requestHostname(request: Request): string | null {
  const host = request.headers.get("host")?.trim();
  if (!host) return null;

  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalhostRequest(request: Request): boolean {
  const hostname = requestHostname(request);
  return hostname !== null && LOCALHOST_NAMES.has(hostname);
}

export function getCronTokens(request: Request): string[] {
  const tokens: string[] = [];

  const headerSecret = request.headers.get("x-cron-secret")?.trim();
  if (headerSecret) tokens.push(headerSecret);

  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) tokens.push(bearer);

  return tokens;
}

export function authorizeCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return process.env.NODE_ENV !== "production" && isLocalhostRequest(request);
  }

  return getCronTokens(request).some((token) => safeCompareSecret(token, secret));
}
