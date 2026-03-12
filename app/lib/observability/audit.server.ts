/**
 * Audit Logging — Structured audit trail for admin actions
 *
 * Records who did what to which resource, with before/after change tracking.
 * Audit logs are separate from application logs — they use a dedicated
 * pino child logger with `audit: true` for easy filtering.
 */

import logger from "./logger.server";
import { trace, context } from "@opentelemetry/api";

const auditLogger = logger.child({ audit: true });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditActor {
  type: "admin" | "system" | "api_key" | "portal_customer";
  identity: string;
}

export interface AuditResource {
  type: string; // e.g., "ReturnCase", "ShopSettings", "WebhookSubscription"
  id: string;
}

export interface AuditChange {
  from: unknown;
  to: unknown;
}

export interface AuditLogParams {
  action: string;
  actor: AuditActor;
  resource: AuditResource;
  shopDomain: string;
  changes?: Record<string, AuditChange>;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Audit log function
// ---------------------------------------------------------------------------

/**
 * Record an audit log entry.
 *
 * @example
 * auditLog({
 *   action: "return.approved",
 *   actor: { type: "admin", identity: "shop-owner" },
 *   resource: { type: "ReturnCase", id: "clxyz123" },
 *   shopDomain: "store.myshopify.com",
 *   changes: { status: { from: "pending", to: "approved" } },
 * });
 */
export function auditLog(params: AuditLogParams): void {
  const span = trace.getSpan(context.active());

  auditLogger.info(
    {
      audit_action: params.action,
      actor_type: params.actor.type,
      actor_identity: params.actor.identity,
      resource_type: params.resource.type,
      resource_id: params.resource.id,
      shop_domain: params.shopDomain,
      changes: params.changes,
      trace_id: span?.spanContext().traceId,
      ...params.metadata,
    },
    `AUDIT: ${params.action} on ${params.resource.type}/${params.resource.id} by ${params.actor.type}:${params.actor.identity}`,
  );

  // Also annotate the active span for correlation
  if (span) {
    span.setAttribute("audit.action", params.action);
    span.setAttribute("audit.actor_type", params.actor.type);
    span.setAttribute("audit.resource_type", params.resource.type);
    span.setAttribute("audit.resource_id", params.resource.id);
  }
}

// ---------------------------------------------------------------------------
// Pre-built audit helpers for common actions
// ---------------------------------------------------------------------------

export function auditReturnAction(
  action: string,
  returnId: string,
  shopDomain: string,
  actor: AuditActor,
  changes?: Record<string, AuditChange>,
  metadata?: Record<string, unknown>,
): void {
  auditLog({
    action: `return.${action}`,
    actor,
    resource: { type: "ReturnCase", id: returnId },
    shopDomain,
    changes,
    metadata,
  });
}

export function auditSettingsChange(
  settingName: string,
  shopDomain: string,
  actor: AuditActor,
  changes: Record<string, AuditChange>,
): void {
  auditLog({
    action: `settings.${settingName}`,
    actor,
    resource: { type: "ShopSettings", id: shopDomain },
    shopDomain,
    changes,
  });
}
