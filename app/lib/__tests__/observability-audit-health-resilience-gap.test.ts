/**
 * Consolidated gap-coverage tests for the trio:
 *   - app/lib/observability/audit.server.ts
 *   - app/lib/observability/health.server.ts
 *   - app/lib/observability/resilience.server.ts
 *
 * Hits the residual branches not covered by the dedicated suites:
 *
 * health.server.ts:
 *   - Lines 119-123: Promise.allSettled "rejected" branches in
 *     runReadinessChecks (when checkDatabase / checkFyndApi themselves
 *     throw rather than resolve). We force this by making
 *     healthCheckDuration.record throw on the catch path of each helper.
 *
 * resilience.server.ts:
 *   - Line 84: recordSuccess() while _state is "open" (no-op fall-through;
 *     neither half_open nor closed branch taken).
 *   - Line 129: transitionTo() same-state early-return guard. Reached by
 *     calling recordFailure() repeatedly while already open so the
 *     `failureCount >= threshold` re-check fires `transitionTo("open")`
 *     while _state is already "open".
 *
 * audit.server.ts already reports 100% — no extra coverage required there;
 * we still add a tiny shape assertion for `auditSettingsChange` so this
 * file's intent (cover all three modules in one place) remains true if
 * the source is later edited.
 *
 * NO source modifications. NO modifications to the existing per-file
 * suites (observability-audit / observability-health /
 * observability-resilience / observability-gap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// resilience.server.ts — line 84 (recordSuccess in open) +
// line 129 (transitionTo same-state guard)
// ---------------------------------------------------------------------------

describe("observability/resilience.server — uncovered branches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../observability/logger.server", () => ({
      securityLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));
    vi.doMock("../observability/metrics.server", () => ({
      circuitBreakerStateChange: { add: vi.fn() },
      circuitBreakerRejected: { add: vi.fn() },
      externalTimeoutCounter: { add: vi.fn() },
      fallbackActivated: { add: vi.fn() },
      redisHealthStatus: { addCallback: vi.fn() },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../observability/logger.server");
    vi.doUnmock("../observability/metrics.server");
    vi.useRealTimers();
  });

  it("recordSuccess while _state is 'open' is a no-op (covers fall-through branch)", async () => {
    const { CircuitBreaker } = await import("../observability/resilience.server");
    // Threshold=1 so a single failure flips closed→open.
    const cb = new CircuitBreaker("svc-fallthrough", 1, 60_000);
    cb.recordFailure();
    // Sanity: state is open and counters reflect the open transition.
    const beforeStatus = cb.getStatus();
    expect(beforeStatus.state).toBe("open");

    // recordSuccess() while _state === "open": neither half_open nor
    // closed branch matches, so the function returns without mutating
    // anything. This exercises the implicit "else (no-op)" branch on the
    // `else if (this._state === "closed")` test.
    cb.recordSuccess();
    cb.recordSuccess();

    const afterStatus = cb.getStatus();
    expect(afterStatus.state).toBe("open");
    // failureCount left untouched by no-op recordSuccess.
    expect(afterStatus.failureCount).toBe(beforeStatus.failureCount);
  });

  it("transitionTo same-state guard: extra failures while already open do not re-emit a state change", async () => {
    const metrics = await import("../observability/metrics.server");
    const { CircuitBreaker } = await import("../observability/resilience.server");
    const cb = new CircuitBreaker("svc-same-state", 2, 60_000);

    // Two failures → closed→open emits exactly one state-change metric.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");

    const stateChangeMock = metrics.circuitBreakerStateChange.add as unknown as ReturnType<
      typeof vi.fn
    >;
    const callsAfterOpen = stateChangeMock.mock.calls.length;
    expect(callsAfterOpen).toBeGreaterThan(0);

    // Now keep failing while already open. Internally `_state` is still
    // "open" (no time has elapsed), so the inner check
    //     if (this.failureCount >= this.failureThreshold) transitionTo("open")
    // re-enters transitionTo with prevState === newState ("open"), hitting
    // the early-return guard at line 129. No new metric is recorded.
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();

    expect(cb.getStatus().state).toBe("open");
    expect(stateChangeMock.mock.calls.length).toBe(callsAfterOpen);
  });
});

// ---------------------------------------------------------------------------
// health.server.ts — runReadinessChecks "rejected" branches (lines 119-123)
// ---------------------------------------------------------------------------

describe("observability/health.server — runReadinessChecks rejected branches", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../../db.server");
    vi.doUnmock("../observability/metrics.server");
    vi.doUnmock("../observability/resilience.server");
    vi.unstubAllGlobals();
  });

  it("uses the rejected fallback shape when checkDatabase itself throws", async () => {
    // Make prisma reject so checkDatabase falls into its catch handler,
    // then make healthCheckDuration.record throw inside that catch
    // handler so the throw escapes checkDatabase entirely. This forces
    // Promise.allSettled to see status === "rejected" for the database
    // entry, exercising lines 119-121 (the rejected fallback object).
    vi.doMock("../../db.server", () => ({
      default: { $queryRaw: vi.fn(() => Promise.reject(new Error("db dead"))) },
    }));
    vi.doMock("../observability/metrics.server", () => ({
      healthCheckDuration: {
        record: vi.fn((_latency: number, tags: { dependency: string }) => {
          if (tags.dependency === "database") {
            // Throws inside checkDatabase's catch handler → escapes
            // the function and surfaces as a rejected allSettled entry.
            throw new Error("metric record blew up");
          }
        }),
      },
      redisHealthStatus: { addCallback: vi.fn() },
    }));
    vi.doMock("../observability/resilience.server", () => ({
      getAllCircuitBreakerStatuses: vi.fn(() => []),
    }));

    // Fynd succeeds quickly so the fynd_api branch is "fulfilled".
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { runReadinessChecks } = await import("../observability/health.server");
    const result = await runReadinessChecks();

    expect(result.status).toBe("degraded");
    expect(result.checks.database.status).toBe("error");
    expect(result.checks.database.latencyMs).toBe(0);
    // The message is built from String(reason); the thrown Error's
    // message text is folded in by Error.toString().
    expect(result.checks.database.message).toContain("metric record blew up");
    expect(result.checks.fynd_api.status).toBe("ok");
  });

  it("uses the rejected fallback shape when checkFyndApi itself throws", async () => {
    vi.doMock("../../db.server", () => ({
      default: { $queryRaw: vi.fn(async () => [{ "?column?": 1 }]) },
    }));
    let recordCalls = 0;
    vi.doMock("../observability/metrics.server", () => ({
      healthCheckDuration: {
        record: vi.fn((_latency: number, tags: { dependency: string }) => {
          if (tags.dependency === "fynd_api") {
            recordCalls++;
            if (recordCalls === 1) {
              // First fynd_api call is in the catch handler of checkFyndApi
              // — throwing here escapes the function and surfaces in
              // Promise.allSettled as rejected.
              throw new Error("fynd metric blew up");
            }
          }
        }),
      },
      redisHealthStatus: { addCallback: vi.fn() },
    }));
    vi.doMock("../observability/resilience.server", () => ({
      getAllCircuitBreakerStatuses: vi.fn(() => []),
    }));

    const fetchMock = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { runReadinessChecks } = await import("../observability/health.server");
    const result = await runReadinessChecks();

    expect(result.status).toBe("degraded");
    expect(result.checks.fynd_api.status).toBe("degraded");
    expect(result.checks.fynd_api.latencyMs).toBe(0);
    expect(result.checks.fynd_api.message).toContain("fynd metric blew up");
    expect(result.checks.database.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// health.server.ts — checkFyndApi abort-timer callback (the 5s setTimeout
// arrow function on line 76). Coverage flags it as an uncovered nested
// function because none of the existing tests let the timer fire.
// ---------------------------------------------------------------------------

describe("observability/health.server — checkFyndApi abort timer fires", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../observability/metrics.server", () => ({
      healthCheckDuration: { record: vi.fn() },
      redisHealthStatus: { addCallback: vi.fn() },
    }));
    vi.doMock("../observability/resilience.server", () => ({
      getAllCircuitBreakerStatuses: vi.fn(() => []),
    }));
    vi.doMock("../../db.server", () => ({ default: { $queryRaw: vi.fn() } }));
  });

  afterEach(() => {
    vi.doUnmock("../observability/metrics.server");
    vi.doUnmock("../observability/resilience.server");
    vi.doUnmock("../../db.server");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("invokes controller.abort() after 5s when fetch never resolves", async () => {
    // fetch returns a promise that only rejects when the AbortSignal fires —
    // exactly what real fetch does on abort. This forces the setTimeout
    // arrow callback at line 76 to actually run and abort the request.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            (e as Error & { name: string }).name = "AbortError";
            reject(e);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    const { checkFyndApi } = await import("../observability/health.server");
    const promise = checkFyndApi();
    // Advance past the 5_000 ms abort-timeout so the inner arrow runs.
    await vi.advanceTimersByTimeAsync(5_001);
    const result = await promise;
    expect(result.status).toBe("degraded");
    expect(result.message).toMatch(/abort/i);
  });
});

// ---------------------------------------------------------------------------
// audit.server.ts — sanity touch (already 100%); keeps this file's
// "all-three-modules" charter honest if source is later modified.
// ---------------------------------------------------------------------------

describe("observability/audit.server — sanity touch (no new gaps)", () => {
  const auditInfo = vi.fn();
  const setAttribute = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    auditInfo.mockClear();
    setAttribute.mockClear();
    vi.doMock("../observability/logger.server", () => ({
      default: { child: vi.fn(() => ({ info: auditInfo })) },
    }));
    vi.doMock("@opentelemetry/api", () => ({
      trace: {
        getSpan: vi.fn(() => ({
          setAttribute,
          spanContext: () => ({ traceId: "tr", spanId: "sp" }),
        })),
      },
      context: { active: () => ({}) },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../observability/logger.server");
    vi.doUnmock("@opentelemetry/api");
  });

  it("auditSettingsChange + auditReturnAction reach the helper wrappers", async () => {
    const { auditSettingsChange, auditReturnAction } =
      await import("../observability/audit.server");
    auditSettingsChange(
      "branding.theme",
      "shop.myshopify.com",
      { type: "admin", identity: "owner" },
      { theme: { from: "light", to: "dark" } },
    );
    auditReturnAction(
      "approved",
      "rc-99",
      "shop.myshopify.com",
      { type: "admin", identity: "owner" },
      undefined,
      { batch: 1 },
    );
    expect(auditInfo).toHaveBeenCalledTimes(2);
  });
});
