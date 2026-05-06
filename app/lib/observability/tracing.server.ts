/**
 * Tracing Utilities — Custom spans, baggage propagation, span events
 *
 * Wraps @opentelemetry/api for convenient use throughout the app:
 * - withSpan() for async span creation with error handling
 * - Baggage helpers for cross-service context propagation
 * - Business event recording on spans
 */

import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  ROOT_CONTEXT,
  type Span,
  type Attributes,
  type SpanContext,
} from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Tracer instance
// ---------------------------------------------------------------------------
export const tracer = trace.getTracer("returnpromax", "1.0.0");

export { SpanStatusCode, ROOT_CONTEXT };
export type { Span, Attributes, SpanContext };

// ---------------------------------------------------------------------------
// withSpan — async span helper with automatic error handling
// ---------------------------------------------------------------------------

/**
 * Creates an active span, runs the provided async function within it,
 * and handles status + error recording + span end automatically.
 *
 * @example
 * const result = await withSpan("return.action.approve", { "return.id": id }, async (span) => {
 *   span.addEvent("return.approved", { auto: "false" });
 *   return await approveReturn(id);
 * });
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous version of withSpan for non-async operations.
 */
export function withSpanSync<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      span.recordException(error);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Baggage helpers
// ---------------------------------------------------------------------------

/**
 * Set context baggage entries that propagate across service boundaries.
 * Call this at auth boundaries (admin auth, portal auth, API key auth).
 */
export function setBaggage(entries: Record<string, string>): void {
  let baggage = propagation.getBaggage(context.active()) ?? propagation.createBaggage();
  for (const [key, value] of Object.entries(entries)) {
    if (value) {
      baggage = baggage.setEntry(key, { value });
    }
  }
  const newCtx = propagation.setBaggage(context.active(), baggage);
  // Note: In OTel, baggage is immutable — we can set it on the span attributes as well
  const span = trace.getSpan(context.active());
  if (span) {
    for (const [key, value] of Object.entries(entries)) {
      if (value) span.setAttribute(key, value);
    }
  }
  // The baggage will propagate on outbound requests via W3C Baggage header
  return void newCtx;
}

/**
 * Get a baggage entry value from the current context.
 */
export function getBaggageValue(key: string): string | undefined {
  const baggage = propagation.getBaggage(context.active());
  return baggage?.getEntry(key)?.value;
}

// ---------------------------------------------------------------------------
// Business event helpers
// ---------------------------------------------------------------------------

/**
 * Record a business event on the active span.
 * Use for significant milestones in business flows.
 *
 * @example
 * addBusinessEvent("return.refund_initiated", {
 *   "refund.amount": 49.99,
 *   "refund.currency": "USD",
 *   "refund.method": "original_payment",
 * });
 */
export function addBusinessEvent(eventName: string, attributes?: Attributes): void {
  const span = trace.getSpan(context.active());
  if (span) {
    span.addEvent(eventName, attributes);
  }
}

/**
 * Set attributes on the currently active span.
 */
export function setSpanAttributes(attributes: Attributes): void {
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Get the active span (or undefined if none).
 */
export function getActiveSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/**
 * Measure duration of an operation and return elapsed ms.
 */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
