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
    // Unwrap envelope: body.payload, body.shipment, or direct body
    let inner: Record<string, unknown>;
    if (body?.payload && typeof body.payload === "object") {
      inner = body.payload as Record<string, unknown>;
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
    }
    // Extract fields from inner.meta if present
    if (inner?.meta && typeof inner.meta === "object") {
      const meta = inner.meta as Record<string, unknown>;
      if (!inner.order_id && meta.order_id) inner.order_id = meta.order_id;
      if (!inner.affiliate_order_id && meta.affiliate_order_id) inner.affiliate_order_id = meta.affiliate_order_id;
      if (!inner.external_order_id && meta.external_order_id) inner.external_order_id = meta.external_order_id;
      if (!inner.channel_order_id && meta.channel_order_id) inner.channel_order_id = meta.channel_order_id;
    }
    const event = body?.event && typeof body.event === "object" ? (body.event as { type?: string; name?: string }) : null;
    eventType = event?.type ?? event?.name ?? undefined;
    const firstShipment = Array.isArray(inner?.shipments) ? inner.shipments[0] : null;
    const statusOrRefund =
      (typeof inner?.refund_status === "string" && inner.refund_status) ||
      (typeof inner?.status === "string" && inner.status) ||
      (typeof inner?.current_shipment_status === "string" && inner.current_shipment_status) ||
      (typeof firstShipment?.refund_status === "string" && firstShipment.refund_status) ||
      (typeof firstShipment?.status === "string" && firstShipment.status) ||
      eventType;
    payload = {
      ...inner,
      ...(statusOrRefund && { refund_status: statusOrRefund }),
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
