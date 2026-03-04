import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  if (!payload || typeof payload !== "object") return new Response();

  const p = payload as Record<string, unknown>;
  const orderName = String(p.name ?? p.order_number ?? "").replace(/^#/, "").trim();
  const financialStatus = String(p.financial_status ?? "").toLowerCase();
  const cancelledAt = p.cancelled_at;

  if (!orderName) return new Response();

  try {
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: shop } });
    if (!shopRecord) return new Response();

    if (cancelledAt || financialStatus === "refunded" || financialStatus === "voided") {
      const returns = await prisma.returnCase.findMany({
        where: {
          shopId: shopRecord.id,
          shopifyOrderName: { contains: orderName },
          status: { in: ["pending", "initiated"] },
        },
      });

      for (const rc of returns) {
        // Idempotency: skip if already cancelled
        if (rc.status === "cancelled") continue;

        await prisma.returnCase.update({
          where: { id: rc.id },
          data: { status: "cancelled", adminNotes: `Auto-cancelled: order ${cancelledAt ? "cancelled" : financialStatus} on Shopify` },
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
    }
  } catch (err) {
    console.error("[webhook:orders/updated]", err instanceof Error ? err.message : err);
  }

  return new Response();
};
