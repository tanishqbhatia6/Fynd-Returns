/**
 * Gorgias Helpdesk Integration — Widget Endpoint
 *
 * Returns an HTML card that Gorgias displays in its sidebar when viewing a customer.
 * Gorgias sends customer email/order info, and we return return case context.
 *
 * GET /api/integrations/gorgias?shop=<domain>&email=<customer_email>&order=<order_name>
 */
import type { LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import prisma from "../db.server";
import { decryptIfEncrypted } from "../lib/encryption.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const customerEmail = (url.searchParams.get("email") || "").toLowerCase().trim();
  const orderName = url.searchParams.get("order") || "";
  const apiKey = url.searchParams.get("api_key") || request.headers.get("x-gorgias-api-key") || "";

  if (!shopDomain) {
    return new Response(renderCard("Configuration Error", "Missing shop parameter.", []), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Verify shop & Gorgias config
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com` },
    include: { settings: true },
  });

  if (!shop?.settings?.gorgiasEnabled) {
    return new Response(renderCard("Not Configured", "Gorgias integration is not enabled for this shop.", []), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Validate API key if configured. Stored value is encrypted (post P0 rollout); the
  // tolerant decrypt returns plaintext as-is for any pre-rollout rows. Comparison is
  // timing-safe to avoid leaking the prefix via string-equality timing.
  if (shop.settings.gorgiasApiKey) {
    /* v8 ignore start */
    // defensive: decrypt always returns string; ?? "" fallback unreachable
    const storedPlain = decryptIfEncrypted(shop.settings.gorgiasApiKey) ?? "";
    /* v8 ignore stop */
    let ok = false;
    try {
      const a = Buffer.from(apiKey, "utf8");
      const b = Buffer.from(storedPlain, "utf8");
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { ok = false; }
    if (!ok) {
      return new Response(renderCard("Unauthorized", "Invalid API key.", []), {
        status: 401,
        headers: { "Content-Type": "text/html" },
      });
    }
  }

  // Find returns by email or order
  const where: Record<string, unknown> = { shopId: shop.id };
  if (customerEmail) {
    where.customerEmailNorm = customerEmail;
  } else if (orderName) {
    where.shopifyOrderName = orderName;
  } else {
    return new Response(renderCard("No Data", "No email or order provided by Gorgias.", []), {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Defensive: try with new fields first, fall back without them if columns don't exist yet
  let returns: Array<{
    id: string; returnRequestNo: string | null; shopifyOrderName: string | null;
    status: string; resolutionType: string | null; createdAt: Date; customerName: string | null;
    isGiftReturn: boolean; fraudRiskLevel: string | null; fraudRiskScore: number | null;
    items: Array<{ title: string | null; qty: number }>;
  }>;
  try {
    returns = await prisma.returnCase.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true, returnRequestNo: true, shopifyOrderName: true,
        status: true, resolutionType: true, createdAt: true, customerName: true,
        isGiftReturn: true, fraudRiskLevel: true, fraudRiskScore: true,
        items: { select: { title: true, qty: true } },
      },
    });
  } catch {
    // Fallback without new fields
    const fallback = await prisma.returnCase.findMany({
      where: where as never,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true, returnRequestNo: true, shopifyOrderName: true,
        status: true, resolutionType: true, createdAt: true, customerName: true,
        items: { select: { title: true, qty: true } },
      },
    });
    returns = fallback.map(r => ({ ...r, isGiftReturn: false, fraudRiskLevel: null, fraudRiskScore: null }));
  }

  if (returns.length === 0) {
    return new Response(renderCard("No Returns", `No return requests found for ${customerEmail || orderName}.`, []), {
      headers: { "Content-Type": "text/html" },
    });
  }

  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  const cards = returns.map(r => {
    const statusColor = getStatusColor(r.status);
    const riskBadge = r.fraudRiskLevel && r.fraudRiskLevel !== "low"
      ? `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:${getRiskColor(r.fraudRiskLevel).bg};color:${getRiskColor(r.fraudRiskLevel).text};margin-left:6px">${r.fraudRiskLevel.toUpperCase()} RISK</span>`
      : "";
    const giftBadge = r.isGiftReturn
      ? `<span style="display:inline-block;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#EDE9FE;color:#7C3AED;margin-left:6px">GIFT</span>`
      : "";
    const items = r.items.map(i => `${i.title} (x${i.qty})`).join(", ");

    return `
      <div style="padding:12px;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <a href="${appUrl}/app/returns/${r.id}" target="_blank" style="font-weight:700;font-size:13px;color:#3b82f6;text-decoration:none">${r.returnRequestNo || r.id.slice(0, 8)}</a>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:${statusColor.bg};color:${statusColor.text}">${r.status.toUpperCase()}</span>
        </div>
        <div style="font-size:12px;color:#64748b;margin-bottom:4px">
          Order: ${r.shopifyOrderName} · ${(r.resolutionType ?? "").replace(/_/g, " ")}${riskBadge}${giftBadge}
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">${items || "No items"}</div>
        <div style="font-size:11px;color:#94a3b8">${new Date(r.createdAt).toLocaleDateString()}</div>
      </div>`;
  });

  return new Response(renderCard(
    `Returns (${returns.length})`,
    `Customer: ${returns[0].customerName || customerEmail}`,
    cards,
  ), {
    headers: { "Content-Type": "text/html" },
  });
};

function renderCard(title: string, subtitle: string, items: string[]): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 12px; color: #1e293b; }
  h3 { font-size: 15px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #64748b; margin: 0 0 12px; }
</style></head>
<body>
  <h3>${title}</h3>
  <p class="sub">${subtitle}</p>
  ${items.join("\n")}
</body></html>`;
}

function getStatusColor(status: string): { bg: string; text: string } {
  switch (status) {
    case "initiated":
    case "pending": return { bg: "#FEF3C7", text: "#92400E" };
    case "approved":
    case "processing": return { bg: "#D1FAE5", text: "#065F46" };
    case "completed": return { bg: "#DBEAFE", text: "#1E40AF" };
    case "rejected": return { bg: "#FEE2E2", text: "#991B1B" };
    case "cancelled": return { bg: "#F3F4F6", text: "#374151" };
    default: return { bg: "#F3F4F6", text: "#374151" };
  }
}

function getRiskColor(level: string): { bg: string; text: string } {
  switch (level) {
    case "critical": return { bg: "#FEE2E2", text: "#DC2626" };
    case "high": return { bg: "#FFEDD5", text: "#EA580C" };
    case "medium": return { bg: "#FEF3C7", text: "#D97706" };
    default: return { bg: "#F3F4F6", text: "#6B7280" };
  }
}
