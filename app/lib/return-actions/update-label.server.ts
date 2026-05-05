import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleUpdateLabel: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, sessionEmail, elapsed } = ctx;
  return await withSpan("return.action.update_label", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "update_label",
  }, async () => {
    const actionTimer = startTimer();
    try {
      const carrier = (body.carrier ?? "").trim();
      const trackingNumber = (body.trackingNumber ?? "").trim();
      const labelUrl = (body.labelUrl ?? "").trim();
      const qrCodeUrl = (body.qrCodeUrl ?? "").trim();

      const labelJson = JSON.stringify({
        carrier: carrier || null,
        trackingNumber: trackingNumber || null,
        labelUrl: labelUrl || null,
        qrCodeUrl: qrCodeUrl || null,
        adminEmail: sessionEmail,
      });

      await prisma.returnCase.update({
        where: { id },
        data: {
          returnLabelUrl: labelUrl || null,
          returnLabelJson: labelJson,
        },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "label_updated",
          payloadJson: labelJson,
        },
      });

      returnActionCounter.add(1, { action: "update_label", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "update_label" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "update_label", outcome: "error" });
      appErrorCounter.add(1, { action: "update_label" });
      returnActionDuration.record(actionTimer(), { action: "update_label" });
      throw err;
    }
  });
};
