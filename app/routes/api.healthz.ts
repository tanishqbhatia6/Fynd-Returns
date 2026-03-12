/**
 * Liveness Probe — /api/healthz
 *
 * Simple check: is the process alive and can it serve HTTP?
 * Returns 200 with basic status info. No dependency checks.
 * Suitable for Kubernetes/Docker liveness probes.
 */

import type { LoaderFunctionArgs } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  return Response.json({
    status: "ok",
    uptime: process.uptime(),
    version: process.env.BUILD_VERSION || "dev",
    timestamp: new Date().toISOString(),
  });
}
