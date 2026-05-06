/**
 * Coverage gap tests for observability/logger.server.ts.
 *
 * Targets the previously-uncovered branches:
 *   - Lines 108-129: the `mixin()` function which derives trace_id / span_id
 *     and pulls request.id / shop.domain / shop.id from OTel baggage.
 *     Both early-return (no active span) and full-fanout (span + baggage)
 *     paths are exercised.
 *   - Line 134: the AppError branch of the `err` serializer that adds
 *     isOperational / errorClass / service / fingerprint.
 *
 * The pino import is mocked so we can capture the configuration object
 * passed to pino() and call the mixin / serializer directly. OTel APIs are
 * mocked so we can deterministically inject (or omit) span context and
 * baggage entries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Pino mock — capture options
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
    child: vi.fn((_b: Record<string, unknown>, opts?: { level?: string }) =>
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
// OTel mock — controllable span + baggage
// ---------------------------------------------------------------------------
const otelState: {
  span: { spanContext: () => { traceId: string; spanId: string; traceFlags: number } } | null;
  baggageEntries: Record<string, string>;
  baggageNull: boolean;
} = {
  span: null,
  baggageEntries: {},
  baggageNull: false,
};

vi.mock("@opentelemetry/api", () => {
  return {
    trace: {
      getSpan: () => otelState.span,
    },
    context: {
      active: () => ({}),
    },
    propagation: {
      getBaggage: () => {
        if (otelState.baggageNull) return undefined;
        return {
          getEntry: (k: string) =>
            otelState.baggageEntries[k] !== undefined
              ? { value: otelState.baggageEntries[k] }
              : undefined,
        };
      },
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  pinoCalls.length = 0;
  otelState.span = null;
  otelState.baggageEntries = {};
  otelState.baggageNull = false;
});

// ---------------------------------------------------------------------------
// mixin() — no active span: returns empty object (line 110)
// ---------------------------------------------------------------------------
describe("logger mixin — no active span", () => {
  it("returns an empty object when no span is active", async () => {
    otelState.span = null;
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { mixin: () => Record<string, unknown> };
    expect(opts.mixin()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mixin() — active span variants (lines 112-128)
// ---------------------------------------------------------------------------
describe("logger mixin — with active span", () => {
  it("emits trace_id / span_id / trace_flags from spanContext()", async () => {
    otelState.span = {
      spanContext: () => ({ traceId: "trace-abc", spanId: "span-xyz", traceFlags: 1 }),
    };
    otelState.baggageNull = true; // exercise the !baggage branches
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { mixin: () => Record<string, unknown> };
    const out = opts.mixin();
    expect(out).toEqual({
      trace_id: "trace-abc",
      span_id: "span-xyz",
      trace_flags: 1,
    });
  });

  it("merges request.id / shop.domain / shop.id baggage entries when present", async () => {
    otelState.span = {
      spanContext: () => ({ traceId: "t1", spanId: "s1", traceFlags: 0 }),
    };
    otelState.baggageEntries = {
      "request.id": "req-123",
      "shop.domain": "demo.myshopify.com",
      "shop.id": "42",
    };
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { mixin: () => Record<string, unknown> };
    expect(opts.mixin()).toEqual({
      trace_id: "t1",
      span_id: "s1",
      trace_flags: 0,
      "request.id": "req-123",
      "shop.domain": "demo.myshopify.com",
      "shop.id": "42",
    });
  });

  it("omits any baggage entry that is missing while keeping the others", async () => {
    otelState.span = {
      spanContext: () => ({ traceId: "t2", spanId: "s2", traceFlags: 0 }),
    };
    otelState.baggageEntries = { "request.id": "req-only" };
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { mixin: () => Record<string, unknown> };
    const out = opts.mixin();
    expect(out["request.id"]).toBe("req-only");
    expect("shop.domain" in out).toBe(false);
    expect("shop.id" in out).toBe(false);
  });

  it("includes only shop.domain when request.id and shop.id are absent", async () => {
    otelState.span = {
      spanContext: () => ({ traceId: "t3", spanId: "s3", traceFlags: 0 }),
    };
    otelState.baggageEntries = { "shop.domain": "store.myshopify.com" };
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as { mixin: () => Record<string, unknown> };
    const out = opts.mixin();
    expect(out["shop.domain"]).toBe("store.myshopify.com");
    expect("request.id" in out).toBe(false);
    expect("shop.id" in out).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// err serializer — AppError branch (line 134-141)
// ---------------------------------------------------------------------------
describe("err serializer — AppError branch", () => {
  it("adds isOperational, errorClass, service, fingerprint, and toLogContext fields", async () => {
    const { FyndApiError } = await import("../observability/errors.server");
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      serializers: { err: (e: unknown) => Record<string, unknown> };
    };

    const err = new FyndApiError("Fynd 500", 500, "/api/orders", "ERR_X");
    const out = opts.serializers.err(err);

    expect(out.message).toBe("Fynd 500");
    expect(out.isOperational).toBe(true);
    expect(out.errorClass).toBe("FyndApiError");
    expect(out.service).toBe("fynd");
    expect(typeof out.fingerprint).toBe("string");
    // toLogContext spread should also surface name/message/etc.
    expect(out.name).toBe("FyndApiError");
  });
});
