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
      const realOrderGid = realOrderId
        ? `gid://shopify/Order/${realOrderId}`
        : null;

      if (realOrderGid) {
        // Update FyndOrderMapping to point to the real Order GID
        try {
          await prisma.fyndOrderMapping.updateMany({
            where: { shopId: shopRecord.id, shopifyOrderName: orderNameRaw || `#${orderName}` },
            data: { shopifyOrderId: realOrderGid, searchStrategy: "draft_order_completed" },
          });
        } catch { /* non-critical */ }
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
      } catch { /* non-critical */ }
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
