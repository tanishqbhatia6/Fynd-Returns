/**
 * Structured Error Classification System
 *
 * Provides a hierarchy of typed errors with:
 * - Operational vs Programmer error classification
 * - Error fingerprinting for deduplication
 * - OTel span attribute conversion
 * - Structured log context extraction
 */

import crypto from "crypto";
import type { Attributes } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Base Error Classes
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly isOperational: boolean;
  abstract readonly service: string;

  /** Computed fingerprint for error deduplication (same class + service + code + pattern) */
  get fingerprint(): string {
    const raw = `${this.constructor.name}:${this.service}:${this.getFingerPrintSuffix()}`;
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  protected abstract getFingerPrintSuffix(): string;

  /** Convert to OTel span attributes */
  toSpanAttributes(): Attributes {
    return {
      "error.class": this.constructor.name,
      "error.operational": this.isOperational,
      "error.service": this.service,
      "error.fingerprint": this.fingerprint,
      "error.message": this.message,
    };
  }

  /** Convert to structured log context */
  toLogContext(): Record<string, unknown> {
    return {
      errorClass: this.constructor.name,
      isOperational: this.isOperational,
      service: this.service,
      fingerprint: this.fingerprint,
      message: this.message,
      stack: this.stack,
    };
  }
}

// ---------------------------------------------------------------------------
// Operational Errors (expected, recoverable)
// ---------------------------------------------------------------------------

export class FyndApiError extends AppError {
  readonly isOperational = true;
  readonly service = "fynd";

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
    public readonly fyndErrorCode?: string,
  ) {
    super(message);
    this.name = "FyndApiError";
  }

  protected getFingerPrintSuffix(): string {
    const pattern = this.endpoint.replace(/\/[a-z0-9]{20,}/gi, "/:id");
    return `${this.statusCode}:${pattern}`;
  }

  toSpanAttributes(): Attributes {
    return {
      ...super.toSpanAttributes(),
      "fynd.status_code": this.statusCode,
      "fynd.endpoint": this.endpoint,
      ...(this.fyndErrorCode ? { "fynd.error_code": this.fyndErrorCode } : {}),
    };
  }
}

export class ShopifyApiError extends AppError {
  readonly isOperational = true;
  readonly service = "shopify";

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly query: string,
  ) {
    super(message);
    this.name = "ShopifyApiError";
  }

  protected getFingerPrintSuffix(): string {
    const queryName = this.query.match(/(?:mutation|query)\s+(\w+)/)?.[1] ?? "unknown";
    return `${this.statusCode}:${queryName}`;
  }

  toSpanAttributes(): Attributes {
    return {
      ...super.toSpanAttributes(),
      "shopify.status_code": this.statusCode,
      "shopify.query": this.query.slice(0, 200),
    };
  }
}

export class WebhookDeliveryError extends AppError {
  readonly isOperational = true;
  readonly service = "webhook";

  constructor(
    message: string,
    public readonly url: string,
    public readonly attempts: number,
    public readonly lastStatusCode?: number,
  ) {
    super(message);
    this.name = "WebhookDeliveryError";
  }

  protected getFingerPrintSuffix(): string {
    const host = (() => {
      try { return new URL(this.url).host; } catch { return "unknown"; }
    })();
    return `${host}:${this.lastStatusCode ?? "timeout"}`;
  }

  toSpanAttributes(): Attributes {
    return {
      ...super.toSpanAttributes(),
      "webhook.url": this.url,
      "webhook.attempts": this.attempts,
      ...(this.lastStatusCode ? { "webhook.last_status_code": this.lastStatusCode } : {}),
    };
  }
}

export class RateLimitError extends AppError {
  readonly isOperational = true;
  readonly service = "rate_limiter";

  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }

  protected getFingerPrintSuffix(): string {
    return this.endpoint;
  }
}

export class AuthenticationError extends AppError {
  readonly isOperational = true;
  readonly service = "auth";

  constructor(
    message: string,
    public readonly authType: "admin" | "portal_jwt" | "api_key" | "fynd_webhook",
    public readonly reason: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }

  protected getFingerPrintSuffix(): string {
    return `${this.authType}:${this.reason}`;
  }

  toSpanAttributes(): Attributes {
    return {
      ...super.toSpanAttributes(),
      "auth.type": this.authType,
      "auth.failure_reason": this.reason,
    };
  }
}

export class ValidationError extends AppError {
  readonly isOperational = true;
  readonly service = "validation";

  constructor(
    message: string,
    public readonly field: string,
    public readonly constraint: string,
    public readonly value?: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }

  protected getFingerPrintSuffix(): string {
    return `${this.field}:${this.constraint}`;
  }
}

export class ExternalTimeoutError extends AppError {
  readonly isOperational = true;
  readonly service: string;

  constructor(
    message: string,
    service: string,
    public readonly timeoutMs: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = "ExternalTimeoutError";
    this.service = service;
  }

  protected getFingerPrintSuffix(): string {
    const pattern = this.endpoint.replace(/\/[a-z0-9]{20,}/gi, "/:id");
    return `${this.timeoutMs}:${pattern}`;
  }

  toSpanAttributes(): Attributes {
    return {
      ...super.toSpanAttributes(),
      "timeout.ms": this.timeoutMs,
      "timeout.endpoint": this.endpoint,
    };
  }
}

// ---------------------------------------------------------------------------
// Programmer Errors (unexpected, bugs)
// ---------------------------------------------------------------------------

export class ConfigurationError extends AppError {
  readonly isOperational = false;
  readonly service = "config";

  constructor(
    message: string,
    public readonly missingKey: string,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }

  protected getFingerPrintSuffix(): string {
    return this.missingKey;
  }
}

export class InvariantViolation extends AppError {
  readonly isOperational = false;
  readonly service = "invariant";

  constructor(
    message: string,
    public readonly assertion: string,
  ) {
    super(message);
    this.name = "InvariantViolation";
  }

  protected getFingerPrintSuffix(): string {
    return this.assertion;
  }
}

// ---------------------------------------------------------------------------
// Utility: classify unknown errors
// ---------------------------------------------------------------------------

export function isOperationalError(err: unknown): boolean {
  if (err instanceof AppError) return err.isOperational;
  return false;
}

export function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  return null;
}
