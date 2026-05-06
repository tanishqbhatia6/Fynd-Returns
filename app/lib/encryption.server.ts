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
 * Validates a hex-encoded 32-byte (64 hex chars) AES key.
 */
function parseHexKey(raw: string | null | undefined): Buffer | null {
  const k = raw?.trim();
  if (!k || k.length !== KEY_LENGTH_HEX || !/^[0-9a-fA-F]+$/.test(k)) return null;
  return Buffer.from(k, "hex");
}

/**
 * Returns the active (current) key + any retired keys retained for the rotation
 * window. New ciphertext is always written with the active key. Decryption tries
 * the active key first, then each retired key in order — a successful decrypt
 * with a retired key signals to the caller that the value should be re-written.
 *
 * Configuration:
 *   ENCRYPTION_KEY            — current/active key (required in non-dev envs)
 *   ENCRYPTION_KEYS_PREVIOUS  — comma-separated list of retired keys still
 *                                accepted for decrypt (e.g. "abc...,def...")
 *
 * Rotation flow:
 *   1. Generate new key, set ENCRYPTION_KEYS_PREVIOUS=<old key>
 *      and ENCRYPTION_KEY=<new key>. Deploy.
 *   2. Run scripts/backfill-rotate-secrets.mjs to re-encrypt every stored
 *      secret with the new key.
 *   3. Once backfill confirmed, drop ENCRYPTION_KEYS_PREVIOUS. Deploy.
 */
function getKeyRing(): { active: Buffer; retired: Buffer[] } {
  const env = (process.env.NODE_ENV ?? "").toLowerCase();
  const isDevOrTest = env === "development" || env === "test";

  const active = parseHexKey(process.env.ENCRYPTION_KEY);
  if (!active) {
    if (isDevOrTest) {
      console.warn("[encryption] Using insecure dev key. Set ENCRYPTION_KEY for real encryption.");
      // Buffer.alloc(32, str) only fills with the FIRST byte of `str`, so this
      // produces 32 copies of 0x64 ("d"). It's deliberately weak and used only
      // when ENCRYPTION_KEY is unset in dev/test. Use Buffer.from(...).slice
      // to spread the literal bytes for slightly better dev-mode entropy and
      // make the intent explicit.
      const seed = Buffer.from("dev-key-change-in-production-padding-32b").subarray(0, 32);
      return { active: seed, retired: [] };
    }
    throw new Error(
      `ENCRYPTION_KEY must be set in NODE_ENV="${env || "(unset)"}" (treated as production): 64 hex chars (32 bytes). Run: openssl rand -hex 32`,
    );
  }

  const retiredRaw = process.env.ENCRYPTION_KEYS_PREVIOUS?.trim() ?? "";
  const retired: Buffer[] = retiredRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseHexKey(s))
    .filter((b): b is Buffer => b != null);

  return { active, retired };
}

/**
 * Backwards-compat single-key getter — returns the active key. New callers
 * should use getKeyRing() to support rotation.
 */
function getKey(): Buffer {
  return getKeyRing().active;
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

/**
 * Decrypt with key rotation support. Tries the active key first, then any
 * retired keys in order. Throws if no key works.
 */
export function decrypt(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, data] = parts;
  if (!ivHex || !tagHex || !data) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const ring = getKeyRing();
  const candidates = [ring.active, ...ring.retired];
  let lastErr: unknown = null;
  for (const key of candidates) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
    } catch (err) {
      lastErr = err;
      // GCM auth tag mismatch — try the next key.
    }
  }
  /* v8 ignore start */
  // defensive: lastErr set to caught err in loop above is always Error; non-Error fall-through unreachable
  throw lastErr instanceof Error ? lastErr : new Error("Decryption failed with all keys");
  /* v8 ignore stop */
}

/**
 * Like decrypt() but also returns whether the value was decrypted with a retired
 * key. Callers can use this to opportunistically re-encrypt with the active key
 * (lazy rotation — a save during normal operation upgrades the row).
 */
export function decryptWithRotationInfo(encrypted: string): { plaintext: string; usedRetiredKey: boolean } {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted format");
  const [ivHex, tagHex, data] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const ring = getKeyRing();
  // Try active key first.
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, ring.active, iv);
    decipher.setAuthTag(tag);
    return {
      plaintext: decipher.update(data, "hex", "utf8") + decipher.final("utf8"),
      usedRetiredKey: false,
    };
  } catch { /* fall through */ }
  // Try retired keys.
  for (const key of ring.retired) {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return {
        plaintext: decipher.update(data, "hex", "utf8") + decipher.final("utf8"),
        usedRetiredKey: true,
      };
    } catch { /* try next */ }
  }
  throw new Error("Decryption failed with all keys");
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
