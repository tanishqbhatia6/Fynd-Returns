import prisma from "../db.server";

const EXCHANGE_DELIVERED_STATUSES = new Set(["delivered", "fulfilled"]);

export function isExchangeDeliveredStatus(status: string | null | undefined): boolean {
  return EXCHANGE_DELIVERED_STATUSES.has((status ?? "").trim().toLowerCase());
}

export async function markExchangeDeliveredForOrder({
  shopId,
  orderGid,
  orderName,
  fulfillmentStatus,
  source,
}: {
  shopId: string;
  orderGid: string | null;
  orderName: string;
  fulfillmentStatus: string | null | undefined;
  source: string;
}): Promise<{ matched: number; updated: number }> {
  const normalizedStatus = (fulfillmentStatus ?? "").trim().toLowerCase();
  if (!orderGid || !isExchangeDeliveredStatus(normalizedStatus)) {
    return { matched: 0, updated: 0 };
  }

  const matchedReturns = await prisma.returnCase.findMany({
    where: {
      shopId,
      resolutionType: "exchange",
      exchangeOrderId: orderGid,
      OR: [{ refundStatus: null }, { refundStatus: { notIn: ["exchanged", "refunded"] } }],
    },
    select: { id: true },
  });
  const returns = Array.isArray(matchedReturns) ? matchedReturns : [];

  for (const returnCase of returns) {
    await prisma.returnCase.update({
      where: { id: returnCase.id },
      data: {
        status: "completed",
        refundStatus: "exchanged",
      },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "shopify_webhook",
        eventType: "exchange_completed",
        payloadJson: JSON.stringify({
          order_id: orderGid,
          order_name: orderName,
          fulfillment_status: normalizedStatus,
          source,
          timestamp: new Date().toISOString(),
        }),
      },
    });
  }

  return { matched: returns.length, updated: returns.length };
}
