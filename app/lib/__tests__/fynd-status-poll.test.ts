import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * fynd-status-poll tests.
 *
 * Both exports (pollStaleReturns + refreshSingleReturn) hit Prisma and
 * the Fynd API client. We mock everything and verify the decision
 * branches — throttle, credential check, shipment parsing, status
 * transitions, event logging, and the graceful degradation paths on
 * individual-return failures.
 *
 * The module keeps `lastPollRun` in module-scope, so tests that
 * exercise pollStaleReturns need to advance time or reset that state
 * — we use vi.useFakeTimers() to control Date.now().
 */

const { prismaMock, createFyndClientOrErrorMock, getShipmentsMock } = vi.hoisted(() => ({
  prismaMock: {
    returnCase: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    returnEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
  createFyndClientOrErrorMock: vi.fn(),
  getShipmentsMock: vi.fn(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
  // Export the type as well (the real module does).
  FyndPlatformClient: class {},
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(
    _n: string,
    _a: unknown,
    fn: (s: { setAttribute: () => void; setAttributes: () => void }) => Promise<T>,
  ) => fn({ setAttribute: () => {}, setAttributes: () => {} }),
}));

import { pollStaleReturns, refreshSingleReturn } from "../fynd-status-poll.server";

function mkShipmentClient(): { getShipments: typeof getShipmentsMock } {
  return { getShipments: getShipmentsMock };
}

function mkReturn(
  overrides: {
    id?: string;
    shopId?: string;
    fyndShipmentId?: string | null;
    fyndOrderId?: string | null;
    forwardAwb?: string | null;
    settings?: unknown;
  } = {},
) {
  // Use `in` check so callers can explicitly pass `settings: null` without
  // triggering the ?? default fallback.
  const settings =
    "settings" in overrides
      ? overrides.settings
      : {
          fyndCredentials: JSON.stringify({ platform: { clientId: "c", clientSecret: "s" } }),
          fyndApplicationId: "app",
          fyndCompanyId: "co",
        };
  return {
    id: overrides.id ?? "rc-1",
    shopId: overrides.shopId ?? "shop-1",
    fyndShipmentId: "fyndShipmentId" in overrides ? overrides.fyndShipmentId : "SH1",
    fyndOrderId: overrides.fyndOrderId ?? "ORD1",
    forwardAwb: overrides.forwardAwb ?? null,
    shop: {
      id: overrides.shopId ?? "shop-1",
      settings,
    },
  };
}

/**
 * lastPollRun is module-scoped and persists between tests. We advance
 * the fake clock by 1 HOUR per test so we always overshoot the 10-min
 * throttle plus any intra-test advances up to ~50 min.
 */
let testNow = 1_000_000_000_000;
beforeEach(() => {
  testNow += 60 * 60_000; // 1 hour per test
  vi.useFakeTimers({ now: testNow });
  prismaMock.returnCase.findMany.mockReset().mockResolvedValue([]);
  prismaMock.returnCase.findUnique.mockReset();
  prismaMock.returnCase.update.mockReset().mockResolvedValue({});
  prismaMock.returnEvent.create.mockReset().mockResolvedValue({});
  createFyndClientOrErrorMock.mockReset();
  getShipmentsMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pollStaleReturns — throttle", () => {
  it("runs on first call", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    const r = await pollStaleReturns();
    expect(r).toEqual({ checked: 0, updated: 0 });
    expect(prismaMock.returnCase.findMany).toHaveBeenCalled();
  });

  it("is throttled if called again within POLL_THROTTLE_MS (10 min)", async () => {
    await pollStaleReturns();
    prismaMock.returnCase.findMany.mockClear();
    // Advance by less than 10 minutes.
    vi.advanceTimersByTime(5 * 60_000);
    const r = await pollStaleReturns();
    expect(r).toEqual({ checked: 0, updated: 0 });
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("runs again after POLL_THROTTLE_MS elapses", async () => {
    await pollStaleReturns();
    prismaMock.returnCase.findMany.mockClear();
    vi.advanceTimersByTime(11 * 60_000);
    await pollStaleReturns();
    expect(prismaMock.returnCase.findMany).toHaveBeenCalled();
  });
});

describe("pollStaleReturns — per-return behaviour", () => {
  it("skips returns with no Fynd credentials on the shop", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn({ settings: null })]);
    const r = await pollStaleReturns();
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(0);
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("skips returns missing fyndShipmentId", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn({ fyndShipmentId: null })]);
    const r = await pollStaleReturns();
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(0);
  });

  it("continues when Fynd client creation fails", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: false, error: "bad creds" });
    const r = await pollStaleReturns();
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(0);
  });

  it("writes shipment payload + updates lastFyndStatusCheck on success", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "in_transit" }],
    });
    const r = await pollStaleReturns();
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(1);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-1" },
        data: expect.objectContaining({ lastFyndStatusCheck: expect.any(Date) }),
      }),
    );
  });

  it("transitions status to completed when shipment_status contains 'delivered'", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "delivered" }],
    });
    await pollStaleReturns();
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("backfills forwardAwb when missing + valid (not a Fynd ID)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn({ forwardAwb: null })]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [
        {
          shipment_id: "SH1",
          shipment_status: "in_transit",
          dp_details: { awb_no: "AWB12345" }, // real AWB (not Fynd ID)
        },
      ],
    });
    await pollStaleReturns();
    const call = prismaMock.returnCase.update.mock.calls[0][0] as { data: { forwardAwb?: string } };
    expect(call.data.forwardAwb).toBe("AWB12345");
  });

  it("does NOT backfill forwardAwb when the AWB is a Fynd shipment ID", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn({ forwardAwb: null })]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [
        {
          shipment_id: "SH1",
          shipment_status: "in_transit",
          dp_details: { awb_no: "16834567890123456" }, // Fynd ID, not a real AWB
        },
      ],
    });
    await pollStaleReturns();
    const call = prismaMock.returnCase.update.mock.calls[0][0] as { data: { forwardAwb?: string } };
    expect(call.data.forwardAwb).toBeUndefined();
  });

  it("logs fynd_status_poll event when journey has steps", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [
        {
          shipment_id: "SH1",
          shipment_status: "in_transit",
          bags: [
            {
              bag_status: [
                {
                  status: "bag_picked",
                  bag_state_mapper: { journey_type: "forward", display_name: "Picked up" },
                  updated_at: "2026-04-22T10:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    await pollStaleReturns();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "fynd_status_poll",
          source: "system",
        }),
      }),
    );
  });

  it("still stamps lastFyndStatusCheck on per-return failure (so we don't retry immediately)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockRejectedValue(new Error("Fynd 500"));
    await pollStaleReturns();
    // An update was still issued to bump lastFyndStatusCheck.
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-1" },
        data: { lastFyndStatusCheck: expect.any(Date) },
      }),
    );
  });

  it("swallows a top-level Prisma error without throwing", async () => {
    prismaMock.returnCase.findMany.mockRejectedValue(new Error("DB down"));
    const r = await pollStaleReturns();
    expect(r).toEqual({ checked: 0, updated: 0 });
  });

  it("reuses the Fynd client across returns with the same shopId", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ id: "rc-1" }),
      mkReturn({ id: "rc-2" }),
      mkReturn({ id: "rc-3" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({ items: [] });
    await pollStaleReturns();
    // Only one client creation for three returns on the same shop.
    expect(createFyndClientOrErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe("refreshSingleReturn", () => {
  it("returns false when return case doesn't exist", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue(null);
    expect(await refreshSingleReturn("missing")).toBe(false);
  });

  it("returns false when return has no fyndShipmentId", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue({
      id: "rc-1",
      fyndShipmentId: null,
      shop: { settings: { fyndCredentials: "{}" } },
    });
    expect(await refreshSingleReturn("rc-1")).toBe(false);
  });

  it("returns false when shop has no Fynd credentials", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue({
      id: "rc-1",
      fyndShipmentId: "SH1",
      shop: { settings: null },
    });
    expect(await refreshSingleReturn("rc-1")).toBe(false);
  });

  it("returns false when Fynd client creation fails", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue(mkReturn());
    createFyndClientOrErrorMock.mockResolvedValue({ ok: false, error: "bad" });
    expect(await refreshSingleReturn("rc-1")).toBe(false);
  });

  it("returns false when getShipments returns null", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue(mkReturn());
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue(null);
    expect(await refreshSingleReturn("rc-1")).toBe(false);
  });

  it("updates return and returns true on success", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue(mkReturn());
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "in_transit" }],
    });
    expect(await refreshSingleReturn("rc-1")).toBe(true);
    expect(prismaMock.returnCase.update).toHaveBeenCalled();
  });

  it("transitions status to completed on delivered_done", async () => {
    prismaMock.returnCase.findUnique.mockResolvedValue(mkReturn());
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "delivery_done" }],
    });
    await refreshSingleReturn("rc-1");
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("returns false + doesn't throw on Prisma error", async () => {
    prismaMock.returnCase.findUnique.mockRejectedValue(new Error("DB down"));
    expect(await refreshSingleReturn("rc-1")).toBe(false);
  });
});
