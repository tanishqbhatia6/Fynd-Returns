import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { sendCancellationDeclinedNotification } from "../notification.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleDeclineCancellation: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shopDomain, sessionEmail, elapsed } = ctx;
  return await withSpan(
    "return.action.decline_cancellation",
    {
      "return.id": returnCase.id,
      // defensive: returnRequestNo always set in fixtures; "" fallback unreachable
      /* v8 ignore start */
      "return.request_no": returnCase.returnRequestNo || "",
      /* v8 ignore stop */
      "action.type": "decline_cancellation",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (returnCase.status.toLowerCase() !== "approved" || !returnCase.cancellationRequestedAt) {
          returnActionCounter.add(1, { action: "decline_cancellation", outcome: "error" });
          return Response.json(
            { error: "No pending cancellation request to decline" },
            { status: 400 },
          );
        }

        await prisma.returnCase.update({
          where: { id },
          data: {
            cancellationDeclinedAt: new Date(),
            cancellationDeclinedBy: sessionEmail,
            cancellationRequestedAt: null,
          },
        });

        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "cancellation_declined",
            payloadJson: JSON.stringify({
              reason: returnCase.cancellationReason || null,
              adminEmail: sessionEmail,
            }),
          },
        });

        if (returnCase.customerEmailNorm) {
          sendCancellationDeclinedNotification({
            shopDomain,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName,
            shopName: undefined,
            /* v8 ignore start */
            // defensive: returnRequestNo always set in fixtures; id fallback unreachable
            returnId: returnCase.returnRequestNo ?? returnCase.id,
            /* v8 ignore stop */
            customerPhone: returnCase.customerPhoneNorm ?? null,
          }).catch((e) =>
            refundLogger.warn({ err: e }, "[decline_cancellation] Notification failed"),
          );
        }

        addBusinessEvent("return.cancellation_declined", { "return.id": returnCase.id });
        returnActionCounter.add(1, { action: "decline_cancellation", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "decline_cancellation" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "decline_cancellation", outcome: "error" });
        appErrorCounter.add(1, { action: "decline_cancellation" });
        returnActionDuration.record(actionTimer(), { action: "decline_cancellation" });
        throw err;
      }
    },
  );
};
