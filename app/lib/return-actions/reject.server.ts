import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
  returnsRejectedCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { closeShopifyReturnBestEffort } from "../shopify-admin.server";
import { sendRejectionNotification } from "../notification.server";
import { auditReturnAction } from "../observability/audit.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleReject: ReturnActionHandler = async (ctx, body) => {
  const {
    id,
    returnCase,
    shop,
    admin,
    isTerminal,
    sessionEmail,
    shopDomain,
    elapsed,
    logShopifyReturnEvent,
  } = ctx;
  const note = body.note;
  const rejectionReason = body.rejectionReason;
  return await withSpan(
    "return.action.reject",
    {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "reject",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (isTerminal) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json(
            { error: `Cannot reject: return is already ${returnCase.status}` },
            { status: 400 },
          );
        }
        const reason = (rejectionReason ?? "").trim();
        if (!reason) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json(
            {
              error: "Rejection reason is required. Please provide a reason to show the customer.",
            },
            { status: 400 },
          );
        }
        if (reason.length > 500) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json({ error: "Rejection reason is too long" }, { status: 400 });
        }
        await prisma.returnCase.update({
          where: { id },
          data: {
            status: "rejected",
            rejectionReason: reason,
            adminNotes: note || returnCase.adminNotes,
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "rejected",
            payloadJson: JSON.stringify({
              rejectionReason: reason,
              note: note || null,
              adminEmail: sessionEmail,
            }),
          },
        });
        await closeShopifyReturnBestEffort(admin as never, returnCase as never, {
          action: "decline",
          declineReason: reason,
          logEvent: logShopifyReturnEvent,
        });
        if (returnCase.customerEmailNorm) {
          try {
            await sendRejectionNotification({
              shopDomain,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              rejectionReason: reason,
              shopName: shopDomain?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[Reject] Notification failed");
          }
        }

        addBusinessEvent("return.rejected", {
          "return.id": returnCase.id,
          "rejection.reason": reason,
        });
        returnsRejectedCounter.add(1);
        auditReturnAction(
          "rejected",
          returnCase.id,
          shop.shopDomain,
          { type: "admin", identity: sessionEmail || "shop-admin" },
          { status: { from: returnCase.status, to: "rejected" } },
        );
        returnActionCounter.add(1, { action: "reject", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "reject" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "reject", outcome: "error" });
        appErrorCounter.add(1, { action: "reject" });
        returnActionDuration.record(actionTimer(), { action: "reject" });
        throw err;
      }
    },
  );
};
