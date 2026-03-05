import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * One-time bulk backfill for ALL historical Shopify orders.
 *
 * For each order that has an affiliate_order_id in customAttributes, this:
 *   1. Writes a METAFIELD ($app:fynd_order_id) on the order via orderUpdate
 *      → Makes the order searchable via: metafields.$app.fynd_order_id:"VALUE"
 *      → Indexed by Shopify, O(1) lookup, works at any scale
 *   2. Caches the mapping in FyndOrderMapping (DB) for fast local lookups
 *
 * POST /api/admin/backfill-fynd-mappings
 * Body: { maxPages?: number }  (default: unlimited — scans all orders)
 *
 * Idempotent. Safe to run multiple times. Admin-only (authenticated session).
 */

const BACKFILL_QUERY = `#graphql
  query backfillOrders($cursor: String) {
    orders(first: 250, sortKey: CREATED_AT, reverse: true, after: $cursor) {
      nodes {
        id
        name
        customAttributes { key value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const SET_METAFIELD_MUTATION = `#graphql
  mutation SetFyndMetafield($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  let maxPages = 0;
  try {
    const body = await request.json();
    maxPages = body?.maxPages ?? 0;
  } catch { /* use default */ }

  let cursor: string | null = null;
  let totalScanned = 0;
  let totalMapped = 0;
  let metafieldsWritten = 0;
  let page = 0;

  while (true) {
    if (maxPages > 0 && page >= maxPages) break;

    const res = await admin.graphql(BACKFILL_QUERY, { variables: { cursor } });
    const json = (await res.json()) as {
      data?: {
        orders?: {
          nodes?: Array<{
            id: string;
            name: string;
            customAttributes?: Array<{ key: string; value: string }>;
          }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (json.errors?.length) {
      return Response.json({
        error: "GraphQL error",
        details: json.errors.map((e) => e.message),
        progress: { totalScanned, totalMapped, metafieldsWritten, pages: page },
      }, { status: 500 });
    }

    const nodes = json.data?.orders?.nodes ?? [];
    if (nodes.length === 0) break;

    for (const node of nodes) {
      totalScanned++;
      const attrs = node.customAttributes ?? [];
      const fyndId = extractAffiliateOrderId(attrs);
      if (!fyndId) continue;

      // Write metafield on the order so Shopify indexes it for search
      try {
        await admin.graphql(SET_METAFIELD_MUTATION, {
          variables: {
            input: {
              id: node.id,
              metafields: [{
                namespace: "$app",
                key: "fynd_order_id",
                value: fyndId,
                type: "single_line_text_field",
              }],
            },
          },
        });
        metafieldsWritten++;
      } catch (err) {
        console.error(`[backfill] metafield write failed for ${node.id}:`, err instanceof Error ? err.message : err);
      }

      // Also cache in DB
      try {
        await prisma.fyndOrderMapping.upsert({
          where: {
            shopId_shopifyOrderName: {
              shopId: shopRecord.id,
              shopifyOrderName: node.name,
            },
          },
          create: {
            shopId: shopRecord.id,
            shopifyOrderName: node.name,
            shopifyOrderId: node.id,
            fyndOrderId: fyndId,
            searchStrategy: "bulk_backfill",
          },
          update: {
            fyndOrderId: fyndId,
            shopifyOrderId: node.id,
          },
        });
        totalMapped++;
      } catch { /* skip conflicts */ }
    }

    if (!json.data?.orders?.pageInfo?.hasNextPage) break;
    cursor = json.data?.orders?.pageInfo?.endCursor ?? null;
    if (!cursor) break;
    page++;
  }

  return Response.json({
    success: true,
    totalScanned,
    totalMapped,
    metafieldsWritten,
    pages: page + 1,
    message: `Backfill complete. Scanned ${totalScanned} orders, wrote ${metafieldsWritten} metafields, cached ${totalMapped} DB mappings.`,
  });
};
