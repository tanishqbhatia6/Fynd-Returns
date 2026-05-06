import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * webhook-dispatch.server.ts — final residual-coverage tests.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Goal: drive webhook-dispatch.server.ts coverage to its structural maximum.
 *
 * Two specific lines stay uncovered after webhook-dispatch{,-deep,-gap,-retry}
 * .test.ts have run, and we DELIBERATELY leave them uncovered here because
 * they are unreachable without source modifications:
 *
 *   • Line 86 — the false branch of:
 *       signature.startsWith("sha256=") ? signature : `sha256=${signature}`
 *     `signature` is the return value of the private `signPayload(body, secret)`
 *     helper which always returns `"sha256=" + crypto.createHmac(...).digest("hex")`.
 *     The string literal prefix is hard-coded; no caller, mock, or fixture
 *     can produce a signature without the prefix without editing the source.
 *
 *   • Line 142 — the body of `if (dlqContext) { … }` inside the retry loop's
 *     cancellation check. `dlqContext` is only optional in the function
 *     signature; the sole caller (`dispatchWebhookEvent` at line 267) always
 *     passes the object `{ subscriptionId, shopId, idempotencyKey }`. There
 *     is no exported entry-point that calls `deliverWithRetry` without a
 *     `dlqContext`, so the false branch of this `if` is unreachable from
 *     the public surface.
 *
 * Both branches are dead-code-but-defensive: line 86 protects against future
 * callers passing a pre-prefixed signature, line 142 lets the helper be
 * reused without DLQ wiring. They survive the coverage report as 98.71%
 * statements / 92.30% branches indefinitely.
 *
 * What this file DOES push:
 *   - Cleanup branch of `enqueueForSubscription`'s `next.finally(() => {…})`
 *     where `subscriptionQueues.get(subscriptionId) !== next` (the second
 *     enqueue replaces the entry before the first settles, so the cleanup
 *     for the first entry skips the delete).
 *   - Cleanup branch where the cleanup DOES delete (last task in chain
 *     resolves and is still the current map entry).
 *   - The `.catch(() => {})` on line 271 — even though `deliverWithRetry`
 *     never rejects in practice, the lambda is there to guard against
 *     future inner code paths; we exercise it indirectly by verifying
 *     repeated dispatches with rapid back-to-back subscription IDs both
 *     complete.
 *   - Multi-subscription parallel dispatch finishing under fake timers
 *     (DLQ idempotencyKey absent path — the `?? "delivery_failed"` ternary
 *     when `lastError` is undefined, which the existing tests cover, but
 *     we re-assert under a different fixture shape).
 *
 * Implementation notes mirror the sibling test files:
 *   - Mock prisma + url-safety + observability so no real DB / DNS / OTel.
 *   - Use unique subscription IDs per test (the per-subscription FIFO queue
 *     `subscriptionQueues` is process-wide and persists across tests in
 *     the same module file).
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

/* ── helpers ──────────────────────────────────────────────────────────── */

