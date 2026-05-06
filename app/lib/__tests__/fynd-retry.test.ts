import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * fynd-retry.server.ts tests.
 *
 * Covers runFyndRetryQueue throttling, per-case happy path, retry backoff
 * scheduling, exhaustion, and the scheduleRetry helper.
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
  // withSpan just invokes the callback with a stub span
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
    id: "rc-1",
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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientMock.mockReset();
  createReturnOnFyndMock.mockReset();
  loggerInfoMock.mockClear();
  loggerErrorMock.mockClear();
  retryAttemptAdd.mockClear();
  retryExhaustedAdd.mockClear();
  // Advance module-scope lastRetryRun by 10 minutes to bypass throttle
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60_000);
});

describe("runFyndRetryQueue", () => {
  it("no-ops when throttled (runs twice back-to-back without clock advance)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    await runFyndRetryQueue();
    const secondResult = await runFyndRetryQueue();

    expect(secondResult).toEqual({ processed: 0, succeeded: 0, failed: 0, exhausted: 0 });
  });

  it("zero pending cases: returns zero counts without creating client", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await runFyndRetryQueue();
    expect(res).toEqual({ processed: 0, succeeded: 0, failed: 0, exhausted: 0 });
    expect(createFyndClientMock).not.toHaveBeenCalled();
  });

  it("skips cases without fyndCredentials", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ shop: { settings: null } })]);
    const res = await runFyndRetryQueue();
    expect(res.processed).toBe(1);
    expect(res.succeeded).toBe(0);
    expect(res.failed).toBe(0);
    expect(createFyndClientMock).not.toHaveBeenCalled();
  });

  it("success path: updates case to synced + emits retry_success event", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "R-99",
      fyndReturnNo: "RN-99",
      fyndOrderId: "O-99",
      fyndShipmentId: "S-99",
      fyndPayload: { x: 1 },
    });

    const res = await runFyndRetryQueue();
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(0);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fyndSyncStatus: "synced",
          fyndReturnId: "R-99",
          fyndSyncError: null,
        }),
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "fynd_sync_retry_success" }),
      }),
    );
    expect(retryAttemptAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ outcome: "success" }),
    );
  });

  it("failure with retries remaining: schedules retry with backoff", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ fyndSyncRetries: 2 })]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "Fynd 500" });

    const res = await runFyndRetryQueue();
    expect(res.failed).toBe(1);
    expect(res.exhausted).toBe(0);

    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncStatus).toBe("retry_scheduled");
    expect(call.data.fyndSyncRetries).toBe(3);
    expect(call.data.fyndSyncError).toContain("Fynd 500");
    expect(call.data.fyndSyncNextRetry).toBeInstanceOf(Date);
    expect(retryAttemptAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ outcome: "retry_scheduled" }),
    );
  });

  it("failure at max retries: marks exhausted and emits retries_exhausted event", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase({ fyndSyncRetries: 4 })]); // 4+1 === MAX_RETRIES
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "final" });

    const res = await runFyndRetryQueue();
    expect(res.exhausted).toBe(1);
    expect(res.failed).toBe(0);

    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncStatus).toBe("failed");
    expect(call.data.fyndSyncRetries).toBe(5);
    expect(call.data.fyndSyncError).toMatch(/Exhausted 5 retries/);
    expect(call.data.fyndSyncNextRetry).toBe(null);

    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "fynd_sync_retries_exhausted" }),
      }),
    );
    expect(retryExhaustedAdd).toHaveBeenCalledWith(1);
  });

  it("createFyndClientOrError failure counts as a retry failure", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: false, error: "bad creds" });

    const res = await runFyndRetryQueue();
    expect(res.failed).toBe(1);
    expect(res.succeeded).toBe(0);
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncStatus).toBe("retry_scheduled");
    expect(call.data.fyndSyncError).toContain("bad creds");
  });

  it("non-platform client counts as a failure", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: {} }); // no getShipments

    const res = await runFyndRetryQueue();
    expect(res.failed).toBe(1);
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncError).toMatch(/does not support Platform API/);
  });

  it("logs aggregate summary when processed > 0", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkCase()]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakePlatformClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "R-1" });

    await runFyndRetryQueue();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 1, succeeded: 1 }),
      expect.stringContaining("Processed 1"),
    );
  });

  it("captures prisma query errors in the fynd logger", async () => {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("db gone"));
    const res = await runFyndRetryQueue();
    expect(res).toEqual({ processed: 0, succeeded: 0, failed: 0, exhausted: 0 });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("Queue error"),
    );
  });
});

describe("scheduleRetry", () => {
  it("updates the case to retry_scheduled with retries=0", async () => {
    await scheduleRetry("rc-5", "initial failure");
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-5" },
        data: expect.objectContaining({
          fyndSyncStatus: "retry_scheduled",
          fyndSyncRetries: 0,
          fyndSyncError: "initial failure",
        }),
      }),
    );
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncNextRetry).toBeInstanceOf(Date);
  });

  it("truncates long error messages to 2000 chars", async () => {
    const long = "e".repeat(3000);
    await scheduleRetry("rc-5", long);
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.fyndSyncError.length).toBe(2000);
  });
});
