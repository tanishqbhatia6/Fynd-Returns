/**
 * Portal configuration: which pages/tabs to show, driven from Admin.
 */

export type PortalConfig = {
  showOrderTracking: boolean;
  showReturnTracking: boolean;
  showCreateReturnTab: boolean;
  defaultTab: "order" | "return" | "create";
};

const DEFAULT_PORTAL_CONFIG: PortalConfig = {
  showOrderTracking: true,
  showReturnTracking: true,
  showCreateReturnTab: true,
  defaultTab: "return",
};

export function parsePortalConfig(json: string | null | undefined): PortalConfig {
  if (!json || !json.trim()) return DEFAULT_PORTAL_CONFIG;
  try {
    const parsed = JSON.parse(json) as Partial<PortalConfig>;
    return {
      showOrderTracking: parsed.showOrderTracking ?? true,
      showReturnTracking: parsed.showReturnTracking ?? true,
      showCreateReturnTab: parsed.showCreateReturnTab ?? true,
      defaultTab: ["order", "return", "create"].includes(parsed.defaultTab ?? "")
        ? parsed.defaultTab!
        : "return",
    };
  } catch {
    return DEFAULT_PORTAL_CONFIG;
  }
}
