/**
 * Fynd Webhook Auto-Retry Cron
 *
 * Called by external cron every 15 minutes.
 * Retries "ignored" webhooks (no ReturnCase match at the time) — the ReturnCase
 * may have been created since the webhook first arrived.
 *
 * Security: CRON_SECRET Bearer token.
 * URL: POST /api/fynd-webhook-retry-cron (or GET for simple cron services)
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authorizeCronRequest } from "../lib/cron-auth.server";
import { cronLogger } from "../lib/observability/logger.server";
import { cronJobCounter } from "../lib/observability/metrics.server";

const MAX_RETRIES = 5;
const BACKOFF_MINUTES = [5, 15, 60, 240, 720]; // 5m, 15m, 1h, 4h, 12h
const BATCH_SIZE = 100;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorizeCronRequest(request)) {
    cronJobCounter.add(1, { job: "fynd_webhook_retry", outcome: "unauthorized" });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runRetryCron();
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorizeCronRequest(request)) {
    cronJobCounter.add(1, { job: "fynd_webhook_retry", outcome: "unauthorized" });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runRetryCron();
};

async function runRetryCron() {
  const prisma = (await import("../db.server")).default;
  const { processFyndWebhook, unwrapFyndWebhookPayload } =
    await import("../lib/fynd-webhook.server");

  const now = new Date();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  // Find ignored webhooks eligible for retry
  const eligible = await prisma.fyndWebhookLog.findMany({
    where: {
      action: "ignored",
      rawPayload: { not: null },
      retryCount: { lt: MAX_RETRIES },
      createdAt: { gte: sevenDaysAgo },
      OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  if (eligible.length === 0) {
    cronJobCounter.add(1, { job: "fynd_webhook_retry", outcome: "empty" });
    return Response.json({ ok: true, processed: 0, succeeded: 0, rescheduled: 0, exhausted: 0 });
  }

  let succeeded = 0;
  let rescheduled = 0;
  let exhausted = 0;

  for (const log of eligible) {
    if (!log.rawPayload) continue;
    try {
      const { payload, eventType } = unwrapFyndWebhookPayload(log.rawPayload);
      const result = await processFyndWebhook(payload, log.rawPayload, eventType);

      if (result.ok && result.action !== "ignored") {
        // Success! Delete the old ignored log (processFyndWebhook created a new one)
        await prisma.fyndWebhookLog.delete({ where: { id: log.id } }).catch(() => {});
        succeeded++;
      } else {
        // Still ignored — schedule next retry with exponential backoff
        const newCount = log.retryCount + 1;
        if (newCount >= MAX_RETRIES) {
          await prisma.fyndWebhookLog.update({
            where: { id: log.id },
            data: {
              retryCount: newCount,
              retryAfter: null,
              error: `Exhausted ${MAX_RETRIES} auto-retries. Manual retry still available.`,
            },
          });
          exhausted++;
        } else {
          const delayMin = BACKOFF_MINUTES[Math.min(newCount, BACKOFF_MINUTES.length - 1)];
          await prisma.fyndWebhookLog.update({
            where: { id: log.id },
            data: { retryCount: newCount, retryAfter: new Date(Date.now() + delayMin * 60_000) },
          });
          rescheduled++;
        }
      }
    } catch {
      // Parse/processing error — increment retry count with backoff
      const newCount = log.retryCount + 1;
      const delayMin = BACKOFF_MINUTES[Math.min(newCount, BACKOFF_MINUTES.length - 1)];
      await prisma.fyndWebhookLog
        .update({
          where: { id: log.id },
          data: {
            retryCount: newCount,
            retryAfter: newCount >= MAX_RETRIES ? null : new Date(Date.now() + delayMin * 60_000),
            ...(newCount >= MAX_RETRIES
              ? { error: `Exhausted ${MAX_RETRIES} auto-retries after processing error.` }
              : {}),
          },
        })
        .catch(() => {});
      if (newCount >= MAX_RETRIES) exhausted++;
      else rescheduled++;
    }
  }

  cronLogger.info(
    { processed: eligible.length, succeeded, rescheduled, exhausted },
    "Fynd webhook retry cron completed",
  );

  cronJobCounter.add(1, {
    job: "fynd_webhook_retry",
    outcome: exhausted > 0 ? "partial_exhausted" : "success",
  });

  return Response.json({
    ok: true,
    processed: eligible.length,
    succeeded,
    rescheduled,
    exhausted,
  });
}
