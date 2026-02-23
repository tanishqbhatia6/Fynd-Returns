/**
 * Fynd Shipment Update Webhook Handler
 *
 * Listens for Fynd shipment/refund status updates and:
 * - refund_initiated / refund_pending / UNDER PROCESS → refundStatus = "in_progress"
 * - refund_done / refunded → calls Shopify Refund API, refundStatus = "refunded"
 *
 * Webhook URL: POST /api/webhooks/fynd
 * Configure this URL in Fynd Platform (Partners → Webhooks) for shipment status events.
 */

import prisma from "../db.server";
import { createAdminClient, createRefund, fetchOrder, fetchOrderByOrderNumber } from "./shopify-admin.server";

/** Fynd refund statuses that indicate refund is in progress */
const REFUND_IN_PROGRESS = [
  "refund_initiated",
  "refund_pending",
  "under process",
  "under_process",
  "UNDER PROCESS",
  "in_progress",
  "processing",
];

/** Fynd refund statuses that indicate refund is complete */
const REFUND_COMPLETE = ["refund_done", "refunded", "REFUNDED", "completed", "COMPLETED"];

export type FyndWebhookPayload = {
  shipment_id?: string;
  shipmentId?: string;
  id?: string;
  order_id?: string;
  orderId?: string;
  affiliate_order_id?: string;
  affiliateOrderId?: string;
  external_order_id?: string;
  channel_order_id?: string;
  status?: string;
  refund_status?: string;
  refund_status_flag?: string;
  event?: string;
  shipments?: Array<{
    shipment_id?: string;
    shipmentId?: string;
    id?: string;
    status?: string;
    refund_status?: string;
    order?: { affiliate_order_id?: string; fynd_order_id?: string };
  }>;
  order?: {
    affiliate_order_id?: string;
    fynd_order_id?: string;
    shipments?: Array<{ shipment_id?: string; shipmentId?: string; status?: string; refund_status?: string }>;
  };
};

