import type { ActionFunctionArgs } from "react-router";
import shopifyApp, { authenticate } from "../shopify.server";
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
 *
 * CONTRACT: This handler MUST return a 2xx response for all authenticated
 * Shopify webhook deliveries. Any failure in downstream processing is logged
 * but swallowed — otherwise Shopify retries, inflates the failure rate, and
 * eventually unsubscribes the topic. See WEBHOOK_RELIABILITY_AUDIT.md.
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
  // authenticate.webhook may throw a 401 Response on HMAC failure — that's
  // correct and Shopify expects it. Any other throw is wrapped so we return
  // 200 to Shopify and log the details, preventing the retry storm that
  // otherwise counts against the topic's failure rate.
  let authed;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    // Re-throw Response objects (HMAC 401 etc.) so Shopify gets the right
    // status. Wrap every other error so we return 200 and log properly.
    if (err instanceof Response) throw err;
    console.error("[webhook:orders/create] authenticate failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response();
  }

  const { shop, payload } = authed;
  if (!payload || typeof payload !== "object") return new Response();

  try {
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
    // Fast path: no Fynd order ID, nothing to do. Skips DB + Shopify API
    // on the majority of orders (non-Fynd traffic).
    if (!fyndOrderId) return new Response();

    const gid = orderGid ?? `gid://shopify/Order/${orderId}`;

    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    // Write the metafield (best-effort — inner try/catch). If the session
    // is missing or Shopify returns userErrors, we still want to record the
    // DB mapping so order lookups can find this order.
    try {
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
    } catch (err) {
      console.error("[webhook:orders/create] metafield write failed", {
        shop, orderName, fyndOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Cache the mapping in our DB regardless of whether the metafield
    // write succeeded — DB lookup is the authoritative search path.
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
    console.error("[webhook:orders/create]", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return new Response();
};
