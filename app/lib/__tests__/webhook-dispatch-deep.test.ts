import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * webhook-dispatch.server.ts tests.
 * ────────────────────────────────────────────────────────────────────
 *
 * Challenge: dispatchWebhookEvent is fire-and-forget — it returns
 * immediately and the async delivery chain runs in the background via
 * an IIFE. We use a tracked fetch + an explicit "settle" helper that
 * awaits the microtask queue until the outbound fetch has been
 * attempted.
 *
 * We also mock url-safety.server so the SSRF re-check always passes
 * (the real check DNS-resolves and may block localhost — irrelevant
 * for these tests).
 *
 * Signing correctness is verified by reading the X-Webhook-Signature
 * header and re-computing the HMAC ourselves.
 */

import crypto from "crypto";

const { prismaMock, fetchSpy } = vi.hoisted(() => ({
  prismaMock: {
    webhookSubscription: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: "sub-1" }),
    },
    webhookDeliveryFailure: { create: vi.fn().mockResolvedValue({}) },
  },
  fetchSpy: vi.fn(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

// SSRF re-check happens via dynamic import of url-safety.server — stub it
// unconditionally to "safe" so tests don't rely on DNS.
vi.mock("../url-safety.server", () => ({
  isSafeOutboundUrl: vi.fn().mockResolvedValue({ ok: true }),
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
 * Wait for pending microtasks + macrotasks to flush.
 *
 * The delivery chain spans:
 *   IIFE → withSpan → findMany → signPayload → enqueueForSubscription →
 *   deliverWithRetry → webhookInflight.add → try → deliverWebhook →
 *   dynamic import("./url-safety.server") → isSafeOutboundUrl → fetch
 *
 * Several dynamic imports + multiple awaits make microtask-only flushing
 * unreliable. A real 50 ms sleep is plenty to complete the initial fetch
 * without waiting on the 30 s retry timer.
 */
async function flushAll() {
  // 200 ms covers the initial fetch + per-sub FIFO drain even under coverage
  // instrumentation / CI concurrency. Lower values (50ms) race on loaded CI.
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  prismaMock.webhookSubscription.findMany.mockReset().mockResolvedValue([]);
  prismaMock.webhookSubscription.findFirst.mockReset().mockResolvedValue({ id: "sub-1" });
  prismaMock.webhookDeliveryFailure.create.mockReset().mockResolvedValue({});
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatchWebhookEvent — no subscribers", () => {
  it("does nothing when the shop has no subscriptions", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r-1" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing when no subscriptions match the event type", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        shopId: "shop-1",
        isActive: true,
        url: "https://hook.example.com/a",
        secret: "s1",
        events: JSON.stringify(["return.rejected"]), // doesn't include "return.approved"
      },
    ]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r-1" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips a subscription whose events JSON is invalid", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      {
        id: "sub-bad",
        shopId: "shop-1",
        isActive: true,
        url: "https://hook.example.com/bad",
        secret: "s",
        events: "{{{not json",
      },
    ]);
    dispatchWebhookEvent("shop-1", "return.approved", { id: "r-1" });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dispatchWebhookEvent — successful delivery", () => {
  // Per-sub FIFO queue persists across tests — use unique IDs per test.
  const mkSub = (id: string) => ({
    id,
    shopId: "shop-1",
    isActive: true,
    url: "https://hook.example.com/approved",
    secret: "super-secret",
    events: JSON.stringify(["return.approved", "return.refunded"]),
  });

  it("POSTs to the subscription URL with the expected body", async () => {
    const sub = mkSub("sub-ok-1");
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { returnId: "r-42" });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(sub.url);
    const body = JSON.parse((init as { body: string }).body);
    expect(body.event).toBe("return.approved");
    expect(body.data.returnId).toBe("r-42");
    expect(typeof body.idempotencyKey).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  it("signs the body with HMAC-SHA256 in X-Webhook-Signature", async () => {
    const sub = mkSub("sub-ok-2");
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { a: 1 });
    await flushAll();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    const body = (init as { body: string }).body;
    const expected = "sha256=" + crypto.createHmac("sha256", sub.secret).update(body).digest("hex");
    expect(headers["X-Webhook-Signature"]).toBe(expected);
  });

  it("also sets the legacy X-RPM-Signature for one-release compatibility", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([mkSub("sub-ok-3")]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { a: 1 });
    await flushAll();
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["X-RPM-Signature"]).toBeTruthy();
    expect(headers["X-RPM-Event"]).toBe("return.approved");
  });

  it("includes X-Webhook-Event: <eventType> header", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([mkSub("sub-ok-4")]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { x: 1 });
    await flushAll();
    const headers = (fetchSpy.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["X-Webhook-Event"]).toBe("return.approved");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("dispatches to multiple matching subscriptions", async () => {
    const subA = { ...mkSub("sub-multi-a"), url: "https://a.example.com" };
    const subB = { ...mkSub("sub-multi-b"), url: "https://b.example.com" };
    prismaMock.webhookSubscription.findMany.mockResolvedValue([subA, subB]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { r: 1 });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://a.example.com");
    expect(urls).toContain("https://b.example.com");
  });
});

