import jwt from "jsonwebtoken";
import crypto from "crypto";

const SECRET = process.env.PORTAL_JWT_SECRET || "dev-secret-change-in-production";
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
