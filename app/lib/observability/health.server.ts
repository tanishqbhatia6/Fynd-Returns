/**
 * Health Check Utilities — Dependency health verification
 *
 * Provides individual health checks for DB, Fynd API, and SMTP
 * with timeout guards and structured status reporting.
 */

import prisma from "../../db.server";
import { healthCheckDuration } from "./metrics.server";
import { getAllCircuitBreakerStatuses } from "./resilience.server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  status: "ok" | "degraded" | "error";
  latencyMs: number;
  message?: string;
}

export interface ReadinessResult {
  status: "ok" | "degraded";
  checks: Record<string, HealthCheckResult>;
  circuitBreakers: ReturnType<typeof getAllCircuitBreakerStatuses>;
  version: string;
  uptime: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} health check timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

/**
 * Check database connectivity via a simple query.
 */
export async function checkDatabase(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    await withTimeout(
      prisma.$queryRaw`SELECT 1` as Promise<unknown>,
      3000,
      "database",
    );
    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "database" });
    return { status: "ok", latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "database" });
    return {
      status: "error",
      latencyMs,
      message: err instanceof Error ? err.message : "Database check failed",
    };
  }
}

/**
 * Check Fynd API reachability with a lightweight request.
 * Does NOT consume OAuth tokens — just checks if the endpoint responds.
 */
export async function checkFyndApi(): Promise<HealthCheckResult> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://api.fynd.com", {
      method: "HEAD",
      signal: controller.signal,
    });
    void res; // suppress unused-var; we only care that it resolved

    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "fynd_api" });

    // Any response (even 4xx) means the service is reachable
    return { status: "ok", latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "fynd_api" });
    return {
      status: "degraded",
      latencyMs,
      message: err instanceof Error ? err.message : "Fynd API unreachable",
    };
  } finally {
    // Always clear the timer so a thrown fetch doesn't leave it queued
    // for ~5s doing nothing.
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Composite health check
// ---------------------------------------------------------------------------

/**
 * Run all readiness checks and return composite result.
 */
export async function runReadinessChecks(): Promise<ReadinessResult> {
  const [database, fyndApi] = await Promise.allSettled([
    checkDatabase(),
    checkFyndApi(),
  ]);

  const checks: Record<string, HealthCheckResult> = {
    database:
      database.status === "fulfilled"
        ? database.value
        : { status: "error", latencyMs: 0, message: String(database.reason) },
    fynd_api:
      fyndApi.status === "fulfilled"
        ? fyndApi.value
        : { status: "degraded", latencyMs: 0, message: String(fyndApi.reason) },
  };

  const allHealthy = Object.values(checks).every((c) => c.status === "ok");

  return {
    status: allHealthy ? "ok" : "degraded",
    checks,
    circuitBreakers: getAllCircuitBreakerStatuses(),
    version: process.env.BUILD_VERSION || "dev",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}
