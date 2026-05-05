import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { closeShopifyReturnBestEffort } from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { sendCancellationNotification } from "../notification.server";
import { dispatchWebhookEvent } from "../webhook-dispatch.server";
import { auditReturnAction } from "../observability/audit.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse, extractErrorMessage } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleApproveCancellation: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shop, admin, sessionEmail, shopDomain, elapsed, logShopifyReturnEvent } = ctx;
  return await withSpan("return.action.approve_cancellation", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "approve_cancellation",
  }, async () => {
    const actionTimer = startTimer();
    try {
      if (returnCase.status.toLowerCase() !== "approved" || !returnCase.cancellationRequestedAt) {
        returnActionCounter.add(1, { action: "approve_cancellation", outcome: "error" });
        return Response.json(
          { error: "No pending cancellation request to approve" },
          { status: 400 },
        );
      }

      // Close Shopify Return BEFORE flipping our status. If close fails we keep the
      // local status as "approved" so an admin can retry. (Critical invariant.)
      const closeResult = await closeShopifyReturnBestEffort(admin as never, returnCase as never, {
        action: "close",
        logEvent: logShopifyReturnEvent,
      });
      const closeFailed = closeResult && typeof closeResult === "object" && "ok" in closeResult && closeResult.ok === false;
      if (closeFailed) {
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "cancellation_blocked_by_shopify",
            payloadJson: JSON.stringify({
              reason: "Shopify return close failed; cancellation NOT applied locally so it can be retried.",
              error: (closeResult as { error?: string }).error ?? null,
              adminEmail: sessionEmail,
            }),
          },
        }).catch(() => {});
        returnActionCounter.add(1, { action: "approve_cancellation", outcome: "shopify_close_failed" });
        return Response.json({
          error: "Could not close the Shopify return. Cancellation has not been applied. Please retry, or close the Shopify return manually first.",
        }, { status: 502 });
      }

      await prisma.returnCase.update({
        where: { id },
        data: { status: "cancelled" },
      });

      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "cancellation_approved",
          payloadJson: JSON.stringify({
            reason: returnCase.cancellationReason || null,
            adminEmail: sessionEmail,
          }),
        },
      });

      // Best-effort Fynd cancel.
      const fyndReturnIdVal = returnCase.fyndReturnId;
      const fyndSyncStatus = (returnCase as unknown as { fyndSyncStatus?: string | null }).fyndSyncStatus;
      const fyndShipmentIdVal = returnCase.fyndShipmentId;
      const fyndOrderIdVal = returnCase.fyndOrderId;
      if ((fyndReturnIdVal || fyndSyncStatus === "synced") && fyndShipmentIdVal) {
        try {
          const settingsForCancel = shop.settings as (NonNullable<unknown> & { fyndApiType?: string | null }) | undefined;
          if (settingsForCancel) {
            const clientResult = await createFyndClientOrError(settingsForCancel as never, { requirePlatform: true });
            if (clientResult.ok && "updateShipmentStatus" in clientResult.client) {
              const fyndClient = clientResult.client as import("../fynd.server").FyndPlatformClient;
              const cancelPayload = {
                statuses: [
                  {
                    shipments: [{ identifier: fyndShipmentIdVal }],
                    status: "return_request_cancelled",
                  },
                ],
                task: false,
                force_transition: false,
                lock_after_transition: false,
                unlock_before_transition: false,
              };
              const callId = fyndOrderIdVal || fyndShipmentIdVal;
              await fyndClient.updateShipmentStatus(callId, cancelPayload);
              refundLogger.info({ shipmentId: fyndShipmentIdVal }, "[approve_cancellation] Fynd return_request_cancelled sent");
            }
          }
        } catch (fyndErr) {
          refundLogger.warn({ err: fyndErr }, "[approve_cancellation] Fynd cancel best-effort failed");
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "fynd_cancel_failed",
              payloadJson: JSON.stringify({
                error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr),
                shipmentId: fyndShipmentIdVal,
              }),
            },
          }).catch(() => {});
        }
      }

      if (returnCase.customerEmailNorm) {
        sendCancellationNotification({
          shopDomain,
          to: returnCase.customerEmailNorm,
          orderName: returnCase.shopifyOrderName,
          shopName: undefined,
          returnId: returnCase.returnRequestNo ?? returnCase.id,
          customerPhone: returnCase.customerPhoneNorm ?? null,
        }).catch((e) => refundLogger.warn({ err: e }, "[approve_cancellation] Notification failed"));
      }

      dispatchWebhookEvent(shop.id, "return.cancelled", {
        returnCaseId: id,
        returnRequestNo: returnCase.returnRequestNo,
        shopifyOrderName: returnCase.shopifyOrderName,
        previousStatus: "approved",
        cancelledBy: "admin_approved_customer_request",
        reason: returnCase.cancellationReason || null,
      });

      addBusinessEvent("return.cancellation_approved", { "return.id": returnCase.id });
      auditReturnAction(
        "cancellation_approved",
        returnCase.id,
        shop.shopDomain,
        { type: "admin", identity: sessionEmail || "shop-admin" },
        { status: { from: "approved", to: "cancelled" } },
      );
      returnActionCounter.add(1, { action: "approve_cancellation", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "approve_cancellation" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err)) throw err;
      if (err instanceof Response) throw err;
      const rawMessage = await extractErrorMessage(err);
      refundLogger.error({ err, returnId: id }, "[approve_cancellation] Error");
      returnActionCounter.add(1, { action: "approve_cancellation", outcome: "error" });
      appErrorCounter.add(1, { action: "approve_cancellation" });
      returnActionDuration.record(actionTimer(), { action: "approve_cancellation" });
      return Response.json({ error: rawMessage || "Failed to approve cancellation" }, { status: 500 });
    }
  });
};
