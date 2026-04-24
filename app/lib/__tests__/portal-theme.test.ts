import { describe, it, expect } from "vitest";
import {
  DEFAULT_PORTAL_THEME,
  parsePortalTheme,
  applyPortalThemeToHtml,
  FONT_OPTIONS,
} from "../portal-theme.server";

describe("DEFAULT_PORTAL_THEME", () => {
  it("has all required fields with non-empty values", () => {
    for (const v of Object.values(DEFAULT_PORTAL_THEME)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
    }
  });

  it("primaryColor defaults to Shopify green", () => {
    expect(DEFAULT_PORTAL_THEME.primaryColor).toBe("#008060");
  });
});

describe("parsePortalTheme", () => {
  it("returns defaults for null", () => {
    expect(parsePortalTheme(null)).toEqual(DEFAULT_PORTAL_THEME);
  });

  it("returns defaults for undefined", () => {
    expect(parsePortalTheme(undefined)).toEqual(DEFAULT_PORTAL_THEME);
  });

  it("returns defaults for empty / whitespace string", () => {
    expect(parsePortalTheme("")).toEqual(DEFAULT_PORTAL_THEME);
    expect(parsePortalTheme("   ")).toEqual(DEFAULT_PORTAL_THEME);
  });

  it("returns defaults for malformed JSON", () => {
    expect(parsePortalTheme("{broken")).toEqual(DEFAULT_PORTAL_THEME);
  });

  it("merges partial JSON with defaults", () => {
    const theme = parsePortalTheme(JSON.stringify({ primaryColor: "#ff0000" }));
    expect(theme.primaryColor).toBe("#ff0000");
    expect(theme.backgroundColor).toBe(DEFAULT_PORTAL_THEME.backgroundColor);
  });

  it("fully overrides when all fields supplied", () => {
    const custom = {
      primaryColor: "#123456",
      primaryHoverColor: "#234567",
      backgroundColor: "#345678",
      surfaceColor: "#456789",
      textColor: "#567890",
      textMutedColor: "#6789ab",
      borderColor: "#789abc",
      fontFamily: "Arial",
      headingFont: "Arial",
      borderRadius: "4px",
      shadow: "none",
    };
    expect(parsePortalTheme(JSON.stringify(custom))).toEqual(custom);
  });

  it("returns a mutable copy, not the frozen default", () => {
    const theme = parsePortalTheme(null);
    expect(() => { theme.primaryColor = "#xxx"; }).not.toThrow();
  });
});

describe("applyPortalThemeToHtml", () => {
  const theme = parsePortalTheme(null);

  it("replaces all theme tokens in HTML", () => {
    const html = `
      <style>
        body { background: %BG_COLOR%; color: %TEXT_COLOR%; font: %FONT_FAMILY%; }
        .btn { background: %PRIMARY_COLOR%; border-radius: %BORDER_RADIUS%; box-shadow: %SHADOW%; }
        .btn:hover { background: %PRIMARY_HOVER%; }
        .card { background: %SURFACE_COLOR%; border: 1px solid %BORDER_COLOR%; }
        h1 { font: %HEADING_FONT%; }
        .muted { color: %TEXT_MUTED%; }
      </style>
    `;
    const out = applyPortalThemeToHtml(html, theme);
    expect(out).not.toContain("%PRIMARY_COLOR%");
    expect(out).not.toContain("%BG_COLOR%");
    expect(out).not.toContain("%PRIMARY_HOVER%");
    expect(out).not.toContain("%BORDER_RADIUS%");
    expect(out).toContain(theme.primaryColor);
    expect(out).toContain(theme.primaryHoverColor);
  });

  it("leaves HTML without tokens untouched", () => {
    const html = "<div>plain</div>";
    expect(applyPortalThemeToHtml(html, theme)).toBe(html);
  });

  it("replaces multiple occurrences of the same token", () => {
    const html = "%PRIMARY_COLOR%,%PRIMARY_COLOR%,%PRIMARY_COLOR%";
    const out = applyPortalThemeToHtml(html, theme);
    expect(out).toBe(`${theme.primaryColor},${theme.primaryColor},${theme.primaryColor}`);
  });
});

describe("FONT_OPTIONS", () => {
  it("contains well-formed entries", () => {
    expect(FONT_OPTIONS.length).toBeGreaterThan(0);
    for (const opt of FONT_OPTIONS) {
      expect(opt.value).toBeTruthy();
      expect(opt.label).toBeTruthy();
    }
  });

  it("includes a default DM Sans option", () => {
    expect(FONT_OPTIONS.some(o => o.label.includes("DM Sans"))).toBe(true);
  });
});
