/**
 * Request Context — Request ID generation and W3C Baggage propagation
 *
 * Provides correlation IDs and contextual metadata that flows through
 * logs, traces, and metrics for unified observability.
 */

import crypto from "crypto";
import { trace, context, propagation, type Span } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Request ID generation
// ---------------------------------------------------------------------------

/**
 * Extract or generate a request ID from the incoming request.
 * Checks standard headers in priority order, falls back to crypto.randomUUID().
 */
export function getRequestId(request: Request): string {
  return (
    request.headers.get("x-request-id") ||
    request.headers.get("x-amzn-trace-id") ||
    crypto.randomUUID()
  );
}

/**
 * Set the request ID on the active span and baggage.
 * Call early in request handling (after auth).
 */
export function setRequestContext(
  request: Request,
  extra?: {
    shopDomain?: string;
    shopId?: string;
    userType?: "admin" | "portal_customer" | "api_key" | "system";
    returnId?: string;
    returnRequestNo?: string;
  },
): string {
  const requestId = getRequestId(request);
  const span = trace.getSpan(context.active());

  if (span) {
    span.setAttribute("request.id", requestId);

    if (extra?.shopDomain) span.setAttribute("shop.domain", extra.shopDomain);
    if (extra?.shopId) span.setAttribute("shop.id", extra.shopId);
    if (extra?.userType) span.setAttribute("user.type", extra.userType);
    if (extra?.returnId) span.setAttribute("return.id", extra.returnId);
    if (extra?.returnRequestNo) span.setAttribute("return.request_no", extra.returnRequestNo);
  }

  // Set baggage for propagation across services
  let baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  baggage = baggage.setEntry("request.id", { value: requestId });
  if (extra?.shopDomain) baggage = baggage.setEntry("shop.domain", { value: extra.shopDomain });
  if (extra?.shopId) baggage = baggage.setEntry("shop.id", { value: extra.shopId });
  if (extra?.userType) baggage = baggage.setEntry("user.type", { value: extra.userType });
  if (extra?.returnId) baggage = baggage.setEntry("return.id", { value: extra.returnId });

  propagation.setBaggage(context.active(), baggage);

  return requestId;
}

/**
 * Get a value from the current context baggage.
 */
export function getContextValue(key: string): string | undefined {
  const baggage = propagation.getBaggage(context.active());
  return baggage?.getEntry(key)?.value;
}

/**
 * Create response headers with correlation data.
 * Add these to outgoing responses for client-side correlation.
 */
export function getCorrelationHeaders(requestId: string): Record<string, string> {
  const span = trace.getSpan(context.active());
  const headers: Record<string, string> = {
    "X-Request-Id": requestId,
  };
  if (span) {
    headers["X-Trace-Id"] = span.spanContext().traceId;
  }
  return headers;
}

/**
 * Hash an IP address for privacy-preserving logging/metrics.
 * Returns first 8 chars of SHA-256 hash.
 */
export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

/**
 * Extract source IP from request headers (handles proxies).
 */
export function getSourceIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}
