import { describe, it, expect } from "vitest";
import { sanitizeCredentialInputs } from "../credential-validation.server";

describe("sanitizeCredentialInputs", () => {
  describe("fyndCompanyId", () => {
    it("accepts a normal alphanumeric ID", () => {
      expect(sanitizeCredentialInputs({ fyndCompanyId: "company_123-abc" })).toEqual({
        valid: true,
        sanitized: { fyndCompanyId: "company_123-abc" },
      });
    });
    it("rejects IDs longer than 64 chars", () => {
      const r = sanitizeCredentialInputs({ fyndCompanyId: "x".repeat(65) });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/too long/i);
    });
    it("rejects IDs with invalid characters", () => {
      const r = sanitizeCredentialInputs({ fyndCompanyId: "has space" });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/invalid characters/i);
    });
    it("trims whitespace", () => {
      const r = sanitizeCredentialInputs({ fyndCompanyId: "  abc_123  " });
      expect(r.sanitized?.fyndCompanyId).toBe("abc_123");
    });
    it("accepts empty string (optional field)", () => {
      expect(sanitizeCredentialInputs({ fyndCompanyId: "" }).valid).toBe(true);
    });
  });

  describe("fyndApplicationId", () => {
    it("rejects overlong IDs", () => {
      const r = sanitizeCredentialInputs({ fyndApplicationId: "x".repeat(129) });
      expect(r.valid).toBe(false);
    });
    it("rejects IDs with symbols", () => {
      expect(sanitizeCredentialInputs({ fyndApplicationId: "app!id" }).valid).toBe(false);
    });
  });

  describe("fyndClientId / fyndClientSecret / fyndApplicationToken", () => {
    it("enforces max length on clientId", () => {
      expect(sanitizeCredentialInputs({ fyndClientId: "x".repeat(257) }).valid).toBe(false);
    });
    it("allows any character in clientId (secrets have special chars)", () => {
      expect(sanitizeCredentialInputs({ fyndClientId: "abc.def:ghi/jkl" }).valid).toBe(true);
    });
    it("enforces max length on clientSecret", () => {
      expect(sanitizeCredentialInputs({ fyndClientSecret: "x".repeat(513) }).valid).toBe(false);
    });
    it("enforces max length on applicationToken", () => {
      expect(sanitizeCredentialInputs({ fyndApplicationToken: "x".repeat(513) }).valid).toBe(false);
    });
  });

  describe("fyndCustomBaseUrl", () => {
    it("accepts a valid HTTPS URL", () => {
      const r = sanitizeCredentialInputs({ fyndCustomBaseUrl: "https://api.fynd.com" });
      expect(r.valid).toBe(true);
    });
    it("accepts a hostname-only input (auto-prepends https)", () => {
      const r = sanitizeCredentialInputs({ fyndCustomBaseUrl: "api.fynd.com" });
      expect(r.valid).toBe(true);
    });
    it("rejects a non-http URL that starts with 'http' (protocol check)", () => {
      // The code auto-prepends https:// only when the input doesn't start with
      // 'http'. So 'http-custom://x' DOES start with 'http' -> parsed as-is,
      // protocol fails the allowlist check.
      const r = sanitizeCredentialInputs({ fyndCustomBaseUrl: "httpx://bad" });
      expect(r.valid).toBe(false);
    });
    it("rejects truly unparseable URLs", () => {
      // Leading % is not valid hostname, new URL throws.
      const r = sanitizeCredentialInputs({ fyndCustomBaseUrl: "http://%%%invalid" });
      expect(r.valid).toBe(false);
    });
    it("rejects overlong URLs", () => {
      expect(
        sanitizeCredentialInputs({ fyndCustomBaseUrl: "https://" + "x".repeat(260) }).valid,
      ).toBe(false);
    });
    it("accepts empty URL (optional)", () => {
      expect(sanitizeCredentialInputs({ fyndCustomBaseUrl: "" }).valid).toBe(true);
    });
  });

  describe("policyJson", () => {
    it("accepts valid JSON", () => {
      expect(sanitizeCredentialInputs({ policyJson: '{"returnWindow": 30}' }).valid).toBe(true);
    });
    it("accepts empty {}", () => {
      expect(sanitizeCredentialInputs({ policyJson: "{}" }).valid).toBe(true);
    });
    it("rejects invalid JSON", () => {
      const r = sanitizeCredentialInputs({ policyJson: "{not json" });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/valid JSON/);
    });
    it("rejects overlong JSON (> 16KB)", () => {
      const big = JSON.stringify({ x: "x".repeat(17 * 1024) });
      expect(sanitizeCredentialInputs({ policyJson: big }).valid).toBe(false);
    });
  });

  it("returns all sanitized values when valid", () => {
    const r = sanitizeCredentialInputs({
      fyndCompanyId: "c-1",
      fyndApplicationId: "app_1",
      fyndClientId: "  cid  ",
      fyndClientSecret: "secret",
      fyndCustomBaseUrl: "https://fynd.example.com",
    });
    expect(r.valid).toBe(true);
    expect(r.sanitized?.fyndCompanyId).toBe("c-1");
    expect(r.sanitized?.fyndClientId).toBe("cid");
    expect(r.sanitized?.fyndCustomBaseUrl).toBe("https://fynd.example.com");
  });
});
