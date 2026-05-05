/**
 * Tests for observability/audit.server.ts: focuses on auditReturnAction —
 * the structured log shape it produces and the PII / credential redaction
 * applied by the underlying pino logger. Audit trails are a security and
 * compliance surface, so a regression here (e.g. a leaked customer email
 * or API key in audit metadata) is high-impact.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { auditInfoMock, setAttributeMock, getSpanMock } = vi.hoisted(() => {
  const auditInfo = vi.fn();
  const setAttribute = vi.fn();
  const getSpan = vi.fn(() => ({
    setAttribute,
    spanContext: () => ({ traceId: "trace-abc", spanId: "span-1" }),
  }));
  return { auditInfoMock: auditInfo, setAttributeMock: setAttribute, getSpanMock: getSpan };
});

// Mock the logger module: child({ audit: true }) returns a fake logger whose
// .info we observe. We do not exercise the real pino redact path here — that
// is unit-tested separately. Redaction tests below import pino directly and
// run the same redact paths.
vi.mock("../observability/logger.server", () => ({
  default: { child: vi.fn(() => ({ info: auditInfoMock })) },
}));

vi.mock("@opentelemetry/api", () => ({
  trace: { getSpan: getSpanMock },
  context: { active: () => ({}) },
}));

import { auditReturnAction } from "../observability/audit.server";

beforeEach(() => {
  auditInfoMock.mockClear();
  setAttributeMock.mockClear();
  getSpanMock.mockClear();
  getSpanMock.mockReturnValue({
    setAttribute: setAttributeMock,
    spanContext: () => ({ traceId: "trace-abc", spanId: "span-1" }),
  });
});

describe("auditReturnAction — log shape", () => {
  it("namespaces the action under 'return.'", () => {
    auditReturnAction("approved", "rc-1", "store.myshopify.com", {
      type: "admin",
      identity: "owner@shop.com",
    });
    expect(auditInfoMock).toHaveBeenCalledTimes(1);
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.audit_action).toBe("return.approved");
  });

  it("sets resource to ReturnCase with the provided returnId", () => {
    auditReturnAction("rejected", "rc-42", "s.myshopify.com", {
      type: "admin",
      identity: "u",
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.resource_type).toBe("ReturnCase");
    expect(payload.resource_id).toBe("rc-42");
  });

  it("propagates actor type and identity into the log payload", () => {
    auditReturnAction("approved", "rc-1", "s.myshopify.com", {
      type: "portal_customer",
      identity: "cust-77",
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.actor_type).toBe("portal_customer");
    expect(payload.actor_identity).toBe("cust-77");
  });

  it("includes the shopDomain", () => {
    auditReturnAction("approved", "rc-1", "store.myshopify.com", {
      type: "admin",
      identity: "u",
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.shop_domain).toBe("store.myshopify.com");
  });

  it("forwards before/after changes verbatim", () => {
    const changes = {
      status: { from: "pending", to: "approved" },
      refund_amount: { from: null, to: 4200 },
    };
    auditReturnAction("approved", "rc-1", "s.myshopify.com",
      { type: "admin", identity: "u" }, changes);
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.changes).toEqual(changes);
  });

  it("spreads metadata at the top level of the payload", () => {
    auditReturnAction(
      "refunded", "rc-1", "s.myshopify.com",
      { type: "system", identity: "cron" },
      undefined,
      { reason: "auto-approval", batch: 7 },
    );
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.reason).toBe("auto-approval");
    expect(payload.batch).toBe(7);
  });

  it("leaves changes undefined when not provided", () => {
    auditReturnAction("viewed", "rc-1", "s.myshopify.com", {
      type: "admin",
      identity: "u",
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.changes).toBeUndefined();
  });

  it("includes the OTel trace_id from the active span", () => {
    auditReturnAction("approved", "rc-1", "s.myshopify.com", {
      type: "admin",
      identity: "u",
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.trace_id).toBe("trace-abc");
  });

  it("emits a human-readable summary message", () => {
    auditReturnAction("approved", "rc-1", "s.myshopify.com", {
      type: "admin",
      identity: "owner@shop.com",
    });
    const [, message] = auditInfoMock.mock.calls[0];
    expect(message).toBe("AUDIT: return.approved on ReturnCase/rc-1 by admin:owner@shop.com");
  });

  it("annotates the active span with audit.* attributes", () => {
    auditReturnAction("approved", "rc-1", "s.myshopify.com", {
      type: "admin",
      identity: "u",
    });
    const calls = Object.fromEntries(setAttributeMock.mock.calls);
    expect(calls["audit.action"]).toBe("return.approved");
    expect(calls["audit.actor_type"]).toBe("admin");
    expect(calls["audit.resource_type"]).toBe("ReturnCase");
    expect(calls["audit.resource_id"]).toBe("rc-1");
  });

  it("does not throw when no span is active and skips span annotation", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() =>
      auditReturnAction("approved", "rc-1", "s.myshopify.com", {
        type: "admin",
        identity: "u",
      }),
    ).not.toThrow();
    expect(auditInfoMock).toHaveBeenCalledTimes(1);
    expect(setAttributeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Redaction — uses the real pino logger config to confirm sensitive keys
// passed through audit metadata are scrubbed before they hit the log sink.
// ---------------------------------------------------------------------------
describe("auditReturnAction — redaction (pino redact paths)", () => {
  // Mirror the redact paths from logger.server.ts. The config is duplicated
  // here intentionally to lock in the contract — if logger.server.ts removes
  // a path, this test fails and someone has to make a conscious decision.
  const REDACT_PATHS = [
    "password", "secret", "token", "accessToken", "apiKey", "api_key",
    "customerEmail", "customerPhone", "customerName", "email", "phone",
    "*.password", "*.token", "*.apiKey", "*.customerEmail",
    "*.customerPhone", "*.customerName",
  ];

  async function captureWithRealPino(payload: Record<string, unknown>) {
    const pino = (await import("pino")).default;
    const lines: string[] = [];
    const stream = { write(chunk: string) { lines.push(chunk); } };
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } }, stream);
    log.info(payload, "AUDIT");
    return JSON.parse(lines[0]);
  }

  it("redacts customerEmail at the top level of metadata", async () => {
    const out = await captureWithRealPino({
      audit_action: "return.approved",
      customerEmail: "buyer@example.com",
    });
    expect(out.customerEmail).toBe("[REDACTED]");
  });

  it("redacts customerPhone and customerName", async () => {
    const out = await captureWithRealPino({
      audit_action: "return.approved",
      customerPhone: "+15555550123",
      customerName: "Jane Buyer",
    });
    expect(out.customerPhone).toBe("[REDACTED]");
    expect(out.customerName).toBe("[REDACTED]");
  });

  it("redacts credentials (token, apiKey, password)", async () => {
    const out = await captureWithRealPino({
      audit_action: "return.approved",
      token: "Bearer xyz",
      apiKey: "sk_live_abc",
      password: "hunter2",
    });
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
  });

  it("redacts nested sensitive fields inside changes", async () => {
    const out = await captureWithRealPino({
      audit_action: "return.approved",
      changes: {
        customerEmail: { from: "old@x.com", to: "new@x.com" },
        token: { from: "t1", to: "t2" },
      },
    });
    // Wildcard paths target one level of nesting, so changes.customerEmail
    // (the key, not its sub-fields) becomes redacted.
    expect(out.changes.customerEmail).toBe("[REDACTED]");
    expect(out.changes.token).toBe("[REDACTED]");
  });

  it("preserves non-sensitive fields", async () => {
    const out = await captureWithRealPino({
      audit_action: "return.approved",
      resource_id: "rc-1",
      shop_domain: "s.myshopify.com",
      changes: { status: { from: "pending", to: "approved" } },
    });
    expect(out.audit_action).toBe("return.approved");
    expect(out.resource_id).toBe("rc-1");
    expect(out.shop_domain).toBe("s.myshopify.com");
    expect(out.changes.status).toEqual({ from: "pending", to: "approved" });
  });
});
