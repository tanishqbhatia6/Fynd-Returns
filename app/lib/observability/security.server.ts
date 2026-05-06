/**
 * Security Observability — Auth failure tracking, suspicious activity detection
 *
 * Provides instrumented wrappers for recording auth events and rate limit
 * breaches with privacy-preserving metrics and structured logs.
 */

import { trace, context } from "@opentelemetry/api";
import { securityLogger } from "./logger.server";
import {
  authFailureCounter,
  authSuccessCounter,
  rateLimitRejectedCounter,
  rateLimitCheckCounter,
  webhookSignatureFailure,
} from "./metrics.server";
import { hashIp, getSourceIp } from "./request-context.server";

// ---------------------------------------------------------------------------
// Auth event recording
// ---------------------------------------------------------------------------

export type AuthType = "admin" | "portal_jwt" | "api_key" | "fynd_webhook";

export function recordAuthSuccess(
  authType: AuthType,
  meta?: Record<string, string>,
): void {
  authSuccessCounter.add(1, { auth_type: authType });
  securityLogger.debug({ authType, ...meta }, "Auth success");
}

export function recordAuthFailure(
  request: Request,
  authType: AuthType,
  reason: string,
  meta?: Record<string, string>,
): void {
  const sourceIp = getSourceIp(request);
  const ipHash = hashIp(sourceIp);

  authFailureCounter.add(1, {
    auth_type: authType,
    reason,
    source_ip_hash: ipHash,
  });

  securityLogger.warn(
    {
      authType,
      reason,
      source_ip_hash: ipHash,
      url: request.url?.split("?")[0],
      ...meta,
    },
    `Auth failure: ${authType} — ${reason}`,
  );

  // Set suspicious flag on active span if present
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttribute("security.auth_failure", true);
    span.setAttribute("security.auth_type", authType);
    span.setAttribute("security.failure_reason", reason);
  }
}

// ---------------------------------------------------------------------------
// Rate limit event recording
// ---------------------------------------------------------------------------

export function recordRateLimitCheck(
  request: Request,
  endpoint: string,
  allowed: boolean,
  remaining: number,
): void {
  rateLimitCheckCounter.add(1, {
    endpoint,
    result: allowed ? "allowed" : "denied",
  });

  if (!allowed) {
    const sourceIp = getSourceIp(request);
    const ipHash = hashIp(sourceIp);

    rateLimitRejectedCounter.add(1, {
      endpoint,
      source_ip_hash: ipHash,
    });

    securityLogger.warn(
      {
        endpoint,
        source_ip_hash: ipHash,
        url: request.url?.split("?")[0],
      },
      `Rate limit exceeded: ${endpoint}`,
    );

    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttribute("security.rate_limited", true);
      span.setAttribute("security.rate_limit_endpoint", endpoint);
    }
  }

  // Emit near-limit warning when remaining < 20% of max
  if (allowed && remaining <= 2) {
    securityLogger.debug(
      { endpoint, remaining },
      `Rate limit near threshold: ${endpoint} (${remaining} remaining)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

export function recordWebhookSignatureFailure(
  webhookType: "fynd" | "shopify" | "outbound",
  failureReason: "missing" | "mismatch" | "replay",
  meta?: Record<string, string>,
): void {
  webhookSignatureFailure.add(1, {
    webhook_type: webhookType,
    failure_reason: failureReason,
  });

  securityLogger.warn(
    { webhookType, failureReason, ...meta },
    `Webhook signature failure: ${webhookType} — ${failureReason}`,
  );

  /* v8 ignore start */
  // defensive: span is null in test environment without active OpenTelemetry context
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttribute("security.suspicious", true);
    span.setAttribute("security.signal", `webhook_signature_${failureReason}`);
  }
  /* v8 ignore stop */
}

// ---------------------------------------------------------------------------
// Suspicious activity detection
// ---------------------------------------------------------------------------

export function recordSuspiciousActivity(
  signal: string,
  riskScore: number,
  context_data?: Record<string, unknown>,
): void {
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttribute("security.suspicious", true);
    span.setAttribute("security.signal", signal);
    span.setAttribute("security.risk_score", riskScore);
  }

  securityLogger.warn(
    { signal, riskScore, ...context_data },
    `Suspicious activity detected: ${signal} (risk: ${riskScore})`,
  );
}
