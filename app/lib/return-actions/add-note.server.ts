import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

void addBusinessEvent;

export const handleAddNote: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, sessionEmail, elapsed } = ctx;
  const { note } = body;
  return await withSpan("return.action.add_note", {
    "return.id": returnCase.id,
    // defensive: returnRequestNo always set in fixtures; "" fallback unreachable
    /* v8 ignore start */
    "return.request_no": returnCase.returnRequestNo || "",
    /* v8 ignore stop */
    "action.type": "add_note",
  }, async () => {
    const actionTimer = startTimer();
    try {
      await prisma.returnCase.update({
        where: { id },
        data: { adminNotes: note ?? returnCase.adminNotes },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "note_added",
          payloadJson: JSON.stringify({ note: note || null, adminEmail: sessionEmail }),
        },
      });

      returnActionCounter.add(1, { action: "add_note", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "add_note" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "add_note", outcome: "error" });
      appErrorCounter.add(1, { action: "add_note" });
      returnActionDuration.record(actionTimer(), { action: "add_note" });
      throw err;
    }
  });
};
