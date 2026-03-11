import { describe, it, expect } from "vitest";
import {
  formatMoney,
  formatDate,
  formatDateTime,
  formatNumber,
  normalizeLocale,
  isRtlLocale,
  RTL_LOCALES,
} from "../i18n.server";

describe("formatMoney", () => {
  it("formats USD correctly with default locale", () => {
    const result = formatMoney(29.99, "USD", "en");
    expect(result).toContain("29.99");
    // Should include dollar sign or "USD"
    expect(result).toMatch(/\$|USD/);
  });

  it("formats INR correctly", () => {
    const result = formatMoney(1500, "INR", "en-IN");
    expect(result).toContain("1,500.00");
    // Should include rupee symbol or "INR"
    expect(result).toMatch(/\u20B9|INR/);
  });

  it("formats large amounts with grouping separators", () => {
    const result = formatMoney(12345.67, "USD", "en");
    expect(result).toContain("12,345.67");
  });

  it("returns em-dash for NaN input", () => {
    expect(formatMoney(NaN, "USD", "en")).toBe("\u2014");
  });

  it("returns em-dash for non-numeric string input", () => {
    expect(formatMoney("abc", "USD", "en")).toBe("\u2014");
  });

  it("parses string amounts correctly", () => {
    const result = formatMoney("42.50", "USD", "en");
    expect(result).toContain("42.50");
  });

  it("defaults to USD when currency is null", () => {
    const result = formatMoney(10, null, "en");
    expect(result).toMatch(/\$|USD/);
  });

  it("defaults to en locale when locale is null", () => {
    const result = formatMoney(10, "USD", null);
    expect(result).toContain("10.00");
  });

  it("formats zero correctly", () => {
    const result = formatMoney(0, "USD", "en");
    expect(result).toContain("0.00");
  });
});

describe("formatDate", () => {
  it("formats a Date object in the default locale", () => {
    const result = formatDate(new Date("2024-06-15T12:00:00Z"), "en", "UTC");
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2024");
  });

  it("formats an ISO string date", () => {
    const result = formatDate("2024-01-01T00:00:00Z", "en", "UTC");
    expect(result).toContain("Jan");
    expect(result).toContain("1");
    expect(result).toContain("2024");
  });

  it("returns em-dash for null input", () => {
    expect(formatDate(null)).toBe("\u2014");
  });

  it("returns em-dash for undefined input", () => {
    expect(formatDate(undefined)).toBe("\u2014");
  });

  it("returns em-dash for invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("\u2014");
  });

  it("respects timezone parameter", () => {
    // Midnight UTC on Jan 1 should show Dec 31 in a timezone behind UTC
    const resultUtc = formatDate("2024-01-01T00:30:00Z", "en", "UTC");
    expect(resultUtc).toContain("Jan");
  });
});

describe("formatDateTime", () => {
  it("includes both date and time components", () => {
    const result = formatDateTime(new Date("2024-06-15T14:30:00Z"), "en", "UTC");
    expect(result).toContain("Jun");
    expect(result).toContain("15");
    expect(result).toContain("2024");
    // Should contain time portion
    expect(result).toMatch(/2:30|14:30/);
  });

  it("returns em-dash for null", () => {
    expect(formatDateTime(null)).toBe("\u2014");
  });

  it("returns em-dash for invalid date", () => {
    expect(formatDateTime("garbage")).toBe("\u2014");
  });
});

describe("formatNumber", () => {
  it("formats integers with grouping", () => {
    const result = formatNumber(1234567, "en");
    expect(result).toBe("1,234,567");
  });

  it("formats decimals", () => {
    const result = formatNumber(3.14, "en");
    expect(result).toContain("3.14");
  });

  it("defaults to en locale when null", () => {
    const result = formatNumber(1000, null);
    expect(result).toBe("1,000");
  });
});

describe("normalizeLocale", () => {
  it("returns default locale for null", () => {
    expect(normalizeLocale(null)).toBe("en");
  });

  it("returns default locale for undefined", () => {
    expect(normalizeLocale(undefined)).toBe("en");
  });

  it("converts underscore to hyphen", () => {
    expect(normalizeLocale("pt_BR")).toBe("pt-BR");
  });

  it("passes through already-normalized locales", () => {
    expect(normalizeLocale("en-US")).toBe("en-US");
  });

  it("passes through simple locales", () => {
    expect(normalizeLocale("fr")).toBe("fr");
  });
});

describe("isRtlLocale", () => {
  it("returns true for Arabic (ar)", () => {
    expect(isRtlLocale("ar")).toBe(true);
  });

  it("returns true for Hebrew (he)", () => {
    expect(isRtlLocale("he")).toBe(true);
  });

  it("returns true for Farsi (fa)", () => {
    expect(isRtlLocale("fa")).toBe(true);
  });

  it("returns true for Urdu (ur)", () => {
    expect(isRtlLocale("ur")).toBe(true);
  });

  it("returns true for locale with region subtag (ar-SA)", () => {
    expect(isRtlLocale("ar-SA")).toBe(true);
  });

  it("returns false for English (en)", () => {
    expect(isRtlLocale("en")).toBe(false);
  });

  it("returns false for French (fr)", () => {
    expect(isRtlLocale("fr")).toBe(false);
  });

  it("returns false for German (de)", () => {
    expect(isRtlLocale("de")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRtlLocale(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRtlLocale(undefined)).toBe(false);
  });

  it("is case-insensitive for base language", () => {
    expect(isRtlLocale("AR")).toBe(true);
    expect(isRtlLocale("He")).toBe(true);
  });
});

describe("RTL_LOCALES constant", () => {
  it("contains exactly 4 locales", () => {
    expect(RTL_LOCALES.size).toBe(4);
  });

  it("contains ar, he, fa, ur", () => {
    expect(RTL_LOCALES.has("ar")).toBe(true);
    expect(RTL_LOCALES.has("he")).toBe(true);
    expect(RTL_LOCALES.has("fa")).toBe(true);
    expect(RTL_LOCALES.has("ur")).toBe(true);
  });
});
