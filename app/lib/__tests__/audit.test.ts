import { describe, it, expect, vi, beforeEach } from "vitest";

const { auditInfoMock, setAttributeMock, getSpanMock } = vi.hoisted(() => {
  const auditInfo = vi.fn();
  const setAttribute = vi.fn();
  const getSpan = vi.fn(() => ({ setAttribute, spanContext: () => ({ traceId: "t1" }) }));
  return { auditInfoMock: auditInfo, setAttributeMock: setAttribute, getSpanMock: getSpan };
});

vi.mock("../observability/logger.server", () => ({
  // default export: something with .child({ audit: true }) → return fake audit logger
  default: { child: vi.fn(() => ({ info: auditInfoMock })) },
}));

vi.mock("@opentelemetry/api", () => ({
  trace: { getSpan: getSpanMock },
  context: { active: () => ({}) },
}));

import { auditLog, auditReturnAction, auditSettingsChange } from "../observability/audit.server";

beforeEach(() => {
  auditInfoMock.mockClear();
  setAttributeMock.mockClear();
  getSpanMock.mockClear();
  getSpanMock.mockReturnValue({ setAttribute: setAttributeMock, spanContext: () => ({ traceId: "t1" }) });
});

describe("auditLog", () => {
  it("emits a structured info log with audit fields", () => {
    auditLog({
      action: "return.approved",
      actor: { type: "admin", identity: "owner@shop.com" },
      resource: { type: "ReturnCase", id: "r-1" },
      shopDomain: "store.myshopify.com",
    });

    expect(auditInfoMock).toHaveBeenCalledTimes(1);
    const [payload, message] = auditInfoMock.mock.calls[0];
    expect(payload).toMatchObject({
      audit_action: "return.approved",
      actor_type: "admin",
      actor_identity: "owner@shop.com",
      resource_type: "ReturnCase",
      resource_id: "r-1",
      shop_domain: "store.myshopify.com",
      trace_id: "t1",
    });
    expect(message).toContain("AUDIT: return.approved on ReturnCase/r-1 by admin:owner@shop.com");
  });

  it("includes changes and metadata in the payload", () => {
    auditLog({
      action: "return.status_change",
      actor: { type: "system", identity: "cron" },
      resource: { type: "ReturnCase", id: "r-2" },
      shopDomain: "s.myshopify.com",
      changes: { status: { from: "pending", to: "approved" } },
      metadata: { reason: "automated" },
    });
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.changes).toEqual({ status: { from: "pending", to: "approved" } });
    expect(payload.reason).toBe("automated");
  });

  it("annotates the active span with audit attributes", () => {
    auditLog({
      action: "webhook.subscribed",
      actor: { type: "api_key", identity: "key-1" },
      resource: { type: "WebhookSubscription", id: "sub-1" },
      shopDomain: "s.myshopify.com",
    });
    const names = setAttributeMock.mock.calls.map(c => c[0]);
    expect(names).toEqual(expect.arrayContaining([
      "audit.action", "audit.actor_type", "audit.resource_type", "audit.resource_id",
    ]));
  });

  it("works with no active span (no span annotation path)", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() =>
      auditLog({
        action: "settings.updated",
        actor: { type: "admin", identity: "u" },
        resource: { type: "ShopSettings", id: "s" },
        shopDomain: "s.myshopify.com",
      }),
    ).not.toThrow();
    expect(auditInfoMock).toHaveBeenCalled();
    expect(setAttributeMock).not.toHaveBeenCalled();
  });
});

describe("auditReturnAction", () => {
  it("prefixes action with 'return.' and sets resource=ReturnCase", () => {
    auditReturnAction(
      "refunded",
      "rc-99",
      "s.myshopify.com",
      { type: "admin", identity: "u" },
      { refund_status: { from: null, to: "issued" } },
      { amountCents: 4200 },
    );
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.audit_action).toBe("return.refunded");
    expect(payload.resource_type).toBe("ReturnCase");
    expect(payload.resource_id).toBe("rc-99");
    expect(payload.changes).toEqual({ refund_status: { from: null, to: "issued" } });
    expect(payload.amountCents).toBe(4200);
  });
});

describe("auditSettingsChange", () => {
  it("prefixes with 'settings.' + uses shopDomain as resource id", () => {
    auditSettingsChange(
      "notifications_enabled",
      "store.myshopify.com",
      { type: "admin", identity: "owner" },
      { emailEnabled: { from: false, to: true } },
    );
    const [payload] = auditInfoMock.mock.calls[0];
    expect(payload.audit_action).toBe("settings.notifications_enabled");
    expect(payload.resource_type).toBe("ShopSettings");
    expect(payload.resource_id).toBe("store.myshopify.com");
    expect(payload.changes.emailEnabled.to).toBe(true);
  });
});
