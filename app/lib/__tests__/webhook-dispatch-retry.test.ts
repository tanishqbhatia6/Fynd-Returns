import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * webhook-dispatch.server.ts — extra tests for the deliverWithRetry private path.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * These tests exercise the private `deliverWithRetry` helper exclusively
 * through the public `dispatchWebhookEvent` surface. They focus on the
 * retry/back-off ladder, DLQ persistence shape, and edge cases around
 * mid-retry subscription cancellation that the broader webhook-dispatch
 * test files only cover lightly.
 *
 * Strategy:
 *   - global fetch is replaced with a vi.fn() whose `mockResolvedValueOnce`
 *     queue lets us script per-attempt responses (5xx → 5xx → 200, etc.).
 *   - prismaMock.webhookDeliveryFailure.create is stubbed so we can assert
 *     the exact DLQ payload written when the 3-attempt ladder is exhausted.
 *   - vi.useFakeTimers() advances past the 30 s + 2 min retry back-offs
 *     deterministically so tests run instantly.
 *   - All other collaborators (logger, tracing, metrics, url-safety) are
 *     mocked the same way the existing webhook-dispatch test files do, so
 *     this file slots into the existing harness without surprises.
 *
 * Note on subscription IDs:
 *   The module keeps a process-wide per-subscription FIFO queue
 *   (`subscriptionQueues`) that survives across tests. Reusing the same
 *   ID inherits a pending task from the previous test, which silently
 *   stalls the new one — every test below uses a fresh unique ID.
 */

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

/* ── helpers ───────────────────────────────────────────────────────── */

