import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * webhook-dispatch.server.ts — unit tests.
 * ────────────────────────────────────────────────────────────────────
 * Mirrors the prismaMock pattern used in notification.test.ts.
 *
 * dispatchWebhookEvent is fire-and-forget: it returns void synchronously
 * and the actual delivery happens inside an IIFE. Tests rely on a
 * `flushAll` helper that waits long enough for the initial fetch attempt
 * (and per-subscription queue drain) to complete — but never long enough
 * to wait through the 30 s retry back-off, which we sidestep entirely
 * by *not* asserting through retries unless the test specifically
 * stubs out timers or sequences `fetch` results carefully.
 *
 * The url-safety SSRF re-check is mocked unconditionally to "safe" so
 * tests don't depend on DNS resolution.
 */

import crypto from "crypto";

const { prismaMock, fetchSpy, isSafeOutboundUrlMock } = vi.hoisted(() => ({
  prismaMock: {
    webhookSubscription: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    webhookDeliveryFailure: {
      create: vi.fn(),
    },
  },
  fetchSpy: vi.fn(),
  isSafeOutboundUrlMock: vi.fn(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../url-safety.server", () => ({
  isSafeOutboundUrl: isSafeOutboundUrlMock,
}));

vi.mock("../observability/logger.server", () => ({
  webhookLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
}));

vi.mock("../observability/metrics.server", () => ({
  webhookDispatchCounter: { add: vi.fn() },
  webhookDeliveryAttempts: { add: vi.fn() },
  webhookRetriesExhausted: { add: vi.fn() },
  webhookInflight: { add: vi.fn() },
}));

import { dispatchWebhookEvent } from "../webhook-dispatch.server";

/**
 * Wait for the IIFE → withSpan → findMany → enqueueForSubscription →
 * deliverWithRetry → dynamic import("./url-safety.server") → fetch
 * chain to flush. 200 ms is enough on CI without races and never
 * crosses the 30 s retry timer.
 */
async function flushAll() {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/* ── Fixtures ─────────────────────────────────────────────────────── */

let subCounter = 0;
function uniqueId(prefix: string) {
  subCounter += 1;
  return `${prefix}-${subCounter}-${Date.now()}`;
}

function makeSub(
  overrides: Partial<{
    id: string;
    shopId: string;
    isActive: boolean;
    url: string;
    secret: string;
    events: string;
  }> = {},
) {
  return {
    id: overrides.id ?? uniqueId("sub"),
    shopId: "shop-1",
    isActive: true,
    url: "https://hook.example.com/incoming",
    secret: "test-secret",
    events: JSON.stringify(["return.approved"]),
    ...overrides,
  };
}

/* ── Setup ────────────────────────────────────────────────────────── */

beforeEach(() => {
  prismaMock.webhookSubscription.findMany.mockReset().mockResolvedValue([]);
  prismaMock.webhookSubscription.findFirst.mockReset().mockResolvedValue({ id: "sub-default" });
  prismaMock.webhookDeliveryFailure.create.mockReset().mockResolvedValue({});
  fetchSpy.mockReset();
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── 1. No subscriptions = no-op ──────────────────────────────────── */

describe("dispatchWebhookEvent — no subscriptions", () => {
  it("returns synchronously without throwing", () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    expect(() => dispatchWebhookEvent("shop-1", "return.approved", { id: "r" })).not.toThrow();
  });

  it("does not call fetch when there are zero subscriptions for the shop", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not call fetch when no subscription matches the event type", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      makeSub({ events: JSON.stringify(["return.rejected"]) }),
    ]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters out subscriptions whose events JSON is malformed", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub({ events: "}}}garbage" })]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("queries findMany with shopId + isActive filter", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    dispatchWebhookEvent("shop-xyz", "return.approved", { id: "r" });
    await flushAll();
    expect(prismaMock.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: { shopId: "shop-xyz", isActive: true },
    });
  });
});

/* ── 2. Fire-and-forget signature verification ────────────────────── */

