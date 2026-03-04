import jwt from "jsonwebtoken";
import crypto from "crypto";

const SECRET = (() => {
  const s = process.env.PORTAL_JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PORTAL_JWT_SECRET must be set in production (at least 32 characters)");
  }
  console.warn("[portal-auth] PORTAL_JWT_SECRET not set or too short — using insecure dev fallback. Set it in .env for production.");
  return "dev-secret-change-in-production-unsafe";
})();
const TOKEN_TTL = "1h";

export function createPortalToken(payload: Record<string, unknown>): string {
  return jwt.sign(
    { ...payload, iat: Math.floor(Date.now() / 1000) },
    SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyPortalToken(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, SECRET) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hashLookupValue(value: string): string {
  return crypto
    .createHash("sha256")
    .update(String(value).toLowerCase().trim())
    .digest("hex");
}

/**
 * Remove expired LookupSessions older than the given age.
 * Call periodically (e.g. from a cron or on app startup) to prevent table bloat.
 */
export async function cleanupExpiredSessions(prisma: {
  lookupSession: { deleteMany: (args: { where: Record<string, unknown> }) => Promise<{ count: number }> };
}, maxAgeDays = 7): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const result = await prisma.lookupSession.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
