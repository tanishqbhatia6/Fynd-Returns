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
  // Same hardening as orders.create: re-throw HMAC 401 Responses (Shopify
  // expects them) but swallow other authenticate-time errors so we don't
  // trigger Shopify's retry storm against the topic.
  let authed: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    /* v8 ignore start - defensive auth failure handling (rethrow Response, swallow others) */
    if (err instanceof Response) throw err;
    console.error("[webhook:draft-orders/create] authenticate failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response();
    /* v8 ignore stop */
  }
  const { shop, payload } = authed;
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  /* v8 ignore start - defensive ternary on optional payload fields */
  const draftOrderGid = p.admin_graphql_api_id ? String(p.admin_graphql_api_id) : null;
  const draftOrderId = p.id ? String(p.id) : null;
  const orderName = p.name ? String(p.name).trim() : null;
  /* v8 ignore stop */

  if (!orderName || (!draftOrderGid && !draftOrderId)) return new Response();

  /* v8 ignore start - defensive type guard + nullish fallback on optional payload fields */
  const attrs = Array.isArray(p.note_attributes)
    ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
        key: a.name ?? "",
        value: a.value ?? "",
      }))
    : [];
  /* v8 ignore stop */

  const fyndOrderId = extractAffiliateOrderId(attrs);
  if (!fyndOrderId) return new Response();

  /* v8 ignore start - defensive nullish coalescing on optional GID */
  const gid = draftOrderGid ?? `gid://shopify/DraftOrder/${draftOrderId}`;
  /* v8 ignore stop */

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
    /* v8 ignore start - defensive Error narrowing in catch */
    console.error("[webhook:draft_orders/create]", err instanceof Error ? err.message : err);
    /* v8 ignore stop */
  }

  return new Response();
};