let subCounter = 0;
function uniqueSubId() {
  subCounter += 1;
  return `retry-sub-${subCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    id: overrides.id ?? uniqueSubId(),
    shopId: "shop-retry",
    isActive: true,
    url: "https://hook.example.com/retry",
    secret: "retry-secret",
    events: JSON.stringify(["return.approved"]),
    ...overrides,
  };
}

/**
 * Drive the IIFE chain forward under fake timers.
 *
 *   IIFE → withSpan → findMany → enqueueForSubscription →
 *   deliverWithRetry → dynamic import("./url-safety.server") → fetch →
 *   (back-off setTimeout) → fetch → ...
 *
 * Each step is a microtask; advanceTimersByTimeAsync(0) drains microtasks
 * without moving the simulated clock. We also poke setImmediate a few
 * times because dynamic imports schedule across both queues.
 */
async function flushMicro() {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

/**
 * Advance past the full retry ladder: initial fetch + 30 s + 2 min.
 * Used by tests that expect all three attempts to fire.
 */
async function advanceFullRetryLadder() {
  await flushMicro();
  await vi.advanceTimersByTimeAsync(30_000);
  await flushMicro();
  await vi.advanceTimersByTimeAsync(120_000);
  await flushMicro();
}

/* ── setup / teardown ──────────────────────────────────────────────── */

beforeEach(() => {
  prismaMock.webhookSubscription.findMany.mockReset().mockResolvedValue([]);
  // Default: subscription is still active when checked between retries.
  prismaMock.webhookSubscription.findFirst.mockReset().mockResolvedValue({ id: "sub-active" });
  prismaMock.webhookDeliveryFailure.create.mockReset().mockResolvedValue({});
  fetchSpy.mockReset();
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── tests ─────────────────────────────────────────────────────────── */

describe("deliverWithRetry — sequenced 5xx → 200 retry ladder", () => {
  it("succeeds on the first retry when initial 503 is followed by 200", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-1" });

    await flushMicro();
    // Only the initial attempt has fired so far — the 30 s back-off blocks the retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicro();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Success on retry → no DLQ row.
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("succeeds on the second retry when 500 → 502 → 200 sequence is delivered", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-2" });
    await advanceFullRetryLadder();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("does not exceed 3 total attempts even when every response is 5xx", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-3" });
    await advanceFullRetryLadder();

    // Initial + 2 retries = exactly 3 attempts.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // And then a single DLQ row.
    expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledTimes(1);
  });

  it("waits 30 s before the first retry and 2 min before the second", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 504 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-4" });
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 29 s isn't enough to clear the first back-off.
    await vi.advanceTimersByTimeAsync(29_000);
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The remaining 1 s clears it.
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // 119 s isn't enough to clear the 2 min back-off.
    await vi.advanceTimersByTimeAsync(119_000);
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("treats a fetch network rejection on attempt 1 the same as a 5xx (proceeds to retry)", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-5" });
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicro();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("recovers from a mixed sequence of network error then 5xx then 200", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-6" });
    await advanceFullRetryLadder();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });
});

describe("deliverWithRetry — DLQ write on permanent failure", () => {
  it("writes a DLQ row with the correct shape after exhausting all retries", async () => {
    const sub = makeSub({ url: "https://broken.example.com/hook" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 503 });

    dispatchWebhookEvent("shop-retry", "return.approved", { returnId: "r-dlq" });
    await advanceFullRetryLadder();

    expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledTimes(1);
    const arg = prismaMock.webhookDeliveryFailure.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.subscriptionId).toBe(sub.id);
    expect(arg.data.shopId).toBe("shop-retry");
    expect(arg.data.eventType).toBe("return.approved");
    expect(arg.data.url).toBe(sub.url);
    expect(arg.data.attemptCount).toBe(3);
    expect(typeof arg.data.payloadJson).toBe("string");
    expect(typeof arg.data.idempotencyKey).toBe("string");
    // payloadJson is the exact body that was POSTed.
    const parsed = JSON.parse(arg.data.payloadJson as string);
    expect(parsed.event).toBe("return.approved");
    expect(parsed.data).toEqual({ returnId: "r-dlq" });
    expect(parsed.idempotencyKey).toBe(arg.data.idempotencyKey);
  });

  it("uses the same idempotencyKey for body and DLQ row", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-idem" });
    await advanceFullRetryLadder();

    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    const dlqArg = prismaMock.webhookDeliveryFailure.create.mock.calls[0][0] as {
      data: { idempotencyKey: string; payloadJson: string };
    };
    expect(dlqArg.data.idempotencyKey).toBe(sentBody.idempotencyKey);
    const dlqBody = JSON.parse(dlqArg.data.payloadJson);
    expect(dlqBody.idempotencyKey).toBe(sentBody.idempotencyKey);
  });

  it("falls back to lastError 'delivery_failed' when no specific error string is captured", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-le" });
    await advanceFullRetryLadder();

    const dlqArg = prismaMock.webhookDeliveryFailure.create.mock.calls[0][0] as {
      data: { lastError: string };
    };
    expect(dlqArg.data.lastError).toBe("delivery_failed");
  });

  it("does not write a DLQ row when the final retry succeeds", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-rec" });
    await advanceFullRetryLadder();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("does not throw when the DLQ insert itself fails", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: false, status: 500 });
    prismaMock.webhookDeliveryFailure.create.mockRejectedValue(new Error("DLQ write blew up"));

    expect(() =>
      dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-bad-dlq" }),
    ).not.toThrow();

    await advanceFullRetryLadder();
    // We still attempted to write — the rejection is swallowed, not fatal.
    expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledTimes(1);
  });
});

describe("deliverWithRetry — mid-retry subscription cancellation", () => {
  it("abandons the retry loop when the subscription is deactivated between attempts", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    // Initial attempt fails so we enter the retry path.
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    // The mid-retry "still active?" check returns null → abandon.
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-cxl" });
    await advanceFullRetryLadder();

    // Only the initial attempt fired — the retry was skipped entirely.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // And we never reached the "exhausted" branch, so no DLQ row.
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("queries findFirst with id+isActive when checking cancellation", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500 });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-cxl-2" });
    await advanceFullRetryLadder();

    expect(prismaMock.webhookSubscription.findFirst).toHaveBeenCalledWith({
      where: { id: sub.id, isActive: true },
      select: { id: true },
    });
  });

  it("proceeds with the retry when findFirst itself throws (best-effort)", async () => {
    const sub = makeSub();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    prismaMock.webhookSubscription.findFirst.mockRejectedValueOnce(
      new Error("transient db hiccup"),
    );

    dispatchWebhookEvent("shop-retry", "return.approved", { id: "r-cxl-3" });
    await advanceFullRetryLadder();

    // The cancellation check failed soft → retry still happened → succeeded.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });
});
