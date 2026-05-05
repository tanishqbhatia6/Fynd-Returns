/**
 * Extra coverage for api.fynd-webhook-retry-cron.
 *
 * Focus areas (complementary to api.fynd-webhook-retry-cron.test.ts):
 *   1. Backoff sequence — verify each retryCount → delay mapping
 *      (5/15/60/240/720 minutes) produced by BACKOFF_MINUTES.
 *   2. Max retries cap — exhaustion semantics across both the
 *      "still ignored" branch and the "thrown error" branch.
 *   3. Batch processing — multiple logs in one cron tick, mixed
 *      outcomes, BATCH_SIZE handling, query shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, processFyndWebhookMock, unwrapFyndWebhookPayloadMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));

import { loader, action } from "../api.fynd-webhook-retry-cron";

const origEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...origEnv };
  process.env.CRON_SECRET = "topsecret";
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock
    .mockReset()
    .mockImplementation((raw: string) => ({ payload: JSON.parse(raw), eventType: "shipment.updated" }));
});
afterEach(() => {
  process.env = { ...origEnv };
  vi.useRealTimers();
});

function mkReq(opts: { method?: string; auth?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("Authorization", opts.auth);
  return new Request("https://app.example/api/fynd-webhook-retry-cron", {
    method: opts.method ?? "POST",
    headers,
  });
}

const BEARER = { auth: "Bearer topsecret" };
const FIXED_NOW = new Date("2026-05-05T12:00:00.000Z").getTime();

/**
 * Get the `data.retryAfter` Date from the most recent prisma update call.
 * Returns the delta from `now` in minutes (rounded to nearest int).
 */
function lastUpdateDelayMinutes(now: number): number {
  const calls = prismaMock.fyndWebhookLog.update.mock.calls;
  const last = calls[calls.length - 1][0];
  const ra: Date = last.data.retryAfter;
  return Math.round((ra.getTime() - now) / 60_000);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 1. Backoff sequence
 * ───────────────────────────────────────────────────────────────────────── */
describe("backoff sequence", () => {
  it("retryCount 0 → newCount 1 → 15 minutes (BACKOFF_MINUTES[1])", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "b-0", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(15);
  });

  it("retryCount 1 → newCount 2 → 60 minutes (BACKOFF_MINUTES[2])", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "b-1", rawPayload: JSON.stringify({}), retryCount: 1 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(60);
  });

  it("retryCount 2 → newCount 3 → 240 minutes (BACKOFF_MINUTES[3])", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "b-2", rawPayload: JSON.stringify({}), retryCount: 2 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(240);
  });

  it("retryCount 3 → newCount 4 → 720 minutes (BACKOFF_MINUTES[4])", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "b-3", rawPayload: JSON.stringify({}), retryCount: 3 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(720);
  });

  it("thrown-error branch uses 5 minutes when newCount=1 falls into BACKOFF_MINUTES[1]=15? actually maps to slot[newCount]=15", async () => {
    // Note: route uses BACKOFF_MINUTES[Math.min(newCount, len-1)]; newCount=1 → 15.
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "be-0", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockRejectedValueOnce(new Error("boom"));
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(15);
  });

  it("thrown-error branch with retryCount 3 → newCount 4 → 720 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "be-3", rawPayload: JSON.stringify({}), retryCount: 3 },
    ]);
    processFyndWebhookMock.mockRejectedValueOnce(new Error("boom"));
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    expect(lastUpdateDelayMinutes(FIXED_NOW)).toBe(720);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 2. Max retries cap
 * ───────────────────────────────────────────────────────────────────────── */