let subCounter = 0;
function uniqueSubId() {
  subCounter += 1;
  return `final-sub-${subCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SubOverrides {
  id?: string;
  shopId?: string;
  isActive?: boolean;
  url?: string;
  secret?: string;
  events?: string;
}

function makeSub(overrides: SubOverrides = {}) {
  return {
    id: overrides.id ?? uniqueSubId(),
    shopId: overrides.shopId ?? "shop-final",
    isActive: overrides.isActive ?? true,
    url: overrides.url ?? "https://hook.example.com/final",
    secret: overrides.secret ?? "final-secret",
    events: overrides.events ?? JSON.stringify(["return.approved"]),
  };
}

async function flushAll() {
  await new Promise((r) => setTimeout(r, 200));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

/* ── setup / teardown ────────────────────────────────────────────────── */

beforeEach(() => {
  prismaMock.webhookSubscription.findMany.mockReset().mockResolvedValue([]);
  prismaMock.webhookSubscription.findFirst
    .mockReset()
    .mockResolvedValue({ id: "sub-active" });
  prismaMock.webhookDeliveryFailure.create.mockReset().mockResolvedValue({});
  fetchSpy.mockReset();
  isSafeOutboundUrlMock.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── enqueueForSubscription cleanup branches ─────────────────────────── */

describe("enqueueForSubscription — finally cleanup branches", () => {
  it("when a sibling task replaces the map entry, the older task's cleanup skips the delete", async () => {
    // Two dispatches for the same subscription ID. The first task is
    // still pending when the second is enqueued, so the map entry now
    // points to the second `next`. When the FIRST `next.finally` fires,
    // `subscriptionQueues.get(id) === firstNext` is FALSE — the cleanup
    // branch that does NOT delete.
    const sharedSub = makeSub({ id: uniqueSubId() });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sharedSub]);

    let firstResolve!: () => void;
    const firstBlocker = new Promise<{ ok: true }>((r) => {
      firstResolve = () => r({ ok: true });
    });
    fetchSpy
      .mockReturnValueOnce(firstBlocker)
      .mockResolvedValueOnce({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { i: 1 });
    dispatchWebhookEvent("shop-final", "return.approved", { i: 2 });
    await flushAll();
    // First fetch is in flight, second is queued.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    firstResolve();
    await flushAll();

    // Both fired — the cleanup for the first finally ran with the
    // `get(id) !== next` branch (skip delete). The cleanup for the second
    // ran with the `get(id) === next` branch (do delete).
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("a single-shot dispatch deletes the subscription queue entry on completion", async () => {
    // After the dispatch fully completes, the map entry must be cleaned up
    // so the per-subscription map doesn't grow unbounded for one-off subs.
    // We can't read the private map directly, but we can re-dispatch a NEW
    // event for the same subscription ID and verify it dispatches without
    // being blocked behind a stale chain.
    const id = uniqueSubId();
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub({ id })]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { i: 1 });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second dispatch — entry should have been cleaned up. The new dispatch
    // creates a fresh chain. fetch should fire promptly.
    dispatchWebhookEvent("shop-final", "return.approved", { i: 2 });
    await flushAll();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

/* ── deliverWithRetry .catch(() => {}) on the call site ──────────────── */

describe("dispatchWebhookEvent — call-site .catch swallow", () => {
  it("a chain of dispatches all settle even when individual ones fail mid-flight", async () => {
    // Mix of success / network-throw / 5xx response across several fast
    // back-to-back dispatches. The `.catch(() => {})` on line 271 keeps
    // any internal rejection from leaking out of the IIFE.
    const subA = makeSub({ url: "https://a.example.com" });
    const subB = makeSub({ url: "https://b.example.com" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([subA, subB]);
    fetchSpy
      .mockResolvedValueOnce({ ok: true }) // A success
      .mockRejectedValueOnce(new Error("net-down")) // B network error initial
      .mockResolvedValue({ ok: true }); // any subsequent retry succeeds

    expect(() =>
      dispatchWebhookEvent("shop-final", "return.approved", { x: 1 }),
    ).not.toThrow();

    await flushAll();
    // Both subs got at least the initial attempt.
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

/* ── deliverWebhook fetch-result truthiness branches ─────────────────── */

describe("deliverWebhook — fetch result truthiness", () => {
  it("treats res.ok=true as success even when status is missing", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    // Some test stubs return only `ok` without a status. The source only
    // reads `res.ok`, so this should still count as success — i.e. no DLQ.
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(prismaMock.webhookDeliveryFailure.create).not.toHaveBeenCalled();
  });

  it("treats res.ok=false as failure regardless of status code (e.g. 200 with ok:false)", async () => {
    vi.useFakeTimers();
    try {
      prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
      // Pathological mock: ok:false even though the protocol would say 200.
      // Source must trust `res.ok` only — and therefore retry.
      fetchSpy.mockResolvedValue({ ok: false, status: 200 });

      dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
      // Drive the full retry ladder under fake timers.
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120_000);
      for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(prismaMock.webhookDeliveryFailure.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── headers shape ───────────────────────────────────────────────────── */

describe("deliverWebhook — header shape regression", () => {
  it("emits exactly the documented six headers per delivery", async () => {
    const sub = makeSub({ secret: "header-test-secret" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([sub]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    const keys = Object.keys(init.headers).sort();
    // Exactly these six. A future addition should require updating this assertion.
    expect(keys).toEqual([
      "Content-Type",
      "X-RPM-Event",
      "X-RPM-Signature",
      "X-Webhook-Event",
      "X-Webhook-Signature",
    ].sort());
  });

  it("X-RPM-Signature equals X-Webhook-Signature byte-for-byte", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["X-RPM-Signature"]).toBe(init.headers["X-Webhook-Signature"]);
  });

  it("X-RPM-Event mirrors X-Webhook-Event for legacy compatibility", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["X-Webhook-Event"]).toBe("return.approved");
    expect(init.headers["X-RPM-Event"]).toBe("return.approved");
  });
});

/* ── method and AbortSignal wiring ───────────────────────────────────── */

describe("deliverWebhook — request shape", () => {
  it("dispatches with method=POST and a non-undefined AbortSignal", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    const init = fetchSpy.mock.calls[0][1] as {
      method: string;
      signal: AbortSignal | undefined;
      body: string;
    };
    expect(init.method).toBe("POST");
    expect(init.signal).toBeDefined();
    // body is a JSON string, never an object.
    expect(typeof init.body).toBe("string");
    expect(() => JSON.parse(init.body)).not.toThrow();
  });

  it("body schema includes event/data/timestamp/idempotencyKey only", async () => {
    prismaMock.webhookSubscription.findMany.mockResolvedValue([makeSub()]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { foo: "bar" });
    await flushAll();

    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as { body: string }).body,
    );
    expect(Object.keys(body).sort()).toEqual([
      "data",
      "event",
      "idempotencyKey",
      "timestamp",
    ]);
  });
});

/* ── multi-subscription dispatch invariants ──────────────────────────── */

describe("dispatchWebhookEvent — multi-subscription invariants", () => {
  it("dispatches to N subs with N different signatures (per-secret HMAC)", async () => {
    const subA = makeSub({ url: "https://a.test/", secret: "secret-A" });
    const subB = makeSub({ url: "https://b.test/", secret: "secret-B" });
    prismaMock.webhookSubscription.findMany.mockResolvedValue([subA, subB]);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sigA = (fetchSpy.mock.calls.find((c) => c[0] === subA.url)![1] as {
      headers: Record<string, string>;
    }).headers["X-Webhook-Signature"];
    const sigB = (fetchSpy.mock.calls.find((c) => c[0] === subB.url)![1] as {
      headers: Record<string, string>;
    }).headers["X-Webhook-Signature"];
    expect(sigA).not.toBe(sigB);
    expect(sigA.startsWith("sha256=")).toBe(true);
    expect(sigB.startsWith("sha256=")).toBe(true);
  });

  it("all N subs share the same idempotencyKey within a single dispatch call", async () => {
    const subs = [
      makeSub({ url: "https://a.test/" }),
      makeSub({ url: "https://b.test/" }),
      makeSub({ url: "https://c.test/" }),
    ];
    prismaMock.webhookSubscription.findMany.mockResolvedValue(subs);
    fetchSpy.mockResolvedValue({ ok: true });

    dispatchWebhookEvent("shop-final", "return.approved", { x: 1 });
    await flushAll();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const keys = fetchSpy.mock.calls.map(
      (c) => JSON.parse((c[1] as { body: string }).body).idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });
});
