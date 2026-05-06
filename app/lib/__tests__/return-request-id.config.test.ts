import { describe, it, expect } from "vitest";
import {
  parseReturnIdConfig,
  buildReturnRequestId,
  previewReturnRequestId,
  formatReturnRequestId,
  DEFAULT_RETURN_ID_CONFIG,
} from "../return-request-id";

/* parseReturnIdConfig + buildReturnRequestId + previewReturnRequestId.
   formatReturnRequestId is covered in return-request-id.test.ts already —
   this file fills in the configurable-ID paths that file doesn't hit. */

describe("parseReturnIdConfig", () => {
  it("returns defaults for null/empty input", () => {
    expect(parseReturnIdConfig(null)).toEqual(DEFAULT_RETURN_ID_CONFIG);
    expect(parseReturnIdConfig(undefined)).toEqual(DEFAULT_RETURN_ID_CONFIG);
    expect(parseReturnIdConfig("")).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });
  it("returns defaults for invalid JSON", () => {
    expect(parseReturnIdConfig("{not json")).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });
  it("parses full custom config", () => {
    const json = JSON.stringify({
      prefix: "RMA",
      separator: "_",
      bodyMode: "sequential",
      hashLength: 10,
      sequentialPadding: 8,
      suffix: "-2026",
    });
    expect(parseReturnIdConfig(json)).toEqual({
      prefix: "RMA",
      separator: "_",
      bodyMode: "sequential",
      hashLength: 10,
      sequentialPadding: 8,
      suffix: "-2026",
    });
  });
  it("falls back to defaults for invalid field values", () => {
    const json = JSON.stringify({
      bodyMode: "nonsense",
      hashLength: 99,
      sequentialPadding: 2, // below minimum 4
    });
    const cfg = parseReturnIdConfig(json);
    expect(cfg.bodyMode).toBe(DEFAULT_RETURN_ID_CONFIG.bodyMode);
    expect(cfg.hashLength).toBe(DEFAULT_RETURN_ID_CONFIG.hashLength);
    expect(cfg.sequentialPadding).toBe(DEFAULT_RETURN_ID_CONFIG.sequentialPadding);
  });
  it("accepts valid hashLength values (6/8/10)", () => {
    expect(parseReturnIdConfig(JSON.stringify({ hashLength: 6 })).hashLength).toBe(6);
    expect(parseReturnIdConfig(JSON.stringify({ hashLength: 10 })).hashLength).toBe(10);
  });
  it("accepts sequentialPadding in range 4-8", () => {
    for (let n = 4; n <= 8; n++) {
      expect(parseReturnIdConfig(JSON.stringify({ sequentialPadding: n })).sequentialPadding).toBe(
        n,
      );
    }
  });
});

describe("buildReturnRequestId", () => {
  const cuid = "cm5x9abc1234defg5678hijklmno";

  it("builds hash mode", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "hash" as const, hashLength: 8 };
    const id = buildReturnRequestId(cfg, cuid);
    expect(id).toMatch(/^RPM-[A-Z0-9]{8}$/);
  });
  it("builds sequential mode with zero-padded counter", () => {
    const cfg = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "sequential" as const,
      sequentialPadding: 6,
    };
    expect(buildReturnRequestId(cfg, cuid, 42)).toBe("RPM-000042");
    expect(buildReturnRequestId(cfg, cuid, 1234567)).toBe("RPM-1234567");
  });
  it("sequential mode uses 0 when counter omitted", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "sequential" as const };
    expect(buildReturnRequestId(cfg, cuid)).toBe("RPM-000000");
  });
  it("builds date_hash mode (YYMMDD-HASH)", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "date_hash" as const, hashLength: 6 };
    const id = buildReturnRequestId(cfg, cuid);
    expect(id).toMatch(/^RPM-\d{6}-[A-Z0-9]{6}$/);
  });
  it("builds date_sequential mode (YYMMDD-NNNN)", () => {
    const cfg = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "date_sequential" as const,
      sequentialPadding: 4,
    };
    const id = buildReturnRequestId(cfg, cuid, 7);
    expect(id).toMatch(/^RPM-\d{6}-0007$/);
  });
  it("applies suffix when set", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, suffix: "-US" };
    expect(buildReturnRequestId(cfg, cuid)).toMatch(/-US$/);
  });
  it("omits prefix if empty string", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, prefix: "" };
    const id = buildReturnRequestId(cfg, cuid);
    // No leading prefix-separator.
    expect(id.startsWith("-")).toBe(false);
    expect(id).not.toMatch(/^RPM/);
  });
  it("handles short cuid by padding", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 8 };
    const id = buildReturnRequestId(cfg, "abc");
    expect(id).toBe("RPM-ABCXXXXX");
  });
  it("replaces non-alphanumeric chars in cuid with X", () => {
    const cfg = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 8 };
    const id = buildReturnRequestId(cfg, "aaaaaaaa!@#$%^&*");
    // Last 8 of the cuid (after upper+filter) become the body.
    expect(id).toMatch(/^RPM-[A-Z0-9X]{8}$/);
  });
});

describe("previewReturnRequestId", () => {
  it("produces a deterministic preview with counter=42", () => {
    expect(
      previewReturnRequestId({
        ...DEFAULT_RETURN_ID_CONFIG,
        bodyMode: "sequential",
        sequentialPadding: 6,
      }),
    ).toBe("RPM-000042");
  });
  it("produces a default hash-mode preview", () => {
    const id = previewReturnRequestId(DEFAULT_RETURN_ID_CONFIG);
    expect(id).toMatch(/^RPM-[A-Z0-9]{8}$/);
  });
});

describe("formatReturnRequestId", () => {
  it("formats the tail 8 chars of a full-length cuid as RPM-XXXXXXXX", () => {
    const full = "cm5x9abc1234defg5678hijklmno";
    expect(formatReturnRequestId(full)).toBe(`RPM-${full.slice(-8).toUpperCase()}`);
  });
  it("returns the original string when < 8 chars", () => {
    expect(formatReturnRequestId("abc")).toBe("abc");
    expect(formatReturnRequestId("")).toBe("");
  });
  it("replaces non-alphanumerics in the suffix with X", () => {
    expect(formatReturnRequestId("12345678-!@#$%^&*")).toBe("RPM-XXXXXXXX");
  });
});
