import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Shopify draft_orders/update webhook handler.
 *
 * Handles two key scenarios:
 * 1. Draft order completed (converted to real order): update FyndOrderMapping to
 *    point to the real Shopify Order GID instead of the DraftOrder GID.
 * 2. Draft order cancelled: auto-cancel any ReturnCase records that reference
 *    this draft order name (unlikely but possible if a return was created manually).
 *
 * In both cases, also backfills sourceChannel = "draft_order" on any ReturnCase
 * records matching this order name that still have sourceChannel = null.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderNameRaw = String(p.name ?? "").trim();
  const orderName = orderNameRaw.replace(/^#/, "").trim();
  const status = String(p.status ?? "").toLowerCase(); // "open" | "completed" | "invoiced"

  if (!orderName) return new Response();

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    if (status === "completed") {
      // Draft order was converted to a real order.
      // Shopify includes order_id and order_gid on the completed draft order payload.
      const realOrderId = p.order_id ? String(p.order_id) : null;
      const realOrderGraphqlId = p.order_admin_graphql_api_id ?? p.order_gid;
      const realOrderGid = realOrderGraphqlId
        ? String(realOrderGraphqlId)
        : realOrderId?.startsWith("gid://shopify/Order/")
          ? realOrderId
          : realOrderId
            ? `gid://shopify/Order/${realOrderId}`
            : null;
      const draftOrderGid = p.admin_graphql_api_id
        ? String(p.admin_graphql_api_id)
        : p.id
          ? `gid://shopify/DraftOrder/${p.id}`
          : null;
      const realOrderName = String(p.order_name ?? "").trim();

      if (realOrderGid) {
        // Update FyndOrderMapping to point to the real Order GID
        try {
          await prisma.fyndOrderMapping.updateMany({
            /* v8 ignore start */
            // defensive: orderNameRaw always present from webhook payload; #-prefix fallback unreachable
            where: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}` },
            /* v8 ignore stop */
            data: { shopifyOrderId: realOrderGid, searchStrategy: "draft_order_completed" },
          });
        } catch {
          /* non-critical */
        }

        try {
          const exchangeReturns = await prisma.returnCase.findMany({
            where: {
              shopId: shopRecord.id,
              resolutionType: "exchange",
              OR: [
                ...(draftOrderGid ? [{ exchangeOrderId: draftOrderGid }] : []),
                { exchangeOrderName: orderNameRaw },
                { exchangeOrderName: `#${orderName}` },
              ],
            },
            select: { id: true, exchangeOrderId: true },
          });

          const returns = Array.isArray(exchangeReturns) ? exchangeReturns : [];
          for (const returnCase of returns) {
            if (returnCase.exchangeOrderId === realOrderGid) continue;
            await prisma.returnCase.update({
              where: { id: returnCase.id },
              data: {
                exchangeOrderId: realOrderGid,
                ...(realOrderName ? { exchangeOrderName: realOrderName } : {}),
              },
            });
            await prisma.returnEvent.create({
              data: {
                returnCaseId: returnCase.id,
                source: "shopify_webhook",
                eventType: "exchange_order_completed",
                payloadJson: JSON.stringify({
                  draft_order_id: draftOrderGid,
                  draft_order_name: orderNameRaw || `#${orderName}`,
                  order_id: realOrderGid,
                  order_name: realOrderName || null,
                  timestamp: new Date().toISOString(),
                }),
              },
            });
          }
        } catch {
          /* non-critical */
        }
      }

      // Backfill sourceChannel on any existing ReturnCase for this order
      try {
        await prisma.returnCase.updateMany({
          where: {
            shopId: shopRecord.id,
            shopifyOrderName: { contains: orderName },
            sourceChannel: null,
          },
          data: { sourceChannel: "draft_order" },
        });
      } catch {
        /* non-critical */
      }
    } else if (status !== "open" && status !== "invoiced") {
      // Draft order was cancelled/deleted — cancel any associated returns
      const returns = await prisma.returnCase.findMany({
        where: {
          shopId: shopRecord.id,
          shopifyOrderName: { contains: orderName },
          status: { in: ["pending", "initiated"] },
        },
      });
      for (const rc of returns) {
        if (rc.status === "cancelled") continue;
        await prisma.returnCase.update({
          where: { id: rc.id },
          data: {
            status: "cancelled",
            adminNotes: "Auto-cancelled: draft order cancelled on Shopify",
            ...(rc.sourceChannel ? {} : { sourceChannel: "draft_order" }),
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "shopify_webhook",
            eventType: "auto_cancelled",
            payloadJson: JSON.stringify({
              reason: "draft_order_cancelled",
              order_name: orderName,
              timestamp: new Date().toISOString(),
            }),
          },
        });
      }
    }
  } catch (err) {
    console.error("[webhook:draft_orders/update]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