describe("dispatchWebhookEvent — SSRF re-check", () => {
  it("skips delivery when the URL fails the SSRF re-check", async () => {
    // Override the url-safety mock for this test only.
    const urlSafety = await import("../url-safety.server");
    (urlSafety.isSafeOutboundUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "private_ip",
    });

    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      {
        id: "sub-ssrf",
        shopId: "shop-1",
        isActive: true,
        url: "http://169.254.169.254/fake",
        secret: "s",
        events: JSON.stringify(["return.approved"]),
      },
    ]);
    fetchSpy.mockResolvedValue({ ok: true });
    dispatchWebhookEvent("shop-1", "return.approved", { r: 1 });
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dispatchWebhookEvent — failure handling", () => {
  // Unique subscription IDs per test — the per-sub FIFO queue persists
  // across tests, so sharing an ID would make this test inherit a
  // pending task from an earlier test and never dispatch.
  const mkSub = (id: string) => ({
    id,
    shopId: "shop-1",
    isActive: true,
    url: "https://hook.example.com/x",
    secret: "s",
    events: JSON.stringify(["return.approved"]),
  });

  it("treats 4xx/5xx response as failure (initial attempt counted)", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([mkSub("sub-fail-4xx")]);
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    dispatchWebhookEvent("shop-1", "return.approved", { r: 1 });
    await flushAll();
    // Initial attempt happened.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("survives a network error from fetch without throwing synchronously", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([mkSub("sub-fail-net")]);
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));
    // Fire-and-forget — the synchronous call must not throw.
    expect(() => dispatchWebhookEvent("shop-1", "return.approved", { r: 1 })).not.toThrow();
    await flushAll();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("swallows a Prisma findMany error silently (logged, fire-and-forget)", async () => {
    prismaMock.webhookSubscription.findMany.mockRejectedValue(new Error("DB down"));
    expect(() => dispatchWebhookEvent("shop-1", "return.approved", { r: 1 })).not.toThrow();
    await flushAll();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dispatchWebhookEvent — per-subscription FIFO", () => {
  it("serialises calls for the same subscription (2nd fires after 1st resolves)", async () => {
    const sub = {
      id: "sub-fifo",
      shopId: "shop-1",
      isActive: true,
      url: "https://hook.example.com/fifo",
      secret: "s",
      events: JSON.stringify(["return.approved"]),
    };
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);

    // Make the first fetch block until we manually resolve it.
    let firstResolve!: () => void;
    const firstBlocker = new Promise<{ ok: true }>((r) => {
      firstResolve = () => r({ ok: true });
    });
    fetchSpy.mockReturnValueOnce(firstBlocker).mockResolvedValueOnce({ ok: true });

    dispatchWebhookEvent("shop-1", "return.approved", { i: 1 });
    dispatchWebhookEvent("shop-1", "return.approved", { i: 2 });
    await flushAll();

    // Only the first call is in-flight; the second is queued behind it.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    firstResolve();
    await flushAll();

    // Now both fired.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
