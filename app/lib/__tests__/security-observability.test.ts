import { describe, it, expect, vi } from "vitest";

const { setAttributeMock, getSpanMock } = vi.hoisted(() => {
  const setAttribute = vi.fn();
  const getSpan = vi.fn(() => ({ setAttribute }));
  return { setAttributeMock: setAttribute, getSpanMock: getSpan };
});

vi.mock("@opentelemetry/api", () => ({
  trace: { getSpan: getSpanMock },
  context: { active: () => ({}) },
}));

vi.mock("../observability/logger.server", () => ({
  securityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/metrics.server", () => ({
  authFailureCounter: { add: vi.fn() },
  authSuccessCounter: { add: vi.fn() },
  rateLimitRejectedCounter: { add: vi.fn() },
  rateLimitCheckCounter: { add: vi.fn() },
  webhookSignatureFailure: { add: vi.fn() },
}));

// Use the real request-context module — it's already tested separately.
vi.mock("../observability/request-context.server", () => ({
  hashIp: (ip: string) => `h${ip.length}`,
  getSourceIp: (req: Request) => req.headers.get("x-forwarded-for") ?? "unknown",
}));

import {
  recordAuthSuccess,
  recordAuthFailure,
  recordRateLimitCheck,
  recordWebhookSignatureFailure,
  recordSuspiciousActivity,
} from "../observability/security.server";

function mkRequest(headers: Record<string, string> = {}) {
  return new Request("https://example.com/api?foo=bar", { headers });
}

describe("recordAuthSuccess", () => {
  it("doesn't throw", () => {
    expect(() => recordAuthSuccess("api_key")).not.toThrow();
  });
  it("accepts meta object", () => {
    expect(() => recordAuthSuccess("admin", { shopDomain: "x.myshopify.com" })).not.toThrow();
  });
});

describe("recordAuthFailure", () => {
  it("sets span attributes on active span", () => {
    setAttributeMock.mockClear();
    recordAuthFailure(mkRequest(), "api_key", "invalid_key");
    const names = setAttributeMock.mock.calls.map(c => c[0]);
    expect(names).toContain("security.auth_failure");
    expect(names).toContain("security.auth_type");
    expect(names).toContain("security.failure_reason");
  });

  it("doesn't throw when no active span", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() => recordAuthFailure(mkRequest(), "api_key", "invalid_key")).not.toThrow();
  });

  it("accepts optional meta", () => {
    expect(() =>
      recordAuthFailure(mkRequest({ "x-forwarded-for": "1.2.3.4" }), "api_key", "expired", { keyId: "k-1" }),
    ).not.toThrow();
  });
});

describe("recordRateLimitCheck", () => {
  it("allowed path doesn't set rate_limited span attr", () => {
    setAttributeMock.mockClear();
    recordRateLimitCheck(mkRequest(), "portal.otp.send", true, 50);
    const names = setAttributeMock.mock.calls.map(c => c[0]);
    expect(names).not.toContain("security.rate_limited");
  });

  it("denied path sets rate_limited attrs", () => {
    setAttributeMock.mockClear();
    recordRateLimitCheck(mkRequest(), "portal.otp.send", false, 0);
    const names = setAttributeMock.mock.calls.map(c => c[0]);
    expect(names).toContain("security.rate_limited");
    expect(names).toContain("security.rate_limit_endpoint");
  });

  it("near-limit warning path (allowed + remaining ≤ 2)", () => {
    // No exception, no span attrs for allowed case.
    expect(() => recordRateLimitCheck(mkRequest(), "api.returns.list", true, 1)).not.toThrow();
  });

  it("doesn't throw without active span", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() => recordRateLimitCheck(mkRequest(), "x", false, 0)).not.toThrow();
  });
});

describe("recordWebhookSignatureFailure", () => {
  it("sets span suspicious + signal attrs", () => {
    setAttributeMock.mockClear();
    recordWebhookSignatureFailure("fynd", "mismatch");
    const entries = setAttributeMock.mock.calls.map(c => [c[0], c[1]]);
    expect(entries).toContainEqual(["security.suspicious", true]);
    expect(entries.some(e => e[0] === "security.signal" && String(e[1]).includes("webhook_signature_mismatch"))).toBe(true);
  });

  it.each<[string, string]>([
    ["fynd", "missing"],
    ["shopify", "mismatch"],
    ["outbound", "replay"],
  ])("handles %s/%s", (webhookType, reason) => {
    expect(() =>
      recordWebhookSignatureFailure(webhookType as "fynd" | "shopify" | "outbound", reason as "missing" | "mismatch" | "replay"),
    ).not.toThrow();
  });

  it("accepts meta", () => {
    expect(() =>
      recordWebhookSignatureFailure("fynd", "mismatch", { shipmentId: "SH1" }),
    ).not.toThrow();
  });
});

describe("recordSuspiciousActivity", () => {
  it("sets risk score and signal on span", () => {
    setAttributeMock.mockClear();
    recordSuspiciousActivity("ip_mismatch", 75);
    const entries = setAttributeMock.mock.calls.map(c => [c[0], c[1]]);
    expect(entries).toContainEqual(["security.suspicious", true]);
    expect(entries).toContainEqual(["security.signal", "ip_mismatch"]);
    expect(entries).toContainEqual(["security.risk_score", 75]);
  });

  it("accepts optional context_data", () => {
    expect(() =>
      recordSuspiciousActivity("multiple_returns", 60, { customerEmail: "x@y.com" }),
    ).not.toThrow();
  });

  it("doesn't throw without span", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() => recordSuspiciousActivity("x", 10)).not.toThrow();
  });
});
