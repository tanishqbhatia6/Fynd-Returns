/**
 * Tests for return-request-id.ts: configurable return-request-ID generation.
 * Covers config parsing/defaulting, body-mode variants (hash, sequential,
 * date_hash, date_sequential), padding, prefix/separator/suffix handling,
 * and the legacy formatReturnRequestId() fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseReturnIdConfig,
  buildReturnRequestId,
  formatReturnRequestId,
  DEFAULT_RETURN_ID_CONFIG,
  type ReturnIdConfig,
} from "../return-request-id";

describe("parseReturnIdConfig", () => {
  it("returns defaults when input is null", () => {
    expect(parseReturnIdConfig(null)).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });

  it("returns defaults when input is undefined", () => {
    expect(parseReturnIdConfig(undefined)).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });

  it("returns defaults when input is an empty string", () => {
    expect(parseReturnIdConfig("")).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });

  it("returns defaults when JSON is malformed", () => {
    expect(parseReturnIdConfig("{not valid json")).toEqual(DEFAULT_RETURN_ID_CONFIG);
  });

  it("parses a fully valid config", () => {
    const json = JSON.stringify({
      prefix: "RMA",
      separator: "_",
      bodyMode: "sequential",
      hashLength: 10,
      sequentialPadding: 5,
      suffix: "-2026",
    });
    expect(parseReturnIdConfig(json)).toEqual({
      prefix: "RMA",
      separator: "_",
      bodyMode: "sequential",
      hashLength: 10,
      sequentialPadding: 5,
      suffix: "-2026",
    });
  });

  it("falls back to default bodyMode when value is invalid", () => {
    const json = JSON.stringify({ bodyMode: "garbage" });
    expect(parseReturnIdConfig(json).bodyMode).toBe(DEFAULT_RETURN_ID_CONFIG.bodyMode);
  });

  it("falls back to default hashLength when value is not 6/8/10", () => {
    const json = JSON.stringify({ hashLength: 7 });
    expect(parseReturnIdConfig(json).hashLength).toBe(DEFAULT_RETURN_ID_CONFIG.hashLength);
  });

  it("accepts each valid hashLength (6, 8, 10)", () => {
    expect(parseReturnIdConfig(JSON.stringify({ hashLength: 6 })).hashLength).toBe(6);
    expect(parseReturnIdConfig(JSON.stringify({ hashLength: 8 })).hashLength).toBe(8);
    expect(parseReturnIdConfig(JSON.stringify({ hashLength: 10 })).hashLength).toBe(10);
  });

  it("clamps sequentialPadding outside the 4-8 range to default", () => {
    expect(parseReturnIdConfig(JSON.stringify({ sequentialPadding: 3 })).sequentialPadding).toBe(
      DEFAULT_RETURN_ID_CONFIG.sequentialPadding,
    );
    expect(parseReturnIdConfig(JSON.stringify({ sequentialPadding: 9 })).sequentialPadding).toBe(
      DEFAULT_RETURN_ID_CONFIG.sequentialPadding,
    );
  });

  it("accepts boundary sequentialPadding values (4 and 8)", () => {
    expect(parseReturnIdConfig(JSON.stringify({ sequentialPadding: 4 })).sequentialPadding).toBe(4);
    expect(parseReturnIdConfig(JSON.stringify({ sequentialPadding: 8 })).sequentialPadding).toBe(8);
  });

  it("accepts an empty-string prefix and suffix as valid", () => {
    const cfg = parseReturnIdConfig(JSON.stringify({ prefix: "", suffix: "" }));
    expect(cfg.prefix).toBe("");
    expect(cfg.suffix).toBe("");
  });

  it("ignores non-string prefix/separator/suffix and substitutes defaults", () => {
    const json = JSON.stringify({ prefix: 123, separator: false, suffix: null });
    const cfg = parseReturnIdConfig(json);
    expect(cfg.prefix).toBe(DEFAULT_RETURN_ID_CONFIG.prefix);
    expect(cfg.separator).toBe(DEFAULT_RETURN_ID_CONFIG.separator);
    expect(cfg.suffix).toBe(DEFAULT_RETURN_ID_CONFIG.suffix);
  });
});

describe("buildReturnRequestId - hash mode", () => {
  it("uses default config to produce PREFIX-HASH (8 chars)", () => {
    const id = buildReturnRequestId(DEFAULT_RETURN_ID_CONFIG, "cm5x9abc1234defg5678hijklmno");
    expect(id).toBe("RPM-HIJKLMNO");
  });

  it("respects custom hashLength of 6", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 6 };
    const id = buildReturnRequestId(cfg, "abcdefghij1234567890");
    expect(id).toBe("RPM-567890");
  });

  it("respects custom hashLength of 10", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 10 };
    // cuid is 20 chars → last 10 = "1234567890"
    const id = buildReturnRequestId(cfg, "abcdefghij1234567890");
    expect(id).toBe("RPM-1234567890");
  });

  it("replaces non-alphanumerics in cuid hash with X", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 8 };
    // last 8 of "abc-d_e.fghij" → "_e.fghij" → "_E.FGHIJ" → "XEXFGHIJ"
    const id = buildReturnRequestId(cfg, "abc-d_e.fghij");
    expect(id).toBe("RPM-XEXFGHIJ");
  });

  it("pads with X when cuid is shorter than hashLength", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 8 };
    expect(buildReturnRequestId(cfg, "ab")).toBe("RPM-ABXXXXXX");
  });

  it("pads with X when cuid is empty", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, hashLength: 8 };
    expect(buildReturnRequestId(cfg, "")).toBe("RPM-XXXXXXXX");
  });
});

describe("buildReturnRequestId - sequential mode", () => {
  it("zero-pads the counter to sequentialPadding width (default 6)", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "sequential" };
    expect(buildReturnRequestId(cfg, "anycuid", 42)).toBe("RPM-000042");
  });

  it("uses custom padding width", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "sequential",
      sequentialPadding: 4,
    };
    expect(buildReturnRequestId(cfg, "x", 7)).toBe("RPM-0007");
  });

  it("does not truncate counters wider than the padding", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "sequential",
      sequentialPadding: 4,
    };
    expect(buildReturnRequestId(cfg, "x", 123456)).toBe("RPM-123456");
  });

  it("defaults a missing counter to 0", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "sequential" };
    expect(buildReturnRequestId(cfg, "x")).toBe("RPM-000000");
  });
});

describe("buildReturnRequestId - date modes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin to 2026-03-07 (local time) → YYMMDD = 260307
    vi.setSystemTime(new Date(2026, 2, 7, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("date_hash uses YYMMDD<sep>HASH", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "date_hash" };
    const id = buildReturnRequestId(cfg, "cm5x9abc1234defg5678hijklmno");
    expect(id).toBe("RPM-260307-HIJKLMNO");
  });

  it("date_sequential uses YYMMDD<sep>PADDED", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, bodyMode: "date_sequential" };
    expect(buildReturnRequestId(cfg, "x", 9)).toBe("RPM-260307-000009");
  });

  it("date modes use the configured separator between date and body", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      separator: "_",
      bodyMode: "date_sequential",
      sequentialPadding: 4,
    };
    expect(buildReturnRequestId(cfg, "x", 1)).toBe("RPM_260307_0001");
  });
});

describe("buildReturnRequestId - prefix / separator / suffix", () => {
  it("omits the leading prefix segment when prefix is empty (no leading separator)", () => {
    const cfg: ReturnIdConfig = { ...DEFAULT_RETURN_ID_CONFIG, prefix: "", hashLength: 8 };
    // last 8 of cuid → "34567890"
    expect(buildReturnRequestId(cfg, "abcdefghij1234567890")).toBe("34567890");
  });

  it("supports an empty separator (concatenated)", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      separator: "",
      bodyMode: "sequential",
      sequentialPadding: 4,
    };
    expect(buildReturnRequestId(cfg, "x", 5)).toBe("RPM0005");
  });

  it("supports alternative separators like '/'", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      separator: "/",
      bodyMode: "sequential",
      sequentialPadding: 4,
    };
    expect(buildReturnRequestId(cfg, "x", 5)).toBe("RPM/0005");
  });

  it("appends a non-empty suffix to the final id", () => {
    const cfg: ReturnIdConfig = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "sequential",
      sequentialPadding: 4,
      suffix: "-US",
    };
    expect(buildReturnRequestId(cfg, "x", 5)).toBe("RPM-0005-US");
  });
});

describe("formatReturnRequestId (legacy)", () => {
  it("returns the input unchanged when shorter than 8 chars", () => {
    expect(formatReturnRequestId("abc")).toBe("abc");
    expect(formatReturnRequestId("1234567")).toBe("1234567");
  });

  it("returns the input unchanged when empty", () => {
    expect(formatReturnRequestId("")).toBe("");
  });

  it("formats a cuid to RPM-<LAST 8 UPPERCASED>", () => {
    expect(formatReturnRequestId("cm5x9abc1234defg5678hijklmno")).toBe("RPM-HIJKLMNO");
  });

  it("replaces non-alphanumerics in the trailing 8 with X", () => {
    // last 8 of "0000000000ab-cd_ef" → "ab-cd_ef" → "ABXCDXEF"
    expect(formatReturnRequestId("0000000000ab-cd_ef")).toBe("RPM-ABXCDXEF");
  });

  it("returns exactly 12 chars (RPM- + 8) for ids of length >= 8", () => {
    const out = formatReturnRequestId("0123456789abcdef");
    expect(out).toBe("RPM-89ABCDEF");
    expect(out.length).toBe(12);
  });
});
