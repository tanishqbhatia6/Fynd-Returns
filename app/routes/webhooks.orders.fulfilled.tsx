import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderNameRaw = String(p.name ?? p.order_number ?? "").trim();
  const orderNameClean = orderNameRaw.replace(/^#/, "").trim();
  const fulfillmentStatus = String(p.fulfillment_status ?? "fulfilled").toLowerCase();

  if (!orderNameClean) return new Response();

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
      try {
        await prisma.fyndOrderMapping.upsert({
          where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderNameClean}` } },
          create: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderNameClean}`, shopifyOrderId: gid ?? undefined, fyndOrderId, searchStrategy: "orders_fulfilled_webhook" },
          update: { fyndOrderId, ...(gid ? { shopifyOrderId: gid } : {}) },
        });
      } catch { /* non-critical */ }
    }

    const returns = await prisma.returnCase.findMany({
      where: { shopId: shopRecord.id, shopifyOrderName: { contains: orderNameClean } },
    });

    for (const rc of returns) {
      const recentEvent = await prisma.returnEvent.findFirst({
        where: {
          returnCaseId: rc.id,
          eventType: "order_fulfilled",
          happenedAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      if (recentEvent) continue;

      await prisma.returnEvent.create({
        data: {
          returnCaseId: rc.id,
          source: "shopify_webhook",
          eventType: "order_fulfilled",
          payloadJson: JSON.stringify({
            fulfillment_status: fulfillmentStatus,
            order_name: orderNameClean,
            timestamp: new Date().toISOString(),
          }),
        },
      });
    }
  } catch (err) {
    console.error("[webhook:orders/fulfilled]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
