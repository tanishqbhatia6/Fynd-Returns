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

function getPrimaryContrastColor(color: string): "#ffffff" | "#17202e" {
  const hex = color.trim().match(/^#?([0-9a-f]{6})$/i)?.[1];
  if (!hex) return "#ffffff";

  const channels = [0, 2, 4].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.0187;

  return whiteContrast >= darkContrast ? "#ffffff" : "#17202e";
}

export function applyPortalThemeToHtml(html: string, theme: PortalTheme): string {
  return html
    .replaceAll("%PRIMARY_COLOR%", theme.primaryColor)
    .replaceAll("%PRIMARY_HOVER%", theme.primaryHoverColor)
    .replaceAll("%PRIMARY_CONTRAST%", getPrimaryContrastColor(theme.primaryColor))
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
  {
    value: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    label: "DM Sans (Modern)",
  },
  { value: "Inter, -apple-system, BlinkMacSystemFont, sans-serif", label: "Inter" },
  {
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    label: "System UI",
  },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Playfair Display', Georgia, serif", label: "Playfair Display" },
] as const;
