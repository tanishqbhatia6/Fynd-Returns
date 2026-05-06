/**
 * Tests for observability/resilience.server.ts: circuit breaker state machine
 * (closed → open → half_open → closed), error threshold handling, the
 * execute() wrapper, and pre-built breaker registry. These tests exercise the
 * state transitions which protect external dependencies (Fynd / Shopify /
 * SMTP / WhatsApp) from cascading failure.
 */
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
  fyndCircuitBreaker,
  shopifyCircuitBreaker,
  smtpCircuitBreaker,
  whatsappCircuitBreaker,
  getAllCircuitBreakerStatuses,
  recordTimeout,
  recordFallback,
} from "../observability/resilience.server";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/* ── Closed state + threshold ──────────────────────────────────────── */

describe("CircuitBreaker — closed state behaviour", () => {
  it("starts closed with stateNumeric=0 and zero failures", () => {
    const cb = new CircuitBreaker("svc", 5, 30_000);
    const s = cb.getStatus();
    expect(s.state).toBe("closed");
    expect(s.stateNumeric).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(cb.canExecute()).toBe(true);
  });

  it("does NOT open while failures stay strictly below threshold", () => {
    const cb = new CircuitBreaker("svc", 4, 30_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    expect(cb.getStatus().failureCount).toBe(3);
  });

  it("opens precisely on the Nth failure where N=threshold", () => {
    const cb = new CircuitBreaker("svc", 3, 30_000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure(); // Nth — should flip to open.
    expect(cb.state).toBe("open");
    expect(cb.stateNumeric).toBe(1);
  });

  it("recordSuccess in closed state zeroes the failure count", () => {
    const cb = new CircuitBreaker("svc", 3, 30_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getStatus().failureCount).toBe(0);
    // Confirmed by needing a fresh threshold-many failures to open.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });
});

/* ── Open state + auto-recovery timer ──────────────────────────────── */

describe("CircuitBreaker — open state and reset timer", () => {
  it("blocks canExecute() while open", () => {
    const cb = new CircuitBreaker("svc", 1, 10_000);
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.canExecute()).toBe(false);
  });

  it("execute() rejects with CircuitOpenError carrying the service name", async () => {
    const cb = new CircuitBreaker("payments", 1, 10_000);
    cb.recordFailure();
    await expect(cb.execute(async () => "never")).rejects.toMatchObject({
      name: "CircuitOpenError",
      serviceName: "payments",
    });
  });

  it("does NOT auto-transition before resetTimeoutMs has elapsed", () => {
    const cb = new CircuitBreaker("svc", 1, 5_000);
    cb.recordFailure();
    vi.advanceTimersByTime(4_999);
    expect(cb.state).toBe("open");
  });

  it("auto-transitions to half_open once resetTimeoutMs has elapsed", () => {
    const cb = new CircuitBreaker("svc", 1, 5_000);
    cb.recordFailure();
    vi.advanceTimersByTime(5_001);
    expect(cb.state).toBe("half_open");
    expect(cb.stateNumeric).toBe(2);
  });
});

/* ── Half-open probing ─────────────────────────────────────────────── */

describe("CircuitBreaker — half_open probing", () => {
  it("permits up to halfOpenMaxAttempts probe requests", () => {
    const cb = new CircuitBreaker("svc", 1, 1_000, 2);
    cb.recordFailure();
    vi.advanceTimersByTime(1_001);
    expect(cb.state).toBe("half_open");
    // Two probes allowed; record the successes one-by-one.
    expect(cb.canExecute()).toBe(true);
    cb.recordSuccess();
    expect(cb.canExecute()).toBe(true);
    cb.recordSuccess();
    // After hitting the threshold the breaker closes — back to unconditional yes.
    expect(cb.state).toBe("closed");
  });

  it("re-opens immediately on a single failure during half_open", () => {
    const cb = new CircuitBreaker("svc", 1, 1_000, 3);
    cb.recordFailure();
    vi.advanceTimersByTime(1_001);
    expect(cb.state).toBe("half_open");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  it("closing from half_open clears failure and success counters", () => {
    const cb = new CircuitBreaker("svc", 1, 1_000, 2);
    cb.recordFailure();
    vi.advanceTimersByTime(1_001);
    // Access .state to drive the open → half_open auto-transition before
    // recording probe successes — recordSuccess only counts in half_open.
    expect(cb.state).toBe("half_open");
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.getStatus().failureCount).toBe(0);
  });
});

/* ── execute() integration ─────────────────────────────────────────── */

describe("CircuitBreaker.execute()", () => {
  it("returns the resolved value on success", async () => {
    const cb = new CircuitBreaker("svc", 3, 10_000);
    await expect(cb.execute(async () => ({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("propagates the underlying error and records a failure", async () => {
    const cb = new CircuitBreaker("svc", 5, 10_000);
    await expect(
      cb.execute(async () => {
        throw new Error("upstream-fail");
      }),
    ).rejects.toThrow("upstream-fail");
    expect(cb.getStatus().failureCount).toBe(1);
  });

  it("CircuitOpenError extends Error with the documented message format", () => {
    const err = new CircuitOpenError("inventory");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CircuitOpenError");
    expect(err.message).toContain("inventory");
    expect(err.message).toContain("open");
  });
});

/* ── Pre-built breakers + utilities ────────────────────────────────── */

describe("Pre-built breakers and helpers", () => {
  it("getAllCircuitBreakerStatuses lists exactly the four built-in services", () => {
    const all = getAllCircuitBreakerStatuses();
    const names = all.map((s) => s.name).sort();
    expect(names).toEqual(["fynd", "shopify", "smtp", "whatsapp"]);
  });

  it("each pre-built breaker exposes a name matching its registry entry", () => {
    expect(fyndCircuitBreaker.name).toBe("fynd");
    expect(shopifyCircuitBreaker.name).toBe("shopify");
    expect(smtpCircuitBreaker.name).toBe("smtp");
    expect(whatsappCircuitBreaker.name).toBe("whatsapp");
  });

  it("recordTimeout and recordFallback are side-effect-only and never throw", () => {
    expect(() => recordTimeout("fynd", "fetch_order", 8_000)).not.toThrow();
    expect(() => recordFallback("shopify", "cache", { reason: "timeout" })).not.toThrow();
    expect(() => recordFallback("smtp", "queue")).not.toThrow();
  });
});
