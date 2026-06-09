/**
 * Fynd Consolidation Cron Route
 *
 * Called by an external cron job (e.g. Vercel Cron, Railway, cron-job.org) every hour.
 * Processes all shops with fyndConsolidateReturns enabled and sends batched Fynd returns.
 *
 * Security: Protected by CRON_SECRET env var (Bearer token).
 * Configure your cron to call: POST /api/fynd-consolidation-cron
 * with header: Authorization: Bearer <CRON_SECRET>
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authorizeCronRequest } from "../lib/cron-auth.server";
import { runConsolidationForAllShops } from "../lib/fynd-consolidation.server";
import { cronLogger } from "../lib/observability/logger.server";
import { cronJobCounter } from "../lib/observability/metrics.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorizeCronRequest(request)) {
    cronJobCounter.add(1, { job: "fynd_consolidation", outcome: "unauthorized" });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCron();
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!authorizeCronRequest(request)) {
    cronJobCounter.add(1, { job: "fynd_consolidation", outcome: "unauthorized" });
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCron();
};

async function runCron() {
  const startedAt = new Date().toISOString();
  try {
    const results = await runConsolidationForAllShops();
    const totalGroups = results.reduce((s, r) => s + r.groupsProcessed, 0);
    const totalCases = results.reduce((s, r) => s + r.casesUpdated, 0);
    const allErrors = results.flatMap((r) => r.errors);
    cronJobCounter.add(1, {
      job: "fynd_consolidation",
      outcome: allErrors.length > 0 ? "partial_error" : "success",
    });
    return Response.json({
      ok: true,
      startedAt,
      shopsProcessed: results.length,
      totalGroups,
      totalCases,
      errors: allErrors.length > 0 ? allErrors : undefined,
    });
  } catch (err) {
    cronJobCounter.add(1, { job: "fynd_consolidation", outcome: "error" });
    cronLogger.error({ err }, "Fynd consolidation cron failed");
    return Response.json(
      {
        ok: false,
        startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
