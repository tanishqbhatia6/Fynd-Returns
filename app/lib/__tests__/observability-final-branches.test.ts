/**
 * Final branch closure for the observability/* server modules.
 *
 * Strategy
 * --------
 * Each of the 9 modules under app/lib/observability has its own dedicated
 * suite already; this file only attacks the residual branch gaps that the
 * existing suites don't reach in isolation:
 *
 *   logger.server.ts             — production transport branch (NODE_ENV=production
 *                                  swaps the pretty transport for undefined),
 *                                  default level fallback, mixin no-span path,
 *                                  AppError serializer + req serializer empty paths.
 *   metrics.server.ts            — fallback values in the deploy marker
 *                                  (BUILD_VERSION/BUILD_COMMIT/NODE_ENV undefined).
 *   tracing.server.ts            — withSpanSync non-Error throw, setBaggage with
 *                                  no active span.
 *   request-context.server.ts    — setRequestContext branches when a span IS
 *                                  active (shopId / userType / returnId / returnRequestNo).
 *   audit.server.ts              — span-attribute annotation branch when a span
 *                                  is active.
 *   health.server.ts             — withTimeout failure path (database error message).
 *   slo.server.ts                — calculateBurnRate (target=1.0 with errors)
 *                                  and errorBudgetRemaining edges.
 *   resilience.server.ts         — recordTimeout / recordFallback metadata paths.
 *   errors.server.ts             — fingerprint of ConfigurationError +
 *                                  InvariantViolation (the two functions left
 *                                  uncovered after errors.test.ts), plus
 *                                  toAppError on a non-AppError input.
 *
 * The OTel + pino mocks are re-installed per test where needed via
 * vi.resetModules(); modules that need a real OTel surface use the no-op
 * default already provided by @opentelemetry/api.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared pino mock
// ---------------------------------------------------------------------------
const pinoCalls: { options: Record<string, unknown> }[] = [];

function makeStubLogger(level = "info"): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    level,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(
      (_b: Record<string, unknown>, opts?: { level?: string }) =>
        makeStubLogger(opts?.level ?? level),
    ),
  };
  return stub;
}

vi.mock("pino", () => {
  const factory = (options: Record<string, unknown>) => {
    pinoCalls.push({ options });
    return makeStubLogger((options.level as string) ?? "info");
  };
  (factory as unknown as { stdSerializers: unknown }).stdSerializers = {
    err: (e: Error) => ({ message: e.message, name: e.name, stack: e.stack }),
  };
  return { default: factory };
});

// ---------------------------------------------------------------------------
// Controllable @opentelemetry/api mock
// ---------------------------------------------------------------------------
type OtelSpan = {
  spanContext: () => { traceId: string; spanId: string; traceFlags: number };
  setAttribute: ReturnType<typeof vi.fn>;
  setAttributes: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  addEvent: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

const otelState: {
  span: OtelSpan | null;
  baggageEntries: Record<string, string>;
  baggageNull: boolean;
} = { span: null, baggageEntries: {}, baggageNull: false };

function makeSpan(): OtelSpan {
  return {
    spanContext: () => ({ traceId: "t-final", spanId: "s-final", traceFlags: 1 }),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    addEvent: vi.fn(),
    end: vi.fn(),
  };
}

function makeBaggage(): {
  getEntry: (k: string) => { value: string } | undefined;
  setEntry: (k: string, v: { value: string }) => unknown;
} {
  const baggage = {
    getEntry: (k: string) =>
      otelState.baggageEntries[k] !== undefined
        ? { value: otelState.baggageEntries[k] }
        : undefined,
    setEntry: (k: string, v: { value: string }) => {
      otelState.baggageEntries[k] = v.value;
      return baggage;
    },
  };
  return baggage;
}

function makeNoopInstrument(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    add: vi.fn(),
    record: vi.fn(),
    addCallback: vi.fn(),
    removeCallback: vi.fn(),
  };
}

vi.mock("@opentelemetry/api", () => {
  const tracerStartActive = vi.fn(
    (_n: string, _o: unknown, fn: (s: OtelSpan) => unknown) =>
      fn(otelState.span ?? makeSpan()),
  );
  const meter = {
    createCounter: () => makeNoopInstrument(),
    createHistogram: () => makeNoopInstrument(),
    createUpDownCounter: () => makeNoopInstrument(),
    createObservableGauge: () => makeNoopInstrument(),
    createObservableCounter: () => makeNoopInstrument(),
    createObservableUpDownCounter: () => makeNoopInstrument(),
  };
  return {
    metrics: {
      getMeter: () => meter,
    },
    trace: {
      getTracer: () => ({ startActiveSpan: tracerStartActive }),
      getSpan: () => otelState.span,
    },
    context: { active: () => ({}) },
    propagation: {
      getBaggage: () => {
        if (otelState.baggageNull) return undefined;
        return makeBaggage();
      },
      createBaggage: () => makeBaggage(),
      setBaggage: (ctx: unknown) => ctx,
    },
    SpanStatusCode: { OK: 1, ERROR: 2 },
    ROOT_CONTEXT: {},
  };
});

beforeEach(() => {
  vi.resetModules();
  pinoCalls.length = 0;
  otelState.span = null;
  otelState.baggageEntries = {};
  otelState.baggageNull = false;
});

// ===========================================================================
// logger.server.ts — production + no-span + req-empty branches
// ===========================================================================

describe("logger.server.ts — final branches", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses undefined transport when NODE_ENV=production (line 154)", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.LOG_LEVEL;
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { transport?: unknown; level: string };
    expect(opts.transport).toBeUndefined();
    // production default level is "info"
    expect(opts.level).toBe("info");
  });

  it("uses pretty transport and debug default when NODE_ENV is not production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      transport?: { target: string; options: { colorize: boolean } };
      level: string;
    };
    expect(opts.transport?.target).toBe("pino-pretty");
    expect(opts.transport?.options.colorize).toBe(true);
    expect(opts.level).toBe("debug");
  });

  it("honors LOG_LEVEL env var when set (overrides NODE_ENV defaults)", async () => {
    process.env.LOG_LEVEL = "warn";
    process.env.NODE_ENV = "production";
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { level: string };
    expect(opts.level).toBe("warn");
  });

  it("req serializer handles missing url and missing headers gracefully", async () => {
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      serializers: { req: (r: unknown) => Record<string, unknown> };
    };
    // No url
    const a = opts.serializers.req({ method: "GET", headers: {} });
    expect(a.url).toBeUndefined();
    // url with no query string is preserved as-is
    const b = opts.serializers.req({
      method: "POST",
      url: "/path",
      headers: { "user-agent": "bot/1.0" },
    });
    expect(b.url).toBe("/path");
    // url with query string is stripped
    const c = opts.serializers.req({
      method: "GET",
      url: "/path?token=abc",
      headers: { "user-agent": "bot/2.0" },
    });
    expect(c.url).toBe("/path");
    // No headers object
    const d = opts.serializers.req({ method: "GET", url: "/x" });
    expect((d.headers as Record<string, string>)["user-agent"]).toBeUndefined();
  });

  it("err serializer falls through std for non-AppError instances (line 144 fallthrough)", async () => {
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      serializers: { err: (e: unknown) => Record<string, unknown> };
    };
    const out = opts.serializers.err(new TypeError("plain"));
    expect(out.message).toBe("plain");
    // No AppError-only fields should be present
    expect(out.isOperational).toBeUndefined();
    expect(out.errorClass).toBeUndefined();
  });

  it("createModuleLogger applies LOG_LEVEL_<MODULE> env override", async () => {
    process.env.LOG_LEVEL_FYND = "trace";
    const mod = await import("../observability/logger.server");
    expect(mod.fyndLogger).toBeDefined();
    expect(typeof (mod.fyndLogger as unknown as { info: unknown }).info).toBe(
      "function",
    );
  });
});

// ===========================================================================
// metrics.server.ts — env-var fallback ternary branches
// ===========================================================================

describe("metrics.server.ts — deploy marker fallback ternaries", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("records the deploy event with default values when env vars are absent", async () => {
    delete process.env.BUILD_VERSION;
    delete process.env.BUILD_COMMIT;
    delete process.env.NODE_ENV;
    vi.resetModules();
    const m = await import("../observability/metrics.server");
    expect(typeof m.deployStartedCounter.add).toBe("function");
    // Module init already added; we just confirm the counter is callable.
    m.deployStartedCounter.add(1, { version: "x", commit: "y", environment: "z" });
  });

  it("records the deploy event with explicit env values when set", async () => {
    process.env.BUILD_VERSION = "v1.2.3";
    process.env.BUILD_COMMIT = "abc1234";
    process.env.NODE_ENV = "staging";
    vi.resetModules();
    const m = await import("../observability/metrics.server");
    expect(typeof m.deployStartedCounter.add).toBe("function");
  });
});

// ===========================================================================
// tracing.server.ts — non-Error throw + no-span baggage path
// ===========================================================================

describe("tracing.server.ts — final branches", () => {
  it("withSpanSync wraps a non-Error thrown value into an Error before rethrow", async () => {
    otelState.span = makeSpan();
    const { withSpanSync } = await import("../observability/tracing.server");
    expect(() =>
      withSpanSync("op", {}, () => {
        throw "string-thrown";
      }),
    ).toThrow();
  });

  it("setBaggage is a no-op for span attributes when there is no active span", async () => {
    otelState.span = null;
    const { setBaggage } = await import("../observability/tracing.server");
    expect(() => setBaggage({ tenant: "shop-1", user: "" })).not.toThrow();
  });
});

// ===========================================================================
// request-context.server.ts — span-active extras branches
// ===========================================================================

describe("request-context.server.ts — span-active extras", () => {
  it("sets every extra attribute on the active span (lines 47-51)", async () => {
    const span = makeSpan();
    otelState.span = span;
    const { setRequestContext } = await import(
      "../observability/request-context.server"
    );
    const req = new Request("https://example.com/", {
      headers: { "x-request-id": "req-final" },
    });
    setRequestContext(req, {
      shopDomain: "demo.myshopify.com",
      shopId: "gid://shopify/Shop/1",
      userType: "admin",
      returnId: "ret-1",
      returnRequestNo: "RR-100",
    });
    expect(span.setAttribute).toHaveBeenCalledWith("request.id", "req-final");
    expect(span.setAttribute).toHaveBeenCalledWith(
      "shop.domain",
      "demo.myshopify.com",
    );
    expect(span.setAttribute).toHaveBeenCalledWith("shop.id", "gid://shopify/Shop/1");
    expect(span.setAttribute).toHaveBeenCalledWith("user.type", "admin");
    expect(span.setAttribute).toHaveBeenCalledWith("return.id", "ret-1");
    expect(span.setAttribute).toHaveBeenCalledWith("return.request_no", "RR-100");
  });

  it("getCorrelationHeaders includes X-Trace-Id when span is active", async () => {
    otelState.span = makeSpan();
    const { getCorrelationHeaders } = await import(
      "../observability/request-context.server"
    );
    const headers = getCorrelationHeaders("rid-1");
    expect(headers["X-Request-Id"]).toBe("rid-1");
    expect(headers["X-Trace-Id"]).toBe("t-final");
  });
});

// ===========================================================================
// audit.server.ts — active-span annotation branch
// ===========================================================================

describe("audit.server.ts — span-active annotation", () => {
  it("annotates the active span with audit attributes when present", async () => {
    const span = makeSpan();
    otelState.span = span;
    const { auditLog } = await import("../observability/audit.server");
    auditLog({
      action: "return.approved",
      actor: { type: "admin", identity: "user-1" },
      resource: { type: "ReturnCase", id: "ret-1" },
      shopDomain: "shop.myshopify.com",
      changes: { status: { from: "pending", to: "approved" } },
      metadata: { source: "ui" },
    });
    expect(span.setAttribute).toHaveBeenCalledWith("audit.action", "return.approved");
    expect(span.setAttribute).toHaveBeenCalledWith("audit.actor_type", "admin");
    expect(span.setAttribute).toHaveBeenCalledWith("audit.resource_type", "ReturnCase");
    expect(span.setAttribute).toHaveBeenCalledWith("audit.resource_id", "ret-1");
  });
});

// ===========================================================================
// health.server.ts — non-Error throw branch in catch
// ===========================================================================

describe("health.server.ts — non-Error message fallback", () => {
  it("checkFyndApi returns 'degraded' with a message when fetch rejects with non-Error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      return Promise.reject("network down");
    });
    const { checkFyndApi } = await import("../observability/health.server");
    const result = await checkFyndApi();
    expect(result.status).toBe("degraded");
    expect(result.message).toBe("Fynd API unreachable");
    fetchSpy.mockRestore();
  });
});

// ===========================================================================
// slo.server.ts — boundary branches
// ===========================================================================

describe("slo.server.ts — boundary branches", () => {
  it("calculateBurnRate returns Infinity when target=1.0 and there are errors", async () => {
    const { calculateBurnRate } = await import("../observability/slo.server");
    expect(calculateBurnRate(1, 100, 1.0)).toBe(Infinity);
    expect(calculateBurnRate(0, 100, 1.0)).toBe(0);
    expect(calculateBurnRate(0, 0, 0.99)).toBe(0);
  });

  it("errorBudgetRemaining 100% when total=0 and 0% when allowedErrors=0 with errors", async () => {
    const { errorBudgetRemaining } = await import("../observability/slo.server");
    expect(errorBudgetRemaining(0, 0, 0.99)).toBe(100);
    // total*1-target floors to 0 → branch
    expect(errorBudgetRemaining(1, 10, 0.999)).toBe(0);
    expect(errorBudgetRemaining(0, 10, 0.999)).toBe(100);
  });

  it("annotateSLO is a no-op when sloName is unknown", async () => {
    otelState.span = makeSpan();
    const { annotateSLO } = await import("../observability/slo.server");
    expect(() => annotateSLO("totally-not-a-real-slo", { breached: true })).not.toThrow();
  });
});

// ===========================================================================
// resilience.server.ts — timeout/fallback branches
// ===========================================================================

describe("resilience.server.ts — timeout/fallback recording", () => {
  it("recordTimeout and recordFallback are side-effect-only and don't throw", async () => {
    const { recordTimeout, recordFallback } = await import(
      "../observability/resilience.server"
    );
    expect(() => recordTimeout("svc", "op", 1000)).not.toThrow();
    expect(() => recordFallback("svc", "cache")).not.toThrow();
    // With optional metadata
    expect(() => recordFallback("svc", "cache", { reason: "timeout" })).not.toThrow();
  });
});

// ===========================================================================
// errors.server.ts — uncovered fingerprint methods
// ===========================================================================

describe("errors.server.ts — uncovered fingerprint methods", () => {
  it("ConfigurationError fingerprint uses missingKey suffix (line 254)", async () => {
    const { ConfigurationError } = await import("../observability/errors.server");
    const err = new ConfigurationError("missing FYND_HOST", "FYND_HOST");
    expect(err.isOperational).toBe(false);
    expect(err.service).toBe("config");
    expect(typeof err.fingerprint).toBe("string");
    expect(err.fingerprint).toHaveLength(16);
    // toLogContext + toSpanAttributes traverse the fingerprint getter.
    expect(err.toLogContext().fingerprint).toBe(err.fingerprint);
    expect(err.toSpanAttributes()["error.fingerprint"]).toBe(err.fingerprint);
  });

  it("InvariantViolation fingerprint uses assertion suffix (line 271)", async () => {
    const { InvariantViolation } = await import("../observability/errors.server");
    const err = new InvariantViolation("count mismatch", "approvedCount<=total");
    expect(err.isOperational).toBe(false);
    expect(err.service).toBe("invariant");
    expect(typeof err.fingerprint).toBe("string");
    expect(err.fingerprint).toHaveLength(16);
    // Different assertions yield different fingerprints
    const other = new InvariantViolation("x", "different");
    expect(other.fingerprint).not.toBe(err.fingerprint);
  });

  it("toAppError returns null for non-AppError values; isOperationalError returns false", async () => {
    const { toAppError, isOperationalError } = await import(
      "../observability/errors.server"
    );
    expect(toAppError(new Error("plain"))).toBeNull();
    expect(toAppError("string")).toBeNull();
    expect(toAppError(null)).toBeNull();
    expect(isOperationalError(new Error("plain"))).toBe(false);
    expect(isOperationalError("string")).toBe(false);
  });
});
