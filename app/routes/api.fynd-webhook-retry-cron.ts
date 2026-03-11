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

const MAX_RETRIES = 5;
const BACKOFF_MINUTES = [5, 15, 60, 240, 720]; // 5m, 15m, 1h, 4h, 12h
const BATCH_SIZE = 100;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    const host = request.headers.get("host") ?? "";
    return host.includes("localhost") || host.includes("127.0.0.1");
  }
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "GET" && isAuthorized(request)) {
    return runRetryCron();
  }
  return Response.json({ error: "Unauthorized" }, { status: 401 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runRetryCron();
};

async function runRetryCron() {
  const prisma = (await import("../db.server")).default;
  const { processFyndWebhook, unwrapFyndWebhookPayload } = await import(
    "../lib/fynd-webhook.server"
  );

  const now = new Date();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  // Find ignored webhooks eligible for retry
  const eligible = await prisma.fyndWebhookLog.findMany({
    where: {
      action: "ignored",
      rawPayload: { not: null },
      retryCount: { lt: MAX_RETRIES },
      createdAt: { gte: sevenDaysAgo },
      OR: [
        { retryAfter: null },
        { retryAfter: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  if (eligible.length === 0) {
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
            data: { retryCount: newCount, retryAfter: null, error: `Exhausted ${MAX_RETRIES} auto-retries. Manual retry still available.` },
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
      await prisma.fyndWebhookLog.update({
        where: { id: log.id },
        data: {
          retryCount: newCount,
          retryAfter: newCount >= MAX_RETRIES ? null : new Date(Date.now() + delayMin * 60_000),
          ...(newCount >= MAX_RETRIES ? { error: `Exhausted ${MAX_RETRIES} auto-retries after processing error.` } : {}),
        },
      }).catch(() => {});
      if (newCount >= MAX_RETRIES) exhausted++;
      else rescheduled++;
    }
  }

  console.log(`[Fynd webhook retry cron] Processed ${eligible.length}: ${succeeded} succeeded, ${rescheduled} rescheduled, ${exhausted} exhausted`);

  return Response.json({
    ok: true,
    processed: eligible.length,
    succeeded,
    rescheduled,
    exhausted,
  });
}
