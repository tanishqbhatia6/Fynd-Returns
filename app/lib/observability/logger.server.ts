/**
 * Structured Logger — Pino with OTel Trace Correlation
 *
 * Every log entry automatically includes trace_id, span_id, request.id,
 * and shop.domain from the active OTel context.
 *
 * Features:
 * - JSON output in production, pretty-printed in dev
 * - PII and credential redaction
 * - Per-module configurable log levels (LOG_LEVEL_FYND=debug)
 * - Log sampling for high-volume endpoints
 * - Enhanced error serializer for AppError subclasses
 */

import pino from "pino";
import { trace, context, propagation } from "@opentelemetry/api";
import { AppError } from "./errors.server";

// ---------------------------------------------------------------------------
// PII / Credential redaction paths
// ---------------------------------------------------------------------------
const REDACT_PATHS = [
  // Credentials / secrets
  "password",
  "secret",
  "token",
  "accessToken",
  "access_token",
  "clientSecret",
  "client_secret",
  "apiKey",
  "api_key",
  "smtpPass",
  "smtpUser",
  "whatsappApiKey",
  "gorgiasApiKey",
  "keyHash",
  "otp",
  "otpTarget",
  "applicationToken",
  "fyndCredentials",
  "portalToken",
  "*.password",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.access_token",
  "*.clientSecret",
  "*.client_secret",
  "*.apiKey",
  "*.api_key",
  "*.smtpPass",
  "*.otp",
  "*.otpTarget",
  "*.portalToken",
  "*.whatsappApiKey",
  "*.gorgiasApiKey",
  // Customer PII (P3 finding from QA audit) — log lines previously included raw
  // customer email/phone/name in error contexts. Redacted by default; if the
  // ops team needs PII for debugging, raise log level on a specific span.
  "customerEmail",
  "customerEmailNorm",
  "customerPhone",
  "customerPhoneNorm",
  "customerName",
  "email",
  "phone",
  "*.customerEmail",
  "*.customerEmailNorm",
  "*.customerPhone",
  "*.customerPhoneNorm",
  "*.customerName",
  // HTTP headers / cookies
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "req.headers.cookie",
];

// ---------------------------------------------------------------------------
// Log sampling for high-volume endpoints
// ---------------------------------------------------------------------------
const LOG_SAMPLE_RATES: Record<string, number> = {
  "portal.lookup": 0.1,
  "portal.otp.send": 0.5,
  health_check: 0.01,
};

export function shouldSampleLog(module: string): boolean {
  const rate = LOG_SAMPLE_RATES[module];
  if (rate === undefined) return true;
  return Math.random() < rate;
}

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------
const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};

    const ctx = span.spanContext();
    const baggage = propagation.getBaggage(context.active());

    return {
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
      trace_flags: ctx.traceFlags,
      ...(baggage?.getEntry("request.id")
        ? { "request.id": baggage.getEntry("request.id")!.value }
        : {}),
      ...(baggage?.getEntry("shop.domain")
        ? { "shop.domain": baggage.getEntry("shop.domain")!.value }
        : {}),
      ...(baggage?.getEntry("shop.id") ? { "shop.id": baggage.getEntry("shop.id")!.value } : {}),
    };
  },
  serializers: {
    err(err: unknown) {
      const serialized = pino.stdSerializers.err(err as Error);
      if (err instanceof AppError) {
        return {
          ...serialized,
          isOperational: err.isOperational,
          errorClass: err.constructor.name,
          service: err.service,
          fingerprint: err.fingerprint,
          ...err.toLogContext(),
        };
      }
      return serialized;
    },
    req(req: { method?: string; url?: string; headers?: Record<string, string> }) {
      return {
        method: req.method,
        url: req.url?.split("?")[0], // strip query params for privacy
        headers: { "user-agent": req.headers?.["user-agent"] },
      };
    },
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

export default logger;

// ---------------------------------------------------------------------------
// Module-specific child loggers
// ---------------------------------------------------------------------------

/**
 * Create a child logger for a specific module with optional env-var level override.
 * Set LOG_LEVEL_FYND=debug to override the fynd module's log level.
 */
export function createModuleLogger(module: string) {
  const envKey = `LOG_LEVEL_${module.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const moduleLevel = process.env[envKey] || undefined;
  return logger.child({ module }, moduleLevel ? { level: moduleLevel } : {});
}

/** Fynd integration logger */
export const fyndLogger = createModuleLogger("fynd");

/** Outbound webhook dispatch logger */
export const webhookLogger = createModuleLogger("webhook");

/** Refund processing logger */
export const refundLogger = createModuleLogger("refund");

/** Customer portal logger */
export const portalLogger = createModuleLogger("portal");

/** Notification (email/whatsapp) logger */
export const notifLogger = createModuleLogger("notification");

/** Database/Prisma logger */
export const prismaLogger = createModuleLogger("prisma");

/** Security/auth logger */
export const securityLogger = createModuleLogger("security");

/** General app logger */
export const appLogger = createModuleLogger("app");
