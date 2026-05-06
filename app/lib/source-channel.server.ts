/**
 * Normalizes a Shopify order source_name / sourceName value into one of:
 *   "pos"          — Shopify POS (in-store)
 *   "draft_order"  — Created from a Draft Order
 *   "b2b"          — B2B / Wholesale channel
 *   "web"          — Standard Online Store (default)
 *   (raw value)    — Any other channel we haven't mapped yet
 *
 * Returns null when sourceName is absent or empty (treated the same as "web").
 */
export function normalizeSourceChannel(sourceName: string | null | undefined): string | null {
  if (!sourceName) return null;
  const s = sourceName.toLowerCase().trim();
  if (s === "pos" || s === "shopify_pos") return "pos";
  if (s === "shopify_draft_order" || s === "draft_order") return "draft_order";
  if (s === "shopify_b2b" || s === "b2b" || s === "wholesale") return "b2b";
  if (s === "web" || s === "online" || s === "online_store") return "web";
  // Return raw value so novel channels are still stored, not silently dropped
  return s;
}

/** Human-readable label for a sourceChannel value. */
export function sourceChannelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "pos":
      return "Point of Sale";
    case "draft_order":
      return "Draft Order";
    case "b2b":
      return "B2B / Wholesale";
    case "web":
      return "Online Store";
    default:
      return channel ?? "Online Store";
  }
}

export type ChannelPolicy = {
  returnEnabled: boolean; // false = block returns for this channel entirely
  returnWindowDays: number | null; // null = use global setting
  autoApproveEnabled: boolean | null; // null = use global setting
};

export type ChannelPoliciesMap = {
  pos?: ChannelPolicy;
  draft_order?: ChannelPolicy;
  b2b?: ChannelPolicy;
};

export function parseChannelPolicies(json: string | null | undefined): ChannelPoliciesMap {
  if (!json) return {};
  try {
    return JSON.parse(json) as ChannelPoliciesMap;
  } catch {
    return {};
  }
}

export function getChannelPolicy(
  policies: ChannelPoliciesMap,
  sourceChannel: string | null | undefined,
): ChannelPolicy | null {
  if (!sourceChannel || sourceChannel === "web") return null;
  return (policies as Record<string, ChannelPolicy>)[sourceChannel] ?? null;
}
