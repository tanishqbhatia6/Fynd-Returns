import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleEditDetails: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, sessionEmail, elapsed } = ctx;
  return await withSpan("return.action.edit_details", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "edit_details",
  }, async () => {
    const actionTimer = startTimer();
    try {
      const b = body as Record<string, unknown>;
      const trim = (v: unknown, max = 500) =>
        typeof v === "string" ? v.trim().slice(0, max) || null : null;
      const updateData: Record<string, string | null> = {};
      if ("customerAddress1" in b) updateData.customerAddress1 = trim(b.customerAddress1);
      if ("customerAddress2" in b) updateData.customerAddress2 = trim(b.customerAddress2);
      if ("customerCity" in b) updateData.customerCity = trim(b.customerCity, 100);
      if ("customerProvince" in b) updateData.customerProvince = trim(b.customerProvince, 100);
      if ("customerZip" in b) updateData.customerZip = trim(b.customerZip, 20);
      if ("customerCountry" in b) updateData.customerCountry = trim(b.customerCountry, 100);
      if ("customerLandmark" in b) updateData.customerLandmark = trim(b.customerLandmark);
      await prisma.returnCase.update({ where: { id }, data: updateData });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "details_edited",
          payloadJson: JSON.stringify({ fields: Object.keys(updateData), adminEmail: sessionEmail }),
        },
      });

      returnActionCounter.add(1, { action: "edit_details", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "edit_details" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "edit_details", outcome: "error" });
      appErrorCounter.add(1, { action: "edit_details" });
      returnActionDuration.record(actionTimer(), { action: "edit_details" });
      throw err;
    }
  });
};
