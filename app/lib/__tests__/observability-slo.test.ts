/**
 * Tests for observability/slo.server.ts: SLO definitions, burn-rate math,
 * error-budget accounting, and the OpenTelemetry span annotation helper.
 * Alerting and dashboards consume these attributes — a regression here
 * silently degrades incident response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @opentelemetry/api so we can inspect setAttribute calls without
// standing up a real tracer provider.
const mockSetAttribute = vi.fn();
const mockGetSpan = vi.fn();

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getSpan: (...args: unknown[]) => mockGetSpan(...args),
  },
  context: {
    active: () => ({}),
  },
}));

import {
  SLO_DEFINITIONS,
  calculateBurnRate,
  errorBudgetRemaining,
  annotateSLO,
  getSLO,
} from "../observability/slo.server";

beforeEach(() => {
  mockSetAttribute.mockReset();
  mockGetSpan.mockReset();
});

describe("SLO_DEFINITIONS", () => {
  it("contains the expected named SLOs with sane targets", () => {
    const names = SLO_DEFINITIONS.map((s) => s.name);
    expect(names).toContain("api_latency_p99");
    expect(names).toContain("api_error_rate");
    expect(names).toContain("fynd_sync_success");
    expect(names).toContain("webhook_delivery");
    expect(names).toContain("refund_processing");

    for (const slo of SLO_DEFINITIONS) {
      expect(slo.target).toBeGreaterThan(0);
      expect(slo.target).toBeLessThanOrEqual(1);
      expect(slo.windowSeconds).toBeGreaterThan(0);
      expect(typeof slo.description).toBe("string");
    }
  });
});

describe("calculateBurnRate", () => {
  it("returns 0 when total is 0 (no traffic, no burn)", () => {
    expect(calculateBurnRate(0, 0, 0.99)).toBe(0);
  });

  it("returns 1.0 when actual error rate equals allowed error rate", () => {
    // target=0.99 → allowed=0.01; 10/1000 = 0.01 → burn = 1.0
    expect(calculateBurnRate(10, 1000, 0.99)).toBeCloseTo(1.0, 5);
  });

  it("returns >1 when burning faster than sustainable", () => {
    // target=0.999 → allowed=0.001; 10/1000 = 0.01 → burn = 10
    expect(calculateBurnRate(10, 1000, 0.999)).toBeCloseTo(10, 5);
  });

  it("returns <1 when burning slower than sustainable", () => {
    // target=0.99 → allowed=0.01; 1/1000 = 0.001 → burn = 0.1
    expect(calculateBurnRate(1, 1000, 0.99)).toBeCloseTo(0.1, 5);
  });

  it("returns Infinity when target is 100% and any errors occur", () => {
    expect(calculateBurnRate(1, 1000, 1.0)).toBe(Infinity);
  });

  it("returns 0 when target is 100% and no errors occur", () => {
    expect(calculateBurnRate(0, 1000, 1.0)).toBe(0);
  });
});

describe("errorBudgetRemaining", () => {
  it("returns 100% when total is 0 (no traffic, full budget)", () => {
    expect(errorBudgetRemaining(0, 0, 0.99)).toBe(100);
  });

  it("returns 100% when no errors have occurred", () => {
    // target=0.99 over 1000 → allowed=10 errors; 0 used → 100% remaining
    expect(errorBudgetRemaining(0, 1000, 0.99)).toBe(100);
  });

  it("returns 0% when the budget is exhausted", () => {
    // allowed=10 errors; 10 used → 0% remaining
    expect(errorBudgetRemaining(10, 1000, 0.99)).toBe(0);
  });

  it("returns 0% (clamped) when errors exceed the allowed budget", () => {
    expect(errorBudgetRemaining(50, 1000, 0.99)).toBe(0);
  });

  it("returns 50% when half the budget is consumed", () => {
    // allowed=10; 5 used → 5/10 = 50%
    expect(errorBudgetRemaining(5, 1000, 0.99)).toBe(50);
  });

  it("returns 0 when allowedErrors floors to 0 and any errors occurred", () => {
    // target=0.999, total=100 → allowed=floor(100*0.001)=0
    expect(errorBudgetRemaining(1, 100, 0.999)).toBe(0);
    expect(errorBudgetRemaining(0, 100, 0.999)).toBe(100);
  });
});

describe("getSLO", () => {
  it("returns the matching definition by name", () => {
    const slo = getSLO("api_latency_p99");
    expect(slo).toBeDefined();
    expect(slo?.indicator).toBe("latency_p99");
    expect(slo?.threshold).toBe(500);
  });

  it("returns undefined for an unknown name", () => {
    expect(getSLO("nope_does_not_exist")).toBeUndefined();
  });
});

describe("annotateSLO", () => {
  it("is a no-op when there is no active span", () => {
    mockGetSpan.mockReturnValue(undefined);
    annotateSLO("api_latency_p99", { breached: true, durationMs: 600 });
    expect(mockSetAttribute).not.toHaveBeenCalled();
  });

  it("is a no-op when the SLO name is unknown", () => {
    mockGetSpan.mockReturnValue({ setAttribute: mockSetAttribute });
    annotateSLO("not_a_real_slo", { breached: true });
    expect(mockSetAttribute).not.toHaveBeenCalled();
  });

  it("sets slo.name + slo.target and threshold when defined", () => {
    mockGetSpan.mockReturnValue({ setAttribute: mockSetAttribute });
    annotateSLO("api_latency_p99", { breached: false, durationMs: 120 });

    const calls = Object.fromEntries(mockSetAttribute.mock.calls);
    expect(calls["slo.name"]).toBe("api_latency_p99");
    expect(calls["slo.target"]).toBe(0.99);
    expect(calls["slo.target_ms"]).toBe(500);
    expect(calls["slo.breached"]).toBe(false);
    expect(calls["slo.duration_ms"]).toBe(120);
  });

  it("omits slo.target_ms when the SLO has no threshold", () => {
    mockGetSpan.mockReturnValue({ setAttribute: mockSetAttribute });
    annotateSLO("api_error_rate", { breached: true });

    const keys = mockSetAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain("slo.name");
    expect(keys).toContain("slo.target");
    expect(keys).toContain("slo.breached");
    expect(keys).not.toContain("slo.target_ms");
    expect(keys).not.toContain("slo.duration_ms");
  });

  it("omits breached/duration when not provided", () => {
    mockGetSpan.mockReturnValue({ setAttribute: mockSetAttribute });
    annotateSLO("api_latency_p99", {});

    const keys = mockSetAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain("slo.name");
    expect(keys).toContain("slo.target");
    expect(keys).toContain("slo.target_ms");
    expect(keys).not.toContain("slo.breached");
    expect(keys).not.toContain("slo.duration_ms");
  });
});
