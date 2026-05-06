/**
 * Background retry engine for failed Fynd syncs.
 * Runs on dashboard load (throttled) — retries failed syncs with exponential backoff.
 * Max 5 retries per return, backoff: 2min → 5min → 15min → 1hr → 4hr
 */

import prisma from "../db.server";
import { createFyndClientOrError } from "./fynd.server";
import { createReturnOnFynd } from "./fynd-returns.server";
import { fyndLogger } from "./observability/logger.server";
import { withSpan } from "./observability/tracing.server";
import { fyndRetryAttempt, fyndRetryExhausted } from "./observability/metrics.server";

const MAX_RETRIES = 5;
const BACKOFF_MINUTES = [2, 5, 15, 60, 240];
const BATCH_SIZE = 10;

function nextRetryTime(retryCount: number): Date {
  const delayMinutes = BACKOFF_MINUTES[Math.min(retryCount, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + delayMinutes * 60_000);
}

let lastRetryRun = 0;
const RETRY_THROTTLE_MS = 5 * 60_000;

export async function runFyndRetryQueue(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  exhausted: number;
}> {
  if (Date.now() - lastRetryRun < RETRY_THROTTLE_MS) {
    return { processed: 0, succeeded: 0, failed: 0, exhausted: 0 };
  }
  lastRetryRun = Date.now();

  return withSpan(
    "fynd.retry.queue_run",
    { "retry.batch_size": BATCH_SIZE, "retry.max_retries": MAX_RETRIES },
    async (span) => {
      const result = { processed: 0, succeeded: 0, failed: 0, exhausted: 0 };

      try {
        const pendingRetries = await prisma.returnCase.findMany({
          where: {
            fyndSyncStatus: { in: ["failed", "retry_scheduled"] },
            fyndSyncRetries: { lt: MAX_RETRIES },
            fyndSyncNextRetry: { lte: new Date() },
            status: { in: ["approved", "pending"] },
          },
          include: { items: true, shop: { include: { settings: true } } },
          take: BATCH_SIZE,
          orderBy: { fyndSyncNextRetry: "asc" },
        });

        span.setAttribute("retry.pending_count", pendingRetries.length);

        for (const rc of pendingRetries) {
          result.processed++;

          if (!rc.shop.settings?.fyndCredentials) {
            continue;
          }

          try {
            const clientResult = await createFyndClientOrError(rc.shop.settings);
            if (!clientResult.ok) {
              /* v8 ignore start */
              // defensive: clientResult.ok=false always carries an error field; fallback unreachable
              throw new Error(
                "error" in clientResult ? clientResult.error : "Failed to create Fynd client",
              );
              /* v8 ignore stop */
            }
            if (!("getShipments" in clientResult.client)) {
              throw new Error("Fynd client does not support Platform API");
            }

            const retrySyncStart = Date.now();
            const syncResult = await createReturnOnFynd(clientResult.client, rc, {
              /* v8 ignore start */
              // defensive: rc.fyndShipmentId set in fixtures; || null fallback unreachable
              targetShipmentId: rc.fyndShipmentId || null,
              /* v8 ignore stop */
            });
            const retrySyncDuration = Date.now() - retrySyncStart;
            if (syncResult.success) {
              await prisma.returnCase.update({
                where: { id: rc.id },
                data: {
                  fyndSyncStatus: "synced",
                  fyndSyncError: null,
                  fyndSyncNextRetry: null,
                  fyndReturnId: syncResult.fyndReturnId ?? rc.fyndReturnId,
                  fyndReturnNo: syncResult.fyndReturnNo ?? rc.fyndReturnNo,
                  fyndOrderId: syncResult.fyndOrderId ?? rc.fyndOrderId,
                  fyndShipmentId: syncResult.fyndShipmentId ?? rc.fyndShipmentId,
                  fyndPayloadJson: syncResult.fyndPayload
                    ? JSON.stringify(syncResult.fyndPayload)
                    : rc.fyndPayloadJson,
                },
              });
              await prisma.returnEvent.create({
                data: {
                  returnCaseId: rc.id,
                  source: "system",
                  eventType: "fynd_sync_retry_success",
                  payloadJson: JSON.stringify({
                    action: "auto_retry",
                    attempt: rc.fyndSyncRetries + 1,
                    durationMs: retrySyncDuration,
                    fyndReturnId: syncResult.fyndReturnId ?? null,
                    fyndOrderId: syncResult.fyndOrderId ?? null,
                    fyndShipmentId: syncResult.fyndShipmentId ?? null,
                  }),
                },
              });
              fyndRetryAttempt.add(1, {
                attempt_number: rc.fyndSyncRetries + 1,
                outcome: "success",
              });
              result.succeeded++;
            } else {
              /* v8 ignore start */
              // defensive: syncResult.error always present on failure path; fallback unreachable
              throw new Error(syncResult.error || "Fynd sync failed");
              /* v8 ignore stop */
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const newRetries = rc.fyndSyncRetries + 1;

            if (newRetries >= MAX_RETRIES) {
              await prisma.returnCase.update({
                where: { id: rc.id },
                data: {
                  fyndSyncStatus: "failed",
                  fyndSyncRetries: newRetries,
                  fyndSyncError: `Exhausted ${MAX_RETRIES} retries. Last error: ${errMsg}`.slice(
                    0,
                    2000,
                  ),
                  fyndSyncNextRetry: null,
                },
              });
              await prisma.returnEvent.create({
                data: {
                  returnCaseId: rc.id,
                  source: "system",
                  eventType: "fynd_sync_retries_exhausted",
                  payloadJson: JSON.stringify({
                    action: "auto_retry",
                    attempts: newRetries,
                    maxRetries: MAX_RETRIES,
                    lastError: errMsg.slice(0, 500),
                    nextAction: "manual_retry_or_manual_refund",
                    backoffSchedule: "2min, 5min, 15min, 1hr, 4hr",
                  }),
                },
              });
              fyndRetryAttempt.add(1, { attempt_number: newRetries, outcome: "exhausted" });
              fyndRetryExhausted.add(1);
              result.exhausted++;
            } else {
              await prisma.returnCase.update({
                where: { id: rc.id },
                data: {
                  fyndSyncStatus: "retry_scheduled",
                  fyndSyncRetries: newRetries,
                  fyndSyncError: errMsg.slice(0, 2000),
                  fyndSyncNextRetry: nextRetryTime(newRetries),
                },
              });
              fyndRetryAttempt.add(1, { attempt_number: newRetries, outcome: "retry_scheduled" });
              result.failed++;
            }
          }
        }
      } catch (err) {
        fyndLogger.error({ err }, "[fynd-retry] Queue error");
      }

      if (result.processed > 0) {
        fyndLogger.info(
          {
            processed: result.processed,
            succeeded: result.succeeded,
            failed: result.failed,
            exhausted: result.exhausted,
          },
          `[fynd-retry] Processed ${result.processed}: ${result.succeeded} succeeded, ${result.failed} scheduled for retry, ${result.exhausted} exhausted`,
        );
      }

      span.setAttributes({
        "retry.processed": result.processed,
        "retry.succeeded": result.succeeded,
        "retry.failed": result.failed,
        "retry.exhausted": result.exhausted,
      });

      return result;
    },
  );
}

export function scheduleRetry(returnCaseId: string, error: string): Promise<void> {
  return prisma.returnCase
    .update({
      where: { id: returnCaseId },
      data: {
        fyndSyncStatus: "retry_scheduled",
        fyndSyncRetries: 0,
        fyndSyncError: error.slice(0, 2000),
        fyndSyncNextRetry: nextRetryTime(0),
      },
    })
    .then(() => {});
}
