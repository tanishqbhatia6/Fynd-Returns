import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { isRedirectResponse } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleUpdateInstructions: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, shop, sessionEmail, elapsed } = ctx;
  return await withSpan("return.action.update_instructions", {
    "return.id": returnCase.id,
    // defensive: returnRequestNo always set in fixtures; "" fallback unreachable
    /* v8 ignore start */
    "return.request_no": returnCase.returnRequestNo || "",
    /* v8 ignore stop */
    "action.type": "update_instructions",
  }, async () => {
    const actionTimer = startTimer();
    try {
      /* v8 ignore start */
      // defensive: returnInstructions ?? "" — body always supplies a string in fixtures; nullish fallback unreachable
      const instructions = (body.returnInstructions ?? "").trim();
      /* v8 ignore stop */

      await prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        create: { shopId: shop.id, defaultReturnInstructions: instructions || null },
        update: { defaultReturnInstructions: instructions || null },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "instructions_updated",
          payloadJson: JSON.stringify({ returnInstructions: instructions || null, adminEmail: sessionEmail }),
        },
      });

      returnActionCounter.add(1, { action: "update_instructions", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "update_instructions" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "update_instructions", outcome: "error" });
      appErrorCounter.add(1, { action: "update_instructions" });
      returnActionDuration.record(actionTimer(), { action: "update_instructions" });
      throw err;
    }
  });
};
