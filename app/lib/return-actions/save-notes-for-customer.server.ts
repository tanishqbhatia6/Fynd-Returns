import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { refundLogger } from "../observability/logger.server";
import { sendCustomerNoteNotification } from "../notification.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleSaveNotesForCustomer: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, sessionEmail, shopDomain, elapsed } = ctx;
  const { notesForCustomer } = body;
  return await withSpan("return.action.save_notes_for_customer", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "save_notes_for_customer",
  }, async () => {
    const actionTimer = startTimer();
    try {
      const val = notesForCustomer !== undefined
        ? (notesForCustomer || null)
        : (returnCase as { notesForCustomer?: string | null }).notesForCustomer ?? null;
      await prisma.returnCase.update({
        where: { id },
        data: { notesForCustomer: val },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "notes_for_customer_published",
          payloadJson: notesForCustomer
            ? JSON.stringify({ notesForCustomer, adminEmail: sessionEmail })
            : null,
        },
      });
      // Notify customer when a note is published.
      if (val && returnCase.customerEmailNorm) {
        sendCustomerNoteNotification({
          shopDomain,
          to: returnCase.customerEmailNorm,
          orderName: returnCase.shopifyOrderName,
          note: val,
          shopName: undefined,
          returnId: returnCase.returnRequestNo ?? returnCase.id,
        }).catch((e) => refundLogger.warn({ err: e }, "[save_notes_for_customer] Notification failed"));
      }

      returnActionCounter.add(1, { action: "save_notes_for_customer", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "save_notes_for_customer" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "save_notes_for_customer", outcome: "error" });
      appErrorCounter.add(1, { action: "save_notes_for_customer" });
      returnActionDuration.record(actionTimer(), { action: "save_notes_for_customer" });
      throw err;
    }
  });
};
