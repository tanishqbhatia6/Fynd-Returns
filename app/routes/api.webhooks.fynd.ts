/**
 * Fynd Shipment Update Webhook
 *
 * Receives POST from Fynd when shipment/refund status changes.
 * Updates refundStatus (in_progress) and triggers Shopify refund when Fynd reports refund_done.
 *
 * Configure in Fynd Platform: Webhooks → add URL: https://YOUR_APP_URL/api/webhooks/fynd
 * Optional: set FYND_WEBHOOK_SECRET env to verify X-Fynd-Signature (if Fynd supports it).
 */

import type { ActionFunctionArgs } from "react-router";
import { processFyndWebhook, type FyndWebhookPayload } from "../lib/fynd-webhook.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let payload: FyndWebhookPayload;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    // Fynd Platform format: { company_id, contains, event, payload }
    const inner = body?.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : body;
    // Map event.type (e.g. refund_done) to refund_status when present
    const event = body?.event && typeof body.event === "object" ? (body.event as { type?: string; name?: string }) : null;
    const eventType = event?.type ?? event?.name;
    payload = {
      ...inner,
      ...(eventType && { refund_status: inner?.refund_status ?? eventType }),
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
