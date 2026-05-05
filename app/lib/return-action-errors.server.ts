/**
 * Pure helpers for normalising and classifying errors surfaced by the
 * Return action handler (api.returns.$id.actions.ts). Extracted to keep that
 * file's behaviour 100% identical while making the helpers individually
 * testable.
 */

const TRUNCATE_LIMIT = 300;

function truncateAtBoundary(msg: string, limit = TRUNCATE_LIMIT): string {
  if (msg.length <= limit) return msg;
  const slice = msg.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > limit - 60 ? lastSpace : limit;
  return slice.slice(0, cut).replace(/[\s,;:.\-]+$/, "") + "…";
}

export function enrichFyndError(msg: string): string {
  if (!msg) return msg;
  const is403 = /403|forbidden/i.test(msg);
  const hasGuidance = /company\/orders|scopes|Fynd Partners|Settings.*Integrations|Test Platform/i.test(msg);
  if (is403 && !hasGuidance) {
    return `${msg} — Sync uses the same OAuth flow as Test Platform. If Test Platform passes in Settings → Integrations but sync still fails, the write endpoint may require additional permissions—contact Fynd support.`;
  }
  return msg;
}

export function classifyFyndError(msg: string): "config_error" | "network_error" | "timeout" | "api_error" {
  if (/not configured|configure|Platform API|Settings.*Integrations|Client ID|Company ID/i.test(msg)) return "config_error";
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network|socket hang up|DNS/i.test(msg)) return "network_error";
  if (/ETIMEDOUT|timeout|timed out|aborted/i.test(msg)) return "timeout";
  return "api_error";
}

export function enrichRefundError(msg: string, ctx: { method?: string | null; orderName?: string | null }): string {
  if (!msg) return msg;
  if (/no transactions|transactions cannot be empty/i.test(msg) && ctx.method === "original")
    return `${msg} — This may be a COD or gift-card order. Try "Store credit" or "Discount code" refund method instead.`;
  if (/customer.*not found|store.*credit.*no.*customer|store_credit.*customer/i.test(msg))
    return `${msg} — Store credit requires the customer to have a Shopify account. Use "Discount code" method instead.`;
  if (/already.*been.*refunded|already refunded/i.test(msg))
    return `${msg} — Check Shopify Admin for order ${ctx.orderName ?? ""} to verify refund status.`;
  if (/location|restock/i.test(msg))
    return `${msg} — Try a different restock location, or disable restocking in Settings → Return Settings.`;
  if (/gift.*card|store_credit.*amount/i.test(msg))
    return `${msg} — Use "Discount code" refund method for gift card or store credit orders.`;
  return msg;
}

export function isRedirectResponse(err: unknown): boolean {
  if (err instanceof Response) {
    return err.status >= 300 && err.status < 400;
  }
  return false;
}

export async function extractErrorMessage(err: unknown): Promise<string> {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT")) {
      return "Unable to connect to external service. Please try again later.";
    }
    return truncateAtBoundary(msg);
  }
  if (typeof err === "object" && err !== null && "ok" in err && typeof (err as Response).json === "function") {
    const res = err as Response;
    try {
      const j = await res.json().catch(() => ({}));
      const msg = (j as { error?: string; message?: string })?.error ?? (j as { error?: string; message?: string })?.message;
      if (typeof msg === "string" && msg.trim()) {
        return truncateAtBoundary(msg);
      }
    } catch {
      /* ignore */
    }
    return `Request failed (${res.status}). Please check Fynd configuration and try again.`;
  }
  const s = String(err);
  if (s === "[object Response]" || s === "[object Object]") return "Request failed. Please check Fynd configuration and try again.";
  return truncateAtBoundary(s);
}
