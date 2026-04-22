import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH_HEX = 64; // 32 bytes = 64 hex chars

// Encrypted values use this format: `<ivHex>:<tagHex>:<dataHex>`. We treat any string
// matching this pattern (3 hex segments separated by colons) as already-encrypted so
// idempotent re-encrypts don't double-encrypt and re-decrypts of plaintext don't crash.
const ENCRYPTED_FORMAT_RE = /^[0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+$/;

export function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  return ENCRYPTED_FORMAT_RE.test(value);
}

/** Boot-time validation. Call from instrumentation/root so misconfig fails fast. */
export function assertEncryptionConfigured(): void {
  // Throws if misconfigured. Uses getKey() which raises the descriptive error.
  getKey();
}

/**
 * Validates ENCRYPTION_KEY: must be exactly 64 hex characters (32 bytes).
 * In production, key is required. In development, a dev key is used only when
 * NODE_ENV is explicitly "development".
 */
function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY?.trim();
  const env = (process.env.NODE_ENV ?? "").toLowerCase();
  const isProd = env === "production";
  // Treat anything that isn't *literally* "development" or "test" as production-
  // grade (staging, preview, qa, etc.). The previous implementation accepted ANY
  // non-"production" env as eligible for the dev-key fallback, which silently
  // weakened encryption on staging and made a leaked staging DB trivially
  // decryptable (P2 finding from QA audit).
  const isDevOrTest = env === "development" || env === "test";

  if (isProd || !isDevOrTest) {
    if (!key || key.length !== KEY_LENGTH_HEX || !/^[0-9a-fA-F]+$/.test(key)) {
      throw new Error(
        `ENCRYPTION_KEY must be set in NODE_ENV="${env || "(unset)"}" (treated as production): 64 hex chars (32 bytes). Run: openssl rand -hex 32`,
      );
    }
    return Buffer.from(key, "hex");
  }

  if (key && key.length === KEY_LENGTH_HEX && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, "hex");
  }

  // Dev/test only.
  console.warn("[encryption] Using insecure dev key. Set ENCRYPTION_KEY for real encryption.");
  return Buffer.alloc(32, "dev-key-change-in-production");
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

/**
 * Tolerant variant: decrypts if the value looks encrypted, otherwise returns the
 * value as-is. Used during the SMTP-creds rollout while pre-existing plaintext rows
 * are migrated lazily on next save. Once the backfill completes, callers can switch
 * back to plain `decrypt()`.
 */
export function decryptIfEncrypted(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!looksEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch {
    // Decryption failed (likely a value that incidentally matches the format but
    // isn't actually encrypted, or a key-rotation scenario). Treat as opaque.
    return null;
  }
}

/** Encrypt only if not already encrypted — safe to call repeatedly. */
export function encryptIfNeeded(value: string | null | undefined): string | null {
  if (!value) return null;
  if (looksEncrypted(value)) return value;
  return encrypt(value);
}
