import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderName = String(p.name ?? p.order_number ?? "").replace(/^#/, "").trim();
  const fulfillmentStatus = String(p.fulfillment_status ?? "fulfilled").toLowerCase();

  if (!orderName) return new Response();

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    const returns = await prisma.returnCase.findMany({
      where: { shopId: shopRecord.id, shopifyOrderName: { contains: orderName } },
    });

    for (const rc of returns) {
      // Idempotency: skip if we already recorded this event recently
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
            order_name: orderName,
            timestamp: new Date().toISOString(),
          }),
        },
      });
    }
  } catch (err) {
    console.error("[webhook:orders/fulfilled]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
