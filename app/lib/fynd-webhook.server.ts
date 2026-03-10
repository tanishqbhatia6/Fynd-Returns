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
import { createAdminClient, createRefund, fetchOrder, fetchOrderByOrderNumber, type RefundMethodConfig } from "./shopify-admin.server";
import { sendRefundNotification } from "./notification.server";

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

/** Fynd statuses that trigger auto-refund when autoRefundEnabled is on */
const AUTO_REFUND_TRIGGERS = ["credit_note_generated", "credit_note"];

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
    order_id?: string;
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

/** Fynd order_id (internal) — used for lookup when affiliate_order_id not present */
function extractOrderId(payload: FyndWebhookPayload): string | null {
  const s =
    payload.order_id ??
    payload.orderId ??
    payload.order?.fynd_order_id ??
    payload.order?.order_id ??
    payload.shipments?.[0]?.order?.fynd_order_id;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

/** Collect all order identifiers for multi-strategy lookup */
function extractOrderIdentifiers(payload: FyndWebhookPayload): string[] {
  const ids = new Set<string>();
  for (const id of [
    extractAffiliateOrderId(payload),
    extractOrderId(payload),
  ]) {
    if (id) ids.add(id);
  }
  return [...ids];
}

export type ProcessFyndWebhookResult =
  | { ok: true; action: "refund_in_progress" | "refund_completed" | "ignored"; returnCaseId?: string }
  | { ok: false; error: string };

async function logWebhook(params: {
  shipmentId: string | null;
  orderId: string | null;
  refundStatus: string | null;
  action: string;
  returnCaseId?: string | null;
  rawPayload?: string | null;
  error?: string | null;
}) {
  try {
    await prisma.fyndWebhookLog.create({
      data: {
        shipmentId: params.shipmentId ?? undefined,
        orderId: params.orderId ?? undefined,
        refundStatus: params.refundStatus ?? undefined,
        action: params.action,
        returnCaseId: params.returnCaseId ?? undefined,
        rawPayload: params.rawPayload ? params.rawPayload.slice(0, 10000) : undefined,
        error: params.error ? params.error.slice(0, 2000) : undefined,
      },
    });
  } catch (e) {
    console.warn("[Fynd webhook] Failed to log webhook:", e);
  }
}

export async function processFyndWebhook(payload: FyndWebhookPayload): Promise<ProcessFyndWebhookResult> {
  const shipmentId = extractShipmentId(payload);
  const refundStatus = extractRefundStatus(payload);
  const orderIds = extractOrderIdentifiers(payload);
  const affiliateOrderId = extractAffiliateOrderId(payload);
  const orderId = extractOrderId(payload);

  if (!shipmentId && orderIds.length === 0) {
    await logWebhook({
      shipmentId: null,
      orderId: null,
      refundStatus,
      action: "ignored",
      rawPayload: JSON.stringify(payload),
    });
    return { ok: true, action: "ignored", returnCaseId: undefined };
  }

  // Multi-strategy lookup: fyndShipmentId first, then fyndOrderId (try all order identifiers)
  let returnCase = shipmentId
    ? await prisma.returnCase.findFirst({
        where: { fyndShipmentId: shipmentId },
        include: { items: true, shop: true },
      })
    : null;

  if (!returnCase && orderIds.length > 0) {
    for (const oid of orderIds) {
      returnCase = await prisma.returnCase.findFirst({
        where: { fyndOrderId: oid },
        include: { items: true, shop: true },
      });
      if (returnCase) break;
    }
  }

  if (!returnCase) {
    await logWebhook({
      shipmentId,
      orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
      refundStatus,
      action: "ignored",
      rawPayload: JSON.stringify(payload),
    });
    return { ok: true, action: "ignored", returnCaseId: undefined };
  }

  const backfillData: Record<string, string> = {};
  if (shipmentId && !returnCase.fyndShipmentId) {
    backfillData.fyndShipmentId = shipmentId;
  }
  if (orderId && !returnCase.fyndOrderId) {
    backfillData.fyndOrderId = orderId;
  } else if (affiliateOrderId && !returnCase.fyndOrderId) {
    backfillData.fyndOrderId = affiliateOrderId;
  }
  // When Fynd sends any webhook for this return, it means Fynd has successfully processed the sync.
  // Transition "pending" or "processing" → "synced" so the admin UI stops showing the spinner.
  if (returnCase.fyndSyncStatus === "processing" || returnCase.fyndSyncStatus === "pending") {
    backfillData.fyndSyncStatus = "synced";
  }
  if (Object.keys(backfillData).length > 0) {
    try {
      await prisma.returnCase.update({
        where: { id: returnCase.id },
        data: backfillData,
      });
      returnCase = { ...returnCase, ...backfillData };
    } catch {
      // Non-fatal
    }
  }

  // Proactively cache FyndOrderMapping so Track Order lookups work
  // even before any return is created for a given Fynd order.
  const fyndOid = affiliateOrderId ?? orderId;
  if (fyndOid && returnCase.shopifyOrderName) {
    try {
      await prisma.fyndOrderMapping.upsert({
        where: {
          shopId_shopifyOrderName: {
            shopId: returnCase.shopId,
            shopifyOrderName: returnCase.shopifyOrderName,
          },
        },
        create: {
          shopId: returnCase.shopId,
          shopifyOrderName: returnCase.shopifyOrderName,
          shopifyOrderId: returnCase.shopifyOrderId ?? undefined,
          fyndOrderId: fyndOid,
          fyndShipmentId: shipmentId ?? undefined,
          searchStrategy: "webhook",
        },
        update: {
          fyndOrderId: fyndOid,
          ...(shipmentId ? { fyndShipmentId: shipmentId } : {}),
          ...(returnCase.shopifyOrderId ? { shopifyOrderId: returnCase.shopifyOrderId } : {}),
        },
      });
    } catch {
      // Non-fatal — mapping is an optimization, not required
    }
  }

  const shopDomain = returnCase.shop.shopDomain;

  // Get offline session for Shopify API
  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
  });
  if (!session?.accessToken) {
    const errMsg = `No offline session for shop ${shopDomain}. App may need to be reinstalled.`;
    await logWebhook({
      shipmentId,
      orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
      refundStatus,
      action: "error",
      returnCaseId: returnCase.id,
      rawPayload: JSON.stringify(payload),
      error: errMsg,
    });
    return { ok: false, error: errMsg };
  }

  const admin = createAdminClient(shopDomain, session.accessToken);

  // Map Fynd status to our action
  const statusLower = (refundStatus ?? "").toLowerCase().replace(/\s+/g, "_");
  const isInProgress =
    REFUND_IN_PROGRESS.some((s) => statusLower === s.toLowerCase()) ||
    /under.?process|in.?progress|pending|initiated|processing/i.test(refundStatus ?? "");
  const isComplete = REFUND_COMPLETE.some((s) => statusLower === s.toLowerCase()) || /refund.?done|refunded/i.test(refundStatus ?? "");

  if (isInProgress) {
    const alreadyInProgress = returnCase.refundStatus === "in_progress" || returnCase.refundStatus === "refunded";
    if (!alreadyInProgress) {
      await prisma.returnCase.update({
        where: { id: returnCase.id },
        data: { refundStatus: "in_progress" },
      });
    }
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "fynd_webhook",
        eventType: "refund_in_progress",
        payloadJson: JSON.stringify({ fynd_refund_status: refundStatus, shipment_id: shipmentId, idempotent: alreadyInProgress }),
      },
    });
    await logWebhook({
      shipmentId,
      orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
      refundStatus,
      action: "refund_in_progress",
      returnCaseId: returnCase.id,
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
      if (returnCase.customerEmailNorm) {
        sendRefundNotification({
          shopDomain,
          to: returnCase.customerEmailNorm,
          orderName: returnCase.shopifyOrderName || "your order",
          shopName: shopDomain.replace(".myshopify.com", ""),
        }).catch(err => console.warn("[fynd-webhook] Manual refund notification failed:", err));
      }
      await logWebhook({
        shipmentId,
        orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
        refundStatus,
        action: "refund_completed",
        returnCaseId: returnCase.id,
      });
      return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
    }

    let orderIdForRefund = returnCase.shopifyOrderId;
    let lineItemsForRefund: Array<{ id: string; quantity: number }> = (returnCase.items ?? [])
      .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
      .map((i) => ({ id: i.shopifyLineItemId, quantity: i.qty }));

    const isGid = orderIdForRefund?.startsWith("gid://");
    const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
    if (!isGid && !isNumericId) {
      const orderNumber = (returnCase.shopifyOrderName ?? orderIdForRefund ?? "").replace(/^#/, "").trim();
      const orderByNumber = orderNumber ? await fetchOrderByOrderNumber(admin, orderNumber) : null;
      if (orderByNumber?.id) {
        orderIdForRefund = orderByNumber.id;
        if (lineItemsForRefund.length === 0 && orderByNumber.lineItems?.length) {
          lineItemsForRefund = orderByNumber.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
        }
      }
    }

    if (!orderIdForRefund) {
      const errMsg = "Could not determine Shopify order for refund";
      await logWebhook({
        shipmentId,
        orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
        refundStatus,
        action: "error",
        returnCaseId: returnCase.id,
        error: errMsg,
      });
      return { ok: false, error: errMsg };
    }

    if (lineItemsForRefund.length === 0) {
      const order = await fetchOrder(admin, orderIdForRefund);
      if (order?.lineItems?.length) {
        lineItemsForRefund = order.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
      }
    }

    let webhookRefundLocationId: string | null = null;
    let refundMethodCfg: RefundMethodConfig | null = null;
    try {
      const ss = await prisma.shopSettings.findUnique({ where: { shopId: returnCase.shop.id } });
      webhookRefundLocationId = (ss as { refundLocationId?: string | null } | null)?.refundLocationId ?? null;
      const pm = (ss as { refundPaymentMethod?: string } | null)?.refundPaymentMethod ?? "original";
      const pct = (ss as { refundStoreCreditPct?: number | null } | null)?.refundStoreCreditPct ?? 100;
      if (["original", "store_credit", "both"].includes(pm)) {
        refundMethodCfg = { method: pm as "original" | "store_credit" | "both", storeCreditPct: pct };
      }

      const orderForRefund = orderIdForRefund ? await fetchOrder(admin, orderIdForRefund) : null;
      if (!webhookRefundLocationId && orderForRefund?.fulfillments?.[0]?.location?.id) {
        webhookRefundLocationId = orderForRefund.fulfillments[0].location.id;
      }
      const COD_RE = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
      const isCod = (orderForRefund?.paymentGatewayNames ?? []).some((g) => COD_RE.test(g))
        || orderForRefund?.displayFinancialStatus === "PENDING";
      if (isCod && refundMethodCfg?.method === "original") {
        refundMethodCfg = { method: "store_credit" };
      }
    } catch { /* fallback to createRefund's auto-fetch */ }

    const result = await createRefund(
      admin,
      orderIdForRefund,
      lineItemsForRefund,
      `Refund processed via Fynd webhook (shipment ${shipmentId})`,
      webhookRefundLocationId,
      refundMethodCfg,
    );
    if (!result.success) {
      const errMsg = result.error ?? "Shopify refund failed";
      const isAlreadyRefunded = /already refunded|refunded for this|has been refunded/i.test(errMsg);
      if (isAlreadyRefunded) {
        await prisma.returnCase.update({
          where: { id: returnCase.id },
          data: { refundStatus: "refunded", status: "completed" },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: returnCase.id,
            source: "fynd_webhook",
            eventType: "refund_already_done",
            payloadJson: JSON.stringify({ shipment_id: shipmentId, note: "Shopify reported already refunded" }),
          },
        });
        await logWebhook({
          shipmentId,
          orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
          refundStatus,
          action: "refund_completed",
          returnCaseId: returnCase.id,
        });
        return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
      }
      await logWebhook({
        shipmentId,
        orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
        refundStatus,
        action: "error",
        returnCaseId: returnCase.id,
        error: errMsg,
      });
      return { ok: false, error: errMsg };
    }

    const refundDetails = {
      refundId: result.refundId ?? null,
      amount: result.refundAmount ?? null,
      currency: result.refundCurrency ?? null,
      createdAt: result.refundCreatedAt ?? new Date().toISOString(),
      method: result.refundMethod ?? "original",
      source: "fynd_webhook",
    };
    await prisma.returnCase.update({
      where: { id: returnCase.id },
      data: { refundStatus: "refunded", refundJson: JSON.stringify(refundDetails), status: "completed" },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "fynd_webhook",
        eventType: "refund_processed",
        payloadJson: JSON.stringify({ ...refundDetails, shipment_id: shipmentId, fynd_refund_status: refundStatus }),
      },
    });
    if (returnCase.customerEmailNorm) {
      sendRefundNotification({
        shopDomain,
        to: returnCase.customerEmailNorm,
        orderName: returnCase.shopifyOrderName || "your order",
        amount: refundDetails.amount ?? undefined,
        currency: refundDetails.currency ?? undefined,
        shopName: shopDomain.replace(".myshopify.com", ""),
      }).catch(err => console.warn("[fynd-webhook] Refund notification failed:", err));
    }
    await logWebhook({
      shipmentId,
      orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
      refundStatus,
      action: "refund_completed",
      returnCaseId: returnCase.id,
    });
    return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
  }

  // Auto-refund on credit_note_generated (if enabled in settings)
  const isAutoRefundTrigger = AUTO_REFUND_TRIGGERS.some((s) => statusLower === s.toLowerCase()) ||
    /credit.?note/i.test(refundStatus ?? "");
  if (isAutoRefundTrigger && returnCase.refundStatus !== "refunded") {
    const shopSettings = await prisma.shopSettings.findUnique({
      where: { shopId: returnCase.shop.id },
    });
    if (shopSettings?.autoRefundEnabled) {
      let orderIdForRefund = returnCase.shopifyOrderId;
      let lineItemsForRefund: Array<{ id: string; quantity: number }> = (returnCase.items ?? [])
        .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
        .map((i) => ({ id: i.shopifyLineItemId, quantity: i.qty }));

      if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
        const isGid = orderIdForRefund?.startsWith("gid://");
        const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
        if (!isGid && !isNumericId) {
          const orderNumber = (returnCase.shopifyOrderName ?? orderIdForRefund ?? "").replace(/^#/, "").trim();
          const orderByNumber = orderNumber ? await fetchOrderByOrderNumber(admin, orderNumber) : null;
          if (orderByNumber?.id) {
            orderIdForRefund = orderByNumber.id;
            if (lineItemsForRefund.length === 0 && orderByNumber.lineItems?.length) {
              lineItemsForRefund = orderByNumber.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
            }
          }
        }
        if (orderIdForRefund && lineItemsForRefund.length === 0) {
          const order = await fetchOrder(admin, orderIdForRefund);
          if (order?.lineItems?.length) {
            lineItemsForRefund = order.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
          }
        }

        let autoRefundLocationId: string | null = (shopSettings as { refundLocationId?: string | null }).refundLocationId ?? null;
        let autoOrderData: Awaited<ReturnType<typeof fetchOrder>> | null = null;
        if (orderIdForRefund) {
          try {
            autoOrderData = await fetchOrder(admin, orderIdForRefund);
            if (!autoRefundLocationId) {
              autoRefundLocationId = autoOrderData?.fulfillments?.[0]?.location?.id ?? null;
            }
          } catch { /* fallback to createRefund's own location fetch */ }
        }

        let autoRefundMethodCfg: RefundMethodConfig | null = null;
        const autoRpm = (shopSettings as { refundPaymentMethod?: string }).refundPaymentMethod ?? "original";
        const autoRpct = (shopSettings as { refundStoreCreditPct?: number | null }).refundStoreCreditPct ?? 100;
        if (["original", "store_credit", "both"].includes(autoRpm)) {
          autoRefundMethodCfg = { method: autoRpm as "original" | "store_credit" | "both", storeCreditPct: autoRpct };
        }

        const COD_RE = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
        const isCodAuto = (autoOrderData?.paymentGatewayNames ?? []).some((g) => COD_RE.test(g))
          || autoOrderData?.displayFinancialStatus === "PENDING";
        if (isCodAuto && autoRefundMethodCfg?.method === "original") {
          autoRefundMethodCfg = { method: "store_credit" };
        }

        if (orderIdForRefund && lineItemsForRefund.length > 0) {
          const result = await createRefund(
            admin,
            orderIdForRefund,
            lineItemsForRefund,
            `Auto-refund triggered by Fynd credit note (shipment ${shipmentId})`,
            autoRefundLocationId,
            autoRefundMethodCfg,
          );
          if (result.success) {
            const refundDetails = {
              refundId: result.refundId ?? null,
              amount: result.refundAmount ?? null,
              currency: result.refundCurrency ?? null,
              createdAt: result.refundCreatedAt ?? new Date().toISOString(),
              method: result.refundMethod ?? "original",
              source: "auto_fynd_credit_note",
            };
            await prisma.returnCase.update({
              where: { id: returnCase.id },
              data: { refundStatus: "refunded", refundJson: JSON.stringify(refundDetails), status: "completed" },
            });
            await prisma.returnEvent.create({
              data: {
                returnCaseId: returnCase.id,
                source: "fynd_webhook",
                eventType: "auto_refund_processed",
                payloadJson: JSON.stringify({ ...refundDetails, trigger: "credit_note_generated", shipment_id: shipmentId }),
              },
            });
            if (returnCase.customerEmailNorm) {
              sendRefundNotification({
                shopDomain,
                to: returnCase.customerEmailNorm,
                orderName: returnCase.shopifyOrderName || "your order",
                amount: refundDetails.amount ?? undefined,
                currency: refundDetails.currency ?? undefined,
                shopName: shopDomain.replace(".myshopify.com", ""),
              }).catch(err => console.warn("[fynd-webhook] Auto-refund notification failed:", err));
            }
            await logWebhook({
              shipmentId,
              orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
              refundStatus,
              action: "refund_completed",
              returnCaseId: returnCase.id,
            });
            return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
          } else {
            await prisma.returnEvent.create({
              data: {
                returnCaseId: returnCase.id,
                source: "fynd_webhook",
                eventType: "auto_refund_failed",
                payloadJson: JSON.stringify({ error: result.error, trigger: "credit_note_generated", shipment_id: shipmentId }),
              },
            });
          }
        }
      }
    } else {
      await prisma.returnEvent.create({
        data: {
          returnCaseId: returnCase.id,
          source: "fynd_webhook",
          eventType: "credit_note_generated",
          payloadJson: JSON.stringify({ fynd_status: refundStatus, shipment_id: shipmentId, note: "Auto-refund is disabled. Process refund manually from admin." }),
        },
      });
    }
  }

  // Log Fynd status update to timeline even when we don't take refund action
  // (e.g. return_bag_delivered, return_accepted, etc.) so the full journey is visible
  if (refundStatus) {
    const eventLabel = refundStatus.replace(/_/g, " ");
    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "fynd_webhook",
        eventType: eventLabel,
        payloadJson: JSON.stringify({ fynd_status: refundStatus, shipment_id: shipmentId }),
      },
    });
  }

  await logWebhook({
    shipmentId,
    orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
    refundStatus,
    action: "ignored",
    returnCaseId: returnCase.id,
  });
  return { ok: true, action: "ignored", returnCaseId: returnCase.id };
}
