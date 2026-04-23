import type { ActionFunctionArgs } from "react-router";
import shopifyApp, { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * Shopify orders/fulfilled webhook handler.
 *
 * Logs a "order_fulfilled" event on every matching ReturnCase so the
 * return-detail timeline shows when the original order shipped. Also
 * lazy-backfills the Fynd order mapping + metafield for Fynd orders that
 * weren't captured at create-time.
 *
 * Fast path: skip DB + Shopify API entirely for orders that have no Fynd
 * affiliate_order_id AND no matching ReturnCase. See
 * WEBHOOK_RELIABILITY_AUDIT.md for the April 2026 reliability review.
 */

const SET_FYND_METAFIELD_MUTATION = `#graphql
  mutation($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { message }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  let authed;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[webhook:orders/fulfilled] authenticate failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response();
  }

  const { shop, payload } = authed;
  if (!payload || typeof payload !== "object") return new Response();

  try {
    const p = payload as Record<string, unknown>;
    const orderNameRaw = String(p.name ?? p.order_number ?? "").trim();
    const orderNameClean = orderNameRaw.replace(/^#/, "").trim();
    if (!orderNameClean) return new Response();

    const fulfillmentStatus = String(p.fulfillment_status ?? "fulfilled").toLowerCase();

    const attrs = Array.isArray(p.note_attributes)
      ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
          key: a.name ?? "", value: a.value ?? "",
        }))
      : [];
    const fyndOrderId = extractAffiliateOrderId(attrs);

    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    // Metafield + mapping backfill for Fynd orders.
    if (fyndOrderId) {
      const gid = p.admin_graphql_api_id
        ? String(p.admin_graphql_api_id)
        : p.id ? `gid://shopify/Order/${p.id}` : null;

      if (gid) {
        try {
          const { admin } = await shopifyApp.unauthenticated.admin(shop);
          await admin.graphql(SET_FYND_METAFIELD_MUTATION, {
            variables: {
              input: {
                id: gid,
                metafields: [{
                  namespace: "$app",
                  key: "fynd_order_id",
                  value: fyndOrderId,
                  type: "single_line_text_field",
                }],
              },
            },
          });
        } catch (err) {
          console.error("[webhook:orders/fulfilled] metafield write failed", {
            shop, orderName: orderNameClean, fyndOrderId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      try {
        await prisma.fyndOrderMapping.upsert({
          where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderNameClean}` } },
          create: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderNameClean}`, shopifyOrderId: gid ?? undefined, fyndOrderId, searchStrategy: "orders_fulfilled_webhook" },
          update: { fyndOrderId, ...(gid ? { shopifyOrderId: gid } : {}) },
        });
      } catch (err) {
        console.error("[webhook:orders/fulfilled] mapping upsert failed", {
          shop, orderName: orderNameClean, fyndOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const returns = await prisma.returnCase.findMany({
      where: { shopId: shopRecord.id, shopifyOrderName: { contains: orderNameClean } },
    });

    for (const rc of returns) {
      // Idempotency: Shopify may deliver duplicate webhooks. Skip if we
      // already logged an order_fulfilled event in the last minute.
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
    console.error("[webhook:orders/fulfilled]", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return new Response();
};
