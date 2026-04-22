/**
 * Tests for the encryption helpers added in Phase 1A:
 *  - looksEncrypted() — recognises the IV:tag:data format
 *  - encryptIfNeeded() — idempotent (already-encrypted values pass through)
 *  - decryptIfEncrypted() — tolerant of plaintext during the rollout
 *
 * These pin the SMTP-creds rollout safety: it must be safe to run new code against
 * a DB that still contains plaintext (no forced backfill at deploy time).
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  encrypt,
  decrypt,
  looksEncrypted,
  encryptIfNeeded,
  decryptIfEncrypted,
} from "../encryption.server";

beforeAll(() => {
  // 32 bytes hex
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

describe("looksEncrypted", () => {
  it("returns true for the IV:tag:data hex format", () => {
    const enc = encrypt("hello");
    expect(looksEncrypted(enc)).toBe(true);
  });

  it("returns false for plaintext", () => {
    expect(looksEncrypted("plain-password-123")).toBe(false);
    expect(looksEncrypted("smtp.gmail.com")).toBe(false);
    expect(looksEncrypted("user@example.com")).toBe(false);
  });

  it("returns false for null/empty", () => {
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
    expect(looksEncrypted("")).toBe(false);
  });

  it("returns false for two-segment strings (look like IV:data, not IV:tag:data)", () => {
    expect(looksEncrypted("abc:def")).toBe(false);
  });
});

describe("encryptIfNeeded", () => {
  it("encrypts plaintext", () => {
    const out = encryptIfNeeded("hunter2");
    expect(out).not.toBeNull();
    expect(out).not.toBe("hunter2");
    expect(looksEncrypted(out)).toBe(true);
  });

  it("is a no-op for already-encrypted values (idempotent)", () => {
    const enc = encrypt("hunter2");
    const out = encryptIfNeeded(enc);
    expect(out).toBe(enc); // exact same string, no double-encryption
  });

  it("returns null for null/empty input", () => {
    expect(encryptIfNeeded(null)).toBeNull();
    expect(encryptIfNeeded(undefined)).toBeNull();
    expect(encryptIfNeeded("")).toBeNull();
  });
});

describe("decryptIfEncrypted (rollout safety)", () => {
  it("decrypts encrypted values back to plaintext", () => {
    const enc = encrypt("hunter2");
    expect(decryptIfEncrypted(enc)).toBe("hunter2");
  });

  it("returns plaintext as-is when not encrypted (rollout safety)", () => {
    // This is the critical property — pre-encryption-rollout DB rows are plaintext;
    // calling decryptIfEncrypted on them must NOT throw and must return the value.
    expect(decryptIfEncrypted("plaintext-password")).toBe("plaintext-password");
    expect(decryptIfEncrypted("smtp.gmail.com")).toBe("smtp.gmail.com");
  });

  it("returns null for null/empty", () => {
    expect(decryptIfEncrypted(null)).toBeNull();
    expect(decryptIfEncrypted(undefined)).toBeNull();
    expect(decryptIfEncrypted("")).toBeNull();
  });

  it("returns null (not throw) for malformed-but-encrypted-looking values", () => {
    // Looks like the format but is corrupt/wrong-key — must not crash.
    const fake = "deadbeef:cafe:1234";
    expect(() => decryptIfEncrypted(fake)).not.toThrow();
    expect(decryptIfEncrypted(fake)).toBeNull();
  });
});

describe("end-to-end roundtrip", () => {
  it("encrypt → decrypt yields the original", () => {
    const secret = "Pa$$w0rd!_with-special@chars";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("each encrypt of the same value yields a different ciphertext (random IV)", () => {
    const a = encrypt("same-input");
    const b = encrypt("same-input");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same-input");
    expect(decrypt(b)).toBe("same-input");
  });
});
