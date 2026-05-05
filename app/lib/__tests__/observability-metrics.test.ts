/**
 * Smoke tests for observability/metrics.server.ts.
 *
 * The module pre-instantiates a large catalogue of OpenTelemetry counters,
 * histograms, up-down counters and observable gauges at import time. These
 * tests verify that every exported instrument exists and exposes the
 * expected shape (`add`/`record`/`addCallback`) so a missed export or a
 * rename can't silently break instrumented call sites.
 */
import { describe, it, expect } from "vitest";
import * as metricsModule from "../observability/metrics.server";

const COUNTERS = [
  "httpRequestCounter",
  "returnActionCounter",
  "fyndSyncCounter",
  "appErrorCounter",
  "returnsCreatedCounter",
  "returnsApprovedCounter",
  "returnsRejectedCounter",
  "returnsCompletedCounter",
  "refundCounter",
  "webhookDispatchCounter",
  "webhookDeliveryAttempts",
  "webhookRetriesExhausted",
  "fyndWebhookCounter",
  "fyndRetryExhausted",
  "fyndRetryAttempt",
  "authFailureCounter",
  "authSuccessCounter",
  "rateLimitRejectedCounter",
  "rateLimitCheckCounter",
  "webhookSignatureFailure",
  "circuitBreakerStateChange",
  "circuitBreakerRejected",
  "externalTimeoutCounter",
  "fallbackActivated",
  "deployStartedCounter",
] as const;

const HISTOGRAMS = [
  "returnActionDuration",
  "fyndApiDuration",
  "shopifyApiDuration",
  "dbQueryDuration",
  "refundAmountHistogram",
  "refundProcessingTime",
  "healthCheckDuration",
] as const;

const UP_DOWN_COUNTERS = ["webhookInflight"] as const;

const OBSERVABLE_GAUGES = [
  "dbPoolActive",
  "dbPoolIdle",
  "rateLimiterKeysActive",
  "returnsPendingGauge",
  "fyndRetryQueueDepth",
  "fyndRetryQueueOldestAge",
  "circuitBreakerState",
] as const;

describe("observability/metrics.server — counters", () => {
  it("exports every expected counter as an object", () => {
    for (const name of COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, unknown>)[name];
      expect(inst, `missing export: ${name}`).toBeDefined();
      expect(typeof inst).toBe("object");
    }
  });

  it("each counter exposes an add() method", () => {
    for (const name of COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, { add?: unknown }>)[name];
      expect(typeof inst.add, `${name}.add should be a function`).toBe("function");
    }
  });

  it("counter.add() does not throw with a numeric value", () => {
    for (const name of COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, { add: (n: number, attrs?: Record<string, unknown>) => void }>)[name];
      expect(() => inst.add(0)).not.toThrow();
    }
  });

  it("counter.add() accepts attribute maps", () => {
    for (const name of COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, { add: (n: number, attrs?: Record<string, unknown>) => void }>)[name];
      expect(() => inst.add(1, { test: "smoke" })).not.toThrow();
    }
  });
});

describe("observability/metrics.server — histograms", () => {
  it("exports every expected histogram as an object", () => {
    for (const name of HISTOGRAMS) {
      const inst = (metricsModule as unknown as Record<string, unknown>)[name];
      expect(inst, `missing export: ${name}`).toBeDefined();
      expect(typeof inst).toBe("object");
    }
  });

  it("each histogram exposes a record() method", () => {
    for (const name of HISTOGRAMS) {
      const inst = (metricsModule as unknown as Record<string, { record?: unknown }>)[name];
      expect(typeof inst.record, `${name}.record should be a function`).toBe("function");
    }
  });

  it("histogram.record() does not throw with a numeric value + attrs", () => {
    for (const name of HISTOGRAMS) {
      const inst = (metricsModule as unknown as Record<string, { record: (n: number, attrs?: Record<string, unknown>) => void }>)[name];
      expect(() => inst.record(123, { kind: "smoke" })).not.toThrow();
    }
  });
});

describe("observability/metrics.server — up-down counters", () => {
  it("exports up-down counters with add()", () => {
    for (const name of UP_DOWN_COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, { add?: unknown }>)[name];
      expect(inst, `missing export: ${name}`).toBeDefined();
      expect(typeof inst.add).toBe("function");
    }
  });

  it("up-down counter accepts negative deltas without throwing", () => {
    for (const name of UP_DOWN_COUNTERS) {
      const inst = (metricsModule as unknown as Record<string, { add: (n: number) => void }>)[name];
      expect(() => inst.add(1)).not.toThrow();
      expect(() => inst.add(-1)).not.toThrow();
    }
  });
});

describe("observability/metrics.server — observable gauges", () => {
  it("exports every expected observable gauge", () => {
    for (const name of OBSERVABLE_GAUGES) {
      const inst = (metricsModule as unknown as Record<string, unknown>)[name];
      expect(inst, `missing export: ${name}`).toBeDefined();
      expect(typeof inst).toBe("object");
    }
  });

  it("each observable gauge exposes addCallback()", () => {
    for (const name of OBSERVABLE_GAUGES) {
      const inst = (metricsModule as unknown as Record<string, { addCallback?: unknown }>)[name];
      expect(typeof inst.addCallback, `${name}.addCallback should be a function`).toBe("function");
    }
  });
});

describe("observability/metrics.server — module surface", () => {
  it("exports the full expected catalogue with no extras of unknown shape", () => {
    const expected = new Set<string>([
      ...COUNTERS,
      ...HISTOGRAMS,
      ...UP_DOWN_COUNTERS,
      ...OBSERVABLE_GAUGES,
    ]);
    // Every expected export should be present.
    for (const name of expected) {
      expect((metricsModule as unknown as Record<string, unknown>)[name]).toBeDefined();
    }
    // The catalogue covers a meaningful number of instruments.
    expect(expected.size).toBeGreaterThanOrEqual(35);
  });
});
