import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * Shopify orders/create webhook handler.
 *
 * When a new order is placed (e.g. via Fynd), this handler:
 * 1. Extracts the Fynd affiliate_order_id from note_attributes (customAttributes)
 * 2. Writes it as a METAFIELD on the order ($app:fynd_order_id)
 * 3. Caches the mapping in FyndOrderMapping for fast DB-level lookups
 *
 * The metafield is indexed by Shopify (adminFilterable: true), so the order
 * becomes searchable via: orders(query: "metafields.$app.fynd_order_id:\"VALUE\"")
 * This is O(1) and works regardless of store volume or order age.
 */

const SET_FYND_METAFIELD_MUTATION = `#graphql
  mutation SetFyndOrderMetafield($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderGid = p.admin_graphql_api_id ? String(p.admin_graphql_api_id) : null;
  const orderId = p.id ? String(p.id) : null;
  const orderName = p.name ? String(p.name).trim() : null;

  if (!orderName || (!orderGid && !orderId)) return new Response();

  const attrs = Array.isArray(p.note_attributes)
    ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
        key: a.name ?? "",
        value: a.value ?? "",
      }))
    : [];

  const fyndOrderId = extractAffiliateOrderId(attrs);
  if (!fyndOrderId) return new Response();

  const gid = orderGid ?? `gid://shopify/Order/${orderId}`;

  // Write the metafield on the Shopify order so it becomes searchable
  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    const session = await prisma.session.findFirst({ where: { shop } });
    if (!session?.accessToken) return new Response();

    const { default: shopifyApp } = await import("../shopify.server");
    const { admin } = await shopifyApp.unauthenticated.admin(shop);

    await admin.graphql(SET_FYND_METAFIELD_MUTATION, {
      variables: {
        input: {
          id: gid,
          metafields: [
            {
              namespace: "$app",
              key: "fynd_order_id",
              value: fyndOrderId,
              type: "single_line_text_field",
            },
          ],
        },
      },
    });

    // Also cache in DB for fast lookups without hitting Shopify API
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
        shopifyOrderId: gid,
        fyndOrderId,
        searchStrategy: "orders_create_webhook",
      },
      update: {
        fyndOrderId,
        shopifyOrderId: gid,
      },
    });
  } catch (err) {
    console.error("[webhook:orders/create]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
