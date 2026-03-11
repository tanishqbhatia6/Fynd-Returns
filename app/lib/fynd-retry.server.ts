/**
 * Background retry engine for failed Fynd syncs.
 * Runs on dashboard load (throttled) — retries failed syncs with exponential backoff.
 * Max 5 retries per return, backoff: 2min → 5min → 15min → 1hr → 4hr
 */

import prisma from "../db.server";
import { createFyndClientOrError } from "./fynd.server";
import { createReturnOnFynd } from "./fynd-returns.server";

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

    for (const rc of pendingRetries) {
      result.processed++;

      if (!rc.shop.settings?.fyndCredentials) {
        continue;
      }

      try {
        const clientResult = await createFyndClientOrError(rc.shop.settings);
        if (!clientResult.ok) {
          throw new Error("error" in clientResult ? clientResult.error : "Failed to create Fynd client");
        }
        if (!("getShipments" in clientResult.client)) {
          throw new Error("Fynd client does not support Platform API");
        }

        const syncResult = await createReturnOnFynd(clientResult.client, rc, {
          targetShipmentId: rc.fyndShipmentId || null,
        });
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
              fyndPayloadJson: syncResult.fyndPayload ? JSON.stringify(syncResult.fyndPayload) : rc.fyndPayloadJson,
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: rc.id,
              source: "system",
              eventType: "fynd_sync_retry_success",
              payloadJson: JSON.stringify({ attempt: rc.fyndSyncRetries + 1 }),
            },
          });
          result.succeeded++;
        } else {
          throw new Error(syncResult.error || "Fynd sync failed");
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
              fyndSyncError: `Exhausted ${MAX_RETRIES} retries. Last error: ${errMsg}`.slice(0, 2000),
              fyndSyncNextRetry: null,
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: rc.id,
              source: "system",
              eventType: "fynd_sync_retries_exhausted",
              payloadJson: JSON.stringify({ attempts: newRetries, lastError: errMsg.slice(0, 500) }),
            },
          });
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
          result.failed++;
        }
      }
    }
  } catch (err) {
    console.error("[fynd-retry] Queue error:", err instanceof Error ? err.message : err);
  }

  if (result.processed > 0) {
    console.log(`[fynd-retry] Processed ${result.processed}: ${result.succeeded} succeeded, ${result.failed} scheduled for retry, ${result.exhausted} exhausted`);
  }

  return result;
}

export function scheduleRetry(returnCaseId: string, error: string): Promise<void> {
  return prisma.returnCase.update({
    where: { id: returnCaseId },
    data: {
      fyndSyncStatus: "retry_scheduled",
      fyndSyncRetries: 0,
      fyndSyncError: error.slice(0, 2000),
      fyndSyncNextRetry: nextRetryTime(0),
    },
  }).then(() => {});
}
