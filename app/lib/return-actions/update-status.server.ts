import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { closeShopifyReturnBestEffort } from "../shopify-admin.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

const VALID_STATUSES = [
  "pending",
  "processing",
  "in progress",
  "approved",
  "rejected",
  "completed",
  "cancelled",
  "initiated",
];

const TERMINAL_STATUSES_FOR_CLOSE = ["completed", "cancelled", "rejected"];

export const handleUpdateStatus: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, admin, sessionEmail, elapsed, logShopifyReturnEvent } = ctx;
  const newStatus = body.status;
  const note = body.note;
  if (!newStatus) {
    return Response.json({ error: "status required" }, { status: 400 });
  }
  return await withSpan("return.action.update_status", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "update_status",
    "status.from": returnCase.status,
    "status.to": newStatus,
  }, async () => {
    const actionTimer = startTimer();
    try {
      if (!VALID_STATUSES.includes(newStatus.toLowerCase())) {
        returnActionCounter.add(1, { action: "update_status", outcome: "error" });
        return Response.json({ error: `Invalid status: ${newStatus}` }, { status: 400 });
      }
      await prisma.returnCase.update({
        where: { id },
        data: { status: newStatus, adminNotes: note || returnCase.adminNotes },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "status_updated",
          payloadJson: JSON.stringify({ from: returnCase.status, to: newStatus, note, adminEmail: sessionEmail }),
        },
      });

      if (TERMINAL_STATUSES_FOR_CLOSE.includes(newStatus.toLowerCase())) {
        const closeAction = newStatus.toLowerCase() === "rejected" ? "decline" : "close";
        await closeShopifyReturnBestEffort(admin as never, returnCase as never, {
          action: closeAction as "close" | "decline",
          declineReason: closeAction === "decline" ? (note || "Return rejected") : undefined,
          logEvent: logShopifyReturnEvent,
        });
      }

      addBusinessEvent("return.status_updated", { "status.from": returnCase.status, "status.to": newStatus });
      returnActionCounter.add(1, { action: "update_status", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "update_status" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "update_status", outcome: "error" });
      appErrorCounter.add(1, { action: "update_status" });
      returnActionDuration.record(actionTimer(), { action: "update_status" });
      throw err;
    }
  });
};
