import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * Shopify orders/create webhook handler.
 *
 * Captures the Fynd affiliate_order_id → Shopify order mapping at creation
 * time so that Track Order lookups work instantly for ANY order, regardless
 * of whether a return has been created. This eliminates the need for
 * expensive custom attribute scans.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderGid = p.admin_graphql_api_id ? String(p.admin_graphql_api_id) : null;
  const orderId = p.id ? String(p.id) : null;
  const orderName = p.name ? String(p.name).trim() : null;

  if (!orderName) return new Response();

  const attrs = Array.isArray(p.note_attributes)
    ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
        key: a.name ?? "",
        value: a.value ?? "",
      }))
    : [];

  const fyndOrderId = extractAffiliateOrderId(attrs);
  if (!fyndOrderId) return new Response();

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    const gid = orderGid ?? (orderId ? `gid://shopify/Order/${orderId}` : null);

    await prisma.fyndOrderMapping.upsert({
      where: {
        shopId_shopifyOrderName: {
          shopId: shopRecord.id,
          shopifyOrderName: orderName,
        },
      },
      create: {
        shopId: shopRecord.id,
        shopifyOrderName: orderName,
        shopifyOrderId: gid ?? undefined,
        fyndOrderId,
        searchStrategy: "orders_create_webhook",
      },
      update: {
        fyndOrderId,
        ...(gid ? { shopifyOrderId: gid } : {}),
      },
    });
  } catch (err) {
    console.error("[webhook:orders/create] FyndOrderMapping upsert:", err instanceof Error ? err.message : err);
  }

  return new Response();
};
