/**
 * Fynd environment configuration
 * Prod: https://api.fynd.com
 * UAT:  https://api.uat.fyndx1.de
 */

export const FYND_ENVIRONMENTS = {
  prod: "https://api.fynd.com",
  uat: "https://api.uat.fyndx1.de",
} as const;

export type FyndEnvironment = keyof typeof FYND_ENVIRONMENTS;

export function getFyndBaseUrl(settings: {
  fyndEnvironment?: string | null;
  fyndCustomBaseUrl?: string | null;
}): string {
  const custom = settings?.fyndCustomBaseUrl?.trim();
  if (custom) {
    try {
      const url = new URL(custom.startsWith("http") ? custom : `https://${custom}`);
      const origin = url.origin.replace(/\/$/, "");
      if (origin) return origin;
    } catch {
      // fallback to preset
    }
  }
  const env = (settings?.fyndEnvironment || "uat") as FyndEnvironment;
  return FYND_ENVIRONMENTS[env] ?? FYND_ENVIRONMENTS.uat;
}

export function getAppMode(settings: { appMode?: string | null }): "dev" | "prod" {
  const mode = settings?.appMode?.toLowerCase();
  return mode === "dev" ? "dev" : "prod";
}
