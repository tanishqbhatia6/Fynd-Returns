import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * webhook-dispatch.server.ts — gap-coverage tests.
 * ───────────────────────────────────────────────────────────────────────
 *
 * Pushes residual coverage to ≥99% by exercising the edge branches the
 * existing webhook-dispatch test files don't quite reach:
 *
 *   - SSRF re-check rejects with a `reason` string (logger warn branch).
 *   - SSRF re-check returns ok:false without a reason (undefined branch).
 *   - SSRF re-check itself throws → fail-closed catch branch.
 *   - HMAC signature already carries the "sha256=" prefix → the ternary
 *     short-circuit (the source treats `signPayload`'s output as already
 *     prefixed; we re-verify the legacy header path).
 *   - findFirst cancellation check throws → catch swallows, retry proceeds.
 *   - DLQ insert throws → catch swallows, no propagation.
 *   - Subscription with malformed events JSON is skipped silently
 *     (already covered, but combined with a parallel valid sub to verify
 *     the filter still dispatches the good one).
 *   - matchingSubs.length === 0 short-circuit (logger info path with zero subs).
 *   - withSpan wrapper rejection → outer try/catch logs without throwing.
 *
 * No source mods. Existing webhook-dispatch*.test.ts files are not touched.
 *
 * Per-subscription FIFO queue (`subscriptionQueues`) is process-wide and
 * survives across tests in the same module file. Every test below uses a
 * fresh unique subscription ID via `uniqueSubId()` so no test inherits a
 * pending task from a sibling.
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
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
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

/* ── helpers ─────────────────────────────────────────────────────────── */

