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

/** GET returns 200 with info — allows URL verification (e.g. Fynd or health checks). No heavy imports. */
export const loader = async (_args: LoaderFunctionArgs) => {
  try {
    return Response.json({
      ok: true,
      message: "Fynd webhook endpoint. Use POST with JSON payload.",
      path: "/api/webhooks/fynd",
    });
  } catch (err) {
    console.error("[Fynd webhook loader]", err);
    return Response.json({ error: "Webhook endpoint error" }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { processFyndWebhook } = await import("../lib/fynd-webhook.server");

  let payload: FyndWebhookPayload;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    // Fynd Platform format: { company_id, contains, event, payload }
    const inner = body?.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : body;
    // Map status for handler: prefer refund_status, then status (e.g. return_bag_delivered), then nested, then event type
    const event = body?.event && typeof body.event === "object" ? (body.event as { type?: string; name?: string }) : null;
    const eventType = event?.type ?? event?.name;
    const firstShipment = Array.isArray(inner?.shipments) ? inner.shipments[0] : null;
    const statusOrRefund =
      (typeof inner?.refund_status === "string" && inner.refund_status) ||
      (typeof inner?.status === "string" && inner.status) ||
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

  // Optional: verify webhook signature if FYND_WEBHOOK_SECRET is set
  const secret = process.env.FYND_WEBHOOK_SECRET;
  if (secret) {
    const signature = request.headers.get("x-fynd-signature") ?? request.headers.get("x-webhook-signature");
    if (signature) {
      // Fynd may use HMAC-SHA256. If they document the format, implement verification here.
      // For now we accept the webhook if secret is set and signature header exists (placeholder).
      // TODO: Implement HMAC verification when Fynd documents their webhook signing.
    }
  }

  try {
    const result = await processFyndWebhook(payload);
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
