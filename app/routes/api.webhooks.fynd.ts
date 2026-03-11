/**
 * Fynd Shipment Update Webhook
 *
 * Receives POST from Fynd when shipment/refund status changes.
 * Updates refundStatus (in_progress) and triggers Shopify refund when Fynd reports refund_done.
 *
 * Configure in Fynd Platform: Webhooks → add URL: https://YOUR_APP_URL/api/webhooks/fynd
 * Optional: set FYND_WEBHOOK_SECRET env to verify X-Fynd-Signature (if Fynd supports it).
 *
 * Loader has no heavy imports so GET requests work without loading Prisma/Shopify.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { FyndWebhookPayload } from "../lib/fynd-webhook.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  return Response.json({ ok: true, method: "POST" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { processFyndWebhook } = await import("../lib/fynd-webhook.server");

  const rawBodyText = await request.text();

  // Signature verification BEFORE parsing — uses raw body for correct HMAC
  const secret = process.env.FYND_WEBHOOK_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (secret) {
    const signature = request.headers.get("x-fynd-signature") ?? request.headers.get("x-webhook-signature");
    if (!signature) {
      console.warn("[Fynd webhook] Missing signature header — rejecting");
      return Response.json({ error: "Missing webhook signature" }, { status: 401 });
    }
    const { createHmac, timingSafeEqual } = await import("crypto");
    const expected = createHmac("sha256", secret).update(rawBodyText).digest("hex");
    const sigClean = signature.replace(/^sha256=/, "");
    try {
      const sigBuf = Buffer.from(sigClean, "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        console.warn("[Fynd webhook] Signature mismatch — rejecting");
        return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
      }
    } catch {
      console.warn("[Fynd webhook] Signature verification error — rejecting");
      return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
    }
  } else if (isProd) {
    console.warn("[Fynd webhook] FYND_WEBHOOK_SECRET not set in production — webhook accepted without verification. Set FYND_WEBHOOK_SECRET for security.");
  }

  let payload: FyndWebhookPayload;
  let eventType: string | undefined;
  try {
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
      // Promote order sub-object fields
      const shipOrder = firstShipment.order as Record<string, unknown> | undefined;
      if (shipOrder && typeof shipOrder === "object") {
        if (shipOrder.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = shipOrder.affiliate_order_id;
        if (shipOrder.fynd_order_id && !inner.order_id) inner.order_id = shipOrder.fynd_order_id;
        if (shipOrder.order_id && !inner.order_id) inner.order_id = shipOrder.order_id;
      }
      // Promote dp_details for AWB extraction
      if (firstShipment.dp_details && !inner.dp_details) inner.dp_details = firstShipment.dp_details;
      // Promote tracking_url
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
    // ── Promote from affiliate_details (real Fynd payload structure) ──
    if (inner.affiliate_details && typeof inner.affiliate_details === "object") {
      const ad = inner.affiliate_details as Record<string, unknown>;
      if (ad.affiliate_order_id && !inner.affiliate_order_id) inner.affiliate_order_id = ad.affiliate_order_id;
      if (ad.affiliate_bag_id && !inner.affiliate_bag_id) inner.affiliate_bag_id = ad.affiliate_bag_id;
      if (ad.company_affiliate_tag && !inner.company_affiliate_tag) inner.company_affiliate_tag = ad.company_affiliate_tag;
    }
    // ── Promote from delivery_partner_details (real Fynd payload structure) ──
    if (inner.delivery_partner_details && typeof inner.delivery_partner_details === "object") {
      const dpd = inner.delivery_partner_details as Record<string, unknown>;
      if (!inner.dp_details) inner.dp_details = inner.delivery_partner_details;
      if (dpd.awb_no && !inner.awb_no) inner.awb_no = dpd.awb_no;
      if (dpd.tracking_url && !inner.tracking_url) inner.tracking_url = dpd.tracking_url;
    }
    // ── Promote from bags[0] (real Fynd payload structure) ──
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
    // ── Handle nested status object (Fynd sends status as {status: "..."} sometimes) ──
    if (inner.status && typeof inner.status === "object") {
      const statusObj = inner.status as Record<string, unknown>;
      inner.status = statusObj.status ?? statusObj.name ?? statusObj.current_status;
    }
    const event = body?.event && typeof body.event === "object" ? (body.event as { type?: string; name?: string }) : null;
    eventType = event?.type ?? event?.name ?? (typeof body?.event === "string" ? body.event as string : undefined);
    const statusOrRefund =
      (typeof inner?.refund_status === "string" && inner.refund_status) ||
      (typeof inner?.status === "string" && inner.status) ||
      (typeof inner?.current_shipment_status === "string" && inner.current_shipment_status) ||
      (typeof firstShipment?.refund_status === "string" && firstShipment.refund_status) ||
      (typeof firstShipment?.status === "string" && firstShipment.status) ||
      eventType;
    payload = {
      ...inner,
      ...(statusOrRefund && { refund_status: statusOrRefund, current_shipment_status: statusOrRefund }),
    } as FyndWebhookPayload;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Replay protection: reject webhooks with timestamps older than 5 minutes
  const webhookTimestamp = request.headers.get("x-webhook-timestamp") ?? request.headers.get("x-fynd-timestamp");
  if (webhookTimestamp) {
    const ts = new Date(webhookTimestamp).getTime();
    if (!isNaN(ts) && Math.abs(Date.now() - ts) > 5 * 60_000) {
      console.warn("[Fynd webhook] Stale webhook rejected (timestamp drift:", Math.abs(Date.now() - ts), "ms)");
      return Response.json({ error: "Webhook timestamp too old" }, { status: 401 });
    }
  }

  // Idempotency: check for duplicate webhook by shipment+status combo
  const shipIdForDedup = payload.shipment_id ?? payload.shipmentId ?? payload.id;
  const statusForDedup = payload.refund_status ?? payload.status;
  if (shipIdForDedup && statusForDedup) {
    try {
      const { default: prismaClient } = await import("../db.server");
      const recentDup = await prismaClient.fyndWebhookLog.findFirst({
        where: {
          shipmentId: String(shipIdForDedup),
          refundStatus: String(statusForDedup),
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      if (recentDup) {
        return Response.json({ ok: true, action: "duplicate_ignored" });
      }
    } catch { /* Non-fatal: proceed without dedup check */ }
  }

  try {
    const result = await processFyndWebhook(payload, rawBodyText, eventType);
    if (!result.ok) {
      console.error("[Fynd webhook]", result.error);
      return Response.json({ error: result.error }, { status: 500 });
    }
    return Response.json({ ok: true, action: result.action, returnCaseId: result.returnCaseId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Fynd webhook] Error:", msg);
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
};
