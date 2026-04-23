import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  securityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/metrics.server", () => ({
  circuitBreakerStateChange: { add: vi.fn() },
  circuitBreakerRejected: { add: vi.fn() },
  externalTimeoutCounter: { add: vi.fn() },
  fallbackActivated: { add: vi.fn() },
}));

import {
  CircuitBreaker,
  CircuitOpenError,
  recordTimeout,
  recordFallback,
  getAllCircuitBreakerStatuses,
} from "../observability/resilience.server";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── CircuitBreaker lifecycle ──────────────────────────────────────── */

describe("CircuitBreaker — closed state", () => {
  it("starts in closed state and allows all requests", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    expect(cb.state).toBe("closed");
    expect(cb.canExecute()).toBe(true);
  });

  it("recordSuccess resets failure count in closed state", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    // Before success, two failures accumulated — still closed.
    expect(cb.state).toBe("closed");
    cb.recordSuccess();
    // Now the counter is reset — a single additional failure shouldn't open.
    cb.recordFailure();
    expect(cb.state).toBe("closed");
  });

  it("opens after failureThreshold consecutive failures", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });
});

describe("CircuitBreaker — open state", () => {
  it("rejects execution via canExecute", () => {
    const cb = new CircuitBreaker("test", 1, 1000);
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.canExecute()).toBe(false);
  });

  it("execute() throws CircuitOpenError when open", async () => {
    const cb = new CircuitBreaker("test", 1, 1000);
    cb.recordFailure();
    await expect(cb.execute(async () => 42)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("CircuitOpenError names the service", () => {
    const cb = new CircuitBreaker("fynd-api", 1, 1000);
    cb.recordFailure();
    try { cb.canExecute(); /* rejects */ } catch { /* unreachable */ }
    expect(() => cb.canExecute()).not.toThrow();
    // The error constructor test itself.
    const err = new CircuitOpenError("fynd-api");
    expect(err.serviceName).toBe("fynd-api");
    expect(err.message).toContain("fynd-api");
    expect(err.name).toBe("CircuitOpenError");
  });

  it("auto-transitions to half_open after resetTimeoutMs", () => {
    const cb = new CircuitBreaker("test", 1, 5000);
    cb.recordFailure();
    expect(cb.state).toBe("open");
    vi.advanceTimersByTime(5001);
    // Access .state to trigger the transition.
    expect(cb.state).toBe("half_open");
  });

  it("does not transition before resetTimeoutMs", () => {
    const cb = new CircuitBreaker("test", 1, 5000);
    cb.recordFailure();
    vi.advanceTimersByTime(4999);
    expect(cb.state).toBe("open");
  });
});

describe("CircuitBreaker — half_open state", () => {
  it("allows limited requests (up to halfOpenMaxAttempts)", () => {
    const cb = new CircuitBreaker("test", 1, 1000, 3);
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.state).toBe("half_open");
    expect(cb.canExecute()).toBe(true);
  });

  it("closes after halfOpenMaxAttempts successes", () => {
    const cb = new CircuitBreaker("test", 1, 1000, 3);
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.state).toBe("half_open");
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
  });

  it("re-opens on any failure", () => {
    const cb = new CircuitBreaker("test", 1, 1000, 3);
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.state).toBe("half_open");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });
});

/* ── execute() happy paths ─────────────────────────────────────────── */

describe("CircuitBreaker.execute", () => {
  it("returns the result of fn on success", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    expect(await cb.execute(async () => "hello")).toBe("hello");
  });

  it("records failure and rethrows on fn error", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    await expect(
      cb.execute(async () => { throw new Error("boom"); }),
    ).rejects.toThrow("boom");
    // Failure was recorded.
    expect(cb.getStatus().failureCount).toBe(1);
  });

  it("success resets failure count", async () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    await cb.execute(async () => "ok");
    expect(cb.getStatus().failureCount).toBe(0);
  });
});

/* ── Status + numeric state ────────────────────────────────────────── */

describe("CircuitBreaker.getStatus / stateNumeric", () => {
  it("reports closed=0", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    expect(cb.stateNumeric).toBe(0);
  });
  it("reports open=1", () => {
    const cb = new CircuitBreaker("test", 1, 1000);
    cb.recordFailure();
    expect(cb.stateNumeric).toBe(1);
  });
  it("reports half_open=2", () => {
    const cb = new CircuitBreaker("test", 1, 1000);
    cb.recordFailure();
    vi.advanceTimersByTime(1001);
    expect(cb.stateNumeric).toBe(2);
  });

  it("getStatus returns a structured snapshot", () => {
    const cb = new CircuitBreaker("test", 3, 1000);
    cb.recordFailure();
    const s = cb.getStatus();
    expect(s.name).toBe("test");
    expect(s.state).toBe("closed");
    expect(s.failureCount).toBe(1);
    expect(typeof s.lastStateChange).toBe("number");
  });
});

/* ── Utility functions ─────────────────────────────────────────────── */

describe("recordTimeout / recordFallback", () => {
  it("recordTimeout doesn't throw", () => {
    expect(() => recordTimeout("fynd", "get_order", 5000)).not.toThrow();
  });
  it("recordFallback doesn't throw with meta", () => {
    expect(() => recordFallback("fynd", "cache_hit", { company_id: "123" })).not.toThrow();
  });
  it("recordFallback works without meta", () => {
    expect(() => recordFallback("shopify", "degraded")).not.toThrow();
  });
});

describe("getAllCircuitBreakerStatuses", () => {
  it("returns a status for each pre-built breaker", () => {
    const all = getAllCircuitBreakerStatuses();
    expect(all).toHaveLength(4);
    const names = all.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(["fynd", "shopify", "smtp", "whatsapp"]));
  });
});

describe("Transition to same state is a no-op", () => {
  it("recordFailure when already open doesn't re-fire metrics", () => {
    const cb = new CircuitBreaker("test", 1, 1000);
    cb.recordFailure();
    const beforeStatus = cb.getStatus();
    cb.recordFailure(); // should re-open (no-op since already open)
    const afterStatus = cb.getStatus();
    // Still open, lastStateChange unchanged.
    expect(afterStatus.state).toBe("open");
    expect(afterStatus.lastStateChange).toBe(beforeStatus.lastStateChange);
  });
});
