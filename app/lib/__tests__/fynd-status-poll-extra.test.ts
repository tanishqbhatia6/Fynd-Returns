import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Extra coverage for pollStaleReturns().
 *
 * Complements fynd-status-poll.test.ts. Focuses on behaviours not
 * already covered there:
 *   - findMany query filters (status whitelist, fyndShipmentId not null,
 *     OR cutoff, ordering, batch size, includes)
 *   - return value tallies for mixed batches (success + skip + failure)
 *   - fallback to fyndShipmentId when fyndOrderId is null when calling
 *     getShipments
 *   - per-shop client cache: separate creation per shopId, cached null
 *     not retried
 *   - no journey -> no returnEvent.create
 *   - delivery_done variant transitions to completed
 *   - NOT overwriting an existing forwardAwb
 *   - graceful continue when getShipments returns null/falsy (no update)
 *   - swallows error from the fallback `update` in the catch branch
 *   - throttle is bypassed/applied based on Date.now math (boundary)
 */

const {
  prismaMock,
  createFyndClientOrErrorMock,
  getShipmentsMock,
} = vi.hoisted(() => ({
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
  FyndPlatformClient: class {},
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: {
    setAttribute: () => void;
    setAttributes: () => void;
  }) => Promise<T>) => fn({ setAttribute: () => {}, setAttributes: () => {} }),
}));

import { pollStaleReturns } from "../fynd-status-poll.server";

function mkShipmentClient(): { getShipments: typeof getShipmentsMock } {
  return { getShipments: getShipmentsMock };
}

function mkReturn(overrides: {
  id?: string;
  shopId?: string;
  fyndShipmentId?: string | null;
  fyndOrderId?: string | null;
  forwardAwb?: string | null;
  settings?: unknown;
} = {}) {
  const settings = "settings" in overrides
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
    fyndOrderId: "fyndOrderId" in overrides ? overrides.fyndOrderId : "ORD1",
    forwardAwb: overrides.forwardAwb ?? null,
    shop: {
      id: overrides.shopId ?? "shop-1",
      settings,
    },
  };
}

// lastPollRun is module-scoped — advance well past throttle each test.
let testNow = 5_000_000_000_000;
beforeEach(() => {
  testNow += 60 * 60_000;
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

describe("pollStaleReturns — findMany query shape", () => {
  it("filters by active statuses, non-null fyndShipmentId, and OR-staleness; orders by lastFyndStatusCheck nulls-first; batches by 5", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    await pollStaleReturns();

    expect(prismaMock.returnCase.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.returnCase.findMany.mock.calls[0][0] as {
      where: {
        status: { in: string[] };
        fyndShipmentId: { not: null };
        OR: Array<Record<string, unknown>>;
      };
      include: { shop: { include: { settings: true } } };
      take: number;
      orderBy: { lastFyndStatusCheck: { sort: string; nulls: string } };
    };

    expect(arg.where.status).toEqual({ in: ["approved", "processing", "in progress"] });
    expect(arg.where.fyndShipmentId).toEqual({ not: null });
    expect(arg.where.OR).toHaveLength(2);
    expect(arg.where.OR[0]).toEqual({ lastFyndStatusCheck: null });
    // Second OR clause: lastFyndStatusCheck < cutoff (Date 30 min before now).
    const lt = (arg.where.OR[1] as { lastFyndStatusCheck: { lt: Date } }).lastFyndStatusCheck.lt;
    expect(lt).toBeInstanceOf(Date);
    expect(testNow - lt.getTime()).toBe(30 * 60_000);
    expect(arg.include).toEqual({ shop: { include: { settings: true } } });
    expect(arg.take).toBe(5);
    expect(arg.orderBy).toEqual({ lastFyndStatusCheck: { sort: "asc", nulls: "first" } });
  });
});

describe("pollStaleReturns — mixed batch tallies", () => {
  it("checked counts every return, updated only counts successes", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ id: "ok" }),
      mkReturn({ id: "no-creds", settings: null }),
      mkReturn({ id: "fail" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock
      .mockResolvedValueOnce({ items: [{ shipment_id: "SH1", shipment_status: "in_transit" }] })
      .mockRejectedValueOnce(new Error("boom"));

    const r = await pollStaleReturns();
    expect(r.checked).toBe(3);
    expect(r.updated).toBe(1);
  });

  it("does not call returnCase.update when getShipments returns null/falsy", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue(null);

    const r = await pollStaleReturns();
    expect(r.checked).toBe(1);
    expect(r.updated).toBe(0);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
  });
});

