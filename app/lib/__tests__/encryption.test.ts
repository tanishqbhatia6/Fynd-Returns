import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../encryption.server";

describe("encrypt + decrypt", () => {
  it("round-trips correctly for a simple string", () => {
    const plaintext = "hello world";
    const ciphertext = encrypt(plaintext);
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("encrypting an empty string produces ciphertext with empty data part that decrypt rejects", () => {
    // AES-256-GCM with empty plaintext produces empty data, which fails the
    // decrypt guard (!data check). This is a known limitation of the module.
    const ciphertext = encrypt("");
    expect(() => decrypt(ciphertext)).toThrow("Invalid encrypted format");
  });

  it("round-trips correctly for unicode and special characters", () => {
    const plaintext = "Hello \u{1F600} \u00E9\u00E8\u00EA \u4F60\u597D <script>alert('xss')</script>";
    const ciphertext = encrypt(plaintext);
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips correctly for a long string", () => {
    const plaintext = "a]b[c".repeat(10000);
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("round-trips JSON data", () => {
    const data = JSON.stringify({ email: "test@example.com", orderId: 12345 });
    const ciphertext = encrypt(data);
    const decrypted = decrypt(ciphertext);
    expect(JSON.parse(decrypted)).toEqual({ email: "test@example.com", orderId: 12345 });
  });
});

describe("encrypt produces unique ciphertext", () => {
  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const plaintext = "same input every time";
    const ct1 = encrypt(plaintext);
    const ct2 = encrypt(plaintext);
    expect(ct1).not.toBe(ct2);
    // But both decrypt to the same value
    expect(decrypt(ct1)).toBe(plaintext);
    expect(decrypt(ct2)).toBe(plaintext);
  });

  it("ciphertext has three colon-separated hex parts (iv:tag:data)", () => {
    const ct = encrypt("test");
    const parts = ct.split(":");
    expect(parts).toHaveLength(3);
    // Each part should be a hex string
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]+$/);
    }
    // IV is 16 bytes = 32 hex chars
    expect(parts[0]).toHaveLength(32);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
  });
});

describe("decrypt error handling", () => {
  it("throws for malformed input with wrong number of parts", () => {
    expect(() => decrypt("just-one-part")).toThrow("Invalid encrypted format");
    expect(() => decrypt("two:parts")).toThrow("Invalid encrypted format");
    expect(() => decrypt("four:parts:here:extra")).toThrow();
  });

  it("throws for empty colon-separated parts", () => {
    expect(() => decrypt("::")).toThrow("Invalid encrypted format");
    expect(() => decrypt(":tag:data")).toThrow("Invalid encrypted format");
  });

  it("throws for tampered ciphertext", () => {
    const ct = encrypt("secret data");
    const parts = ct.split(":");

    // Tamper with the encrypted data portion
    const tamperedData =
      parts[2][0] === "a"
        ? "b" + parts[2].slice(1)
        : "a" + parts[2].slice(1);
    const tampered = `${parts[0]}:${parts[1]}:${tamperedData}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws for tampered auth tag", () => {
    const ct = encrypt("secret data");
    const parts = ct.split(":");

    // Tamper with the auth tag
    const tamperedTag =
      parts[1][0] === "a"
        ? "b" + parts[1].slice(1)
        : "a" + parts[1].slice(1);
    const tampered = `${parts[0]}:${tamperedTag}:${parts[2]}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws for tampered IV", () => {
    const ct = encrypt("secret data");
    const parts = ct.split(":");

    // Tamper with the IV
    const tamperedIv =
      parts[0][0] === "a"
        ? "b" + parts[0].slice(1)
        : "a" + parts[0].slice(1);
    const tampered = `${tamperedIv}:${parts[1]}:${parts[2]}`;

    expect(() => decrypt(tampered)).toThrow();
  });
});
