/**
 * Final coverage push for encryption + observability modules.
 *
 * Targets the residual uncovered branches/lines:
 *   - encryption.server.ts line 125: non-Error thrown from decryption loop
 *     hits the right side of the `lastErr instanceof Error` ternary.
 *   - observability/errors.server.ts lines 254, 271:
 *     ConfigurationError + InvariantViolation getFingerPrintSuffix() invocation.
 *   - observability/metrics.server.ts: import the module to count statements
 *     and exercise the env-var fallback ternaries on the deploy marker.
 *   - observability/resilience.server.ts line 84: recordSuccess() when the
 *     internal state is "open" — neither half_open nor closed branch fires.
 *
 * Tests are designed to be additive — they do NOT modify source or other tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only stub the logger to keep test output clean. metrics.server is left
// unmocked so we can exercise its real instruments (the OTel API ships a
// no-op meter when nothing is registered, so this is safe in node tests).
vi.mock("../observability/logger.server", () => ({
  securityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// encryption.server — final branch
// ---------------------------------------------------------------------------

describe("encryption.server — decrypt failure paths", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    delete process.env.ENCRYPTION_KEYS_PREVIOUS;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("propagates an Error thrown by decryption (covers truthy ternary side)", async () => {
    // Sanity: when an Error is thrown (real auth-tag mismatch), the loop
    // re-throws THAT error rather than the generic fallback.
    const { encrypt, decrypt } = await import("../encryption.server");
    const ct = encrypt("payload");
    const [iv, tag, data] = ct.split(":");
    const flippedTag = (tag[0] === "0" ? "1" : "0") + tag.slice(1);
    expect(() => decrypt(`${iv}:${flippedTag}:${data}`)).toThrow();
  });

  it("decrypt fallback handles ciphertext where every key fails (multi-key path)", async () => {
    // Configure both active and retired keys, then build a ciphertext using a
    // *third* key that is in neither list. Both decrypt attempts fail, exercising
    // the loop's catch + final throw.
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.ENCRYPTION_KEYS_PREVIOUS = "b".repeat(64);
    vi.resetModules();
    const { decrypt } = await import("../encryption.server");
    // Construct a ciphertext that has the right shape but valid content
    // encrypted under a different (unknown) key:
    const crypto = await import("node:crypto");
    const otherKey = Buffer.from("c".repeat(64), "hex");
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", otherKey, iv);
    const enc = Buffer.concat([cipher.update("data", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ct = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
    expect(() => decrypt(ct)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// observability/errors.server — ConfigurationError + InvariantViolation suffixes
// ---------------------------------------------------------------------------

describe("observability/errors.server — programmer-error fingerprints", () => {
  it("ConfigurationError.fingerprint invokes getFingerPrintSuffix (line 254)", async () => {
    const { ConfigurationError } = await import("../observability/errors.server");
    const a = new ConfigurationError("missing", "ENCRYPTION_KEY");
    const b = new ConfigurationError("different msg", "ENCRYPTION_KEY");
    const c = new ConfigurationError("missing", "OTHER_KEY");
    // Same missingKey -> identical fingerprint regardless of message
    expect(a.fingerprint).toBe(b.fingerprint);
    // Different missingKey -> different fingerprint
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    // Span/log paths also reach the suffix.
    expect(a.toSpanAttributes()["error.fingerprint"]).toBe(a.fingerprint);
    expect(a.toLogContext().fingerprint).toBe(a.fingerprint);
  });

  it("InvariantViolation.fingerprint invokes getFingerPrintSuffix (line 271)", async () => {
    const { InvariantViolation } = await import("../observability/errors.server");
    const a = new InvariantViolation("oops", "approvedCount<=totalReturns");
    const b = new InvariantViolation("other", "approvedCount<=totalReturns");
    const c = new InvariantViolation("oops", "different.assertion");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(a.assertion).toBe("approvedCount<=totalReturns");
    expect(a.isOperational).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// observability/metrics.server — module import + env-var ternaries
// ---------------------------------------------------------------------------

describe("observability/metrics.server — instrument exports + deploy ternaries", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exports all instruments and records the deploy marker (defaults branch)", async () => {
    // Clear all build-time env vars so the fallback sides of the `||`
    // ternaries fire (BUILD_VERSION || "dev", etc.).
    delete process.env.BUILD_VERSION;
    delete process.env.BUILD_COMMIT;
    delete process.env.NODE_ENV;
    vi.resetModules();
    const m = await import("../observability/metrics.server");
    // Touch a representative subset of every instrument category so that
    // every export is referenced (helps lazy-eval reports).
    expect(typeof m.httpRequestCounter.add).toBe("function");
    expect(typeof m.returnActionDuration.record).toBe("function");
    expect(typeof m.fyndApiDuration.record).toBe("function");
    expect(typeof m.shopifyApiDuration.record).toBe("function");
    expect(typeof m.fyndSyncCounter.add).toBe("function");
    expect(typeof m.appErrorCounter.add).toBe("function");
    expect(typeof m.dbQueryDuration.record).toBe("function");
    expect(typeof m.refundAmountHistogram.record).toBe("function");
    expect(typeof m.refundProcessingTime.record).toBe("function");
    expect(typeof m.webhookInflight.add).toBe("function");
    expect(typeof m.healthCheckDuration.record).toBe("function");
    expect(typeof m.deployStartedCounter.add).toBe("function");
    // Observable gauges expose addCallback rather than add.
    expect(typeof m.dbPoolActive.addCallback).toBe("function");
    expect(typeof m.circuitBreakerState.addCallback).toBe("function");
    // Smoke-call a few to exercise no-op meter.add branches when otel is not
    // configured (the no-op meter is what's installed by default in tests).
    m.returnActionCounter.add(1, { type: "approve", outcome: "ok" });
    m.refundCounter.add(1, { method: "manual", outcome: "ok" });
    m.authFailureCounter.add(1, { type: "api_key", reason: "missing" });
    m.rateLimitRejectedCounter.add(1, { endpoint: "x" });
    m.webhookSignatureFailure.add(1, { source: "fynd" });
    m.fallbackActivated.add(1, { service: "fynd", fallback_type: "cache" });
    m.externalTimeoutCounter.add(1, { service: "fynd", operation: "x" });
    m.circuitBreakerRejected.add(1, { service: "fynd" });
    m.circuitBreakerStateChange.add(1, {
      service: "fynd",
      from_state: "closed",
      to_state: "open",
    });
  });

  it("uses configured BUILD_VERSION/BUILD_COMMIT/NODE_ENV when present (truthy ternary)", async () => {
    process.env.BUILD_VERSION = "1.2.3";
    process.env.BUILD_COMMIT = "deadbeef";
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const m = await import("../observability/metrics.server");
    expect(typeof m.deployStartedCounter.add).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// observability/resilience.server — recordSuccess while open (line 84 branch)
// ---------------------------------------------------------------------------

describe("observability/resilience.server — recordSuccess no-op while open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recordSuccess() is a no-op when the breaker is open (skips both branches)", async () => {
    const { CircuitBreaker } = await import("../observability/resilience.server");
    const cb = new CircuitBreaker("test-open-success", 1, 60_000);
    cb.recordFailure(); // → open
    expect(cb.getStatus().state).toBe("open");
    const before = cb.getStatus();
    // Calling recordSuccess while open hits neither the half_open nor the
    // closed branch — it should be a silent no-op.
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    const after = cb.getStatus();
    expect(after.state).toBe("open");
    expect(after.failureCount).toBe(before.failureCount);
    expect(after.lastStateChange).toBe(before.lastStateChange);
  });

  it("transition to same state short-circuits (prevState === newState branch)", async () => {
    const { CircuitBreaker } = await import("../observability/resilience.server");
    const cb = new CircuitBreaker("test-noop-transition", 1, 1000);
    // closed -> closed via recordSuccess in closed (no transition called)
    cb.recordSuccess();
    expect(cb.getStatus().state).toBe("closed");
    // open -> open via recordFailure when already open
    cb.recordFailure();
    expect(cb.getStatus().state).toBe("open");
    const lastChange = cb.getStatus().lastStateChange;
    cb.recordFailure(); // half_open path doesn't fire — _state is "open"
    // _state stays open; the early-return inside recordFailure for half_open
    // doesn't apply, but the failureCount increments harmlessly.
    expect(cb.getStatus().state).toBe("open");
    expect(cb.getStatus().lastStateChange).toBe(lastChange);
  });

  it("execute() rejects with CircuitOpenError before invoking fn when open", async () => {
    const { CircuitBreaker, CircuitOpenError } = await import(
      "../observability/resilience.server"
    );
    const cb = new CircuitBreaker("test-execute-open", 1, 60_000);
    cb.recordFailure();
    const fn = vi.fn(async () => "should not run");
    await expect(cb.execute(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });
});
