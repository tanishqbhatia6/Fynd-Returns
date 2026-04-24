import { describe, it, expect, vi } from "vitest";

/**
 * tracing.server.ts tests.
 *
 * Mock @opentelemetry/api to capture interactions instead of routing
 * through a real OTel SDK. Lets us verify withSpan handles success +
 * error paths correctly and that addBusinessEvent / setSpanAttributes
 * dispatch to the active span.
 */

const { spanMock, tracerMock, getSpanMock, getBaggageMock, setBaggageMock, createBaggageMock } = vi.hoisted(() => {
  const span = {
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
    addEvent: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
  };
  const tracer = {
    startActiveSpan: vi.fn((_name: string, _opts: unknown, cb: (s: typeof span) => unknown) => cb(span)),
  };
  const baggageEntries = new Map<string, { value: string }>();
  const baggage = {
    setEntry(k: string, e: { value: string }) {
      baggageEntries.set(k, e);
      return baggage;
    },
    getEntry(k: string) {
      return baggageEntries.get(k);
    },
  };
  return {
    spanMock: span,
    tracerMock: tracer,
    getSpanMock: vi.fn(() => span),
    getBaggageMock: vi.fn(() => baggage),
    setBaggageMock: vi.fn(),
    createBaggageMock: vi.fn(() => baggage),
  };
});

vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: () => tracerMock,
    getSpan: getSpanMock,
  },
  context: { active: () => ({}) },
  propagation: {
    getBaggage: getBaggageMock,
    createBaggage: createBaggageMock,
    setBaggage: setBaggageMock,
  },
  SpanStatusCode: { OK: 1, ERROR: 2 },
  ROOT_CONTEXT: {},
}));

import {
  withSpan,
  withSpanSync,
  setBaggage,
  getBaggageValue,
  addBusinessEvent,
  setSpanAttributes,
  getActiveSpan,
  startTimer,
} from "../observability/tracing.server";

describe("withSpan", () => {
  it("runs the function and sets OK status on success", async () => {
    spanMock.setStatus.mockClear();
    spanMock.end.mockClear();
    const result = await withSpan("test.op", { "test.attr": "x" }, async () => "result");
    expect(result).toBe("result");
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: 1 }); // OK
    expect(spanMock.end).toHaveBeenCalled();
  });

  it("records exception and rethrows on error", async () => {
    spanMock.setStatus.mockClear();
    spanMock.recordException.mockClear();
    spanMock.end.mockClear();
    const err = new Error("boom");
    await expect(withSpan("test.op", {}, async () => { throw err; })).rejects.toThrow("boom");
    expect(spanMock.recordException).toHaveBeenCalledWith(err);
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: 2, message: "boom" });
    expect(spanMock.end).toHaveBeenCalled(); // finally runs
  });

  it("converts non-Error throws to Error", async () => {
    spanMock.recordException.mockClear();
    await expect(withSpan("op", {}, async () => { throw "string-error"; })).rejects.toBe("string-error");
    const captured = spanMock.recordException.mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("string-error");
  });

  it("calls span.end even when fn throws synchronously inside async", async () => {
    spanMock.end.mockClear();
    await expect(withSpan("op", {}, () => { throw new Error("sync"); })).rejects.toThrow();
    expect(spanMock.end).toHaveBeenCalled();
  });
});

describe("withSpanSync", () => {
  it("returns the function's value on success", () => {
    spanMock.setStatus.mockClear();
    expect(withSpanSync("op", {}, () => 42)).toBe(42);
    expect(spanMock.setStatus).toHaveBeenCalledWith({ code: 1 });
  });

  it("rethrows + records on error", () => {
    spanMock.recordException.mockClear();
    expect(() => withSpanSync("op", {}, () => { throw new Error("x"); })).toThrow("x");
    expect(spanMock.recordException).toHaveBeenCalled();
  });

  it("wraps non-Error throws", () => {
    spanMock.recordException.mockClear();
    expect(() => withSpanSync("op", {}, () => { throw 123; })).toThrow();
    expect(spanMock.recordException.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe("setBaggage", () => {
  it("sets baggage entries + mirrors to active span attributes", () => {
    spanMock.setAttribute.mockClear();
    setBaggage({ "shop.domain": "x.myshopify.com", "user.type": "admin" });
    expect(spanMock.setAttribute).toHaveBeenCalledWith("shop.domain", "x.myshopify.com");
    expect(spanMock.setAttribute).toHaveBeenCalledWith("user.type", "admin");
  });

  it("skips empty values", () => {
    spanMock.setAttribute.mockClear();
    setBaggage({ key1: "value", empty: "" });
    expect(spanMock.setAttribute).toHaveBeenCalledWith("key1", "value");
    expect(spanMock.setAttribute).not.toHaveBeenCalledWith("empty", "");
  });

  it("works without an active span", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(() => setBaggage({ x: "y" })).not.toThrow();
  });
});

describe("getBaggageValue", () => {
  it("returns the value when present", () => {
    setBaggage({ "request.id": "r-1" });
    expect(getBaggageValue("request.id")).toBe("r-1");
  });

  it("returns undefined when key not in baggage", () => {
    expect(getBaggageValue("nonexistent")).toBe(undefined);
  });

  it("returns undefined when no baggage", () => {
    getBaggageMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getBaggageMock>);
    expect(getBaggageValue("any")).toBe(undefined);
  });
});

describe("addBusinessEvent", () => {
  it("adds an event to the active span", () => {
    spanMock.addEvent.mockClear();
    addBusinessEvent("return.approved", { id: "r-1" });
    expect(spanMock.addEvent).toHaveBeenCalledWith("return.approved", { id: "r-1" });
  });

  it("works without attributes", () => {
    spanMock.addEvent.mockClear();
    addBusinessEvent("return.created");
    expect(spanMock.addEvent).toHaveBeenCalledWith("return.created", undefined);
  });

  it("no-op without active span", () => {
    spanMock.addEvent.mockClear();
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    addBusinessEvent("event");
    expect(spanMock.addEvent).not.toHaveBeenCalled();
  });
});

describe("setSpanAttributes", () => {
  it("sets attributes on the active span", () => {
    spanMock.setAttributes.mockClear();
    setSpanAttributes({ "x.foo": "bar" });
    expect(spanMock.setAttributes).toHaveBeenCalledWith({ "x.foo": "bar" });
  });

  it("no-op without active span", () => {
    spanMock.setAttributes.mockClear();
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    setSpanAttributes({ foo: "bar" });
    expect(spanMock.setAttributes).not.toHaveBeenCalled();
  });
});

describe("getActiveSpan", () => {
  it("returns the active span", () => {
    expect(getActiveSpan()).toBe(spanMock);
  });

  it("returns undefined when no span", () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    expect(getActiveSpan()).toBe(undefined);
  });
});

describe("startTimer", () => {
  it("returns a function that returns elapsed ms", async () => {
    const stop = startTimer();
    await new Promise((r) => setTimeout(r, 30));
    const elapsed = stop();
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(500);
  });

  it("returns 0 or near-0 when called immediately", () => {
    const stop = startTimer();
    expect(stop()).toBeLessThan(50);
  });
});
