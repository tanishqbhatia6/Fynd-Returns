/**
 * API Key authentication middleware for external API endpoints.
 * Keys use format: rpm_ + 40 hex chars (160-bit entropy).
 * Stored as bcrypt hash; lookup by prefix + shopId then bcrypt verify.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import prisma from "../db.server";

const KEY_PREFIX_LEN = 8; // "rpm_a1b2"
const BCRYPT_ROUNDS = 10;

export type ApiKeyPermission = "read_returns" | "write_returns" | "read_settings" | "manage_webhooks";

export const ALL_PERMISSIONS: ApiKeyPermission[] = [
  "read_returns",
  "write_returns",
  "read_settings",
  "manage_webhooks",
];

export type AuthResult =
  | { ok: true; shopId: string; shopDomain: string; keyId: string }
  | { ok: false; response: Response };

/**
 * Generate a new API key. Returns { fullKey, keyPrefix, keyHash }.
 * The fullKey is shown exactly once to the user.
 */
export async function generateApiKey(): Promise<{
  fullKey: string;
  keyPrefix: string;
  keyHash: string;
}> {
  const random = crypto.randomBytes(20).toString("hex"); // 40 hex chars
  const fullKey = `rpm_${random}`;
  const keyPrefix = fullKey.substring(0, KEY_PREFIX_LEN);
  const keyHash = await bcrypt.hash(fullKey, BCRYPT_ROUNDS);
  return { fullKey, keyPrefix, keyHash };
}

/**
 * Authenticate an incoming request using the X-API-Key header.
 * Verifies the key, checks permissions, and returns the shop context.
 */
export async function authenticateApiKey(
  request: Request,
  requiredPermission: ApiKeyPermission,
): Promise<AuthResult> {
  const apiKey = request.headers.get("X-API-Key");
  if (!apiKey) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "UNAUTHORIZED", message: "Missing X-API-Key header" } },
        { status: 401 },
      ),
    };
  }

  const prefix = apiKey.substring(0, KEY_PREFIX_LEN);

  // Find candidate keys by prefix (indexed lookup)
  const candidates = await prisma.apiKey.findMany({
    where: {
      keyPrefix: prefix,
      isActive: true,
      revokedAt: null,
    },
    include: { shop: true },
  });

  if (candidates.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
        { status: 401 },
      ),
    };
  }

  // Verify bcrypt hash against each candidate
  for (const candidate of candidates) {
    const match = await bcrypt.compare(apiKey, candidate.keyHash);
    if (match) {
      // Check permission
      let permissions: string[] = [];
      try {
        permissions = JSON.parse(candidate.permissions);
      } catch { /* empty */ }

      if (!permissions.includes(requiredPermission)) {
        return {
          ok: false,
          response: Response.json(
            {
              error: {
                code: "FORBIDDEN",
                message: `API key lacks required permission: ${requiredPermission}`,
              },
            },
            { status: 403 },
          ),
        };
      }

      // Fire-and-forget: update lastUsedAt
      prisma.apiKey
        .update({ where: { id: candidate.id }, data: { lastUsedAt: new Date() } })
        .catch(() => { /* non-critical */ });

      return {
        ok: true,
        shopId: candidate.shopId,
        shopDomain: candidate.shop.shopDomain,
        keyId: candidate.id,
      };
    }
  }

  return {
    ok: false,
    response: Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
      { status: 401 },
    ),
  };
}
