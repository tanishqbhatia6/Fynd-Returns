/**
 * Fynd Shipment Update Webhook
 *
 * Receives POST from Fynd when shipment/refund status changes.
 * Updates refundStatus (in_progress) and triggers Shopify refund when Fynd reports refund_done.
 *
 * Configure in Fynd Platform: Webhooks → add URL: https://YOUR_APP_URL/api/webhooks/fynd
 *
 * SECURITY: FYND_WEBHOOK_SECRET is REQUIRED in production. Without it the endpoint
 * rejects all webhooks (previously they were silently accepted, which let anyone on
 * the internet trigger refunds — P0 finding from QA audit, fixed).
 *
 * Loader has no heavy imports so GET requests work without loading Prisma/Shopify.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { FyndWebhookPayload } from "../lib/fynd-webhook.server";
import { webhookLogger } from "../lib/observability/logger.server";

// Hard cap on Fynd webhook body size. Fynd webhooks are typically <20KB; legitimate
// multi-shipment payloads stay under 200KB. We cap at 1MB so a malicious or runaway
// payload cannot OOM the receiver, and we REJECT (413) rather than silently truncating
// (which used to corrupt the stored rawPayload — P1 finding from QA audit).
const MAX_WEBHOOK_BYTES = 1_048_576;

export const loader = async (_args: LoaderFunctionArgs) => {
  return Response.json({ ok: true, method: "POST" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { processFyndWebhook, unwrapFyndWebhookPayload } =
    await import("../lib/fynd-webhook.server");

  // Cheap pre-check via Content-Length, then enforce again after reading the body
  // (Content-Length can lie; the post-read check is the real guard).
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return Response.json({ error: "Webhook payload too large" }, { status: 413 });
    }
  }

  const rawBodyText = await request.text();
  if (Buffer.byteLength(rawBodyText, "utf8") > MAX_WEBHOOK_BYTES) {
    return Response.json({ error: "Webhook payload too large" }, { status: 413 });
  }

  // Signature verification BEFORE parsing — uses raw body for correct HMAC
  const secret = process.env.FYND_WEBHOOK_SECRET;
  const isProd = process.env.NODE_ENV === "production";
  if (isProd && !secret) {
    // Fail closed in production. An unsigned webhook in prod is unsafe — anyone could
    // forge refund-done events to trigger real Shopify refunds.
    webhookLogger.error(
      { webhook: "fynd", reason: "missing_global_secret" },
      "FYND_WEBHOOK_SECRET not configured in production; rejecting webhook",
    );
    return Response.json(
      {
        error:
          "Webhook signature verification is not configured on this server. Contact the merchant's developer to set FYND_WEBHOOK_SECRET.",
      },
      { status: 503 },
    );
  }
  if (secret) {
    // Dual-mode auth: shared-secret in headers (Fynd Commerce compatible) OR
    // HMAC signature for legacy / custom integrations. The shared helper
    // returns a structured failure reason so we can log specifics without
    // leaking detail to the rejected caller.
    const { authenticateWebhook } = await import("../lib/fynd-webhook-verify.server");
    const authResult = authenticateWebhook(request, rawBodyText, secret);
    if (!authResult.ok) {
      webhookLogger.warn(
        { webhook: "fynd", reason: authResult.reason },
        "Fynd webhook authentication failed",
      );
      return Response.json({ error: "Webhook authentication failed" }, { status: 401 });
    }
  }
  // In development with no secret, processing continues — convenient for local testing
  // against Fynd's test webhooks. Production fail-closed is enforced above.

  let payload: FyndWebhookPayload;
  let eventType: string | undefined;
  try {
    ({ payload, eventType } = unwrapFyndWebhookPayload(rawBodyText));
  } catch (parseErr) {
    const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    webhookLogger.error(
      { webhook: "fynd", err: parseErr },
      "Fynd webhook JSON parse failed",
    );
    // Store the failed webhook for later inspection
    try {
      const { default: prismaClient } = await import("../db.server");
      // Body size already capped at MAX_WEBHOOK_BYTES above, so storing in full is safe.
      // No silent truncation here — if debugging needs the full payload, store it.
      await prismaClient.fyndWebhookLog.create({
        data: {
          action: "error",
          rawPayload: rawBodyText,
          error: `JSON parse error: ${errMsg}`,
        },
      });
    } catch {
      /* non-fatal */
    }
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Replay protection: reject webhooks with timestamps older than 5 minutes
  const webhookTimestamp =
    request.headers.get("x-webhook-timestamp") ?? request.headers.get("x-fynd-timestamp");
  if (webhookTimestamp) {
    const ts = new Date(webhookTimestamp).getTime();
    if (!isNaN(ts) && Math.abs(Date.now() - ts) > 5 * 60_000) {
      webhookLogger.warn(
        { webhook: "fynd", timestampDriftMs: Math.abs(Date.now() - ts) },
        "Stale Fynd webhook rejected",
      );
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
    } catch (err) {
      // Non-fatal: proceed without dedup check, but surface the cause so a
      // failing dedup query doesn't silently turn into a flood of duplicate
      // webhook processing.
      webhookLogger.warn(
        { webhook: "fynd", err },
        "Fynd webhook dedup check failed; proceeding without dedup",
      );
    }
  }

  try {
    const result = await processFyndWebhook(payload, rawBodyText, eventType);
    if (!result.ok) {
      webhookLogger.error(
        { webhook: "fynd", error: result.error },
        "Fynd webhook processing returned an error",
      );
      return Response.json({ error: result.error }, { status: 500 });
    }
    return Response.json({ ok: true, action: result.action, returnCaseId: result.returnCaseId });
  } catch (err) {
    webhookLogger.error({ webhook: "fynd", err }, "Fynd webhook processing failed");
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
};