describe("dispatchWebhookEvent — fire-and-forget + signing", () => {
  it("returns void synchronously (does not block the caller)", () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });
    const result = dispatchWebhookEvent("shop-1", "return.approved", { id: "r" });
    expect(result).toBeUndefined();
  });

  it("posts JSON body containing event, data, timestamp and idempotencyKey", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { returnId: "r-99" });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as { method: string; body: string };
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.event).toBe("return.approved");
    expect(body.data).toEqual({ returnId: "r-99" });
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.idempotencyKey).toBe("string");
    expect(body.idempotencyKey.length).toBeGreaterThan(10);
  });

  it("sets X-Webhook-Signature to HMAC-SHA256(body, sub.secret) prefixed sha256=", async () => {
    const sub = makeSub({ secret: "my-strong-secret" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { foo: "bar" });
    await flushAll();
    const init = fetchSpy.mock.calls[0][1] as {
      headers: Record<string, string>;
      body: string;
    };
    const expected =
      "sha256=" + crypto.createHmac("sha256", sub.secret).update(init.body).digest("hex");
    expect(init.headers["X-Webhook-Signature"]).toBe(expected);
  });

  it("also sets the legacy X-RPM-Signature header for backwards compat", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["X-RPM-Signature"]).toBeTruthy();
    expect(headers["X-RPM-Event"]).toBe("return.approved");
  });

  it("sets Content-Type and X-Webhook-Event headers", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Webhook-Event"]).toBe("return.approved");
  });

  it("dispatches to multiple matching subscriptions in parallel", async () => {
    const a = makeSub({ url: "https://a.example.com/hook" });
    const b = makeSub({ url: "https://b.example.com/hook" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([a, b]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain(a.url);
    expect(urls).toContain(b.url);
  });

  it("uses each subscription's own secret for signing", async () => {
    const a = makeSub({ url: "https://a.example.com", secret: "secret-A" });
    const b = makeSub({ url: "https://b.example.com", secret: "secret-B" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([a, b]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    const calls = fetchSpy.mock.calls;
    for (const call of calls) {
      const init = call[1] as { headers: Record<string, string>; body: string };
      const isA = call[0] === a.url;
      const expected =
        "sha256=" +
        crypto
          .createHmac("sha256", isA ? a.secret : b.secret)
          .update(init.body)
          .digest("hex");
      expect(init.headers["X-Webhook-Signature"]).toBe(expected);
    }
  });

  it("does not throw synchronously when fetch rejects", () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(() => dispatchWebhookEvent("shop-1", "return.approved", { id: "r" })).not.toThrow();
  });

  it("swallows Prisma findMany rejection without throwing", async () => {
    prismaMock.webhookSubscription.findMany.mockRejectedValue(new Error("db down"));
    expect(() => dispatchWebhookEvent("shop-1", "return.approved", { id: "r" })).not.toThrow();
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips delivery when SSRF re-check returns ok:false", async () => {
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: "private_ip" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      makeSub({ url: "http://169.254.169.254/imds" }),
    ]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips delivery when the SSRF re-check itself throws (fail closed)", async () => {
    isSafeOutboundUrlMock.mockRejectedValueOnce(new Error("dns failure"));
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── 3. Retry on 5xx ──────────────────────────────────────────────── */

describe("dispatchWebhookEvent — retry on failure", () => {
  it("counts an initial 5xx response as a delivery attempt (no immediate retry without timer advance)", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    // The initial attempt fired exactly once; retries are gated by 30 s/2 min
    // setTimeout we don't advance through.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries after the back-off delay using fake timers (initial 500 → retry succeeds)", async () => {
    vi.useFakeTimers();
    try {
      prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
      // First call fails with 500, the retry succeeds.
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true });

      dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });

      // Drain the initial async chain.
      await vi.advanceTimersByTimeAsync(0);
      // Initial attempt completes.
      // Then the retry loop awaits 30s — advance past it.
      await vi.advanceTimersByTimeAsync(30_000);
      // Allow the post-retry promise chain to settle.
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // No DLQ write because the retry succeeded.
      expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons the retry when subscription has been deactivated between attempts", async () => {
    vi.useFakeTimers();
    try {
      const sub = makeSub();
      prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
      // Initial attempt fails so we enter the retry loop.
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
      // Subscription has been disabled between attempts.
      prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);

      dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);

      // Only the initial attempt fired; the retry was abandoned.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── 4. DLQ write on permanent failure ────────────────────────────── */

describe("dispatchWebhookEvent — dead-letter queue", () => {
  it("persists to webhookDeliveryFailure when all attempts fail", async () => {
    vi.useFakeTimers();
    try {
      const sub = makeSub({ url: "https://broken.example.com/hook" });
      prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
      // All three attempts return 500.
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });

      dispatchWebhookEvent("shop-1", "return.approved", { id: "r-1" });
      // Initial attempt.
      await vi.advanceTimersByTimeAsync(0);
      // First retry after 30s.
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      // Second retry after 2min.
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledOnce();
      const data = (
        prismaMock.webhookDeliveryFailure.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(data.subscriptionId).toBe(sub.id);
      expect(data.shopId).toBe("shop-1");
      expect(data.eventType).toBe("return.approved");
      expect(data.url).toBe(sub.url);
      expect(data.attemptCount).toBe(3);
      expect(typeof data.payloadJson).toBe("string");
      expect(typeof data.idempotencyKey).toBe("string");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not write DLQ if the eventual retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce({ ok: true });

      dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a DLQ write failure without throwing", async () => {
    vi.useFakeTimers();
    try {
      prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      prismaMock.webhookDeliveryFailure.create.mockRejectedValue(new Error("DLQ table missing"));

      expect(() => dispatchWebhookEvent("shop-1", "return.approved", { x: 1 })).not.toThrow();

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
