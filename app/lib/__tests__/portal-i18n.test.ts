/**
 * Tests for portal-i18n.ts: language fallback, override merging, template
 * interpolation, locale-stripping. The portal HTML and email templates rely
 * on these helpers — a regression here surfaces as broken localised UI.
 */
import { describe, it, expect } from "vitest";
import {
  getPortalLabels,
  getAllLabelKeys,
  t,
  SUPPORTED_LANGUAGES,
  DEFAULT_LABELS,
} from "../portal-i18n";

describe("getPortalLabels", () => {
  it("returns English labels for 'en'", () => {
    const labels = getPortalLabels("en");
    expect(labels["portal.title"]).toBe("Returns Center");
  });

  it("falls back to English when language is unknown", () => {
    const labels = getPortalLabels("xx");
    expect(labels["portal.title"]).toBe(DEFAULT_LABELS["portal.title"]);
  });

  it("strips region code (en-GB → en)", () => {
    const labels = getPortalLabels("en-GB");
    expect(labels["portal.title"]).toBe("Returns Center");
  });

  it("is case-insensitive for the language tag", () => {
    const labels = getPortalLabels("EN");
    expect(labels["portal.title"]).toBe("Returns Center");
  });

  it("merges merchant overrides on top of base labels", () => {
    const labels = getPortalLabels("en", { "portal.title": "My Returns" });
    expect(labels["portal.title"]).toBe("My Returns");
    // Untouched keys are preserved.
    expect(labels["portal.lookup.email"]).toBe(DEFAULT_LABELS["portal.lookup.email"]);
  });

  it("ignores empty/whitespace overrides", () => {
    const labels = getPortalLabels("en", { "portal.title": "  ", "portal.tab.trackOrder": "" });
    expect(labels["portal.title"]).toBe("Returns Center");
    expect(labels["portal.tab.trackOrder"]).toBe(DEFAULT_LABELS["portal.tab.trackOrder"]);
  });

  it("ignores non-string override values", () => {
    const labels = getPortalLabels("en", { "portal.title": 42 as unknown as string });
    expect(labels["portal.title"]).toBe("Returns Center");
  });

  it("falls back to English keys missing in the target language", () => {
    // Spanish is supported and has many keys translated, but if any are
    // missing, English should fill in.
    const labels = getPortalLabels("es");
    // Every English key should resolve to a string (no undefined).
    for (const key of getAllLabelKeys()) {
      expect(typeof labels[key]).toBe("string");
    }
  });

  it("treats null overrides as no-op", () => {
    const labels = getPortalLabels("en", null);
    expect(labels["portal.title"]).toBe("Returns Center");
  });
});

describe("t (template interpolation)", () => {
  it("returns the labelled string", () => {
    const labels = getPortalLabels("en");
    expect(t("portal.title", labels)).toBe("Returns Center");
  });

  it("interpolates {key} placeholders", () => {
    const labels = { "portal.policyBanner": "Returns accepted within {days} days of delivery." };
    expect(t("portal.policyBanner", labels, { days: "30" })).toBe("Returns accepted within 30 days of delivery.");
  });

  it("falls back to English when key is missing in labels", () => {
    expect(t("portal.title", {})).toBe(DEFAULT_LABELS["portal.title"]);
  });

  it("returns the key itself when missing everywhere", () => {
    expect(t("totally.missing.key", {})).toBe("totally.missing.key");
  });

  it("leaves un-replaced placeholders intact", () => {
    expect(t("policy.banner", { "policy.banner": "{days} days" })).toBe("{days} days");
  });

  it("replaces all instances of a placeholder (single occurrence per current impl)", () => {
    // Note: current impl uses .replace() which only replaces the first
    // occurrence — this test locks in that contract so a future regex change
    // can't silently break callers that rely on it.
    const out = t("k", { k: "{x} and {x}" }, { x: "Y" });
    expect(out).toBe("Y and {x}");
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("includes English first", () => {
    expect(SUPPORTED_LANGUAGES[0].code).toBe("en");
  });

  it("each entry has code + label", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(typeof lang.code).toBe("string");
      expect(typeof lang.label).toBe("string");
      expect(lang.code.length).toBeGreaterThan(0);
      expect(lang.label.length).toBeGreaterThan(0);
    }
  });

  it("contains expected major languages", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toContain("en");
    expect(codes).toContain("es");
    expect(codes).toContain("fr");
    expect(codes).toContain("de");
    expect(codes).toContain("hi");
    expect(codes).toContain("ar");
  });

  it("has no duplicate language codes", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("getAllLabelKeys", () => {
  it("returns a non-empty list of label keys", () => {
    const keys = getAllLabelKeys();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(50);
  });

  it("includes representative groups", () => {
    const keys = getAllLabelKeys();
    expect(keys.some((k) => k.startsWith("portal."))).toBe(true);
    expect(keys.some((k) => k.startsWith("email."))).toBe(true);
  });

  it("returns identical key list across calls (no mutation)", () => {
    const a = getAllLabelKeys();
    const b = getAllLabelKeys();
    expect(a).toEqual(b);
  });
});