describe("max retries cap", () => {
  it("ignored-branch: retryCount 4 → newCount 5 → exhausted, retryAfter=null, error mentions Exhausted 5", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "x-1", rawPayload: JSON.stringify({}), retryCount: 4 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.exhausted).toBe(1);
    expect(body.rescheduled).toBe(0);
    const data = prismaMock.fyndWebhookLog.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(5);
    expect(data.retryAfter).toBeNull();
    expect(data.error).toMatch(/Exhausted 5 auto-retries/);
  });

  it("error-branch: retryCount 4 throwing → exhausted with retryAfter=null and error set", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "x-2", rawPayload: JSON.stringify({}), retryCount: 4 },
    ]);
    processFyndWebhookMock.mockRejectedValueOnce(new Error("kaboom"));
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.exhausted).toBe(1);
    const data = prismaMock.fyndWebhookLog.update.mock.calls[0][0].data;
    expect(data.retryCount).toBe(5);
    expect(data.retryAfter).toBeNull();
    expect(data.error).toMatch(/Exhausted 5 auto-retries after processing error/);
  });

  it("findMany filter enforces retryCount < MAX_RETRIES (5)", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const where = prismaMock.fyndWebhookLog.findMany.mock.calls[0][0].where;
    expect(where.retryCount).toEqual({ lt: 5 });
    expect(where.action).toBe("ignored");
    expect(where.rawPayload).toEqual({ not: null });
    // sevenDaysAgo gating
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    // retryAfter null OR <= now
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR[0]).toEqual({ retryAfter: null });
    expect(where.OR[1].retryAfter.lte).toBeInstanceOf(Date);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 3. Batch processing
 * ───────────────────────────────────────────────────────────────────────── */
describe("batch processing", () => {
  it("processes each log in the batch once, in order", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "p-1", rawPayload: JSON.stringify({ n: 1 }), retryCount: 0 },
      { id: "p-2", rawPayload: JSON.stringify({ n: 2 }), retryCount: 0 },
      { id: "p-3", rawPayload: JSON.stringify({ n: 3 }), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockResolvedValue({ ok: true, action: "updated" });
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.succeeded).toBe(3);
    expect(processFyndWebhookMock).toHaveBeenCalledTimes(3);
    // Order preserved (oldest first via orderBy createdAt asc)
    expect(processFyndWebhookMock.mock.calls[0][0]).toEqual({ n: 1 });
    expect(processFyndWebhookMock.mock.calls[1][0]).toEqual({ n: 2 });
    expect(processFyndWebhookMock.mock.calls[2][0]).toEqual({ n: 3 });
  });

  it("aggregates mixed outcomes (succeeded + rescheduled + exhausted) in one tick", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "m-1", rawPayload: JSON.stringify({}), retryCount: 0 }, // succeed
      { id: "m-2", rawPayload: JSON.stringify({}), retryCount: 1 }, // reschedule
      { id: "m-3", rawPayload: JSON.stringify({}), retryCount: 4 }, // exhaust
    ]);
    processFyndWebhookMock
      .mockResolvedValueOnce({ ok: true, action: "updated" })
      .mockResolvedValueOnce({ ok: true, action: "ignored" })
      .mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.succeeded).toBe(1);
    expect(body.rescheduled).toBe(1);
    expect(body.exhausted).toBe(1);
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({ where: { id: "m-1" } });
  });

  it("uses orderBy createdAt asc and take BATCH_SIZE=100", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const args = prismaMock.fyndWebhookLog.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.take).toBe(100);
  });

  it("one log throwing does not abort processing of subsequent logs", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "s-1", rawPayload: JSON.stringify({}), retryCount: 0 },
      { id: "s-2", rawPayload: JSON.stringify({}), retryCount: 0 },
      { id: "s-3", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    processFyndWebhookMock
      .mockResolvedValueOnce({ ok: true, action: "updated" })
      .mockRejectedValueOnce(new Error("middle blew up"))
      .mockResolvedValueOnce({ ok: true, action: "updated" });
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(3);
    expect(body.succeeded).toBe(2);
    expect(body.rescheduled).toBe(1);
    expect(processFyndWebhookMock).toHaveBeenCalledTimes(3);
  });

  it("logs with null rawPayload count toward processed but are skipped silently", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "n-1", rawPayload: null, retryCount: 0 },
      { id: "n-2", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "updated" });
    const res = await action({ request: mkReq(BEARER), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(processFyndWebhookMock).toHaveBeenCalledTimes(1);
  });

  it("GET loader path runs the same retry cron and returns aggregate counts", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "g-1", rawPayload: JSON.stringify({}), retryCount: 0 },
      { id: "g-2", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    processFyndWebhookMock
      .mockResolvedValueOnce({ ok: true, action: "updated" })
      .mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await loader({
      request: mkReq({ method: "GET", auth: "Bearer topsecret" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.rescheduled).toBe(1);
  });
});
