/**
 * Per-shop Fynd webhook receiver.
 *
 * URL: POST /api/webhooks/fynd/:shopId
 *
 * Each merchant generates a unique HMAC secret in Settings → Integrations.
 * They configure THIS URL (with their shopId) plus the matching secret in
 * the Fynd Partner Dashboard. We look up the secret by shopId from the URL,
 * verify the X-Fynd-Signature, then process exactly like the legacy endpoint.
 *
 * Why per-shop secret:
 *  - One leaked secret = one shop affected, not the whole platform.
 *  - Merchants can rotate their own secret without operator coordination.
 *  - No global env var to misconfigure.
 *
 * The legacy `/api/webhooks/fynd` endpoint with the global FYND_WEBHOOK_SECRET
 * still works — switch over per shop at your own pace.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { FyndWebhookPayload } from "../lib/fynd-webhook.server";
import { readBoundedBody, verifyWebhookSignature } from "../lib/fynd-webhook-verify.server";

export const loader = async (_args: LoaderFunctionArgs) => {
  return Response.json({ ok: true, method: "POST", model: "per-shop" });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const shopId = params.shopId;
  if (!shopId || shopId.length > 64 || !/^[a-z0-9_-]+$/i.test(shopId)) {
    return Response.json({ error: "Invalid shop identifier" }, { status: 400 });
  }

  // Lazy imports — keep cold-start cheap for non-webhook routes.
  const { processFyndWebhook, unwrapFyndWebhookPayload } = await import("../lib/fynd-webhook.server");
  const { default: prisma } = await import("../db.server");
  const { decryptIfEncrypted } = await import("../lib/encryption.server");

  // Body size guard FIRST — we don't want a 10MB request to reach decryption /
  // signature compute work even if it would later be rejected.
  const bodyResult = await readBoundedBody(request);
  if ("rejected" in bodyResult) return bodyResult.rejected;
  const rawBodyText = bodyResult.body;

  // Look up the shop + its webhook secret. Both must exist; if either is
  // missing the webhook is rejected. We deliberately do NOT differentiate
  // "shop not found" from "secret not configured" in the response — that
  // would let an attacker enumerate which shopIds exist via timing.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { settings: true },
  });
  const storedSecret = shop?.settings?.fyndWebhookSecret;
  const decryptedSecret = decryptIfEncrypted(storedSecret);
  if (!shop || !decryptedSecret) {
    // Generic 401 — same response shape regardless of which side is missing.
    return Response.json({ error: "Webhook authentication failed" }, { status: 401 });
  }

  // Verify signature against the raw body.
  const sigHeader =
    request.headers.get("x-fynd-signature") ??
    request.headers.get("x-webhook-signature");
  if (!verifyWebhookSignature(rawBodyText, sigHeader, decryptedSecret)) {
    console.warn(`[Fynd webhook /${shopId}] Signature mismatch — rejecting`);
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  // Optional replay protection — same window as the legacy endpoint.
  const webhookTimestamp =
    request.headers.get("x-webhook-timestamp") ??
    request.headers.get("x-fynd-timestamp");
  if (webhookTimestamp) {
    const ts = new Date(webhookTimestamp).getTime();
    if (!isNaN(ts) && Math.abs(Date.now() - ts) > 5 * 60_000) {
      console.warn(`[Fynd webhook /${shopId}] Stale webhook rejected`);
      return Response.json({ error: "Webhook timestamp too old" }, { status: 401 });
    }
  }

  // Parse payload (signature is already verified, so this is safe).
  let payload: FyndWebhookPayload;
  let eventType: string | undefined;
  try {
    ({ payload, eventType } = unwrapFyndWebhookPayload(rawBodyText));
  } catch (parseErr) {
    const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.error(`[Fynd webhook /${shopId}] Parse error:`, errMsg);
    try {
      await prisma.fyndWebhookLog.create({
        data: {
          action: "error",
          rawPayload: rawBodyText,
          shopDomain: shop.shopDomain,
          error: `JSON parse error: ${errMsg}`,
        },
      });
    } catch { /* non-fatal */ }
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Inject the shop domain into the payload so processFyndWebhook can use it
  // without falling back to extraction heuristics. The shop is already known
  // from the URL — the most authoritative source.
  payload._shop_domain = shop.shopDomain;

  // Idempotency: same dedup window as the legacy endpoint.
  const shipIdForDedup = payload.shipment_id ?? payload.shipmentId ?? payload.id;
  const statusForDedup = payload.refund_status ?? payload.status;
  if (shipIdForDedup && statusForDedup) {
    try {
      const recentDup = await prisma.fyndWebhookLog.findFirst({
        where: {
          shipmentId: String(shipIdForDedup),
          refundStatus: String(statusForDedup),
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
      });
      if (recentDup) {
        return Response.json({ ok: true, action: "duplicate_ignored" });
      }
    } catch { /* non-fatal */ }
  }

  try {
    const result = await processFyndWebhook(payload, rawBodyText, eventType);
    if (!result.ok) {
      console.error(`[Fynd webhook /${shopId}]`, result.error);
      return Response.json({ error: result.error }, { status: 500 });
    }
    return Response.json({ ok: true, action: result.action, returnCaseId: result.returnCaseId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Fynd webhook /${shopId}] Error:`, msg);
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
};
