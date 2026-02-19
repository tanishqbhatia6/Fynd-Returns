import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH_HEX = 64; // 32 bytes = 64 hex chars

/**
 * Validates ENCRYPTION_KEY: must be exactly 64 hex characters (32 bytes).
 * In production, key is required. In development, a dev key is used only when
 * NODE_ENV is explicitly "development".
 */
function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY?.trim();
  const isProd = process.env.NODE_ENV === "production";

  if (isProd) {
    if (!key || key.length !== KEY_LENGTH_HEX || !/^[0-9a-fA-F]+$/.test(key)) {
      throw new Error(
        "ENCRYPTION_KEY must be set in production: 64 hex chars (32 bytes). Run: openssl rand -hex 32"
      );
    }
    return Buffer.from(key, "hex");
  }

  if (key && key.length === KEY_LENGTH_HEX && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }

  if (process.env.NODE_ENV === "development") {
    console.warn("[encryption] Using dev key. Set ENCRYPTION_KEY for real encryption.");
    return Buffer.alloc(32, "dev-key-change-in-production");
  }

  throw new Error(
    "ENCRYPTION_KEY required. Set 64 hex chars (openssl rand -hex 32) or NODE_ENV=development for dev."
  );
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const key = getKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, data] = parts;
  if (!ivHex || !tagHex || !data) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}
