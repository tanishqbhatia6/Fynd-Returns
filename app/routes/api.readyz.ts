/**
 * Readiness Probe — /api/readyz
 *
 * Deep health check: verifies database connectivity, Fynd API reachability,
 * and circuit breaker states. Returns 200 if all healthy, 503 if degraded.
 * Suitable for Kubernetes/Docker readiness probes and load balancer health checks.
 */

import type { LoaderFunctionArgs } from "react-router";
import { runReadinessChecks } from "../lib/observability/health.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const result = await runReadinessChecks();

  return Response.json(result, {
    status: result.status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
