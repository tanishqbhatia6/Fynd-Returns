import { describe, it, expect } from "vitest";
import { formatReturnRequestId } from "../return-request-id";

describe("formatReturnRequestId", () => {
  it("formats a standard UUID-like id into RPM-XXXXXXXX format", () => {
    const result = formatReturnRequestId("abc12345-6789-def0-1234-56789abcdef0");
    // Last 8 chars: "9abcdef0" -> uppercased
    expect(result).toBe("RPM-9ABCDEF0");
  });

  it("uppercases the suffix", () => {
    const result = formatReturnRequestId("xxxxxxxxabcdefgh");
    // Last 8 chars: "abcdefgh" -> uppercased
    expect(result).toBe("RPM-ABCDEFGH");
  });

  it("returns the raw id if it has fewer than 8 characters", () => {
    expect(formatReturnRequestId("short")).toBe("short");
    expect(formatReturnRequestId("1234567")).toBe("1234567");
  });

  it("returns the raw id for empty string", () => {
    expect(formatReturnRequestId("")).toBe("");
  });

  it("handles exactly 8-character id", () => {
    const result = formatReturnRequestId("a1b2c3d4");
    expect(result).toBe("RPM-A1B2C3D4");
  });

  it("replaces non-alphanumeric characters in the suffix with X", () => {
    // ID ending in "ab-cd_ef" -> last 8 chars "ab-cd_ef" -> "ABXCDXEF"
    const result = formatReturnRequestId("0000000000ab-cd_ef");
    expect(result).toBe("RPM-ABXCDXEF");
  });

  it("replaces special characters like hyphens in the last 8 chars", () => {
    // UUID typically has a hyphen in the last 8 chars
    const result = formatReturnRequestId("550e8400-e29b-41d4-a716-446655440000");
    // Last 8: "55440000"
    expect(result).toBe("RPM-55440000");
  });

  it("handles numeric-only ids", () => {
    const result = formatReturnRequestId("1234567890");
    // Last 8: "34567890"
    expect(result).toBe("RPM-34567890");
  });

  it("handles ids with only special characters beyond 8 length", () => {
    const result = formatReturnRequestId("!@#$%^&*()");
    // Last 8: "#$%^&*()" -> all non-alphanumeric -> "XXXXXXXX"
    expect(result).toBe("RPM-XXXXXXXX");
  });
});
