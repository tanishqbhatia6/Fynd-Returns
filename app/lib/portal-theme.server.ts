export const DEFAULT_PORTAL_THEME = {
  primaryColor: "#008060",
  primaryHoverColor: "#006e52",
  backgroundColor: "#faf9f7",
  surfaceColor: "#ffffff",
  textColor: "#202223",
  textMutedColor: "#6d7175",
  borderColor: "#e1e3e5",
  fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  headingFont: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  borderRadius: "12px",
  shadow: "0 4px 24px rgba(0,0,0,0.06)",
} as const;

export type PortalTheme = Record<keyof typeof DEFAULT_PORTAL_THEME, string>;

export function parsePortalTheme(json: string | null | undefined): PortalTheme {
  if (!json || json.trim() === "") return { ...DEFAULT_PORTAL_THEME };
  try {
    const parsed = JSON.parse(json) as Partial<PortalTheme>;
    return { ...DEFAULT_PORTAL_THEME, ...parsed };
  } catch {
    return { ...DEFAULT_PORTAL_THEME };
  }
}

export function applyPortalThemeToHtml(html: string, theme: PortalTheme): string {
  return html
    .replace("%PRIMARY_COLOR%", theme.primaryColor)
    .replace("%PRIMARY_HOVER%", theme.primaryHoverColor)
    .replace("%BG_COLOR%", theme.backgroundColor)
    .replace("%SURFACE_COLOR%", theme.surfaceColor)
    .replace("%TEXT_COLOR%", theme.textColor)
    .replace("%TEXT_MUTED%", theme.textMutedColor)
    .replace("%BORDER_COLOR%", theme.borderColor)
    .replace("%FONT_FAMILY%", theme.fontFamily)
    .replace("%HEADING_FONT%", theme.headingFont)
    .replace("%BORDER_RADIUS%", theme.borderRadius)
    .replace("%SHADOW%", theme.shadow);
}

export const FONT_OPTIONS = [
  { value: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "DM Sans (Modern)" },
  { value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", label: "Inter" },
  { value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "System UI" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Playfair Display', Georgia, serif", label: "Playfair Display" },
] as const;
