import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Extra coverage for fynd-retry.server.ts.
 *
 * Targets edges not exercised by fynd-retry.test.ts:
 *  - exponential backoff math (2/5/15/60/240 minutes, plus saturation past index)
 *  - scheduleRetry behaviour (initial delay, error pass-through)
 *  - runFyndRetryQueue: non-Error throws, payload JSON serialization,
 *    retainment of existing fynd identifiers when sync result omits them,
 *    error truncation, multi-case batch processing, and findMany filter.
 */

const {
  prismaMock,
  createFyndClientMock,
  createReturnOnFyndMock,
  loggerInfoMock,
  loggerErrorMock,
  retryAttemptAdd,
  retryExhaustedAdd,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createFyndClientMock: vi.fn(),
  createReturnOnFyndMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  retryAttemptAdd: vi.fn(),
  retryExhaustedAdd: vi.fn(),
}));

Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../fynd.server", () => ({
  createFyndClientOrError: createFyndClientMock,
}));

vi.mock("../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: loggerInfoMock, error: loggerErrorMock, warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: vi.fn((_name: string, _attrs: unknown, cb: (span: unknown) => unknown) =>
    cb({ setAttribute: vi.fn(), setAttributes: vi.fn() }),
  ),
}));

vi.mock("../observability/metrics.server", () => ({
  fyndRetryAttempt: { add: retryAttemptAdd },
  fyndRetryExhausted: { add: retryExhaustedAdd },
}));

import { runFyndRetryQueue, scheduleRetry } from "../fynd-retry.server";

const fakePlatformClient = { getShipments: vi.fn() };

function mkCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-extra",
    fyndReturnId: null,
    fyndReturnNo: null,
    fyndOrderId: "O-1",
    fyndShipmentId: "S-1",
    fyndSyncRetries: 0,
    fyndSyncStatus: "failed",
    fyndPayloadJson: null,
    items: [],
    shop: { settings: { fyndCredentials: "encrypted" } },
    ...overrides,
  };
}

// Monotonically advancing base time — module-scope `lastRetryRun` in
// fynd-retry.server.ts persists across tests, so each test must advance
// further into the "future" than any prior test's runFyndRetryQueue() call.
let baseTime = new Date("2030-01-01T00:00:00Z").getTime();

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientMock.mockReset();
  createReturnOnFyndMock.mockReset();
  loggerInfoMock.mockClear();
  loggerErrorMock.mockClear();
  retryAttemptAdd.mockClear();
  retryExhaustedAdd.mockClear();
  // Bypass module-scope throttle window between tests by jumping a full
  // hour ahead of any prior test.
  baseTime += 60 * 60_000;
  vi.useFakeTimers();
  vi.setSystemTime(baseTime);
});

/** Advance enough time to bypass the module-scope retry throttle. */
function bypassThrottle() {
  baseTime += 60 * 60_000;
  vi.setSystemTime(baseTime);
}

/** Read the next-retry Date from the most recent prisma update call. */
function lastUpdateNextRetry(): Date {
  const calls = prismaMock.returnCase.update.mock.calls;
  const data = calls[calls.length - 1][0].data;
  return data.fyndSyncNextRetry as Date;
}

describe("backoff math (via runFyndRetryQueue retry scheduling)", () => {
  it.each([
    // [previousRetries, expectedMinutes]
    // newRetries = previousRetries + 1, BACKOFF_MINUTES indexed by newRetries.
    // BACKOFF_MINUTES = [2, 5, 15, 60, 240]
    [0, 5], // newRetries=1 -> 5min
    [1, 15], // newRetries=2 -> 15min
    [2, 60], // newRetries=3 -> 60min
    [3, 240], // newRetries=4 -> 240min
  ])("schedules ~%i-th retry %i minutes ahead", async (prevRetries, expectedMinutes) => {
    bypassThrottle();
    const now = Date.now();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkCase({ fyndSyncRetries: prevRetries }),
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "boom" });

    await runFyndRetryQueue();

    const next = lastUpdateNextRetry();
    const expected = now + expectedMinutes * 60_000;
    // Allow a tiny drift (vi fake timers should be exact, but be defensive).
    expect(Math.abs(next.getTime() - expected)).toBeLessThanOrEqual(50);
  });

  it("scheduleRetry uses BACKOFF_MINUTES[0] (2 minutes) for fresh failures", async () => {
    vi.setSystemTime(new Date("2026-02-02T00:00:00Z").getTime());
    const now = Date.now();
    await scheduleRetry("rc-fresh", "first failure");
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    const nextRetry = call.data.fyndSyncNextRetry as Date;
    expect(nextRetry.getTime() - now).toBe(2 * 60_000);
  });
});

