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

  const { processFyndWebhook, unwrapFyndWebhookPayload } = await import("../lib/fynd-webhook.server");

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
    ({ payload, eventType } = unwrapFyndWebhookPayload(rawBodyText));
  } catch (parseErr) {
    const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error("[Fynd webhook] Parse error:", errMsg, "Body preview:", rawBodyText.slice(0, 300));
    // Store the failed webhook for later inspection
    try {
      const { default: prismaClient } = await import("../db.server");
      await prismaClient.fyndWebhookLog.create({
        data: {
          action: "error",
          rawPayload: rawBodyText.slice(0, 50000),
          error: `JSON parse error: ${errMsg}`,
        },
      });
    } catch { /* non-fatal */ }
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
