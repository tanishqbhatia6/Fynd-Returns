import { describe, it, expect, vi } from "vitest";

/* OTel mocks. The real baggage API is stateful; we emulate it via a
   Map that persists across calls in the same test. */

type BaggageEntry = { value: string };
const baggageStore = new Map<string, BaggageEntry>();

const mockBaggage = () => ({
  setEntry(key: string, entry: BaggageEntry) {
    baggageStore.set(key, entry);
    return mockBaggage();
  },
  getEntry(key: string) {
    return baggageStore.get(key);
  },
});

const { setAttributeMock, getSpanMock } = vi.hoisted(() => {
  const setAttribute = vi.fn();
  const getSpan = vi.fn(() => ({
    setAttribute,
    spanContext: () => ({ traceId: "abc123trace" }),
  }));
  return { setAttributeMock: setAttribute, getSpanMock: getSpan };
});

vi.mock("@opentelemetry/api", () => ({
  trace: { getSpan: getSpanMock },
  context: { active: () => ({}) },
  propagation: {
    getBaggage: () => mockBaggage(),
    createBaggage: () => mockBaggage(),
    setBaggage: vi.fn(),
  },
}));

import {
  getRequestId,
  setRequestContext,
  getContextValue,
  getCorrelationHeaders,
  hashIp,
  getSourceIp,
} from "../observability/request-context.server";

function mkRequest(headers: Record<string, string> = {}, url = "https://x.com/api/returns?id=1") {
  return new Request(url, { headers });
}

describe("getRequestId", () => {
  it("prefers x-request-id", () => {
    const r = mkRequest({ "x-request-id": "req-123" });
    expect(getRequestId(r)).toBe("req-123");
  });
  it("falls back to x-amzn-trace-id", () => {
    const r = mkRequest({ "x-amzn-trace-id": "Root=1-abc" });
    expect(getRequestId(r)).toBe("Root=1-abc");
  });
  it("generates a uuid when no headers present", () => {
    const id = getRequestId(mkRequest());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("setRequestContext", () => {
  it("returns the request ID + sets it on span + baggage", () => {
    baggageStore.clear();
    setAttributeMock.mockClear();
    const id = setRequestContext(mkRequest({ "x-request-id": "r-1" }));
    expect(id).toBe("r-1");
    expect(setAttributeMock).toHaveBeenCalledWith("request.id", "r-1");
    expect(baggageStore.get("request.id")?.value).toBe("r-1");
  });

  it("sets shop + user + return attrs when provided", () => {
    setAttributeMock.mockClear();
    setRequestContext(mkRequest(), {
      shopDomain: "x.myshopify.com",
      shopId: "shop-1",
      userType: "admin",
      returnId: "rc-1",
      returnRequestNo: "RPM-ABC",
    });
    const entries = setAttributeMock.mock.calls.map((c) => [c[0], c[1]]);
    expect(entries).toContainEqual(["shop.domain", "x.myshopify.com"]);
    expect(entries).toContainEqual(["shop.id", "shop-1"]);
    expect(entries).toContainEqual(["user.type", "admin"]);
    expect(entries).toContainEqual(["return.id", "rc-1"]);
    expect(entries).toContainEqual(["return.request_no", "RPM-ABC"]);
  });

  it("skips span attrs when no active span", async () => {
    setAttributeMock.mockClear();
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    setRequestContext(mkRequest());
    expect(setAttributeMock).not.toHaveBeenCalled();
  });
});

describe("getContextValue", () => {
  it("reads from current baggage", () => {
    baggageStore.clear();
    baggageStore.set("request.id", { value: "r-xyz" });
    expect(getContextValue("request.id")).toBe("r-xyz");
  });

  it("returns undefined for missing keys", () => {
    baggageStore.clear();
    expect(getContextValue("missing")).toBe(undefined);
  });
});

describe("getCorrelationHeaders", () => {
  it("returns X-Request-Id", () => {
    const h = getCorrelationHeaders("r-1");
    expect(h["X-Request-Id"]).toBe("r-1");
  });

  it("adds X-Trace-Id when a span is active", () => {
    const h = getCorrelationHeaders("r-1");
    expect(h["X-Trace-Id"]).toBe("abc123trace");
  });

  it("omits X-Trace-Id when no span", async () => {
    getSpanMock.mockReturnValueOnce(undefined as unknown as ReturnType<typeof getSpanMock>);
    const h = getCorrelationHeaders("r-1");
    expect(h["X-Trace-Id"]).toBeUndefined();
    expect(h["X-Request-Id"]).toBe("r-1");
  });
});

describe("hashIp", () => {
  it("returns 8-char hex", () => {
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic (same IP → same hash)", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });

  it("produces different hashes for different IPs", () => {
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
  });
});

describe("getSourceIp", () => {
  it("extracts first IP from x-forwarded-for", () => {
    const r = mkRequest({ "x-forwarded-for": "203.0.113.1, 10.0.0.5" });
    expect(getSourceIp(r)).toBe("203.0.113.1");
  });

  it("trims whitespace", () => {
    const r = mkRequest({ "x-forwarded-for": "  1.2.3.4   " });
    expect(getSourceIp(r)).toBe("1.2.3.4");
  });

  it("returns 'unknown' when no header present", () => {
    expect(getSourceIp(mkRequest())).toBe("unknown");
  });

  it("returns 'unknown' when x-forwarded-for is empty", () => {
    const r = mkRequest({ "x-forwarded-for": "" });
    expect(getSourceIp(r)).toBe("unknown");
  });
});
