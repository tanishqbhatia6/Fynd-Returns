/**
 * Comprehensive Metrics Definitions
 *
 * Covers:
 * - RED (Request Rate, Error Rate, Duration)
 * - USE (Utilization, Saturation, Errors)
 * - Business KPIs (returns created, refund amounts, processing times)
 * - Queue/Retry metrics
 * - Security metrics (auth failures, rate limit breaches)
 * - Resilience metrics (circuit breaker, timeouts)
 *
 * Runtime metrics (event loop, GC, memory) are in instrumentation.server.mjs.
 * Custom histogram buckets are tuned for web application latencies.
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("returnpromax.business");

// ═══════════════════════════════════════════════════════════════════════════
// RED Metrics — Request Rate, Error Rate, Duration
// ═══════════════════════════════════════════════════════════════════════════

/** HTTP request counter (supplementary to auto-instrumented metrics) */
export const httpRequestCounter = meter.createCounter("http.server.request.count", {
  description: "Total HTTP requests by route, method, status",
});

/** Return action counter — tracks each admin action */
export const returnActionCounter = meter.createCounter("return.action.count", {
  description: "Return actions by type and outcome",
});

/** Return action duration */
export const returnActionDuration = meter.createHistogram("return.action.duration", {
  description: "Duration of return actions in milliseconds",
  unit: "ms",
  advice: {
    explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
});

/** Fynd API call duration */
export const fyndApiDuration = meter.createHistogram("fynd.api.duration", {
  description: "Duration of Fynd API calls in milliseconds",
  unit: "ms",
  advice: {
    explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
});

/** Shopify API call duration */
export const shopifyApiDuration = meter.createHistogram("shopify.api.duration", {
  description: "Duration of Shopify API calls in milliseconds",
  unit: "ms",
  advice: {
    explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  },
});

/** Fynd sync counter */
export const fyndSyncCounter = meter.createCounter("fynd.sync.count", {
  description: "Fynd sync attempts by outcome",
});

/** App error counter */
export const appErrorCounter = meter.createCounter("app.errors.total", {
  description: "Application errors by class, service, and route",
});

// ═══════════════════════════════════════════════════════════════════════════
// USE Metrics — Utilization, Saturation, Errors (for resources)
// ═══════════════════════════════════════════════════════════════════════════

/** DB connection pool — active connections */
export const dbPoolActive = meter.createObservableGauge("db.pool.connections.active", {
  description: "Active database connections",
});

/** DB connection pool — idle connections */
export const dbPoolIdle = meter.createObservableGauge("db.pool.connections.idle", {
  description: "Idle database connections",
});

/** Rate limiter active key count */
export const rateLimiterKeysActive = meter.createObservableGauge("rate_limiter.keys.active", {
  description: "Number of active rate limiter keys in memory",
});

/** DB query duration histogram */
export const dbQueryDuration = meter.createHistogram("db.query.duration", {
  description: "Database query duration in milliseconds",
  unit: "ms",
  advice: {
    explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Business KPI Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Returns created */
export const returnsCreatedCounter = meter.createCounter("returns.created.total", {
  description: "Returns created by channel",
});

/** Returns approved */
export const returnsApprovedCounter = meter.createCounter("returns.approved.total", {
  description: "Returns approved (auto vs manual)",
});

/** Returns rejected */
export const returnsRejectedCounter = meter.createCounter("returns.rejected.total", {
  description: "Returns rejected",
});

/** Returns completed (resolution type) */
export const returnsCompletedCounter = meter.createCounter("returns.completed.total", {
  description: "Returns completed by resolution type",
});

/** Refund counter */
export const refundCounter = meter.createCounter("refund.count", {
  description: "Refunds processed by method and outcome",
});

/** Refund amount histogram */
export const refundAmountHistogram = meter.createHistogram("refund.amount", {
  description: "Refund amounts",
  unit: "1", // currency units
  advice: {
    explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000],
  },
});

/** Refund processing time */
export const refundProcessingTime = meter.createHistogram("refund.processing_time_seconds", {
  description: "Time from approval to refund in seconds",
  unit: "s",
});

/** Pending returns gauge */
export const returnsPendingGauge = meter.createObservableGauge("returns.pending_count", {
  description: "Number of returns in non-terminal states",
});

// ═══════════════════════════════════════════════════════════════════════════
// Queue & Retry Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Fynd retry queue depth */
export const fyndRetryQueueDepth = meter.createObservableGauge("fynd.retry_queue.depth", {
  description: "Items in the Fynd retry queue",
});

/** Fynd retry queue oldest age */
export const fyndRetryQueueOldestAge = meter.createObservableGauge(
  "fynd.retry_queue.oldest_age_seconds",
  { description: "Age of oldest item in Fynd retry queue in seconds" },
);

/** Webhook inflight counter */
export const webhookInflight = meter.createUpDownCounter("webhook.dispatch.inflight", {
  description: "Currently in-flight webhook deliveries",
});

/** Webhook dispatch counter */
export const webhookDispatchCounter = meter.createCounter("webhook.dispatch.count", {
  description: "Outbound webhook dispatches by event type and outcome",
});

/** Webhook delivery attempts */
export const webhookDeliveryAttempts = meter.createCounter("webhook.delivery.attempts", {
  description: "Webhook delivery attempts by outcome",
});

/** Webhook retries exhausted */
export const webhookRetriesExhausted = meter.createCounter("webhook.delivery.retries_exhausted", {
  description: "Webhook deliveries where all retries were exhausted",
});

/** Inbound Fynd webhook counter */
export const fyndWebhookCounter = meter.createCounter("fynd.webhook.count", {
  description: "Inbound Fynd webhooks by event type and outcome",
});

/** Fynd retry exhausted */
export const fyndRetryExhausted = meter.createCounter("fynd.retry.exhausted.total", {
  description: "Fynd sync retries where all attempts were exhausted",
});

/** Fynd retry attempt counter */
export const fyndRetryAttempt = meter.createCounter("fynd.retry.attempt.total", {
  description: "Individual Fynd retry attempts",
});

/** Cron job executions */
export const cronJobCounter = meter.createCounter("cron.job.count", {
  description: "Cron job executions by job name and outcome",
});

// ═══════════════════════════════════════════════════════════════════════════
// Security Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Auth failure counter */
export const authFailureCounter = meter.createCounter("auth.failure.total", {
  description: "Authentication failures by type and reason",
});

/** Auth success counter */
export const authSuccessCounter = meter.createCounter("auth.success.total", {
  description: "Successful authentications by type",
});

/** Rate limit rejection counter */
export const rateLimitRejectedCounter = meter.createCounter("rate_limit.rejected.total", {
  description: "Requests rejected by rate limiter",
});

/** Rate limit check counter */
export const rateLimitCheckCounter = meter.createCounter("rate_limit.check.total", {
  description: "Total rate limit checks by endpoint and result",
});

/** OTP sends and verification attempts */
export const portalOtpCounter = meter.createCounter("portal.otp.count", {
  description: "Portal OTP sends and verification attempts by action and outcome",
});

/** Webhook signature failure counter */
export const webhookSignatureFailure = meter.createCounter("webhook.signature.failure.total", {
  description: "Webhook signature verification failures",
});

// ═══════════════════════════════════════════════════════════════════════════
// Resilience Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Circuit breaker state gauge */
export const circuitBreakerState = meter.createObservableGauge("circuit_breaker.state", {
  description: "Circuit breaker state (0=closed, 1=open, 2=half_open)",
});

/** Circuit breaker state change counter */
export const circuitBreakerStateChange = meter.createCounter("circuit_breaker.state_change.total", {
  description: "Circuit breaker state transitions",
});

/** Circuit breaker rejected requests */
export const circuitBreakerRejected = meter.createCounter("circuit_breaker.rejected.total", {
  description: "Requests rejected by circuit breaker",
});

/** External timeout counter */
export const externalTimeoutCounter = meter.createCounter("external.timeout.total", {
  description: "External API timeouts by service and operation",
});

/** Fallback activation counter */
export const fallbackActivated = meter.createCounter("fallback.activated.total", {
  description: "Fallback paths activated by type",
});

// ═══════════════════════════════════════════════════════════════════════════
// Health check metrics
// ═══════════════════════════════════════════════════════════════════════════

/** Health check duration */
export const healthCheckDuration = meter.createHistogram("health_check.duration", {
  description: "Duration of health check probes in milliseconds",
  unit: "ms",
});

/** Redis health status: 1=ok, 0=unavailable */
export const redisHealthStatus = meter.createObservableGauge("redis.health.status", {
  description: "Redis availability status for readiness and rate limiting",
});

/** Redis operation failures */
export const redisFailureCounter = meter.createCounter("redis.failure.total", {
  description: "Redis operation failures by operation",
});

/** Deploy marker counter — increment once at startup */
export const deployStartedCounter = meter.createCounter("deploy.started.total", {
  description: "Deploy events (incremented once at startup)",
});

// Record deploy event
deployStartedCounter.add(1, {
  version: process.env.BUILD_VERSION || "dev",
  commit: process.env.BUILD_COMMIT || "unknown",
  environment: process.env.NODE_ENV || "development",
});
