/**
 * Gap coverage for app/lib/i18n.server.ts — exercises the Intl-failure
 * catch branches at lines 25, 43, 62, 73 by stubbing the Intl
 * constructors to throw, plus a few defaulting/edge cases not already
 * covered by i18n.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatMoney,
  formatDate,
  formatDateTime,
  formatNumber,
} from "../i18n.server";

describe("i18n.server — Intl-failure fallback branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formatMoney falls back to '<currency> amount.toFixed(2)' when Intl.NumberFormat throws (line 25)", () => {
    const spy = vi
      .spyOn(Intl, "NumberFormat")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    const out = formatMoney(12.345, "USD", "en");
    expect(out).toBe("USD 12.35");
    expect(spy).toHaveBeenCalled();
  });

  it("formatMoney fallback uses DEFAULT_CURRENCY (USD) when currency is null and Intl throws", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const out = formatMoney(7, null, null);
    expect(out).toBe("USD 7.00");
  });

  it("formatMoney fallback echoes a custom currency string verbatim when Intl throws", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const out = formatMoney("3.14", "EUR", "fr-FR");
    expect(out).toBe("EUR 3.14");
  });

  it("formatDate falls back to d.toLocaleDateString() when Intl.DateTimeFormat throws (line 43)", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const d = new Date("2024-06-15T12:00:00Z");
    const expected = d.toLocaleDateString();
    const out = formatDate(d, "en", "UTC");
    expect(out).toBe(expected);
  });

  it("formatDate fallback also handles ISO string input when Intl throws", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const iso = "2024-01-02T03:04:05Z";
    const expected = new Date(iso).toLocaleDateString();
    const out = formatDate(iso);
    expect(out).toBe(expected);
  });

  it("formatDateTime falls back to d.toLocaleString() when Intl.DateTimeFormat throws (line 62)", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const d = new Date("2024-06-15T14:30:00Z");
    const expected = d.toLocaleString();
    const out = formatDateTime(d, "en", "UTC");
    expect(out).toBe(expected);
  });

  it("formatDateTime fallback path is reached for ISO string input as well", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    const iso = "2024-12-31T23:59:00Z";
    const expected = new Date(iso).toLocaleString();
    const out = formatDateTime(iso, null, null);
    expect(out).toBe(expected);
  });

  it("formatNumber falls back to String(value) when Intl.NumberFormat throws (line 73)", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(formatNumber(42, "en")).toBe("42");
    expect(formatNumber(3.14, null)).toBe("3.14");
  });

  it("formatNumber fallback handles negative and zero values", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(formatNumber(-7)).toBe("-7");
    expect(formatNumber(0)).toBe("0");
  });

  it("formatMoney fallback rounds via toFixed(2) — 1.005 case", () => {
    vi.spyOn(Intl, "NumberFormat").mockImplementation(() => {
      throw new Error("boom");
    });
    // toFixed(2) of 1.005 in JS is "1.00" (binary rep) or "1.01" depending on
    // value; just assert it has 2 decimal places after the currency.
    const out = formatMoney(1.005, "USD", "en");
    expect(out).toMatch(/^USD \d+\.\d{2}$/);
  });

  it("formatMoney fallback does not throw when format() itself throws (constructor stub covers both)", () => {
    // Stub returns a faux NumberFormat whose .format throws — this still hits
    // the catch on line 25 because the throw happens inside the try block.
    vi.spyOn(Intl, "NumberFormat").mockImplementation(
      () =>
        ({
          format: () => {
            throw new Error("format failed");
          },
        }) as unknown as Intl.NumberFormat,
    );
    const out = formatMoney(9.5, "GBP", "en-GB");
    expect(out).toBe("GBP 9.50");
  });

  it("formatDate fallback triggered when format() throws (not just constructor)", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          format: () => {
            throw new Error("format failed");
          },
        }) as unknown as Intl.DateTimeFormat,
    );
    const d = new Date("2024-06-15T12:00:00Z");
    const out = formatDate(d, "en", "UTC");
    expect(out).toBe(d.toLocaleDateString());
  });
});