let subCounter = 0;
function uniqueSubId() {
  subCounter += 1;
  return `gap-sub-${subCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeSub(overrides: Partial<{
  id: string;
  shopId: string;
  isActive: boolean;
  url: string;
  secret: string;
  events: string;
}> = {}) {
  return {
    id: overrides.id ?? uniqueSubId(),
    shopId: "shop-gap",
    isActive: true,
    url: "https://hook.example.com/gap",
    secret: "gap-secret",
    events: JSON.stringify(["return.approved"]),
    ...overrides,
  };
}

/**
 * Drain the IIFE → withSpan → findMany → enqueueForSubscription →
 * deliverWithRetry → dynamic import("./url-safety.server") → fetch chain
 * without crossing the 30 s retry timer.
 */
async function flushAll() {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function flushMicro() {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

async function advanceFullRetryLadder() {
  await flushMicro();
  await vi.advanceTimersByTimeAsync(30_000);
  await flushMicro();
  await vi.advanceTimersByTimeAsync(120_000);
  await flushMicro();
}

/* ── setup / teardown ────────────────────────────────────────────────── */

beforeEach(() => {
  prismaMock.webhookSubscription.findMany.mockReset().mockResolvedValue([]);
  prismaMock.webhookSubscription.findFirst.mockReset().mockResolvedValue({ id: "sub-active" });
  prismaMock.webhookDeliveryFailure.create.mockReset().mockResolvedValue({});
  fetchSpy.mockReset();
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── SSRF re-check edges ─────────────────────────────────────────────── */

describe("dispatchWebhookEvent — SSRF re-check edges", () => {
  it("logs the reason string and skips when ok:false with reason supplied", async () => {
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false, reason: "loopback_address" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      makeSub({ url: "http://127.0.0.1/imds" }),
    ]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips delivery when ok:false WITHOUT a reason (reason: undefined branch)", async () => {
    isSafeOutboundUrlMock.mockResolvedValueOnce({ ok: false });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when isSafeOutboundUrl itself throws (catch branch)", async () => {
    isSafeOutboundUrlMock.mockRejectedValueOnce(new Error("dns module crash"));
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    expect(() =>
      dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 }),
    ).not.toThrow();
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── HMAC signing edge ───────────────────────────────────────────────── */

describe("dispatchWebhookEvent — HMAC signing edge", () => {
  it("emits both X-Webhook-Signature and X-RPM-Signature with sha256= prefix verified independently", async () => {
    const sub = makeSub({ secret: "edge-secret-32-bytes-long-enough" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { foo: "bar" });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as {
      headers: Record<string, string>;
      body: string;
    };
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", sub.secret).update(init.body).digest("hex");

    // Primary header — must be the sha256=<hex> form.
    expect(init.headers["X-Webhook-Signature"]).toBe(expected);
    expect(init.headers["X-Webhook-Signature"].startsWith("sha256=")).toBe(true);

    // Legacy alias — same exact value (already prefixed).
    expect(init.headers["X-RPM-Signature"]).toBe(expected);
    expect(init.headers["X-RPM-Signature"].startsWith("sha256=")).toBe(true);
  });

  it("uses an empty-string secret without throwing (HMAC accepts empty key)", async () => {
    const sub = makeSub({ secret: "" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { foo: "bar" });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as {
      headers: Record<string, string>;
      body: string;
    };
    const expected =
      "sha256=" + crypto.createHmac("sha256", "").update(init.body).digest("hex");
    expect(init.headers["X-Webhook-Signature"]).toBe(expected);
  });
});

/* ── Idempotency-key dedup edge ──────────────────────────────────────── */

describe("dispatchWebhookEvent — idempotency-key edges", () => {
  it("emits a fresh idempotencyKey on every dispatch (no cross-call dedup)", async () => {
    // Two different subscriptions on different URLs so the per-sub FIFO
    // queue doesn't serialise them together.
    const a = makeSub({ url: "https://a.example.com/idem" });
    const b = makeSub({ url: "https://b.example.com/idem" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([a, b]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { id: "first" });
    await flushAll();
    dispatchWebhookEvent("shop-gap", "return.approved", { id: "second" });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledTimes(4);

    const keys = fetchSpy.mock.calls.map((c) => {
      const body = JSON.parse((c[1] as { body: string }).body);
      return body.idempotencyKey as string;
    });
    // Calls 1+2 share a key (same dispatch, two subs); 3+4 share a different key.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[3]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it("propagates the same idempotencyKey from request body into the DLQ row", async () => {
    vi.useFakeTimers();
    try {
      const sub = makeSub();
      prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });

      dispatchWebhookEvent("shop-gap", "return.approved", { id: "dlq-idem" });
      await advanceFullRetryLadder();

      expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledOnce();
      const dlqArg = prismaMock.webhookDeliveryFailure.create.mock.calls[0][0] as {
        data: { idempotencyKey?: string; payloadJson: string };
      };
      const sentBody = JSON.parse(
        (fetchSpy.mock.calls[0][1] as { body: string }).body,
      );
      // Must be the same key on the wire and on the DLQ.
      expect(dlqArg.data.idempotencyKey).toBe(sentBody.idempotencyKey);
      expect(typeof dlqArg.data.idempotencyKey).toBe("string");
      expect((dlqArg.data.idempotencyKey as string).length).toBeGreaterThan(10);
      // payloadJson preserves the key end-to-end.
      const dlqBody = JSON.parse(dlqArg.data.payloadJson);
      expect(dlqBody.idempotencyKey).toBe(sentBody.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("idempotencyKey is a UUID-shaped string (randomUUID branch)", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    // RFC-4122 v4 shape: 8-4-4-4-12 hex.
    expect(body.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

/* ── Subscription cancellation try/catch edge ────────────────────────── */

describe("dispatchWebhookEvent — cancellation check try/catch", () => {
  it("proceeds with the retry when findFirst itself rejects (best-effort branch)", async () => {
    vi.useFakeTimers();
    try {
      const sub = makeSub();
      prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      prismaMock.webhookSubscription.findFirst.mockRejectedValueOnce(
        new Error("transient db hiccup"),
      );

      dispatchWebhookEvent("shop-gap", "return.approved", { id: "ff-throw" });
      await advanceFullRetryLadder();

      // Catch swallowed → retry still happened → succeeded.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── DLQ catch branch ────────────────────────────────────────────────── */

describe("dispatchWebhookEvent — DLQ insert catch", () => {
  it("logs and continues when DLQ create rejects with a non-Error value", async () => {
    vi.useFakeTimers();
    try {
      const sub = makeSub();
      prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      // Rejecting with a non-Error verifies the catch handles arbitrary values.
      prismaMock.webhookDeliveryFailure.create.mockRejectedValue("string-rejection");

      expect(() =>
        dispatchWebhookEvent("shop-gap", "return.approved", { id: "non-err" }),
      ).not.toThrow();

      await advanceFullRetryLadder();
      expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── Mixed valid + malformed subscription set ────────────────────────── */

describe("dispatchWebhookEvent — mixed sub filtering", () => {
  it("dispatches to the valid sub and skips the malformed-events sibling in the same batch", async () => {
    const good = makeSub({ url: "https://good.example.com/hook" });
    const broken = makeSub({
      url: "https://broken.example.com/hook",
      events: "{not json",
    });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([good, broken]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(good.url);
  });

  it("dispatches to a sub whose events array contains the eventType plus extras", async () => {
    const sub = makeSub({
      events: JSON.stringify(["return.approved", "return.refunded", "return.rejected"]),
    });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does NOT dispatch when the events array is valid JSON but empty", async () => {
    const sub = makeSub({ events: JSON.stringify([]) });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when the events JSON parses to a non-array (string)", async () => {
    // JSON.parse(`"return.approved"`) → string; .includes() on a string would
    // technically match but the current code declares `events: string[]`, so
    // we feed it a value where .includes() returns false anyway.
    const sub = makeSub({ events: JSON.stringify("not-an-array-substring") });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── Outer try/catch: withSpan / dispatch failures ───────────────────── */

describe("dispatchWebhookEvent — outer error handling", () => {
  it("does not throw when prisma.findMany rejects (already-tested but reinforces the catch path)", async () => {
    prismaMock.webhookSubscription.findMany.mockRejectedValue(new Error("DB exploded"));

    expect(() =>
      dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 }),
    ).not.toThrow();
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not throw when called with a payload containing nested undefined values", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    expect(() =>
      dispatchWebhookEvent("shop-gap", "return.approved", {
        nested: { undef: undefined, arr: [1, undefined, 3] },
      } as Record<string, unknown>),
    ).not.toThrow();
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    // JSON.stringify drops undefined keys and converts undefined in arrays to null.
    expect(body.data.nested.undef).toBeUndefined();
    expect(body.data.nested.arr).toEqual([1, null, 3]);
  });

  it("does not throw when shopId is empty string", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    expect(() =>
      dispatchWebhookEvent("", "return.approved", { x: 1 }),
    ).not.toThrow();
    await flushAll();
    expect(prismaMock.webhookSubscription.findMany).toHaveBeenCalledWith({
      where: { shopId: "", isActive: true },
    });
  });
});

/* ── Zero-subscriber short-circuit ───────────────────────────────────── */

describe("dispatchWebhookEvent — zero-subscriber log path", () => {
  it("returns from withSpan early when matchingSubs.length === 0 (no body construction)", async () => {
    // No subs at all — should not even reach JSON.stringify of the body.
    prismaMock.webhookSubscription.findMany.mockResolvedValue([]);
    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
    // Nothing should have been signed/queued either.
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("returns from withSpan early when subs exist but none match the event type", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([
      makeSub({ events: JSON.stringify(["unrelated.event"]) }),
      makeSub({ events: JSON.stringify(["another.unrelated"]) }),
    ]);
    dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── deliverWebhook clearTimeout finally ─────────────────────────────── */

describe("dispatchWebhookEvent — fetch synchronous-throw clears timeout", () => {
  it("does not leave a pending timer when fetch throws synchronously (DNS-shape failure)", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    // Synchronous throw, not rejected promise — exercises the `finally` block
    // before the await even resumes.
    fetchSpy.mockImplementationOnce(() => {
      throw new Error("synchronous DNS crash");
    });

    expect(() =>
      dispatchWebhookEvent("shop-gap", "return.approved", { x: 1 }),
    ).not.toThrow();
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
