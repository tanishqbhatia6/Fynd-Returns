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
import { createAdminClient, createRefund, fetchOrder, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, extractShopifyOrderNumberVariants, withRestCredentials, type RefundMethodConfig } from "./shopify-admin.server";
import { sendRefundNotification } from "./notification.server";
import { isLikelyFyndId } from "./fynd-payload.server";

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

/** Known Fynd shipment/return journey statuses that should be tracked (not "ignored") */
const FYND_JOURNEY_STATUSES = new Set([
  // Forward journey
  "bag_confirmed", "bag_invoiced", "dp_assigned", "bag_packed",
  "bag_picked", "out_for_delivery", "delivery_done", "handed_over_to_customer",
  // Return journey
  "return_initiated", "return_dp_assigned", "return_bag_in_transit",
  "return_bag_delivered", "return_accepted", "return_completed",
  // RTO journey
  "rto_initiated", "rto_dp_assigned", "rto_bag_in_transit",
  "rto_bag_delivered", "rto_bag_accepted",
  // Edge cases
  "bag_not_picked", "out_for_pickup", "dp_out_for_pickup",
  "deadstock", "deadstock_defective", "return_bag_lost",
]);

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
  shipment_status?: Record<string, unknown> | string;
  delivery_address?: Record<string, unknown>;
  billing_address?: Record<string, unknown>;
  dp_details?: Record<string, unknown>;
  awb_no?: string;
  tracking_url?: string;
  track_url?: string;
  invoice?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  bag_list?: string[];
  application_id?: string;
  company_id?: string;
  current_shipment_status?: string;
  display_name?: string;
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
  affiliate_details?: { affiliate_order_id?: string; [key: string]: unknown };
  delivery_partner_details?: Record<string, unknown>;
  bags?: Array<Record<string, unknown>>;
  _shop_domain?: string;
  _journey_type?: string;
};

/** Coerce any non-null value to a trimmed string (handles numeric IDs from Fynd JSON) */
function coerceStr(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  return s || null;
}

function extractShipmentId(payload: FyndWebhookPayload): string | null {
  const shipmentStatusObj = (typeof payload.shipment_status === "object" && payload.shipment_status !== null)
    ? payload.shipment_status as Record<string, unknown>
    : null;
  const s =
    payload.shipment_id ??
    payload.shipmentId ??
    (shipmentStatusObj?.shipment_id as string | undefined) ??
    payload.id ??
    payload.shipments?.[0]?.shipment_id ??
    payload.shipments?.[0]?.shipmentId ??
    payload.shipments?.[0]?.id ??
    payload.order?.shipments?.[0]?.shipment_id ??
    payload.order?.shipments?.[0]?.shipmentId;
  return coerceStr(s);
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
  return coerceStr(s);
}

function extractAffiliateOrderId(payload: FyndWebhookPayload): string | null {
  const meta = payload.meta as Record<string, unknown> | undefined;
  const affiliateDetails = payload.affiliate_details as Record<string, unknown> | undefined;
  const firstBag = Array.isArray(payload.bags) ? payload.bags[0] as Record<string, unknown> : null;
  const bagAffDetails = firstBag?.affiliate_bag_details as Record<string, unknown> | undefined;
  const s =
    payload.affiliate_order_id ??
    payload.affiliateOrderId ??
    (affiliateDetails?.affiliate_order_id as string | undefined) ??
    (bagAffDetails?.affiliate_order_id as string | undefined) ??
    payload.external_order_id ??
    payload.channel_order_id ??
    (meta?.affiliate_order_id as string | undefined) ??
    (meta?.external_order_id as string | undefined) ??
    (meta?.channel_order_id as string | undefined) ??
    payload.order?.affiliate_order_id ??
    payload.shipments?.[0]?.order?.affiliate_order_id;
  return coerceStr(s);
}