describe("scheduleRetry — edge cases", () => {
  it("propagates short error messages unchanged", async () => {
    await scheduleRetry("rc-x", "short");
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncError).toBe("short");
    expect(call.data.fyndSyncRetries).toBe(0);
    expect(call.data.fyndSyncStatus).toBe("retry_scheduled");
  });

  it("returns a Promise<void> (resolves to undefined, not the prisma result)", async () => {
    prismaMock.returnCase.update.mockResolvedValueOnce({ id: "rc-x" });
    const result = await scheduleRetry("rc-x", "err");
    expect(result).toBeUndefined();
  });

  it("propagates prisma errors instead of swallowing them", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));
    await expect(scheduleRetry("rc-x", "err")).rejects.toThrow("db down");
  });
});

describe("runFyndRetryQueue — extra scenarios", () => {
  it("non-Error thrown values are coerced to string in the saved error", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockRejectedValueOnce("plain string error");

    const res = await runFyndRetryQueue();
    expect(res.failed).toBe(1);
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndSyncError).toBe("plain string error");
    expect(data.fyndSyncStatus).toBe("retry_scheduled");
  });

  it("truncates the error message to 2000 chars on retry-scheduled path", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: false,
      error: "x".repeat(5000),
    });

    await runFyndRetryQueue();
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndSyncError.length).toBe(2000);
  });

  it("truncates the exhausted-retries error message to 2000 chars and prefixes Exhausted N retries", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ fyndSyncRetries: 4 })]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("y".repeat(5000)));

    const res = await runFyndRetryQueue();
    expect(res.exhausted).toBe(1);
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndSyncError.length).toBe(2000);
    expect(data.fyndSyncError.startsWith("Exhausted 5 retries.")).toBe(true);
  });

  it("on success, serializes the fynd payload to JSON", async () => {
    bypassThrottle();
    const payload = { foo: "bar", n: 42 };
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "R-1",
      fyndPayload: payload,
    });

    await runFyndRetryQueue();
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(typeof data.fyndPayloadJson).toBe("string");
    expect(JSON.parse(data.fyndPayloadJson)).toEqual(payload);
  });

  it("on success without payload, retains the case's existing fyndPayloadJson", async () => {
    bypassThrottle();
    const existing = JSON.stringify({ keep: true });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ fyndPayloadJson: existing })]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "R-1",
      // no fyndPayload
    });

    await runFyndRetryQueue();
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndPayloadJson).toBe(existing);
  });

  it("falls back to existing fynd identifiers when sync result omits them", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkCase({
        fyndReturnId: "R-old",
        fyndReturnNo: "RN-old",
        fyndOrderId: "O-old",
        fyndShipmentId: "S-old",
      }),
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true });

    await runFyndRetryQueue();
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndReturnId).toBe("R-old");
    expect(data.fyndReturnNo).toBe("RN-old");
    expect(data.fyndOrderId).toBe("O-old");
    expect(data.fyndShipmentId).toBe("S-old");
  });

  it("processes a multi-case batch and aggregates outcomes correctly", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkCase({ id: "rc-a", fyndSyncRetries: 0 }),
      mkCase({ id: "rc-b", fyndSyncRetries: 1 }),
      mkCase({ id: "rc-c", fyndSyncRetries: 4 }),
    ]);
    createFyndClientMock.mockResolvedValue({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-a" })
      .mockResolvedValueOnce({ success: false, error: "transient" })
      .mockResolvedValueOnce({ success: false, error: "final" });

    const res = await runFyndRetryQueue();
    expect(res).toEqual({ processed: 3, succeeded: 1, failed: 1, exhausted: 1 });
    expect(retryAttemptAdd).toHaveBeenCalledTimes(3);
    expect(retryExhaustedAdd).toHaveBeenCalledTimes(1);
  });

  it("findMany is called with the correct status/retries filter", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await runFyndRetryQueue();
    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where.fyndSyncStatus).toEqual({ in: ["failed", "retry_scheduled"] });
    expect(arg.where.fyndSyncRetries).toEqual({ lt: 5 });
    expect(arg.where.status).toEqual({ in: ["approved", "pending"] });
    expect(arg.where.fyndSyncNextRetry).toEqual({ lte: expect.any(Date) });
    expect(arg.take).toBe(10);
    expect(arg.orderBy).toEqual({ fyndSyncNextRetry: "asc" });
  });

  it("does not log aggregate summary when nothing was processed", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await runFyndRetryQueue();
    expect(loggerInfoMock).not.toHaveBeenCalled();
  });

  it("emits attempt_number=newRetries on retry_scheduled outcome", async () => {
    bypassThrottle();
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ fyndSyncRetries: 1 })]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "x" });

    await runFyndRetryQueue();
    expect(retryAttemptAdd).toHaveBeenCalledWith(1, {
      attempt_number: 2,
      outcome: "retry_scheduled",
    });
  });
});