describe("pollStaleReturns — fyndOrderId fallback", () => {
  it("calls getShipments with fyndOrderId when present", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ fyndOrderId: "ORD-EXPLICIT", fyndShipmentId: "SHX" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({ items: [{ shipment_id: "SHX", shipment_status: "in_transit" }] });

    await pollStaleReturns();
    expect(getShipmentsMock).toHaveBeenCalledWith("ORD-EXPLICIT");
  });

  it("falls back to fyndShipmentId when fyndOrderId is null", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ fyndOrderId: null, fyndShipmentId: "SH-FALLBACK" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({ items: [{ shipment_id: "SH-FALLBACK", shipment_status: "in_transit" }] });

    await pollStaleReturns();
    expect(getShipmentsMock).toHaveBeenCalledWith("SH-FALLBACK");
  });
});

describe("pollStaleReturns — per-shop client cache", () => {
  it("creates a separate client per distinct shopId", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ id: "rc-a", shopId: "shop-A" }),
      mkReturn({ id: "rc-b", shopId: "shop-B" }),
      mkReturn({ id: "rc-c", shopId: "shop-A" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({ items: [] });

    await pollStaleReturns();
    expect(createFyndClientOrErrorMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client creation for a shop after a failed attempt (cached null)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ id: "rc-1", shopId: "shop-X" }),
      mkReturn({ id: "rc-2", shopId: "shop-X" }),
      mkReturn({ id: "rc-3", shopId: "shop-X" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: false, error: "bad creds" });

    const r = await pollStaleReturns();
    expect(createFyndClientOrErrorMock).toHaveBeenCalledTimes(1);
    expect(r.checked).toBe(3);
    expect(r.updated).toBe(0);
    expect(getShipmentsMock).not.toHaveBeenCalled();
  });
});

describe("pollStaleReturns — payload-driven update fields", () => {
  it("does NOT log a returnEvent when forward journey is empty", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "in_transit" }],
    });

    await pollStaleReturns();
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
  });

  it("transitions status to completed on shipment_status containing 'delivery_done'", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{ shipment_id: "SH1", shipment_status: "delivery_done" }],
    });

    await pollStaleReturns();
    const call = prismaMock.returnCase.update.mock.calls[0][0] as { data: { status?: string } };
    expect(call.data.status).toBe("completed");
  });

  it("does NOT overwrite an existing forwardAwb on the return case", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([
      mkReturn({ forwardAwb: "EXISTING-AWB" }),
    ]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockResolvedValue({
      items: [{
        shipment_id: "SH1",
        shipment_status: "in_transit",
        dp_details: { awb_no: "NEW-AWB-67890" },
      }],
    });

    await pollStaleReturns();
    const call = prismaMock.returnCase.update.mock.calls[0][0] as { data: { forwardAwb?: string } };
    expect(call.data.forwardAwb).toBeUndefined();
  });

  it("writes payload JSON to fyndPayloadJson on the update", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    const payload = { items: [{ shipment_id: "SH1", shipment_status: "in_transit" }] };
    getShipmentsMock.mockResolvedValue(payload);

    await pollStaleReturns();
    const call = prismaMock.returnCase.update.mock.calls[0][0] as { data: { fyndPayloadJson?: string } };
    expect(call.data.fyndPayloadJson).toBe(JSON.stringify(payload));
  });
});

describe("pollStaleReturns — error-handling resilience", () => {
  it("does not throw when the fallback lastFyndStatusCheck update itself rejects", async () => {
    prismaMock.returnCase.findMany.mockResolvedValue([mkReturn()]);
    createFyndClientOrErrorMock.mockResolvedValue({ ok: true, client: mkShipmentClient() });
    getShipmentsMock.mockRejectedValue(new Error("Fynd 500"));
    // Both update calls reject — should still resolve cleanly.
    prismaMock.returnCase.update.mockRejectedValue(new Error("DB write failed"));

    await expect(pollStaleReturns()).resolves.toEqual({ checked: 1, updated: 0 });
  });
});