/** Fynd order_id (internal) — used for lookup when affiliate_order_id not present */
function extractOrderId(payload: FyndWebhookPayload): string | null {
  const meta = payload.meta as Record<string, unknown> | undefined;
  const s =
    payload.order_id ??
    payload.orderId ??
    (meta?.order_id as string | undefined) ??
    (meta?.fynd_order_id as string | undefined) ??
    payload.order?.fynd_order_id ??
    payload.order?.order_id ??
    payload.shipments?.[0]?.order?.fynd_order_id;
  return coerceStr(s);
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

/** Extract shop domain from webhook payload (bags[0].affiliate_bag_details.affiliate_meta.shop_domain) */
function extractShopDomain(payload: FyndWebhookPayload): string | null {
  if (typeof payload._shop_domain === "string" && payload._shop_domain.includes(".")) return payload._shop_domain;
  const meta = payload.meta as Record<string, unknown> | undefined;
  if (typeof meta?.shop_domain === "string") return meta.shop_domain as string;
  if (typeof meta?.channel_domain === "string") return meta.channel_domain as string;
  return null;
}

/** Extract customer info from webhook payload (delivery_address, billing_address, meta) */
function extractCustomerFromWebhookPayload(payload: FyndWebhookPayload): {
  name?: string; email?: string; phone?: string;
  city?: string; country?: string; address1?: string;
  province?: string; zip?: string;
} | null {
  const addr = payload.delivery_address ?? payload.billing_address;
  const meta = payload.meta as Record<string, unknown> | undefined;
  if (!addr && !meta) return null;
  const a = (addr ?? {}) as Record<string, unknown>;
  const firstName = typeof a.first_name === "string" ? a.first_name : "";
  const lastName = typeof a.last_name === "string" ? a.last_name : "";
  const fullName = typeof a.name === "string" ? a.name : [firstName, lastName].filter(Boolean).join(" ");
  const email = (typeof a.email === "string" ? a.email : null) ?? (typeof meta?.email === "string" ? meta.email : null);
  const phone = (typeof a.phone === "string" ? a.phone : null) ?? (typeof a.mobile === "string" ? a.mobile : null) ?? (typeof meta?.mobile === "string" ? meta.mobile : null) ?? (typeof meta?.phone === "string" ? meta.phone : null);
  const city = typeof a.city === "string" ? a.city : null;
  const country = typeof a.country === "string" ? a.country : null;
  const address1 = (typeof a.address1 === "string" ? a.address1 : null) ?? (typeof a.address === "string" ? a.address : null);
  const province = (typeof a.state === "string" ? a.state : null) ?? (typeof a.province === "string" ? a.province : null);
  const zip = (typeof a.pincode === "string" ? a.pincode : null) ?? (typeof a.zip === "string" ? a.zip : null) ?? (typeof a.postal_code === "string" ? a.postal_code : null);
  if (!fullName && !email && !phone) return null;
  return {
    ...(fullName ? { name: fullName } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(city ? { city } : {}),
    ...(country ? { country } : {}),
    ...(address1 ? { address1 } : {}),
    ...(province ? { province } : {}),
    ...(zip ? { zip } : {}),
  };
}

/** Detect whether a webhook is for forward, return, or RTO journey */
function detectJourneyType(statusLower: string, payload: FyndWebhookPayload): "forward" | "return" | "rto" | null {
  // Infer from status prefix
  if (statusLower.startsWith("return_") || statusLower === "return_initiated") return "return";
  if (statusLower.startsWith("rto_")) return "rto";
  // Check promoted journey_type from bags[0].bag_status_history
  if (typeof payload._journey_type === "string") {
    const jtPromoted = payload._journey_type.toLowerCase();
    if (jtPromoted === "return") return "return";
    if (jtPromoted === "rto") return "rto";
    if (jtPromoted === "forward") return "forward";
  }
  // Check meta.journey_type or shipment_status.journey_type
  const meta = payload.meta as Record<string, unknown> | undefined;
  const shipmentStatusObj = (typeof payload.shipment_status === "object" && payload.shipment_status !== null)
    ? payload.shipment_status as Record<string, unknown>
    : null;
  const jt = (meta?.journey_type ?? shipmentStatusObj?.journey_type) as string | null | undefined;
  if (jt) {
    const jtLower = String(jt).toLowerCase();
    if (jtLower === "return") return "return";
    if (jtLower === "rto") return "rto";
    if (jtLower === "forward") return "forward";
  }
  // Known forward-only statuses
  const forwardOnly = new Set(["bag_confirmed", "bag_invoiced", "dp_assigned", "bag_packed",
    "bag_picked", "out_for_delivery", "delivery_done", "handed_over_to_customer"]);
  if (forwardOnly.has(statusLower)) return "forward";
  // Return-specific statuses
  if (["out_for_pickup", "dp_out_for_pickup", "return_bag_lost"].includes(statusLower)) return "return";
  return null;
}

/** Extract shipping/logistics info from webhook payload (dp_details, awb_no, tracking_url, invoice) */
function extractShippingFromWebhookPayload(payload: FyndWebhookPayload): {
  carrier?: string; awb?: string; trackingUrl?: string;
  labelUrl?: string; invoiceUrl?: string; invoiceNumber?: string;
} | null {
  const dpd = payload.delivery_partner_details as Record<string, unknown> | undefined;
  const dp = dpd ?? (payload.dp_details as Record<string, unknown> | undefined);
  const meta = payload.meta as Record<string, unknown> | undefined;
  const inv = payload.invoice as Record<string, unknown> | undefined;
  const carrier = (typeof dp?.display_name === "string" ? dp.display_name : null)
    ?? (typeof dp?.name === "string" ? dp.name : null)
    ?? (typeof payload.display_name === "string" ? payload.display_name : null)
    ?? (typeof meta?.cp_name === "string" ? meta.cp_name : null);
  const awbRaw = coerceStr(dp?.awb_no) ?? coerceStr(payload.awb_no) ?? coerceStr(meta?.awb_no);
  const awb = awbRaw && !isLikelyFyndId(awbRaw) ? awbRaw : null;
  const trackingUrl = (typeof payload.tracking_url === "string" ? payload.tracking_url : null)
    ?? (typeof payload.track_url === "string" ? payload.track_url : null)
    ?? (typeof dp?.track_url === "string" ? dp.track_url : null)
    ?? (typeof dp?.tracking_url === "string" ? dp.tracking_url : null);
  const invoiceUrl = inv ? ((typeof inv.invoice_url === "string" ? inv.invoice_url : null) ?? (typeof (inv.links as Record<string, unknown> | undefined)?.invoice_a4 === "string" ? (inv.links as Record<string, unknown>).invoice_a4 as string : null)) : null;
  const labelUrl = inv ? ((typeof inv.label_url === "string" ? inv.label_url : null) ?? (typeof (inv.links as Record<string, unknown> | undefined)?.label === "string" ? (inv.links as Record<string, unknown>).label as string : null)) : null;
  const invoiceNumber = inv ? ((typeof inv.store_invoice_id === "string" ? inv.store_invoice_id : null) ?? (typeof inv.external_invoice_id === "string" ? inv.external_invoice_id : null)) : null;
  if (!carrier && !awb && !trackingUrl && !invoiceUrl) return null;
  return {
    ...(carrier ? { carrier } : {}),
    ...(awb ? { awb } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    ...(labelUrl ? { labelUrl } : {}),
    ...(invoiceUrl ? { invoiceUrl } : {}),
    ...(invoiceNumber ? { invoiceNumber } : {}),
  };
}

/**
 * Unwrap a raw Fynd webhook body into a normalized FyndWebhookPayload.
 * Handles envelope detection (payload/data/shipment), field promotion from
 * nested structures (affiliate_details, delivery_partner_details, bags[0]),
 * and status flattening.
 */
export function unwrapFyndWebhookPayload(rawBodyText: string): {
  payload: FyndWebhookPayload;
  eventType: string | undefined;
} {
  const body = JSON.parse(rawBodyText) as Record<string, unknown>;
  // Unwrap envelope: body.payload, body.data, body.shipment, or direct body
  let inner: Record<string, unknown>;
  if (body?.payload && typeof body.payload === "object") {
    inner = body.payload as Record<string, unknown>;
  } else if (body?.data && typeof body.data === "object") {
    inner = body.data as Record<string, unknown>;
  } else if (body?.shipment && typeof body.shipment === "object") {
    inner = body.shipment as Record<string, unknown>;
  } else {
    inner = body;
  }
  // Flatten nested shipment_status fields into inner
  if (inner?.shipment_status && typeof inner.shipment_status === "object") {
    const ss = inner.shipment_status as Record<string, unknown>;
    if (ss.shipment_id && !inner.shipment_id) inner.shipment_id = ss.shipment_id;
    if (ss.status && !inner.status) inner.status = ss.status;
    if (ss.order_id && !inner.order_id) inner.order_id = ss.order_id;
    if (ss.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = ss.affiliate_order_id;
  }
  // Promote fields from first shipment in shipments[] array
  const firstShipment = (Array.isArray(inner?.shipments) ? inner.shipments[0] : null) as Record<string, unknown> | null;
  if (firstShipment && typeof firstShipment === "object") {
    if (firstShipment.shipment_id && !inner.shipment_id) inner.shipment_id = firstShipment.shipment_id;
    if (firstShipment.id && !inner.shipment_id && !inner.id) inner.id = firstShipment.id;
    if (firstShipment.order_id && !inner.order_id) inner.order_id = firstShipment.order_id;
    if (firstShipment.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = firstShipment.affiliate_order_id;
    if (firstShipment.external_order_id && !inner.external_order_id) inner.external_order_id = firstShipment.external_order_id;
    if (firstShipment.channel_order_id && !inner.channel_order_id) inner.channel_order_id = firstShipment.channel_order_id;
    const shipOrder = firstShipment.order as Record<string, unknown> | undefined;
    if (shipOrder && typeof shipOrder === "object") {
      if (shipOrder.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = shipOrder.affiliate_order_id;
      if (shipOrder.fynd_order_id && !inner.order_id) inner.order_id = shipOrder.fynd_order_id;
      if (shipOrder.order_id && !inner.order_id) inner.order_id = shipOrder.order_id;
    }
    if (firstShipment.dp_details && !inner.dp_details) inner.dp_details = firstShipment.dp_details;
    if (firstShipment.tracking_url && !inner.tracking_url) inner.tracking_url = firstShipment.tracking_url;
  }
  // Extract fields from inner.meta if present
  if (inner?.meta && typeof inner.meta === "object") {
    const meta = inner.meta as Record<string, unknown>;
    if (!inner.order_id && meta.order_id) inner.order_id = meta.order_id;
    if (!inner.affiliate_order_id && meta.affiliate_order_id) inner.affiliate_order_id = meta.affiliate_order_id;
    if (!inner.external_order_id && meta.external_order_id) inner.external_order_id = meta.external_order_id;
    if (!inner.channel_order_id && meta.channel_order_id) inner.channel_order_id = meta.channel_order_id;
    if (!inner.shipment_id && meta.shipment_id) inner.shipment_id = meta.shipment_id;
  }
  // Promote from affiliate_details (real Fynd payload structure)
  if (inner.affiliate_details && typeof inner.affiliate_details === "object") {
    const ad = inner.affiliate_details as Record<string, unknown>;
    if (ad.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = ad.affiliate_order_id;
    if (ad.affiliate_bag_id && !inner.affiliate_bag_id) inner.affiliate_bag_id = ad.affiliate_bag_id;
    if (ad.company_affiliate_tag && !inner.company_affiliate_tag) inner.company_affiliate_tag = ad.company_affiliate_tag;
  }
  // Promote from delivery_partner_details (real Fynd payload structure)
  if (inner.delivery_partner_details && typeof inner.delivery_partner_details === "object") {
    const dpd = inner.delivery_partner_details as Record<string, unknown>;
    if (!inner.dp_details) inner.dp_details = inner.delivery_partner_details;
    if (dpd.awb_no && !inner.awb_no) inner.awb_no = dpd.awb_no;
    if (dpd.tracking_url && !inner.tracking_url) inner.tracking_url = dpd.tracking_url;
  }
  // Promote from bags[0] (real Fynd payload structure)
  const firstBag = (Array.isArray(inner.bags) ? inner.bags[0] : null) as Record<string, unknown> | null;
  if (firstBag && typeof firstBag === "object") {
    const abd = firstBag.affiliate_bag_details as Record<string, unknown> | undefined;
    if (abd && typeof abd === "object") {
      if (abd.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = abd.affiliate_order_id;
      const affMeta = abd.affiliate_meta as Record<string, unknown> | undefined;
      if (affMeta && typeof affMeta === "object") {
        if (affMeta.shop_domain && !inner._shop_domain) inner._shop_domain = affMeta.shop_domain;
      }
    }
    if (Array.isArray(firstBag.bag_status_history) && firstBag.bag_status_history.length > 0) {
      const latestBagStatus = firstBag.bag_status_history[firstBag.bag_status_history.length - 1] as Record<string, unknown>;
      const mapper = latestBagStatus?.bag_state_mapper as Record<string, unknown> | undefined;
      if (mapper?.journey_type && !inner._journey_type) inner._journey_type = mapper.journey_type;
      if (mapper?.name && !inner.status) inner.status = mapper.name;
    }
  }
  // Handle nested status object (Fynd sends status as {status: "..."} sometimes)
  if (inner.status && typeof inner.status === "object") {
    const statusObj = inner.status as Record<string, unknown>;
    inner.status = statusObj.status ?? statusObj.name ?? statusObj.current_status;
  }
  const event = body?.event && typeof body.event === "object" ? (body.event as { type?: string; name?: string }) : null;
  const eventType = event?.type ?? event?.name ?? (typeof body?.event === "string" ? body.event as string : undefined);
  const statusOrRefund =
    (typeof inner?.refund_status === "string" && inner.refund_status) ||
    (typeof inner?.status === "string" && inner.status) ||
    (typeof inner?.current_shipment_status === "string" && inner.current_shipment_status) ||
    (typeof firstShipment?.refund_status === "string" && firstShipment.refund_status) ||
    (typeof firstShipment?.status === "string" && firstShipment.status) ||
    eventType;
  const payload = {
    ...inner,
    ...(statusOrRefund && { refund_status: statusOrRefund, current_shipment_status: statusOrRefund }),
  } as FyndWebhookPayload;

  return { payload, eventType };
}

export type ProcessFyndWebhookResult =
  | { ok: true; action: "refund_in_progress" | "refund_completed" | "status_updated" | "ignored"; returnCaseId?: string }
  | { ok: false; error: string };

async function logWebhook(params: {
  shipmentId: string | null;
  orderId: string | null;
  affiliateOrderId?: string | null;
  refundStatus: string | null;
  fyndStatus?: string | null;
  eventType?: string | null;
  action: string;
  returnCaseId?: string | null;
  carrier?: string | null;
  awbNumber?: string | null;
  trackingUrl?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  shopDomain?: string | null;
  rawPayload?: string | null;
  error?: string | null;
}) {
  try {
    await prisma.fyndWebhookLog.create({
      data: {
        shipmentId: params.shipmentId ?? undefined,
        orderId: params.orderId ?? undefined,
        affiliateOrderId: params.affiliateOrderId ?? undefined,
        refundStatus: params.refundStatus ?? undefined,
        fyndStatus: params.fyndStatus ?? undefined,
        eventType: params.eventType ?? undefined,
        action: params.action,
        returnCaseId: params.returnCaseId ?? undefined,
        carrier: params.carrier ?? undefined,
        awbNumber: params.awbNumber ?? undefined,
        trackingUrl: params.trackingUrl ?? undefined,
        customerName: params.customerName ?? undefined,
        customerEmail: params.customerEmail ?? undefined,
        customerPhone: params.customerPhone ?? undefined,
        shopDomain: params.shopDomain ?? undefined,
        rawPayload: params.rawPayload ?? undefined,
        error: params.error ? params.error.slice(0, 2000) : undefined,
      },
    });
  } catch (e) {
    console.warn("[Fynd webhook] Failed to log webhook:", e);
  }
}

export async function processFyndWebhook(payload: FyndWebhookPayload, rawPayload?: string, eventType?: string): Promise<ProcessFyndWebhookResult> {
  const shipmentId = extractShipmentId(payload);
  const refundStatus = extractRefundStatus(payload);
  const orderIds = extractOrderIdentifiers(payload);
  const affiliateOrderId = extractAffiliateOrderId(payload);
  const orderId = extractOrderId(payload);

  // Pre-compute enrichment fields for webhook logging
  const customer = extractCustomerFromWebhookPayload(payload);
  const shippingInfo = extractShippingFromWebhookPayload(payload);
  const webhookShopDomain = extractShopDomain(payload);
  const logEnrichment = {
    affiliateOrderId: affiliateOrderId ?? undefined,
    fyndStatus: refundStatus ?? undefined,
    eventType: eventType ?? undefined,
    carrier: shippingInfo?.carrier ?? undefined,
    awbNumber: shippingInfo?.awb ?? undefined,
    trackingUrl: shippingInfo?.trackingUrl ?? undefined,
    customerName: customer?.name ?? undefined,
    customerEmail: customer?.email ?? undefined,
    customerPhone: customer?.phone ?? undefined,
    shopDomain: webhookShopDomain ?? undefined,
  };

  if (!shipmentId && orderIds.length === 0) {
    // Log payload keys for debugging unrecognized webhook formats
    const payloadKeys = Object.keys(payload).filter((k) => payload[k as keyof FyndWebhookPayload] != null).join(", ");
    console.warn(`[Fynd webhook] No identifiers extracted. Payload keys: [${payloadKeys}]. Status: ${refundStatus ?? "null"}`);
    await logWebhook({
      shipmentId: null,
      orderId: null,
      refundStatus,
      action: "ignored",
      rawPayload: rawPayload ?? JSON.stringify(payload),
      ...logEnrichment,
      error: `No shipment/order ID found. Keys: ${payloadKeys}`,
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

  // Strategy 3: FyndOrderMapping reverse lookup
  if (!returnCase && (affiliateOrderId || shipmentId)) {
    try {
      const mappingWhere: Array<Record<string, string>> = [];
      if (affiliateOrderId) mappingWhere.push({ fyndOrderId: affiliateOrderId });
      if (shipmentId) mappingWhere.push({ fyndShipmentId: shipmentId });
      const mapping = await prisma.fyndOrderMapping.findFirst({
        where: { OR: mappingWhere },
      });
      if (mapping?.shopifyOrderName) {
        returnCase = await prisma.returnCase.findFirst({
          where: { shopId: mapping.shopId, shopifyOrderName: mapping.shopifyOrderName },
          include: { items: true, shop: true },
        });
        if (returnCase) console.log(`[Fynd webhook] Matched via FyndOrderMapping: ${mapping.shopifyOrderName}`);
      }
    } catch { /* non-fatal */ }
  }

  // Strategy 4: Match by shopifyOrderName via Fynd prefix stripping
  if (!returnCase && affiliateOrderId) {
    try {
      const variants = extractShopifyOrderNumberVariants(affiliateOrderId);
      for (const variant of variants) {
        for (const candidate of [variant, `#${variant}`]) {
          returnCase = await prisma.returnCase.findFirst({
            where: { shopifyOrderName: candidate },
            include: { items: true, shop: true },
          });
          if (returnCase) {
            console.log(`[Fynd webhook] Matched via shopifyOrderName="${candidate}" from affiliate="${affiliateOrderId}"`);
            break;
          }
        }
        if (returnCase) break;
      }
    } catch { /* non-fatal */ }
  }

  // Strategy 5: Case-insensitive fyndOrderId match (legacy data)
  if (!returnCase && affiliateOrderId) {
    try {
      returnCase = await prisma.returnCase.findFirst({
        where: { fyndOrderId: { equals: affiliateOrderId, mode: "insensitive" } },
        include: { items: true, shop: true },
      });
      if (returnCase) console.log(`[Fynd webhook] Matched via case-insensitive fyndOrderId="${affiliateOrderId}"`);
    } catch { /* non-fatal */ }
  }

  // Strategy 6: Direct shopifyOrderName match using all order identifiers
  // Fynd often sends the Shopify order name as affiliate_order_id or external_order_id
  if (!returnCase && orderIds.length > 0) {
    try {
      for (const oid of orderIds) {
        const clean = oid.replace(/^#/, "").trim();
        if (!clean) continue;
        for (const candidate of [clean, `#${clean}`]) {
          returnCase = await prisma.returnCase.findFirst({
            where: { shopifyOrderName: { equals: candidate, mode: "insensitive" } },
            include: { items: true, shop: true },
          });
          if (returnCase) {
            console.log(`[Fynd webhook] Matched via direct shopifyOrderName="${candidate}" from oid="${oid}"`);
            break;
          }
        }
        if (returnCase) break;
      }
    } catch { /* non-fatal */ }
  }

  // Strategy 7: Match by shopifyOrderId when Fynd sends a Shopify GID or numeric ID
  if (!returnCase && orderIds.length > 0) {
    try {
      for (const oid of orderIds) {
        if (oid.startsWith("gid://") || /^\d+$/.test(oid)) {
          const gid = oid.startsWith("gid://") ? oid : `gid://shopify/Order/${oid}`;
          returnCase = await prisma.returnCase.findFirst({
            where: { shopifyOrderId: gid },
            include: { items: true, shop: true },
          });
          if (returnCase) {
            console.log(`[Fynd webhook] Matched via shopifyOrderId="${gid}"`);
            break;
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Strategy 8: Shop-scoped match using shop_domain from payload + order identifiers
  if (!returnCase) {
    if (webhookShopDomain) {
      try {
        const shop = await prisma.shop.findUnique({ where: { shopDomain: webhookShopDomain } });
        if (shop) {
          if (affiliateOrderId) {
            const variants = extractShopifyOrderNumberVariants(affiliateOrderId);
            for (const variant of variants) {
              for (const candidate of [variant, `#${variant}`]) {
                returnCase = await prisma.returnCase.findFirst({
                  where: { shopId: shop.id, shopifyOrderName: { equals: candidate, mode: "insensitive" } },
                  include: { items: true, shop: true },
                });
                if (returnCase) {
                  console.log(`[Fynd webhook] Matched via shop-scoped shopifyOrderName="${candidate}" (shop=${webhookShopDomain})`);
                  break;
                }
              }
              if (returnCase) break;
            }
          }
          if (!returnCase && shipmentId) {
            returnCase = await prisma.returnCase.findFirst({
              where: { shopId: shop.id, fyndShipmentId: shipmentId },
              include: { items: true, shop: true },
            });
            if (returnCase) console.log(`[Fynd webhook] Matched via shop-scoped fyndShipmentId="${shipmentId}"`);
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  if (!returnCase) {
    await logWebhook({
      shipmentId,
      orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
      refundStatus,
      action: "ignored",
      rawPayload: rawPayload ?? JSON.stringify(payload),
      ...logEnrichment,
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
  // Backfill customer info from webhook payload
  if (!returnCase.customerName || !returnCase.customerEmailNorm) {
    const cust = extractCustomerFromWebhookPayload(payload);
    if (cust) {
      if (cust.name && !returnCase.customerName) backfillData.customerName = cust.name;
      if (cust.email && !returnCase.customerEmailNorm) backfillData.customerEmailNorm = cust.email.toLowerCase();
      if (cust.phone && !(returnCase as { customerPhoneNorm?: string }).customerPhoneNorm) backfillData.customerPhoneNorm = cust.phone;
      if (cust.city && !(returnCase as { customerCity?: string }).customerCity) backfillData.customerCity = cust.city;
      if (cust.country && !(returnCase as { customerCountry?: string }).customerCountry) backfillData.customerCountry = cust.country;
      if (cust.address1 && !(returnCase as { customerAddress1?: string }).customerAddress1) backfillData.customerAddress1 = cust.address1;
      if (cust.province && !(returnCase as { customerProvince?: string }).customerProvince) backfillData.customerProvince = cust.province;
      if (cust.zip && !(returnCase as { customerZip?: string }).customerZip) backfillData.customerZip = cust.zip;
    }
  }
  // Update shipping info from webhook payload (always update, not just first time)
  const shipping = extractShippingFromWebhookPayload(payload);
  const earlyStatusLower = (refundStatus ?? "").toLowerCase().replace(/\s+/g, "_");
  const journeyType = detectJourneyType(earlyStatusLower, payload);
  if (shipping) {
    if (shipping.awb) {
      // Route AWB to the correct field based on journey type
      if (journeyType === "return") {
        backfillData.returnAwb = shipping.awb;
      } else {
        backfillData.forwardAwb = shipping.awb;
      }
    }
    if (shipping.carrier || shipping.awb) {
      let existingLabel: Record<string, unknown> = {};
      try {
        if (returnCase.returnLabelJson) existingLabel = JSON.parse(returnCase.returnLabelJson);
      } catch { /* ignore */ }
      backfillData.returnLabelJson = JSON.stringify({
        ...existingLabel,
        ...(shipping.carrier ? { carrier: shipping.carrier } : {}),
        ...(shipping.awb ? { trackingNumber: shipping.awb } : {}),
        ...(shipping.trackingUrl ? { trackingUrl: shipping.trackingUrl } : {}),
        ...(shipping.labelUrl ? { labelUrl: shipping.labelUrl } : {}),
        ...(shipping.invoiceUrl ? { invoiceUrl: shipping.invoiceUrl } : {}),
        source: "fynd_webhook",
      });
    }
  }
  // Always update fyndPayloadJson with latest webhook data
  backfillData.fyndPayloadJson = rawPayload ?? JSON.stringify(payload);
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
      rawPayload: rawPayload ?? JSON.stringify(payload),
      error: errMsg,
      ...logEnrichment,
      shopDomain,
    });
    return { ok: false, error: errMsg };
  }

  const admin = withRestCredentials(createAdminClient(shopDomain, session.accessToken), shopDomain, session.accessToken);

  // Backfill shopifyOrderId using Fynd's affiliate_order_id when the stored ID is not a valid
  // Shopify identifier (GID or numeric). affiliate_order_id == Shopify order name/ID.
  const isValidShopifyId =
    returnCase.shopifyOrderId?.startsWith("gid://") ||
    (returnCase.shopifyOrderId != null && /^\d+$/.test(returnCase.shopifyOrderId));
  if (!isValidShopifyId && affiliateOrderId) {
    try {
      const shopifyOrder = await fetchOrderByFyndAffiliateId(admin, affiliateOrderId);
      if (shopifyOrder?.id) {
        const shopifyBackfill: Record<string, string> = { shopifyOrderId: shopifyOrder.id };
        if (!returnCase.shopifyOrderName && shopifyOrder.name) {
          shopifyBackfill.shopifyOrderName = shopifyOrder.name;
        }
        await prisma.returnCase.update({ where: { id: returnCase.id }, data: shopifyBackfill });
        returnCase = { ...returnCase, ...shopifyBackfill };
        console.log(`[Fynd webhook] Backfilled shopifyOrderId=${shopifyOrder.id} from affiliate_order_id="${affiliateOrderId}" for return ${returnCase.id}`);
      }
    } catch {
      // Non-fatal — refund can still be processed manually
    }
  }

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
        data: { refundStatus: "in_progress", fyndCurrentStatus: statusLower },
      });
    } else {
      await prisma.returnCase.update({ where: { id: returnCase.id }, data: { fyndCurrentStatus: statusLower } }).catch(() => {});
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
      rawPayload: rawPayload ?? JSON.stringify(payload),
      ...logEnrichment,
      shopDomain,
    });
    return { ok: true, action: "refund_in_progress", returnCaseId: returnCase.id };
  }

  if (isComplete && returnCase.refundStatus !== "refunded") {
    // Process refund in Shopify
    if (returnCase.shopifyOrderId?.startsWith("manual:")) {
      await prisma.returnCase.update({
        where: { id: returnCase.id },
        data: { refundStatus: "refunded", status: "completed", fyndCurrentStatus: statusLower },
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
        rawPayload: rawPayload ?? JSON.stringify(payload),
        ...logEnrichment,
        shopDomain,
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
      // Try shopifyOrderName with Fynd prefix stripping
      let orderByNumber = returnCase.shopifyOrderName
        ? await fetchOrderByFyndAffiliateId(admin, returnCase.shopifyOrderName).catch(() => null)
        : null;
      // Try shopifyOrderId with prefix stripping
      if (!orderByNumber && orderIdForRefund) {
        orderByNumber = await fetchOrderByFyndAffiliateId(admin, orderIdForRefund).catch(() => null);
      }
      // Try affiliate_order_id from webhook payload
      if (!orderByNumber && affiliateOrderId) {
        orderByNumber = await fetchOrderByFyndAffiliateId(admin, affiliateOrderId).catch(() => null);
      }
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
        rawPayload: rawPayload ?? JSON.stringify(payload),
        error: errMsg,
        ...logEnrichment,
        shopDomain,
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
          data: { refundStatus: "refunded", status: "completed", fyndCurrentStatus: statusLower },
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
          rawPayload: rawPayload ?? JSON.stringify(payload),
          ...logEnrichment,
          shopDomain,
        });
        return { ok: true, action: "refund_completed", returnCaseId: returnCase.id };
      }
      await logWebhook({
        shipmentId,
        orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
        refundStatus,
        action: "error",
        returnCaseId: returnCase.id,
        rawPayload: rawPayload ?? JSON.stringify(payload),
        error: errMsg,
        ...logEnrichment,
        shopDomain,
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
      data: { refundStatus: "refunded", refundJson: JSON.stringify(refundDetails), status: "completed", fyndCurrentStatus: statusLower },
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
      rawPayload: rawPayload ?? JSON.stringify(payload),
      ...logEnrichment,
      shopDomain,
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
          let orderByNumber = returnCase.shopifyOrderName
            ? await fetchOrderByFyndAffiliateId(admin, returnCase.shopifyOrderName).catch(() => null)
            : null;
          if (!orderByNumber && orderIdForRefund) {
            orderByNumber = await fetchOrderByFyndAffiliateId(admin, orderIdForRefund).catch(() => null);
          }
          if (!orderByNumber && affiliateOrderId) {
            orderByNumber = await fetchOrderByFyndAffiliateId(admin, affiliateOrderId).catch(() => null);
          }
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
              data: { refundStatus: "refunded", refundJson: JSON.stringify(refundDetails), status: "completed", fyndCurrentStatus: statusLower },
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
              rawPayload: rawPayload ?? JSON.stringify(payload),
              ...logEnrichment,
              shopDomain,
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
      await prisma.returnCase.update({ where: { id: returnCase.id }, data: { fyndCurrentStatus: statusLower } }).catch(() => {});
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

  // ─── Journey status processing ───
  // Check if this is a known Fynd shipment journey status
  const isKnownJourneyStatus = FYND_JOURNEY_STATUSES.has(statusLower) ||
    FYND_JOURNEY_STATUSES.has((refundStatus ?? "").toLowerCase());

  // Update fyndCurrentStatus on every webhook — use statusLower for journey statuses,
  // fall back to refundStatus for refund-specific webhooks
  const journeyUpdate: Record<string, string> = {};
  const effectiveStatus = isKnownJourneyStatus ? statusLower : (refundStatus ?? "").toLowerCase().replace(/\s+/g, "_");
  if (effectiveStatus) {
    journeyUpdate.fyndCurrentStatus = effectiveStatus;
  }

  // Status ordering for forward-only advancement (never downgrade)
  const STATUS_ORDER: Record<string, number> = {
    initiated: 0, pending: 1, approved: 2, "in progress": 3, processing: 3, completed: 4,
  };
  const currentLevel = STATUS_ORDER[returnCase.status.toLowerCase()] ?? 0;

  // For key milestones, advance ReturnCase.status
  if (isKnownJourneyStatus) {
    // Return journey: approved → in progress → completed
    if ((statusLower === "return_initiated" || statusLower === "bag_confirmed") && currentLevel < 2) {
      journeyUpdate.status = "approved";
    }
    if (["return_dp_assigned", "bag_picked", "return_bag_in_transit", "out_for_pickup", "dp_out_for_pickup"].includes(statusLower) && currentLevel < 3) {
      journeyUpdate.status = "in progress";
    }
    if (["return_bag_delivered", "return_accepted", "return_completed"].includes(statusLower) && currentLevel < 4) {
      journeyUpdate.status = "completed";
    }
  }

  if (Object.keys(journeyUpdate).length > 0) {
    try {
      await prisma.returnCase.update({ where: { id: returnCase.id }, data: journeyUpdate });
    } catch { /* non-fatal */ }
  }

  // Log journey status to timeline
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

  // Log as "status_updated" for known journey statuses, "ignored" for truly unrecognized
  const finalAction = isKnownJourneyStatus ? "status_updated" : "ignored";
  await logWebhook({
    shipmentId,
    orderId: orderId ?? affiliateOrderId ?? orderIds[0] ?? null,
    refundStatus,
    action: finalAction,
    returnCaseId: returnCase.id,
    rawPayload: rawPayload ?? JSON.stringify(payload),
    ...logEnrichment,
    shopDomain,
  });
  return { ok: true, action: finalAction as "status_updated" | "ignored", returnCaseId: returnCase.id };
}
