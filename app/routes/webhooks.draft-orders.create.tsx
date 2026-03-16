import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * Shopify draft_orders/create webhook handler.
 *
 * When a draft order is created, cache the Fynd affiliate_order_id mapping
 * (same as orders/create) so that when the draft converts to a real order,
 * the mapping is already available.
 *
 * Draft orders can eventually convert to real orders via draft_orders/update
 * (status → "completed") at which point the real order ID is captured.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const draftOrderGid = p.admin_graphql_api_id ? String(p.admin_graphql_api_id) : null;
  const draftOrderId = p.id ? String(p.id) : null;
  const orderName = p.name ? String(p.name).trim() : null;

  if (!orderName || (!draftOrderGid && !draftOrderId)) return new Response();

  const attrs = Array.isArray(p.note_attributes)
    ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
        key: a.name ?? "",
        value: a.value ?? "",
      }))
    : [];

  const fyndOrderId = extractAffiliateOrderId(attrs);
  if (!fyndOrderId) return new Response();

  const gid = draftOrderGid ?? `gid://shopify/DraftOrder/${draftOrderId}`;

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    // Cache draft order → Fynd mapping. shopifyOrderId stores the DraftOrder GID
    // temporarily; it will be updated to the real Order GID on draft_orders/update.
    await prisma.fyndOrderMapping.upsert({
      where: {
        shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: orderName },
      },
      create: {
        shopId: shopRecord.id,
        shopifyOrderName: orderName,
        shopifyOrderId: gid,
        fyndOrderId,
        searchStrategy: "draft_orders_create_webhook",
      },
      update: {
        fyndOrderId,
        shopifyOrderId: gid,
      },
    });
  } catch (err) {
    console.error("[webhook:draft_orders/create]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
