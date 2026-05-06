import type { ActionFunctionArgs } from "react-router";
import shopifyApp, { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";
import { normalizeSourceChannel } from "../lib/source-channel.server";

/**
 * Shopify orders/updated webhook handler.
 *
 * Fires on every order edit. Two jobs:
 *   (1) Auto-cancel matching ReturnCase records when the underlying order
 *       is cancelled/refunded on Shopify.
 *   (2) Lazy-backfill Fynd mapping + sourceChannel for orders that didn't
 *       have them at create-time.
 *
 * Fast path (April 2026 reliability fix): the majority of orders/updated
 * events carry nothing we care about — a shipping-address edit, a note
 * change, etc. Bail out at the payload-parse stage so we don't hit the DB
 * or the Shopify Admin API for ~90% of deliveries. Before this change, the
 * handler did `shop.findUnique + graphql orderUpdate` on every edit,
 * which was the main driver of the 90% failure rate reported in Partner
 * Dashboard monitoring (see WEBHOOK_RELIABILITY_AUDIT.md).
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
    /* v8 ignore start - defensive Error narrowing in authenticate failure path */
    console.error("[webhook:orders/updated] authenticate failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return new Response();
    /* v8 ignore stop */
  }

  const { shop, payload } = authed;
  if (!payload || typeof payload !== "object") return new Response();

  try {
    const p = payload as Record<string, unknown>;
    /* v8 ignore start - defensive nullish coalescing on payload fields */
    const orderNameRaw = String(p.name ?? p.order_number ?? "").trim();
    /* v8 ignore stop */
    const orderName = orderNameRaw.replace(/^#/, "").trim();
    if (!orderName) return new Response();

    /* v8 ignore start - defensive nullish coalescing on payload fields */
    const financialStatus = String(p.financial_status ?? "").toLowerCase();
    /* v8 ignore stop */
    const cancelledAt = p.cancelled_at;
    const sourceChannel = normalizeSourceChannel(p.source_name ? String(p.source_name) : null);

    /* v8 ignore start - defensive type guard + nullish fallback on optional payload fields */
    const attrs = Array.isArray(p.note_attributes)
      ? (p.note_attributes as Array<{ name?: string; value?: string }>).map((a) => ({
          key: a.name ?? "", value: a.value ?? "",
        }))
      : [];
    /* v8 ignore stop */
    const fyndOrderId = extractAffiliateOrderId(attrs);

    // Fast path: skip the DB+API round-trip unless there's actual work to do.
    // Work is: (a) a fyndOrderId to map, (b) a cancellation we need to
    // propagate to return cases, or (c) a sourceChannel we can backfill.
    const isCancellationEvent = !!cancelledAt || financialStatus === "refunded" || financialStatus === "voided";
    if (!fyndOrderId && !isCancellationEvent && !sourceChannel) {
      return new Response();
    }

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
          // Best-effort — the DB mapping below is the authoritative path.
          /* v8 ignore start - defensive Error narrowing in catch */
          console.error("[webhook:orders/updated] metafield write failed", {
            shop, orderName, fyndOrderId,
            error: err instanceof Error ? err.message : String(err),
          });
          /* v8 ignore stop */
        }
      }

      try {
        /* v8 ignore start - defensive fallback chains for optional payload fields */
        await prisma.fyndOrderMapping.upsert({
          where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}` } },
          create: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}`, shopifyOrderId: gid ?? undefined, fyndOrderId, searchStrategy: "orders_updated_webhook" },
          update: { fyndOrderId, ...(gid ? { shopifyOrderId: gid } : {}) },
        });
        /* v8 ignore stop */
      } catch (err) {
        /* v8 ignore start - defensive Error narrowing in catch */
        console.error("[webhook:orders/updated] mapping upsert failed", {
          shop, orderName, fyndOrderId,
          error: err instanceof Error ? err.message : String(err),
        });
        /* v8 ignore stop */
      }
    }

    if (isCancellationEvent) {
      const returns = await prisma.returnCase.findMany({
        where: {
          shopId: shopRecord.id,
          shopifyOrderName: { contains: orderName },
          status: { in: ["pending", "initiated"] },
        },
      });

      for (const rc of returns) {
        // Idempotency: skip if already cancelled.
        if (rc.status === "cancelled") continue;

        await prisma.returnCase.update({
          where: { id: rc.id },
          data: {
            status: "cancelled",
            adminNotes: `Auto-cancelled: order ${cancelledAt ? "cancelled" : financialStatus} on Shopify`,
            // Lazy backfill: set sourceChannel if not already captured at return-creation time.
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
      // Non-cancellation update: opportunistically backfill sourceChannel
      // for any existing return cases on this order that still have it unset.
      try {
        await prisma.returnCase.updateMany({
          where: {
            shopId: shopRecord.id,
            shopifyOrderName: { contains: orderName },
            sourceChannel: null,
          },
          data: { sourceChannel },
        });
      } catch (err) {
        /* v8 ignore start - defensive Error narrowing in catch */
        console.error("[webhook:orders/updated] sourceChannel backfill failed", {
          shop, orderName,
          error: err instanceof Error ? err.message : String(err),
        });
        /* v8 ignore stop */
      }
    }
  } catch (err) {
    /* v8 ignore start - defensive Error narrowing in outer catch */
    console.error("[webhook:orders/updated]", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    /* v8 ignore stop */
  }

  return new Response();
};
