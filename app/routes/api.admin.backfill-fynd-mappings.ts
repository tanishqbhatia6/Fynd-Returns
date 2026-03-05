import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractAffiliateOrderId } from "../lib/shopify-admin.server";

/**
 * One-time bulk backfill of FyndOrderMapping for ALL historical orders.
 *
 * This scans every order in the Shopify store (paginated, 250/page) and
 * extracts affiliate_order_id from customAttributes. Results are cached
 * in FyndOrderMapping so Track Order works instantly for any Fynd order ID
 * regardless of volume or age.
 *
 * POST /api/admin/backfill-fynd-mappings
 * Body: { maxPages?: number }  (default: unlimited — scans all orders)
 *
 * This is idempotent — safe to run multiple times. Designed for admin use
 * (requires authenticated Shopify session), not customer-facing.
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

const AFFILIATE_KEYS = [
  "affiliate_order_id",
  "_affiliate_order_id",
  "fynd_affiliate_order_id",
  "fynd_order_id",
  "_fynd_order_id",
  "fyndorderid",
  "affiliateorderid",
  "order_id",
  "external_order_id",
];

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
        progress: { totalScanned, totalMapped, pages: page },
      }, { status: 500 });
    }

    const nodes = json.data?.orders?.nodes ?? [];
    if (nodes.length === 0) break;

    const mappings: Array<{
      shopifyOrderId: string;
      shopifyOrderName: string;
      fyndOrderId: string;
    }> = [];

    for (const node of nodes) {
      totalScanned++;
      const attrs = node.customAttributes ?? [];
      const fyndId = extractAffiliateOrderId(attrs);
      if (fyndId) {
        mappings.push({
          shopifyOrderId: node.id,
          shopifyOrderName: node.name,
          fyndOrderId: fyndId,
        });
      }
    }

    for (const m of mappings) {
      try {
        await prisma.fyndOrderMapping.upsert({
          where: {
            shopId_shopifyOrderName: {
              shopId: shopRecord.id,
              shopifyOrderName: m.shopifyOrderName,
            },
          },
          create: {
            shopId: shopRecord.id,
            shopifyOrderName: m.shopifyOrderName,
            shopifyOrderId: m.shopifyOrderId,
            fyndOrderId: m.fyndOrderId,
            searchStrategy: "bulk_backfill",
          },
          update: {
            fyndOrderId: m.fyndOrderId,
            shopifyOrderId: m.shopifyOrderId,
          },
        });
        totalMapped++;
      } catch {
        // Skip duplicates / conflicts
      }
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
    pages: page + 1,
    message: `Backfill complete. Scanned ${totalScanned} orders, mapped ${totalMapped} Fynd order IDs.`,
  });
};
