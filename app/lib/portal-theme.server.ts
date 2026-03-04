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
    .replaceAll("%PRIMARY_COLOR%", theme.primaryColor)
    .replaceAll("%PRIMARY_HOVER%", theme.primaryHoverColor)
    .replaceAll("%BG_COLOR%", theme.backgroundColor)
    .replaceAll("%SURFACE_COLOR%", theme.surfaceColor)
    .replaceAll("%TEXT_COLOR%", theme.textColor)
    .replaceAll("%TEXT_MUTED%", theme.textMutedColor)
    .replaceAll("%BORDER_COLOR%", theme.borderColor)
    .replaceAll("%FONT_FAMILY%", theme.fontFamily)
    .replaceAll("%HEADING_FONT%", theme.headingFont)
    .replaceAll("%BORDER_RADIUS%", theme.borderRadius)
    .replaceAll("%SHADOW%", theme.shadow);
}

export const FONT_OPTIONS = [
  { value: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "DM Sans (Modern)" },
  { value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", label: "Inter" },
  { value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", label: "System UI" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Playfair Display', Georgia, serif", label: "Playfair Display" },
] as const;
