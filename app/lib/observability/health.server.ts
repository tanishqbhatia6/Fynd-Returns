/**
 * Health Check Utilities — Dependency health verification
 *
 * Provides individual health checks for DB, Fynd API, and SMTP
 * with timeout guards and structured status reporting.
 */

import prisma from "../../db.server";
import { getRedis } from "../redis.server";
import { healthCheckDuration, redisHealthStatus } from "./metrics.server";
import { getAllCircuitBreakerStatuses } from "./resilience.server";

let redisHealthValue = 0;
redisHealthStatus.addCallback((obs) => obs.observe(redisHealthValue));

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
      setTimeout(
        () => reject(new Error(`${label} health check timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Check database connectivity via a simple query.
 */
export async function checkDatabase(): Promise<HealthCheckResult> {
  const start = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1` as Promise<unknown>, 3000, "database");
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
 * Check Redis connectivity. Production readiness is degraded if Redis is not
 * configured or not reachable because rate limiting must be fleet-wide.
 */
export async function checkRedis(): Promise<HealthCheckResult> {
  const start = performance.now();
  const configured = Boolean(process.env.REDIS_URL?.trim());
  if (!configured) {
    const latencyMs = Math.round(performance.now() - start);
    redisHealthValue = 0;
    if (process.env.NODE_ENV === "production") {
      return { status: "error", latencyMs, message: "REDIS_URL is required in production" };
    }
    return { status: "ok", latencyMs, message: "Redis disabled outside production" };
  }

  const redis = getRedis();
  if (!redis) {
    const latencyMs = Math.round(performance.now() - start);
    redisHealthValue = 0;
    return { status: "error", latencyMs, message: "Redis client unavailable" };
  }

  try {
    await withTimeout(redis.ping(), 3000, "redis");
    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "redis" });
    redisHealthValue = 1;
    return { status: "ok", latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    healthCheckDuration.record(latencyMs, { dependency: "redis" });
    redisHealthValue = 0;
    return {
      status: "error",
      latencyMs,
      message: err instanceof Error ? err.message : "Redis check failed",
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
  const [database, redis, fyndApi] = await Promise.allSettled([
    checkDatabase(),
    checkRedis(),
    checkFyndApi(),
  ]);

  const checks: Record<string, HealthCheckResult> = {
    database:
      database.status === "fulfilled"
        ? database.value
        : { status: "error", latencyMs: 0, message: String(database.reason) },
    redis:
      redis.status === "fulfilled"
        ? redis.value
        : { status: "error", latencyMs: 0, message: String(redis.reason) },
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
