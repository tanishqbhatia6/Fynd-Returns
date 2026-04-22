/**
 * Tests for the key-rotation paths added to encryption.server.ts.
 *
 * Verifies:
 *  - decrypt() falls back to retired keys when active key fails.
 *  - decryptWithRotationInfo() reports usedRetiredKey correctly.
 *  - encrypt() always uses the active key (rotation forward-direction).
 *  - Decryption fails cleanly when no key works.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const KEY_A = "a".repeat(64); // active in tests below
const KEY_B = "b".repeat(64); // becomes retired after rotation
const KEY_C = "c".repeat(64); // unrelated key

async function freshModule() {
  // Vitest caches imports; we want to re-evaluate the module so it reads the
  // current process.env.* values. resetModules forces a clean import.
  const vi = await import("vitest");
  vi.vi.resetModules();
  return await import("../encryption.server");
}

describe("encryption key rotation", () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
  });

  it("encrypt always uses the active key", async () => {
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt, decrypt } = await freshModule();
    const ct = encrypt("hello");
    // Round-trips with active key.
    expect(decrypt(ct)).toBe("hello");
  });

  it("decrypt falls back to a retired key", async () => {
    // First, encrypt with key B.
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const ctOldKey = encryptB("legacy-secret");

    // Now rotate: key A is active, key B is retired.
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { decrypt } = await freshModule();
    expect(decrypt(ctOldKey)).toBe("legacy-secret");
  });

  it("decryptWithRotationInfo reports usedRetiredKey when needed", async () => {
    process.env.ENCRYPTION_KEY = KEY_B;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptB } = await freshModule();
    const ctOld = encryptB("rotateme");

    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = KEY_B;
    const { decryptWithRotationInfo, encrypt: encryptA } = await freshModule();
    const result = decryptWithRotationInfo(ctOld);
    expect(result.plaintext).toBe("rotateme");
    expect(result.usedRetiredKey).toBe(true);

    // Re-encrypted with the active key reports false.
    const ctNew = encryptA("rotateme");
    const result2 = decryptWithRotationInfo(ctNew);
    expect(result2.plaintext).toBe("rotateme");
    expect(result2.usedRetiredKey).toBe(false);
  });

  it("multiple retired keys are tried in order", async () => {
    // Encrypt with C — neither A nor B.
    process.env.ENCRYPTION_KEY = KEY_C;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptC } = await freshModule();
    const ct = encryptC("two-rotations-ago");

    // Now A is active, B & C both retired.
    process.env.ENCRYPTION_KEY = KEY_A;
    process.env.ENCRYPTION_KEYS_PREVIOUS = `${KEY_B},${KEY_C}`;
    const { decrypt } = await freshModule();
    expect(decrypt(ct)).toBe("two-rotations-ago");
  });

  it("throws cleanly when no key works", async () => {
    process.env.ENCRYPTION_KEY = KEY_C;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { encrypt: encryptC } = await freshModule();
    const ct = encryptC("locked-out");

    // Drop C entirely — only A is configured.
    process.env.ENCRYPTION_KEY = KEY_A;
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
    const { decrypt } = await freshModule();
    expect(() => decrypt(ct)).toThrow();
  });
});
