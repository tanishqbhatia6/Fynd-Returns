import { describe, it, expect, vi } from "vitest";

// OTel tracing helpers — just stub them so annotateSLO can set attributes
// on a fake span. We expose getSpanMock so tests can override per-case
// (e.g. return undefined to simulate "no active span").
const { setAttributeMock, getSpanMock } = vi.hoisted(() => {
  const setAttribute = vi.fn();
  const getSpan = vi.fn(() => ({ setAttribute }));
  return { setAttributeMock: setAttribute, getSpanMock: getSpan };
});

vi.mock("@opentelemetry/api", () => ({
  trace: { getSpan: getSpanMock },
  context: { active: () => ({}) },
}));

import {
  SLO_DEFINITIONS,
  calculateBurnRate,
  errorBudgetRemaining,
  annotateSLO,
  getSLO,
} from "../observability/slo.server";

describe("SLO_DEFINITIONS", () => {
  it("covers the five core SLOs", () => {
    const names = SLO_DEFINITIONS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "api_latency_p99",
        "api_error_rate",
        "fynd_sync_success",
        "webhook_delivery",
        "refund_processing",
      ]),
    );
  });

  it("each SLO has a sensible shape", () => {
    for (const slo of SLO_DEFINITIONS) {
      expect(slo.name).toMatch(/^[a-z0-9_]+$/);
      expect(slo.target).toBeGreaterThan(0);
      expect(slo.target).toBeLessThanOrEqual(1);
      expect(slo.windowSeconds).toBeGreaterThan(0);
      expect(["latency_p99", "error_rate", "availability"]).toContain(slo.indicator);
      expect(slo.description.length).toBeGreaterThan(10);
    }
  });
});

describe("getSLO", () => {
  it("returns a defined SLO by name", () => {
    expect(getSLO("api_latency_p99")?.threshold).toBe(500);
  });
  it("returns undefined for unknown names", () => {
    expect(getSLO("nonsense")).toBe(undefined);
  });
});

describe("calculateBurnRate", () => {
  it("returns 0 when no events", () => {
    expect(calculateBurnRate(0, 0, 0.99)).toBe(0);
  });

  it("returns ~1.0 when consuming exactly at the sustainable rate", () => {
    // 1% error rate, target 99% → allowed error rate = 1%, actual = 1%.
    // Floating-point rounding makes the exact 1.0 unachievable; assert close.
    expect(calculateBurnRate(10, 1000, 0.99)).toBeCloseTo(1, 5);
  });

  it("returns >1 when burning budget faster than sustainable", () => {
    expect(calculateBurnRate(50, 1000, 0.99)).toBeCloseTo(5, 5);
  });

  it("returns <1 when budget consumption is healthy", () => {
    expect(calculateBurnRate(5, 1000, 0.99)).toBeCloseTo(0.5, 5);
  });

  it("returns Infinity for target=1.0 with any errors (divide-by-zero guard)", () => {
    expect(calculateBurnRate(1, 1000, 1.0)).toBe(Infinity);
  });

  it("returns 0 for target=1.0 with zero errors", () => {
    expect(calculateBurnRate(0, 1000, 1.0)).toBe(0);
  });
});

describe("errorBudgetRemaining", () => {
  it("100% when no events", () => {
    expect(errorBudgetRemaining(0, 0, 0.99)).toBe(100);
  });

  it("100% when no errors consumed", () => {
    expect(errorBudgetRemaining(0, 1000, 0.99)).toBe(100);
  });

  it("0% when all errors exceeded allowance", () => {
    expect(errorBudgetRemaining(100, 1000, 0.99)).toBe(0);
  });

  it("50% when half the budget is consumed", () => {
    // allowed = floor(1000 * 0.01) = 10
    // 5 consumed → 5 remaining of 10 = 50%
    expect(errorBudgetRemaining(5, 1000, 0.99)).toBe(50);
  });

  it("caps at 0 even if errors far exceed allowance", () => {
    expect(errorBudgetRemaining(1000, 1000, 0.99)).toBe(0);
  });

  it("returns 100 when target=1.0 AND zero errors (special case)", () => {
    expect(errorBudgetRemaining(0, 1000, 1.0)).toBe(100);
  });

  it("returns 0 when target=1.0 AND any errors", () => {
    expect(errorBudgetRemaining(1, 1000, 1.0)).toBe(0);
  });
});

describe("annotateSLO", () => {
  it("is a no-op when no active span", () => {
    setAttributeMock.mockClear();
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    annotateSLO("api_latency_p99", { breached: false });
    expect(setAttributeMock).not.toHaveBeenCalled();
  });

  it("is a no-op for unknown SLO names", () => {
    setAttributeMock.mockClear();
    annotateSLO("nonexistent", { breached: true });
    expect(setAttributeMock).not.toHaveBeenCalled();
  });

  it("sets name + target attributes when SLO exists", () => {
    setAttributeMock.mockClear();
    annotateSLO("api_latency_p99", {});
    const calls = setAttributeMock.mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain("slo.name");
    expect(names).toContain("slo.target");
    expect(names).toContain("slo.target_ms"); // threshold=500
  });

  it("sets breached + duration attributes when provided", () => {
    setAttributeMock.mockClear();
    annotateSLO("api_latency_p99", { breached: true, durationMs: 720 });
    const entries = setAttributeMock.mock.calls.map((c) => [c[0], c[1]]);
    expect(entries).toContainEqual(["slo.breached", true]);
    expect(entries).toContainEqual(["slo.duration_ms", 720]);
  });

  it("skips target_ms for SLOs without a threshold", () => {
    setAttributeMock.mockClear();
    // api_error_rate has no threshold
    annotateSLO("api_error_rate", {});
    const names = setAttributeMock.mock.calls.map((c) => c[0]);
    expect(names).not.toContain("slo.target_ms");
  });
});
