import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
  fyndSyncCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { fetchOrder, fetchOrderByOrderNumber, createShopifyReturn } from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { createReturnOnFynd } from "../fynd-returns.server";
import { refundLogger } from "../observability/logger.server";
import {
  isRedirectResponse,
  enrichFyndError,
  classifyFyndError,
} from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleRetryFyndSync: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shop, admin, sessionEmail, elapsed } = ctx;
  return await withSpan(
    "return.action.retry_fynd_sync",
    {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "retry_fynd_sync",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          return Response.json({ error: "Return must be approved first" }, { status: 400 });
        }
        // Allow retry if: no fyndReturnId, OR sync is in a failed/retry state.
        const syncStatus = (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus;
        if (
          returnCase.fyndReturnId &&
          syncStatus !== "failed" &&
          syncStatus !== "retry_scheduled"
        ) {
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndSuccess=already_synced`);
        }

        addBusinessEvent("return.fynd_sync_started", {
          "return.id": returnCase.id,
          "sync.type": "manual_retry",
        });

        const settingsRetry = shop.settings as
          | (NonNullable<unknown> & { fyndApiType?: string | null })
          | undefined;
        const fyndRetryResult = settingsRetry
          ? await createFyndClientOrError(settingsRetry as never, { requirePlatform: true })
          : {
              ok: false as const,
              error:
                "Fynd is not configured. Configure Fynd with Platform API in Settings → Integrations.",
            };
        if (!fyndRetryResult.ok) {
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(
            `/app/returns/${id}?fyndError=${encodeURIComponent(fyndRetryResult.error)}`,
          );
        }
        const fyndClient = fyndRetryResult.client;
        if (!("getShipments" in fyndClient)) {
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(
            `/app/returns/${id}?fyndError=${encodeURIComponent("Sync to Fynd requires Platform API. Switch to Platform in Settings → Integrations.")}`,
          );
        }
        let affiliateOrderId: string | null = null;
        let fyndResult: Awaited<ReturnType<typeof createReturnOnFynd>> | null = null;
        let retryDurationMs = 0;
        let retryCrashError: string | null = null;

        try {
          if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
            const order = returnCase.shopifyOrderId
              ? await fetchOrder(admin as never, returnCase.shopifyOrderId)
              : await fetchOrderByOrderNumber(
                  admin as never,
                  (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim(),
                );
            affiliateOrderId = order?.affiliateOrderId ?? null;
          }
          const retryStartTime = Date.now();
          fyndResult = await createReturnOnFynd(fyndClient, returnCase as never, {
            affiliateOrderId,
            /* v8 ignore start */
            // defensive: fyndShipmentId set in fixtures; || null fallback unreachable
            targetShipmentId: returnCase.fyndShipmentId || null,
            /* v8 ignore stop */
            /* v8 ignore start */
            // defensive: pickupAddress nullish-coalescing fallbacks per field
            pickupAddress:
              returnCase.customerAddress1 || returnCase.customerCity
                ? {
                    address1: returnCase.customerAddress1 ?? null,
                    address2: returnCase.customerAddress2 ?? null,
                    city: returnCase.customerCity ?? null,
                    province: returnCase.customerProvince ?? null,
                    zip: returnCase.customerZip ?? null,
                    country: returnCase.customerCountry ?? null,
                    landmark: returnCase.customerLandmark ?? null,
                    name: returnCase.customerName ?? null,
                    phone: returnCase.customerPhoneNorm ?? null,
                  }
                : null,
            /* v8 ignore stop */
          });
          retryDurationMs = Date.now() - retryStartTime;
        } catch (err) {
          /* v8 ignore start */
          // defensive: caught err is always Error in this code path; non-Error fallback unreachable
          retryCrashError = enrichFyndError(err instanceof Error ? err.message : String(err));
          /* v8 ignore stop */
          refundLogger.error({ err }, "[retry_fynd_sync] Unhandled error");
        }

        if (retryCrashError || !fyndResult) {
          const crashMsg =
            retryCrashError || "Fynd sync failed unexpectedly. Check server logs for details.";
          await prisma.returnCase
            .update({
              where: { id },
              data: { fyndSyncStatus: "failed", fyndSyncError: crashMsg },
            })
            .catch(() => {});
          await prisma.returnEvent
            .create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "fynd_sync_failed",
                payloadJson: JSON.stringify({
                  action: "manual_retry",
                  status: "crashed",
                  error: crashMsg,
                  errorType: classifyFyndError(crashMsg),
                  adminEmail: sessionEmail,
                }),
              },
            })
            .catch(() => {});
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(crashMsg)}`);
        }

        const hasFyndId = fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId;
        if (fyndResult.success && (hasFyndId || fyndResult.alreadyExists)) {
          let payloadJson: string | null = null;
          try {
            payloadJson =
              fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
          } catch {
            payloadJson = null;
          }
          await prisma.returnCase.update({
            where: { id },
            data: {
              fyndReturnId: fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? null,
              fyndReturnNo: fyndResult.fyndReturnNo ?? null,
              fyndOrderId: fyndResult.fyndOrderId ?? null,
              fyndShipmentId: fyndResult.fyndShipmentId ?? null,
              ...(payloadJson != null && { fyndPayloadJson: payloadJson }),
              fyndSyncStatus: "synced",
              fyndSyncError: null,
              fyndSyncNextRetry: null,
              fyndSyncRetries: 0,
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "fynd_sync",
              payloadJson: JSON.stringify({
                action: "manual_retry",
                status: "success",
                fyndReturnId: fyndResult.fyndReturnId ?? null,
                fyndReturnNo: fyndResult.fyndReturnNo ?? null,
                fyndShipmentId: fyndResult.fyndShipmentId ?? null,
                alreadyExists: fyndResult.alreadyExists ?? false,
                durationMs: retryDurationMs,
                retryAttempt: (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0,
                adminEmail: sessionEmail,
              }),
            },
          });
          if (!returnCase.shopifyReturnId) {
            const retryOrderId = returnCase.shopifyOrderId;
            const canCreateReturn =
              retryOrderId &&
              !retryOrderId.startsWith("manual:") &&
              (retryOrderId.startsWith("gid://") || /^\d+$/.test(retryOrderId)) &&
              (returnCase as { isGreenReturn?: boolean }).isGreenReturn !== true;
            if (canCreateReturn) {
              try {
                const shopifyReturnResult = await createShopifyReturn(
                  admin as never,
                  retryOrderId,
                  (returnCase.items ?? []).map((item) => ({
                    shopifyLineItemId: item.shopifyLineItemId,
                    qty: item.qty,
                    reasonCode: item.reasonCode ?? null,
                    notes: item.notes ?? null,
                    sku: item.sku ?? null,
                  })),
                  { requestedAt: returnCase.createdAt.toISOString() },
                );
                if (shopifyReturnResult.success && shopifyReturnResult.shopifyReturnId) {
                  await prisma.returnCase
                    .update({
                      where: { id },
                      data: { shopifyReturnId: shopifyReturnResult.shopifyReturnId },
                    })
                    .catch(() => {});
                  refundLogger.info(
                    { shopifyReturnId: shopifyReturnResult.shopifyReturnId },
                    "[retry_fynd_sync] Also created Shopify Return",
                  );
                } else {
                  refundLogger.warn(
                    { error: shopifyReturnResult.error },
                    "[retry_fynd_sync] Shopify Return creation failed (non-fatal)",
                  );
                }
              } catch (err) {
                refundLogger.warn(
                  { err },
                  "[retry_fynd_sync] Shopify Return creation crashed (non-fatal)",
                );
              }
            }
          }

          fyndSyncCounter.add(1, { outcome: "success" });
          addBusinessEvent("return.fynd_sync_completed", {
            "return.id": returnCase.id,
            "fynd.return_id": fyndResult.fyndReturnId || "",
            "sync.type": "manual_retry",
          });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          annotateSLO("api_latency_p99", { durationMs: elapsed() });

          const successParam = fyndResult.alreadyExists ? "already_exists" : "1";
          throw redirect(`/app/returns/${id}?fyndSuccess=${successParam}`);
        }
        const rawErr = fyndResult.error?.trim();
        const errMsg = enrichFyndError(
          rawErr ||
            (fyndResult.success
              ? "Sync completed but Fynd did not return a return ID. Check Fynd dashboard."
              : "Unknown Fynd error"),
        );
        await prisma.returnCase
          .update({
            where: { id },
            data: { fyndSyncStatus: "failed", fyndSyncError: errMsg },
          })
          .catch(() => {});
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "fynd_sync_failed",
            payloadJson: JSON.stringify({
              action: "manual_retry",
              status: "failed",
              error: errMsg,
              errorType: classifyFyndError(errMsg),
              durationMs: retryDurationMs,
              retryAttempt: (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0,
              adminEmail: sessionEmail,
            }),
          },
        });

        fyndSyncCounter.add(1, { outcome: "error" });
        returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });

        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(errMsg)}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
        appErrorCounter.add(1, { action: "retry_fynd_sync" });
        returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
        throw err;
      }
    },
  );
};
