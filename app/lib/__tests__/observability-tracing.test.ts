/**
 * Tests for observability/tracing.server.ts: withSpan / withSpanSync error
 * propagation + status, addBusinessEvent on the active span, setSpanAttributes
 * passthrough, baggage helpers, and startTimer monotonicity. Tracing wraps
 * @opentelemetry/api so we mock that surface to assert exactly which span
 * methods our helpers call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @opentelemetry/api before importing the module under test
// ---------------------------------------------------------------------------

const mockSpan = {
  setStatus: vi.fn(),
  recordException: vi.fn(),
  end: vi.fn(),
  setAttribute: vi.fn(),
  setAttributes: vi.fn(),
  addEvent: vi.fn(),
};

const startActiveSpan = vi.fn(
  (_name: string, _opts: unknown, fn: (span: typeof mockSpan) => unknown) =>
    fn(mockSpan),
);

const getSpan = vi.fn<(...args: unknown[]) => typeof mockSpan | undefined>(() => mockSpan);
const getBaggage = vi.fn<(...args: unknown[]) => unknown>();
const setBaggageOnCtx = vi.fn<(...args: unknown[]) => unknown>((ctx) => ctx);
const createBaggage = vi.fn<(...args: unknown[]) => unknown>(() => {
  const entries: Record<string, { value: string }> = {};
  const baggage = {
    setEntry: vi.fn((key: string, entry: { value: string }) => {
      entries[key] = entry;
      return baggage;
    }),
    getEntry: vi.fn((key: string) => entries[key]),
  };
  return baggage;
});

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (...args: unknown[]) =>
        (startActiveSpan as unknown as (...a: unknown[]) => unknown)(...args),
    }),
    getSpan: (ctx: unknown) => getSpan(ctx),
  },
  context: {
    active: () => ({ __ctx: true }),
  },
  propagation: {
    getBaggage: (ctx: unknown) => getBaggage(ctx),
    createBaggage: (entries: unknown) => createBaggage(entries),
    setBaggage: (ctx: unknown, b: unknown) => setBaggageOnCtx(ctx, b),
  },
  SpanStatusCode: { OK: 1, ERROR: 2 },
  ROOT_CONTEXT: { __root: true },
}));

import {
  withSpan,
  withSpanSync,
  addBusinessEvent,
  setSpanAttributes,
  setBaggage,
  getBaggageValue,
  getActiveSpan,
  startTimer,
  SpanStatusCode,
} from "../observability/tracing.server";

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default: getSpan returns a span unless a test overrides it.
  getSpan.mockReturnValue(mockSpan);
  getBaggage.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------

describe("withSpan", () => {
  it("returns the resolved value from the wrapped function", async () => {
    const result = await withSpan("op.name", { foo: "bar" }, async () => 42);
    expect(result).toBe(42);
  });

  it("starts an active span with the given name and attributes", async () => {
    await withSpan("op.name", { foo: "bar" }, async () => "ok");
    expect(startActiveSpan).toHaveBeenCalledWith(
      "op.name",
      { attributes: { foo: "bar" } },
      expect.any(Function),
    );
  });

  it("sets OK status and ends the span on success", async () => {
    await withSpan("op", {}, async () => "ok");
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(mockSpan.recordException).not.toHaveBeenCalled();
  });

  it("records exception, sets ERROR status, ends span, and rethrows on Error", async () => {
    const err = new Error("boom");
    await expect(
      withSpan("op", {}, async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("wraps non-Error thrown values into an Error before recording", async () => {
    await expect(
      withSpan("op", {}, async () => {
        throw "string-error";
      }),
    ).rejects.toBe("string-error");
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "string-error",
    });
    const recorded = mockSpan.recordException.mock.calls[0][0];
    expect(recorded).toBeInstanceOf(Error);
    expect((recorded as Error).message).toBe("string-error");
  });

  it("passes the span to the callback so it can add events", async () => {
    await withSpan("op", {}, async (span) => {
      span.addEvent("custom.event", { k: "v" });
      return null;
    });
    expect(mockSpan.addEvent).toHaveBeenCalledWith("custom.event", { k: "v" });
  });
});

describe("withSpanSync", () => {
  it("returns the value and marks span OK on success", () => {
    const result = withSpanSync("sync.op", { a: 1 }, () => "value");
    expect(result).toBe("value");
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("records exceptions and rethrows on synchronous error", () => {
    const err = new Error("sync-fail");
    expect(() =>
      withSpanSync("sync.op", {}, () => {
        throw err;
      }),
    ).toThrow("sync-fail");
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "sync-fail",
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});

describe("addBusinessEvent", () => {
  it("calls addEvent on the active span with name + attributes", () => {
    addBusinessEvent("return.refund_initiated", { amount: 49.99 });
    expect(mockSpan.addEvent).toHaveBeenCalledWith("return.refund_initiated", {
      amount: 49.99,
    });
  });

  it("is a no-op when there is no active span", () => {
    getSpan.mockReturnValueOnce(undefined);
    expect(() => addBusinessEvent("noop.event", { a: 1 })).not.toThrow();
    expect(mockSpan.addEvent).not.toHaveBeenCalled();
  });

  it("forwards undefined attributes through to addEvent", () => {
    addBusinessEvent("plain.event");
    expect(mockSpan.addEvent).toHaveBeenCalledWith("plain.event", undefined);
  });
});

describe("setSpanAttributes", () => {
  it("forwards attributes to the active span", () => {
    setSpanAttributes({ "shop.id": "abc", "return.id": "r_1" });
    expect(mockSpan.setAttributes).toHaveBeenCalledWith({
      "shop.id": "abc",
      "return.id": "r_1",
    });
  });

  it("is a no-op when there is no active span", () => {
    getSpan.mockReturnValueOnce(undefined);
    setSpanAttributes({ x: 1 });
    expect(mockSpan.setAttributes).not.toHaveBeenCalled();
  });
});

describe("getActiveSpan", () => {
  it("returns the active span from the context", () => {
    expect(getActiveSpan()).toBe(mockSpan);
  });

  it("returns undefined when no span is active", () => {
    getSpan.mockReturnValueOnce(undefined);
    expect(getActiveSpan()).toBeUndefined();
  });
});

describe("startTimer", () => {
  it("returns a function that yields a non-negative integer ms duration", () => {
    const stop = startTimer();
    const elapsed = stop();
    expect(typeof elapsed).toBe("number");
    expect(Number.isInteger(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  it("measures elapsed time using performance.now", () => {
    const spy = vi.spyOn(performance, "now");
    spy.mockReturnValueOnce(1000); // start
    spy.mockReturnValueOnce(1042.4); // stop
    const stop = startTimer();
    expect(stop()).toBe(42);
    spy.mockRestore();
  });

  it("each call returns an independent timer", () => {
    const spy = vi.spyOn(performance, "now");
    spy.mockReturnValueOnce(0); // a start
    spy.mockReturnValueOnce(10); // b start
    spy.mockReturnValueOnce(105); // a stop
    spy.mockReturnValueOnce(50); // b stop
    const a = startTimer();
    const b = startTimer();
    expect(a()).toBe(105);
    expect(b()).toBe(40);
    spy.mockRestore();
  });
});

describe("baggage helpers", () => {
  it("setBaggage writes entries to a freshly created baggage when none exists", () => {
    setBaggage({ tenant: "shop-1", role: "admin" });
    expect(createBaggage).toHaveBeenCalled();
    expect(setBaggageOnCtx).toHaveBeenCalled();
    // Mirrors entries onto the active span as attributes.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("tenant", "shop-1");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("role", "admin");
  });

  it("setBaggage skips empty values", () => {
    setBaggage({ tenant: "shop-1", empty: "" });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("tenant", "shop-1");
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith("empty", "");
  });

  it("getBaggageValue returns the entry value when present", () => {
    getBaggage.mockReturnValueOnce({
      getEntry: (key: string) =>
        key === "tenant" ? { value: "shop-42" } : undefined,
    });
    expect(getBaggageValue("tenant")).toBe("shop-42");
  });

  it("getBaggageValue returns undefined when no baggage exists", () => {
    getBaggage.mockReturnValueOnce(undefined);
    expect(getBaggageValue("tenant")).toBeUndefined();
  });
});