function extractShipmentId(payload: FyndWebhookPayload): string | null {
  const s =
    payload.shipment_id ??
    payload.shipmentId ??
    payload.id ??
    payload.shipments?.[0]?.shipment_id ??
    payload.shipments?.[0]?.shipmentId ??
    payload.shipments?.[0]?.id ??
    payload.order?.shipments?.[0]?.shipment_id ??
    payload.order?.shipments?.[0]?.shipmentId;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

function extractRefundStatus(payload: FyndWebhookPayload): string | null {
  const s =
    payload.refund_status ??
    payload.refund_status_flag ??
    payload.status ??
    payload.shipments?.[0]?.refund_status ??
    payload.shipments?.[0]?.status ??
    payload.order?.shipments?.[0]?.refund_status ??
    payload.order?.shipments?.[0]?.status;
  return typeof s === "string" && s.trim() ? String(s).trim() : null;
}

function extractAffiliateOrderId(payload: FyndWebhookPayload): string | null {
  const s =
    payload.affiliate_order_id ??
    payload.affiliateOrderId ??
    payload.external_order_id ??
    payload.channel_order_id ??
    payload.order?.affiliate_order_id ??
    payload.shipments?.[0]?.order?.affiliate_order_id;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

export type ProcessFyndWebhookResult =
  | { ok: true; action: "refund_in_progress" | "refund_completed" | "ignored"; returnCaseId?: string }
  | { ok: false; error: string };

export async function processFyndWebhook(payload: FyndWebhookPayload): Promise<ProcessFyndWebhookResult> {
  const shipmentId = extractShipmentId(payload);
  const refundStatus = extractRefundStatus(payload);
  const affiliateOrderId = extractAffiliateOrderId(payload);

  if (!shipmentId && !affiliateOrderId) {
    return { ok: false, error: "Could not extract shipment_id or affiliate_order_id from webhook payload" };
  }

  // Find return case by fyndShipmentId (preferred) or fyndOrderId
  const returnCase = await prisma.returnCase.findFirst({
    where: shipmentId
      ? { fyndShipmentId: shipmentId }
      : affiliateOrderId
        ? { fyndOrderId: affiliateOrderId }
        : undefined,
    include: { items: true, shop: true },
  });

  if (!returnCase) {
    return { ok: true, action: "ignored", returnCaseId: undefined };
  }

  const shopDomain = returnCase.shop.shopDomain;

  // Get offline session for Shopify API
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
  });
  if (!session?.accessToken) {
    return { ok: false, error: `No offline session for shop ${shopDomain}. App may need to be reinstalled.` };
  }

  const admin = createAdminClient(shopDomain, session.accessToken);

  // Map Fynd status to our action
  const statusLower = (refundStatus ?? "").toLowerCase().replace(/\s+/g, "_");
  const isInProgress =
    REFUND_IN_PROGRESS.some((s) => statusLower === s.toLowerCase()) ||
    /under.?process|in.?progress|pending|initiated|processing/i.test(refundStatus ?? "");
  const isComplete = REFUND_COMPLETE.some((s) => statusLower === s.toLowerCase()) || /refund.?done|refunded/i.test(refundStatus ?? "");

  if (isInProgress) {
    await prisma.returnCase.update({
      where: { id: returnCase.id },
      data: { refundStatus: "in_progress" },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "fynd_webhook",
        eventType: "refund_in_progress",
        payloadJson: JSON.stringify({ fynd_refund_status: refundStatus, shipment_id: shipmentId }),
      },
    });
    return { ok: true, action: "refund_in_progress", returnCaseId: returnCase.id };
  }

  if (isComplete && returnCase.refundStatus !== "refunded") {
    // Process refund in Shopify
    if (returnCase.shopifyOrderId?.startsWith("manual:")) {
      await prisma.returnCase.update({
        where: { id: returnCase.id },
        data: { refundStatus: "refunded", status: "completed" },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: returnCase.id,
          source: "fynd_webhook",
          eventType: "refund_marked_complete",
          payloadJson: JSON.stringify({ note: "Manual return - Fynd refund done, mark complete in app" }),
        },
      });
      return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
    }

    let orderIdForRefund = returnCase.shopifyOrderId;
    let lineItemIds = (returnCase.items ?? [])
      .map((i) => i.shopifyLineItemId)
      .filter((x): x is string => !!x && x !== "manual");

    const isGid = orderIdForRefund?.startsWith("gid://");
    const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
    if (!isGid && !isNumericId) {
      const orderNumber = (returnCase.shopifyOrderName ?? orderIdForRefund ?? "").replace(/^#/, "").trim();
      const orderByNumber = orderNumber ? await fetchOrderByOrderNumber(admin, orderNumber) : null;
      if (orderByNumber?.id) {
        orderIdForRefund = orderByNumber.id;
        if (lineItemIds.length === 0 && orderByNumber.lineItems?.length) {
          lineItemIds = orderByNumber.lineItems.map((li) => li.id);
        }
      }
    }

    if (!orderIdForRefund) {
      return { ok: false, error: "Could not determine Shopify order for refund" };
    }

    if (lineItemIds.length === 0) {
      const order = await fetchOrder(admin, orderIdForRefund);
      if (order?.lineItems?.length) {
        lineItemIds = order.lineItems.map((li) => li.id);
      }
    }

    const result = await createRefund(
      admin,
      orderIdForRefund,
      lineItemIds,
      `Refund processed via Fynd webhook (shipment ${shipmentId})`
    );
    if (!result.success) {
      return { ok: false, error: result.error ?? "Shopify refund failed" };
    }

    await prisma.returnCase.update({
      where: { id: returnCase.id },
      data: { refundStatus: "refunded", status: "completed" },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "fynd_webhook",
        eventType: "refund_processed",
        payloadJson: JSON.stringify({ shipment_id: shipmentId, fynd_refund_status: refundStatus }),
      },
    });
    return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
  }

  return { ok: true, action: "ignored", returnCaseId: returnCase.id };
}
