/**
 * Deep tests for encryption.server.ts: round-trip behaviour, looksEncrypted
 * detection, the tolerant encryptIfNeeded/decryptIfEncrypted helpers, and the
 * full key-rotation surface (active key, ENCRYPTION_KEYS_PREVIOUS fallbacks,
 * decryptWithRotationInfo). Storage rows pass through these helpers — a
 * regression here can corrupt every encrypted secret in the DB or cause
 * hard-to-trace decrypt failures during key rotation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);

/**
 * Re-import the module so it picks up the current process.env.* values.
 * encryption.server caches nothing across calls, but Node ESM caches the
 * module — resetModules forces a clean evaluation.
 */
async function freshModule() {
  const vi = await import("vitest");
  vi.vi.resetModules();
  return await import("../encryption.server");
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ENCRYPTION_KEY = KEY_A;
  delete process.env.ENCRYPTION_KEYS_PREVIOUS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("looksEncrypted", () => {
  it("returns false for null/undefined/empty/plain text/wrong segment count", async () => {
    const { looksEncrypted } = await freshModule();
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
    expect(looksEncrypted("")).toBe(false);
    expect(looksEncrypted("hello world")).toBe(false);
    expect(looksEncrypted("user@example.com")).toBe(false);
    expect(looksEncrypted("abc:def")).toBe(false); // 2 parts
    expect(looksEncrypted("ab:cd:ef:01")).toBe(false); // 4 parts
  });

  it("returns false when any segment contains non-hex chars", async () => {
    const { looksEncrypted } = await freshModule();
    expect(looksEncrypted("zzzz:abcd:1234")).toBe(false);
    expect(looksEncrypted("abcd:zzzz:1234")).toBe(false);
    expect(looksEncrypted("abcd:1234:zzzz")).toBe(false);
  });

  it("returns true for the iv:tag:data hex pattern (case-insensitive)", async () => {
    const { looksEncrypted, encrypt } = await freshModule();
    expect(looksEncrypted(encrypt("payload"))).toBe(true);
    expect(looksEncrypted("ABCDEF:0123:9876")).toBe(true);
    expect(looksEncrypted("abcdef:0123:9876")).toBe(true);
  });
});

describe("encrypt + decrypt round trip", () => {
  it("round-trips ASCII, unicode, emoji, and long input", async () => {
    const { encrypt, decrypt } = await freshModule();
    expect(decrypt(encrypt("hello world"))).toBe("hello world");
    const unicode = "héllo 你好 \u{1F600}\u{1F511}";
    expect(decrypt(encrypt(unicode))).toBe(unicode);
    const long = "x".repeat(20000);
    expect(decrypt(encrypt(long))).toBe(long);
  });

  it("round-trips JSON-shaped strings without mangling colons in plaintext", async () => {
    const { encrypt, decrypt } = await freshModule();
    const payload = JSON.stringify({ url: "https://example.com:443/path", n: 42 });
    expect(decrypt(encrypt(payload))).toBe(payload);
  });

  it("produces a fresh ciphertext each call thanks to the random IV", async () => {
    const { encrypt, decrypt } = await freshModule();
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same input");
    expect(decrypt(b)).toBe("same input");
  });

  it("ciphertext shape is iv(32 hex):tag(32 hex):data(hex)", async () => {
    const { encrypt } = await freshModule();
    const parts = encrypt("payload").split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });
});

describe("decrypt error handling", () => {
  it("throws on malformed ciphertext (wrong segment count or empty parts)", async () => {
    const { decrypt } = await freshModule();
    expect(() => decrypt("only-one")).toThrow("Invalid encrypted format");
    expect(() => decrypt("two:parts")).toThrow("Invalid encrypted format");
    expect(() => decrypt(":tag:data")).toThrow("Invalid encrypted format");
    expect(() => decrypt("iv::data")).toThrow("Invalid encrypted format");
    expect(() => decrypt("iv:tag:")).toThrow("Invalid encrypted format");
  });

  it("throws when the auth tag is tampered (GCM integrity check)", async () => {
    const { encrypt, decrypt } = await freshModule();
    const [iv, tag, data] = encrypt("secret").split(":");
    const flipped = (tag[0] === "a" ? "b" : "a") + tag.slice(1);
    expect(() => decrypt(`${iv}:${flipped}:${data}`)).toThrow();
  });
});

describe("encryptIfNeeded", () => {
  it("returns null for null/undefined/empty", async () => {
    const { encryptIfNeeded } = await freshModule();
    expect(encryptIfNeeded(null)).toBeNull();
    expect(encryptIfNeeded(undefined)).toBeNull();
    expect(encryptIfNeeded("")).toBeNull();
  });

  it("encrypts plaintext", async () => {
    const { encryptIfNeeded, looksEncrypted, decrypt } = await freshModule();
    const out = encryptIfNeeded("plain-secret")!;
    expect(looksEncrypted(out)).toBe(true);
    expect(decrypt(out)).toBe("plain-secret");
  });

  it("is idempotent on already-encrypted input (does not double-encrypt)", async () => {
    const { encrypt, encryptIfNeeded, decrypt } = await freshModule();
    const ct = encrypt("once");
    const ct2 = encryptIfNeeded(ct);
    expect(ct2).toBe(ct);
    expect(decrypt(ct2!)).toBe("once");
  });
});

describe("decryptIfEncrypted", () => {
  it("returns null for null/undefined/empty and passes plaintext through unchanged", async () => {
    const { decryptIfEncrypted } = await freshModule();
    expect(decryptIfEncrypted(null)).toBeNull();
    expect(decryptIfEncrypted(undefined)).toBeNull();
    expect(decryptIfEncrypted("")).toBeNull();
    expect(decryptIfEncrypted("plain-string")).toBe("plain-string");
    expect(decryptIfEncrypted("user@example.com")).toBe("user@example.com");
  });

  it("decrypts a real ciphertext", async () => {
    const { encrypt, decryptIfEncrypted } = await freshModule();
    const ct = encrypt("smtp-password");
    expect(decryptIfEncrypted(ct)).toBe("smtp-password");
  });

  it("returns null when a value matches the format but cannot be decrypted", async () => {
    const { decryptIfEncrypted } = await freshModule();
    // Three hex segments matching the regex but not actually a valid ciphertext.
    const fake = `${"00".repeat(16)}:${"11".repeat(16)}:${"22".repeat(8)}`;
    expect(decryptIfEncrypted(fake)).toBeNull();
  });
});

describe("key rotation via ENCRYPTION_KEYS_PREVIOUS", () => {
  it("encrypt always uses the active key and round-trips", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { encrypt, decrypt } = await freshModule();
    expect(decrypt(encrypt("hi"))).toBe("hi");
  });

  it("decrypt falls back to a retired key after rotation", async () => {
    // Encrypt with KEY_B as the only active key.
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const ct = encryptB("legacy-value");

    // Rotate: KEY_A active, KEY_B retired.
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { decrypt } = await freshModule();
    expect(decrypt(ct)).toBe("legacy-value");
  });

  it("decryptWithRotationInfo flags retired-key use for lazy re-encryption", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const oldCt = encryptB("rotateme");

    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { encrypt: encryptA, decryptWithRotationInfo } = await freshModule();
    const oldRes = decryptWithRotationInfo(oldCt);
    expect(oldRes).toEqual({ plaintext: "rotateme", usedRetiredKey: true });

    const newCt = encryptA("rotateme");
    const newRes = decryptWithRotationInfo(newCt);
    expect(newRes).toEqual({ plaintext: "rotateme", usedRetiredKey: false });
  });

  it("supports a comma-separated list of retired keys", async () => {
    // Encrypt with KEY_C — two rotations ago.
    process.env.ENCRYPTION_KEY = KEY_C;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptC } = await freshModule();
    const ct = encryptC("two-back");

    // KEY_A active; both B and C retired.
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = `${KEY_B},${KEY_C}`;
    const { decrypt } = await freshModule();
    expect(decrypt(ct)).toBe("two-back");
  });

  it("ignores blank/whitespace entries in ENCRYPTION_KEYS_PREVIOUS", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const ct = encryptB("blanks-ok");

    process.env.ENCRYPTION_KEY = KEY_A;
    // Whitespace and empty entries between commas must be tolerated.
    process.env.ENCRYPTION_KEYS_PREVIOUS = `  ,  ,${KEY_B}, `;
    const { decrypt } = await freshModule();
    expect(decrypt(ct)).toBe("blanks-ok");
  });

  it("silently skips malformed retired keys (wrong length / non-hex)", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const ct = encryptB("skip-bad-keys");

    process.env.ENCRYPTION_KEY = KEY_A;
    // First entry is too short, second contains non-hex; both should be dropped.
    process.env.ENCRYPTION_KEYS_PREVIOUS = `deadbeef,zzzz${"z".repeat(60)},${KEY_B}`;
    const { decrypt } = await freshModule();
    expect(decrypt(ct)).toBe("skip-bad-keys");
  });

  it("throws when no configured key can decrypt the value", async () => {
    process.env.ENCRYPTION_KEY = KEY_C;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptC } = await freshModule();
    const ct = encryptC("locked-out");

    // Drop key C completely — only KEY_A configured.
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { decrypt, decryptWithRotationInfo } = await freshModule();
    expect(() => decrypt(ct)).toThrow();
    expect(() => decryptWithRotationInfo(ct)).toThrow("Decryption failed with all keys");
  });
});

describe("assertEncryptionConfigured", () => {
  it("does not throw when ENCRYPTION_KEY is a valid 64-hex string", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    const { assertEncryptionConfigured } = await freshModule();
    expect(() => assertEncryptionConfigured()).not.toThrow();
  });

  it("does not throw in dev/test even when ENCRYPTION_KEY is unset (falls back to dev key)", async () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = "test";
    const { assertEncryptionConfigured } = await freshModule();
    expect(() => assertEncryptionConfigured()).not.toThrow();
  });
});
