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
import { runConsolidationForAllShops } from "../lib/fynd-consolidation.server";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // If no secret configured, only allow from localhost (dev mode)
    const host = request.headers.get("host") ?? "";
    return host.includes("localhost") || host.includes("127.0.0.1");
  }
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "GET" && isAuthorized(request)) {
    return runCron();
  }
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorized(request)) {
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
    return Response.json({
      ok: true,
      startedAt,
      shopsProcessed: results.length,
      totalGroups,
      totalCases,
      errors: allErrors.length > 0 ? allErrors : undefined,
    });
  } catch (err) {
    console.error("[FyndConsolidationCron] Fatal error:", err);
    return Response.json({
      ok: false,
      startedAt,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
