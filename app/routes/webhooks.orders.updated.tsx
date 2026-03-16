import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";
import { normalizeSourceChannel } from "../lib/source-channel.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderNameRaw = String(p.name ?? p.order_number ?? "").trim();
  const orderName = orderNameRaw.replace(/^#/, "").trim();
  const financialStatus = String(p.financial_status ?? "").toLowerCase();
  const cancelledAt = p.cancelled_at;
  // Capture source_name for lazy backfill of sourceChannel on existing ReturnCase records
  const sourceChannel = normalizeSourceChannel(p.source_name ? String(p.source_name) : null);

  if (!orderName) return new Response();

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    // Cache Fynd order mapping if custom attributes contain affiliate_order_id
    const attrs = Array.isArray(p.note_attributes)
      ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
          key: a.name ?? "", value: a.value ?? "",
        }))
      : [];
    const fyndOrderId = extractAffiliateOrderId(attrs);
    if (fyndOrderId) {
      const gid = p.admin_graphql_api_id ? String(p.admin_graphql_api_id)
        : p.id ? `gid://shopify/Order/${p.id}` : null;
      if (gid) {
        try {
          const { default: shopifyApp } = await import("../shopify.server");
          const { admin } = await shopifyApp.unauthenticated.admin(shop);
          await admin.graphql(
            `#graphql mutation($input: OrderInput!) { orderUpdate(input: $input) { order { id } userErrors { message } } }`,
            { variables: { input: { id: gid, metafields: [{ namespace: "$app", key: "fynd_order_id", value: fyndOrderId, type: "single_line_text_field" }] } } }
          );
        } catch { /* metafield write is best-effort */ }
      }
      try {
        await prisma.fyndOrderMapping.upsert({
          where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}` } },
          create: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}`, shopifyOrderId: gid ?? undefined, fyndOrderId, searchStrategy: "orders_updated_webhook" },
          update: { fyndOrderId, ...(gid ? { shopifyOrderId: gid } : {}) },
        });
      } catch { /* non-critical */ }
    }

    if (cancelledAt || financialStatus === "refunded" || financialStatus === "voided") {
      const returns = await prisma.returnCase.findMany({
        where: {
          shopId: shopRecord.id,
          shopifyOrderName: { contains: orderName },
          status: { in: ["pending", "initiated"] },
        },
      });

      for (const rc of returns) {
        // Idempotency: skip if already cancelled
        if (rc.status === "cancelled") continue;

        await prisma.returnCase.update({
          where: { id: rc.id },
          data: {
            status: "cancelled",
            adminNotes: `Auto-cancelled: order ${cancelledAt ? "cancelled" : financialStatus} on Shopify`,
            // Lazy backfill: set sourceChannel if not already captured at return-creation time
            ...(sourceChannel && !rc.sourceChannel ? { sourceChannel } : {}),
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "shopify_webhook",
            eventType: "auto_cancelled",
            payloadJson: JSON.stringify({
              reason: cancelledAt ? "order_cancelled" : `order_${financialStatus}`,
              order_name: orderName,
              timestamp: new Date().toISOString(),
            }),
          },
        });
      }
    } else if (sourceChannel) {
      // Non-cancellation update: opportunistically backfill sourceChannel for any
      // existing return cases on this order that still have it unset.
      try {
        await prisma.returnCase.updateMany({
          where: {
            shopId: shopRecord.id,
            shopifyOrderName: { contains: orderName },
            sourceChannel: null,
          },
          data: { sourceChannel },
        });
      } catch { /* non-critical backfill */ }
    }
  } catch (err) {
    console.error("[webhook:orders/updated]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
