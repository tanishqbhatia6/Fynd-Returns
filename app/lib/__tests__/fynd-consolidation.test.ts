import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * fynd-consolidation.server.ts tests.
 *
 * Covers both code paths (single-case and multi-case grouping) in
 * runConsolidationBatch, plus runConsolidationForAllShops iteration.
 * Mocks prisma via the shared factory and stubs fynd client creation +
 * createReturnOnFynd so we can drive success/failure outcomes explicitly.
 */

const { prismaMock, createFyndClientMock, createReturnOnFyndMock } = vi.hoisted(() => {
  return {
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    createFyndClientMock: vi.fn(),
    createReturnOnFyndMock: vi.fn(),
  };
});

// Populate prismaMock in place so the vi.mock factory sees it
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../fynd.server", () => ({
  createFyndClientOrError: createFyndClientMock,
}));

vi.mock("../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));

import { runConsolidationBatch, runConsolidationForAllShops } from "../fynd-consolidation.server";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientMock.mockReset();
  createReturnOnFyndMock.mockReset();
});

const fakeFyndClient = { getShipments: vi.fn() }; // .getShipments presence keeps the runtime branch happy

describe("runConsolidationBatch", () => {
  it("no-ops when consolidation not enabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: false },
    });
    const res = await runConsolidationBatch("shop-1");
    expect(res).toEqual({ shopId: "shop-1", groupsProcessed: 0, casesUpdated: 0, errors: [] });
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("no-ops when shop has no settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await runConsolidationBatch("shop-none");
    expect(res.casesUpdated).toBe(0);
    expect(res.errors).toEqual([]);
  });

  it("returns early when no pending cases", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true, fyndConsolidateWindowHours: 4 },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(0);
    expect(createFyndClientMock).not.toHaveBeenCalled();
  });

  it("reports Fynd client unavailability", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    const res = await runConsolidationBatch("shop-1");
    expect(res.errors).toEqual(["Fynd client unavailable: no creds"]);
    expect(res.casesUpdated).toBe(0);
  });

  it("reports when returned client isn't a platform client", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
    ]);
    // ok=true but client lacks getShipments → consolidation bails
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: {} });
    const res = await runConsolidationBatch("shop-1");
    expect(res.errors[0]).toMatch(/Not platform client/);
  });

  it("single-case group: syncs and marks 'synced'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true, fyndConsolidateWindowHours: 2 },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "R-1",
      fyndReturnNo: "RN-1",
      fyndOrderId: "O-1",
      fyndShipmentId: "S-1",
      fyndPayload: { foo: "bar" },
    });

    const res = await runConsolidationBatch("shop-1");
    expect(res.groupsProcessed).toBe(1);
    expect(res.casesUpdated).toBe(1);
    expect(res.errors).toEqual([]);

    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-1" },
        data: expect.objectContaining({
          fyndSyncStatus: "synced",
          fyndReturnId: "R-1",
          fyndReturnNo: "RN-1",
          fyndPayloadJson: JSON.stringify({ foo: "bar" }),
        }),
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          returnCaseId: "rc-1",
          eventType: "fynd_consolidation_synced",
        }),
      }),
    );
  });

  it("single-case group: marks 'failed' and captures error on sync failure", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-fail",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "API rejected" });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(0);
    expect(res.errors).toContain("[rc-fail] API rejected");
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fyndSyncStatus: "failed", fyndSyncError: "API rejected" }),
      }),
    );
  });

  it("multi-case group: shares fyndReturnId across grouped cases", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-a",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
      {
        id: "rc-b",
        fyndOrderId: "O-1",
        fyndShipmentId: "S-1",
        shopifyOrderName: "#1001",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });

    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-1", fyndReturnNo: "RN-1" })
      .mockResolvedValueOnce({ success: true, alreadyExists: true });

    const res = await runConsolidationBatch("shop-1");
    expect(res.groupsProcessed).toBe(1);
    expect(res.casesUpdated).toBe(2);
    expect(res.errors).toEqual([]);

    // Both updates should carry fyndReturnId R-1 (shared)
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const ids = updateCalls.map((c) => c[0].data.fyndReturnId);
    expect(ids).toEqual(["R-1", "R-1"]);
  });

  it("multi-case group: one failure doesn't block others", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-a",
        fyndOrderId: "O-2",
        fyndShipmentId: "S-2",
        shopifyOrderName: "#1002",
        items: [],
      },
      {
        id: "rc-b",
        fyndOrderId: "O-2",
        fyndShipmentId: "S-2",
        shopifyOrderName: "#1002",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });

    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-2", fyndReturnNo: "RN-2" })
      .mockResolvedValueOnce({ success: false, error: "dup line" });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(1);
    expect(res.errors).toContain("[rc-b] dup line");
  });

  it("captures thrown errors at the group level", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-boom",
        fyndOrderId: "O-3",
        fyndShipmentId: "S-3",
        shopifyOrderName: "#1003",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("network"));

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors.some((e) => e.includes("[group:O-3:S-3]") && e.includes("network"))).toBe(
      true,
    );
  });

  it("falls back to shopifyOrderName when fyndOrderId is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-order-only",
        fyndOrderId: null,
        fyndShipmentId: null,
        shopifyOrderName: "#1004",
        items: [],
      },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "R-4" });

    const res = await runConsolidationBatch("shop-1");
    expect(res.groupsProcessed).toBe(1);
    expect(res.casesUpdated).toBe(1);
  });

  it("uses default window of 4 hours when fyndConsolidateWindowHours is not set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await runConsolidationBatch("shop-1");

    const findManyCall = prismaMock.returnCase.findMany.mock.calls[0][0];
    const cutoff = findManyCall.where.updatedAt.lte as Date;
    const expected = Date.now() - 4 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });
});

describe("runConsolidationForAllShops", () => {
  it("iterates all shops with consolidation enabled", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([{ shopId: "s-1" }, { shopId: "s-2" }]);

    // Return empty pending cases for both shops (keeps test focused)
    prismaMock.shop.findUnique
      .mockResolvedValueOnce({ id: "s-1", settings: { fyndConsolidateReturns: true } })
      .mockResolvedValueOnce({ id: "s-2", settings: { fyndConsolidateReturns: true } });
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const results = await runConsolidationForAllShops();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.shopId)).toEqual(["s-1", "s-2"]);
    expect(results.every((r) => r.errors.length === 0)).toBe(true);
  });

  it("captures per-shop errors without failing the whole run", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([{ shopId: "s-1" }, { shopId: "s-2" }]);
    // shop-1 throws in findUnique; shop-2 succeeds with empty pending
    prismaMock.shop.findUnique
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ id: "s-2", settings: { fyndConsolidateReturns: true } });
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const results = await runConsolidationForAllShops();
    expect(results).toHaveLength(2);
    expect(results[0].errors).toEqual(["db down"]);
    expect(results[1].errors).toEqual([]);
  });

  it("returns empty array when no shops configured", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const results = await runConsolidationForAllShops();
    expect(results).toEqual([]);
  });
});
