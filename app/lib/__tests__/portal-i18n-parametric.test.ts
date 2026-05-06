/**
 * Parametric tests for portal-i18n.ts.
 *
 * Iterates every entry in SUPPORTED_LANGUAGES via it.each and asserts that
 * getPortalLabels returns a complete map: every key from getAllLabelKeys()
 * resolves to a non-empty string (English fallback covers any gaps).
 *
 * Also validates locale-stripping (e.g. "en-GB" → "en"), override merging,
 * and uppercase variants for each supported language.
 */
import { describe, it, expect } from "vitest";
import {
  getPortalLabels,
  getAllLabelKeys,
  SUPPORTED_LANGUAGES,
  DEFAULT_LABELS,
} from "../portal-i18n";

const ALL_KEYS = getAllLabelKeys();
const LANG_CASES = SUPPORTED_LANGUAGES.map((l) => [l.code, l.label] as const);

describe("portal-i18n parametric: getPortalLabels completeness", () => {
  it.each(LANG_CASES)(
    "[%s/%s] returns a complete label map (every key resolves to a string)",
    (code) => {
      const labels = getPortalLabels(code);
      expect(labels).toBeTypeOf("object");
      for (const key of ALL_KEYS) {
        expect(typeof labels[key]).toBe("string");
        expect(labels[key].length).toBeGreaterThan(0);
      }
    },
  );

  it.each(LANG_CASES)(
    "[%s/%s] returned object has at least as many keys as English baseline",
    (code) => {
      const labels = getPortalLabels(code);
      const labelKeys = Object.keys(labels);
      expect(labelKeys.length).toBeGreaterThanOrEqual(ALL_KEYS.length);
    },
  );

  it.each(LANG_CASES)("[%s/%s] every English key is present in the returned map", (code) => {
    const labels = getPortalLabels(code);
    for (const key of ALL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(labels, key)).toBe(true);
    }
  });

  it.each(LANG_CASES)("[%s/%s] uppercase language code resolves to a complete map", (code) => {
    const labels = getPortalLabels(code.toUpperCase());
    for (const key of ALL_KEYS) {
      expect(typeof labels[key]).toBe("string");
      expect(labels[key].length).toBeGreaterThan(0);
    }
  });

  it.each(LANG_CASES)("[%s/%s] locale-suffixed code (xx-XX) resolves to a complete map", (code) => {
    const labels = getPortalLabels(`${code}-XX`);
    for (const key of ALL_KEYS) {
      expect(typeof labels[key]).toBe("string");
      expect(labels[key].length).toBeGreaterThan(0);
    }
  });

  it.each(LANG_CASES)("[%s/%s] overrides win over base translations", (code) => {
    const sentinel = `__sentinel_${code}__`;
    const labels = getPortalLabels(code, { "portal.title": sentinel });
    expect(labels["portal.title"]).toBe(sentinel);
    // remaining keys still resolve
    for (const key of ALL_KEYS) {
      expect(typeof labels[key]).toBe("string");
      expect(labels[key].length).toBeGreaterThan(0);
    }
  });

  it.each(LANG_CASES)(
    "[%s/%s] empty/whitespace overrides are ignored, base value preserved",
    (code) => {
      const labels = getPortalLabels(code, {
        "portal.title": "   ",
        "portal.common.back": "",
      });
      expect(labels["portal.title"].trim().length).toBeGreaterThan(0);
      expect(labels["portal.common.back"].trim().length).toBeGreaterThan(0);
    },
  );

  it.each(LANG_CASES)("[%s/%s] non-string override values are ignored", (code) => {
    const overrides = {
      "portal.title": 123 as unknown as string,
      "portal.common.back": null as unknown as string,
    };
    const labels = getPortalLabels(code, overrides);
    expect(typeof labels["portal.title"]).toBe("string");
    expect(labels["portal.title"].length).toBeGreaterThan(0);
    expect(typeof labels["portal.common.back"]).toBe("string");
    expect(labels["portal.common.back"].length).toBeGreaterThan(0);
  });
});

describe("portal-i18n parametric: smoke checks", () => {
  it("SUPPORTED_LANGUAGES has at least 15 entries (one test per language * 8 cases = 120+)", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(15);
  });

  it("getAllLabelKeys returns a non-empty array of strings", () => {
    expect(Array.isArray(ALL_KEYS)).toBe(true);
    expect(ALL_KEYS.length).toBeGreaterThan(0);
    for (const key of ALL_KEYS) {
      expect(typeof key).toBe("string");
    }
  });

  it("DEFAULT_LABELS contains every key from getAllLabelKeys()", () => {
    for (const key of ALL_KEYS) {
      expect(typeof DEFAULT_LABELS[key]).toBe("string");
    }
  });

  it("unknown language code falls back to English with full key set", () => {
    const labels = getPortalLabels("zz-ZZ");
    for (const key of ALL_KEYS) {
      expect(labels[key]).toBe(DEFAULT_LABELS[key]);
    }
  });
});
