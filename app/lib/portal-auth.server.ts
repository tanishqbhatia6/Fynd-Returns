import jwt from "jsonwebtoken";
import crypto from "crypto";

const SECRET = (() => {
  const s = process.env.PORTAL_JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PORTAL_JWT_SECRET must be set in production (at least 32 characters)");
  }
  console.warn(
    "[portal-auth] PORTAL_JWT_SECRET not set or too short — using insecure dev fallback. Set it in .env for production.",
  );
  return "dev-secret-change-in-production-unsafe";
})();
const TOKEN_TTL = "1h";
const CSRF_TTL = "30m"; // shorter — CSRF tokens just bind a session to a shop

export function createPortalToken(payload: Record<string, unknown>): string {
  return jwt.sign({ ...payload, iat: Math.floor(Date.now() / 1000) }, SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

export function verifyPortalToken(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, SECRET) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Issue a short-lived CSRF token bound to the requesting shop. Returned by the
 * order-lookup endpoint and required by all state-changing portal endpoints. Defends
 * against cross-origin POSTs that previously could exploit the *.myshopify.com CORS
 * regex (any subdomain) to forge return creations against unrelated stores.
 *
 * The token also carries the shop claim so it can validate the URL ?shop= matches
 * what the customer actually loaded — addresses the multi-shop isolation P0 finding
 * where ?shop= was trusted from the URL alone.
 */
export type PortalCsrfClaims = {
  csrf: true;
  shopDomain: string;
  /** ISO-day expiry — also enforced via JWT exp. */
  iat?: number;
};

export function createPortalCsrfToken(shopDomain: string): string {
  const claims: PortalCsrfClaims = { csrf: true, shopDomain };
  return jwt.sign(claims, SECRET, { expiresIn: CSRF_TTL });
}

export function verifyPortalCsrfToken(
  token: string | null | undefined,
  expectedShopDomain: string,
): boolean {
  if (!token) return false;
  try {
    const decoded = jwt.verify(token, SECRET) as Partial<PortalCsrfClaims>;
    if (decoded.csrf !== true) return false;
    if (decoded.shopDomain !== expectedShopDomain) return false;
    return true;
  } catch {
    return false;
  }
}

export function hashLookupValue(value: string): string {
  return crypto.createHash("sha256").update(String(value).toLowerCase().trim()).digest("hex");
}

/**
 * Remove expired LookupSessions older than the given age.
 * Call periodically (e.g. from a cron or on app startup) to prevent table bloat.
 */
export async function cleanupExpiredSessions(
  prisma: {
    lookupSession: {
      deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }>;
    };
  },
  maxAgeDays = 7,
): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const result = await prisma.lookupSession.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
