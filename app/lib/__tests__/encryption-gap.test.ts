/**
 * Coverage-gap tests for encryption.server.ts.
 *
 * Targets the residual uncovered branches not exercised by encryption-deep,
 * encryption.rotation, encryption.test, or encryption.write-only:
 *   - Production-mode throw when ENCRYPTION_KEY is missing or invalid
 *     (the descriptive boot-time error path).
 *   - parseHexKey rejection of values with the wrong length / non-hex chars
 *     (covered indirectly by retired-key tests, but pinned here for the
 *     active-key path too).
 *   - assertEncryptionConfigured surfacing the prod misconfig error.
 *   - decryptWithRotationInfo rejecting auth-tag tampering on both the
 *     active key and a retired-key fallback (AAD/integrity rejection).
 *   - decryptIfEncrypted swallowing failures from a structurally valid but
 *     wrong-key ciphertext after rotation has dropped the original key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

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

describe("production-mode key validation", () => {
  it("throws a descriptive error when ENCRYPTION_KEY is unset in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ENCRYPTION_KEY;
    const { encrypt, assertEncryptionConfigured } = await freshModule();
    expect(() => encrypt("anything")).toThrow(/ENCRYPTION_KEY must be set/);
    expect(() => assertEncryptionConfigured()).toThrow(/ENCRYPTION_KEY must be set/);
  });

  it("throws when ENCRYPTION_KEY is set but the wrong length (production)", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "abcd"; // valid hex, wrong length — parseHexKey returns null
    const { assertEncryptionConfigured } = await freshModule();
    expect(() => assertEncryptionConfigured()).toThrow(/ENCRYPTION_KEY must be set/);
  });

  it("throws when ENCRYPTION_KEY contains non-hex chars (production)", async () => {
    process.env.NODE_ENV = "production";
    process.env.ENCRYPTION_KEY = "z".repeat(64); // right length, not hex
    const { assertEncryptionConfigured } = await freshModule();
    expect(() => assertEncryptionConfigured()).toThrow(/ENCRYPTION_KEY must be set/);
  });

  it("throws when NODE_ENV is unset (treated as production)", async () => {
    delete process.env.NODE_ENV;
    delete process.env.ENCRYPTION_KEY;
    const { assertEncryptionConfigured } = await freshModule();
    expect(() => assertEncryptionConfigured()).toThrow(/treated as production/);
  });

  it("trims surrounding whitespace on a valid ENCRYPTION_KEY", async () => {
    process.env.ENCRYPTION_KEY = `  ${KEY_A}  `;
    const { encrypt, decrypt } = await freshModule();
    expect(decrypt(encrypt("trimmed"))).toBe("trimmed");
  });
});

describe("AAD/auth-tag tampering rejection", () => {
  it("decryptWithRotationInfo throws when both active and retired keys reject the tampered tag", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { encrypt, decryptWithRotationInfo } = await freshModule();
    const ct = encrypt("payload");
    const [iv, tag, data] = ct.split(":");
    const flippedTag = (tag[0] === "0" ? "1" : "0") + tag.slice(1);
    expect(() => decryptWithRotationInfo(`${iv}:${flippedTag}:${data}`)).toThrow(
      "Decryption failed with all keys",
    );
  });

  it("decryptWithRotationInfo round-trips active-key ciphertext when retired keys are present", async () => {
    // Exercises the active-key success path inside decryptWithRotationInfo
    // when at least one retired key is configured.
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { encrypt, decryptWithRotationInfo } = await freshModule();
    const ct = encrypt("active-path");
    expect(decryptWithRotationInfo(ct)).toEqual({
      plaintext: "active-path",
      usedRetiredKey: false,
    });
  });
});

describe("malformed ciphertext fallbacks", () => {
  it("decryptWithRotationInfo throws on malformed ciphertext (bad segment count)", async () => {
    const { decryptWithRotationInfo } = await freshModule();
    expect(() => decryptWithRotationInfo("only-one")).toThrow("Invalid encrypted format");
    expect(() => decryptWithRotationInfo("a:b:c:d")).toThrow("Invalid encrypted format");
  });

  it("decryptIfEncrypted swallows decrypt errors after a key was dropped without retention", async () => {
    // Encrypt under KEY_B then rotate to KEY_A with no retained keys —
    // the value still LOOKS encrypted but cannot be decrypted; the helper
    // must return null instead of throwing.
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const oldCt = encryptB("orphaned-row");

    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { decryptIfEncrypted } = await freshModule();
    expect(decryptIfEncrypted(oldCt)).toBeNull();
  });
});
