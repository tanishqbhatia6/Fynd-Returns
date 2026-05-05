import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * fynd-consolidation.server.ts — extra tests.
 *
 * Complements fynd-consolidation.test.ts with additional branch coverage:
 *   • runConsolidationForAllShops error/edge paths (non-Error throws, select shape)
 *   • runConsolidationBatch grouping edge cases (whitespace fyndOrderId,
 *     fallback to rc.id, multi-shipment splits, missing optional fields)
 *   • single-case + multi-case branches that previous suite skipped
 *     (alreadyExists without fyndReturnId, missing error string, partial fields)
 *   • cutoff windowHours = 0
 *   • createFyndClientOrError invoked with requirePlatform:true
 */

const { prismaMock, createFyndClientMock, createReturnOnFyndMock } = vi.hoisted(() => {
  return {
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    createFyndClientMock: vi.fn(),
    createReturnOnFyndMock: vi.fn(),
  };
});

Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../fynd.server", () => ({
  createFyndClientOrError: createFyndClientMock,
}));

vi.mock("../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));

import {
  runConsolidationBatch,
  runConsolidationForAllShops,
} from "../fynd-consolidation.server";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientMock.mockReset();
  createReturnOnFyndMock.mockReset();
});

const fakeFyndClient = { getShipments: vi.fn() };

describe("runConsolidationBatch — extra branches", () => {
  it("passes requirePlatform:true to createFyndClientOrError", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1001", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "R-1" });

    await runConsolidationBatch("shop-1");

    expect(createFyndClientMock).toHaveBeenCalledWith(
      expect.any(Object),
      { requirePlatform: true },
    );
  });

  it("uses windowHours = 0 cutoff when configured to zero", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true, fyndConsolidateWindowHours: 0 },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await runConsolidationBatch("shop-1");

    // 0 hours → cutoff equals (approximately) now
    const findManyCall = prismaMock.returnCase.findMany.mock.calls[0][0];
    const cutoff = findManyCall.where.updatedAt.lte as Date;
    expect(Math.abs(cutoff.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("falls back to rc.id when fyndOrderId AND shopifyOrderName are missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-naked", fyndOrderId: null, fyndShipmentId: null, shopifyOrderName: null, items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    // Force a thrown error so the group key is exposed in the error message
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors[0]).toContain("[group:rc-naked:unknown]");
  });

  it("treats whitespace-only fyndOrderId as missing and falls back to shopifyOrderName", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-ws", fyndOrderId: "   ", fyndShipmentId: "  ", shopifyOrderName: "#1009", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));

    const res = await runConsolidationBatch("shop-1");
    // shopifyOrderName "#1009" → "1009"; whitespace shipment → "unknown"
    expect(res.errors[0]).toContain("[group:1009:unknown]");
  });

  it("strips leading '#' from shopifyOrderName when used as fallback group key", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-x", fyndOrderId: null, fyndShipmentId: "SH", shopifyOrderName: "#5050", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors[0]).toContain("[group:5050:SH]");
  });

  it("splits same order into separate groups for different shipments", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", fyndOrderId: "O-1", fyndShipmentId: "S-A", shopifyOrderName: "#1", items: [] },
      { id: "rc-2", fyndOrderId: "O-1", fyndShipmentId: "S-B", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-A" })
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-B" });

    const res = await runConsolidationBatch("shop-1");
    expect(res.groupsProcessed).toBe(2);
    expect(res.casesUpdated).toBe(2);
  });

  it("single-case alreadyExists without fyndReturnId still marks synced", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-already", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, alreadyExists: true });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(1);
    expect(res.errors).toEqual([]);
    const updateData = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(updateData.fyndSyncStatus).toBe("synced");
    // No fyndReturnId provided → should not set it
    expect(updateData.fyndReturnId).toBeUndefined();
    // No payload → no payload json
    expect(updateData.fyndPayloadJson).toBeUndefined();
  });

  it("single-case success without fyndReturnId AND without alreadyExists → marks failed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-weird", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    // success:true but neither fyndReturnId nor alreadyExists — falls into else
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(0);
    expect(res.errors).toContain("[rc-weird] Unknown Fynd error");
    const updateData = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(updateData.fyndSyncStatus).toBe("failed");
    expect(updateData.fyndSyncError).toBe("Unknown Fynd error");
  });

  it("single-case failure without explicit error uses 'Unknown Fynd error' default", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-noerr", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false });

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors).toContain("[rc-noerr] Unknown Fynd error");
  });

  it("multi-case: first call fails — second call still proceeds and sets sharedFyndReturnId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-a", fyndOrderId: "O-9", fyndShipmentId: "S-9", shopifyOrderName: "#9", items: [] },
      { id: "rc-b", fyndOrderId: "O-9", fyndShipmentId: "S-9", shopifyOrderName: "#9", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: false, error: "first failed" })
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-9", fyndReturnNo: "RN-9" });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(1);
    expect(res.errors).toContain("[rc-a] first failed");

    // The second case's update should carry R-9
    const successUpdate = prismaMock.returnCase.update.mock.calls.find(
      (c) => c[0].where.id === "rc-b",
    );
    expect(successUpdate?.[0].data.fyndReturnId).toBe("R-9");
    expect(successUpdate?.[0].data.fyndReturnNo).toBe("RN-9");
  });

  it("multi-case: all alreadyExists with no fyndReturnId — no shared id set, both marked synced", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-a", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
      { id: "rc-b", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, alreadyExists: true })
      .mockResolvedValueOnce({ success: true, alreadyExists: true });

    const res = await runConsolidationBatch("shop-1");
    expect(res.casesUpdated).toBe(2);
    const updates = prismaMock.returnCase.update.mock.calls;
    for (const [arg] of updates) {
      expect(arg.data.fyndSyncStatus).toBe("synced");
      expect(arg.data.fyndReturnId).toBeUndefined();
    }
  });

  it("multi-case: failure without explicit error uses 'Unknown Fynd error' default", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-a", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
      { id: "rc-b", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock
      .mockResolvedValueOnce({ success: true, fyndReturnId: "R-Z" })
      .mockResolvedValueOnce({ success: false }); // no error string

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors).toContain("[rc-b] Unknown Fynd error");
  });

  it("captures non-Error thrown values at group level via String(err)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-str", fyndOrderId: "O-S", fyndShipmentId: "S-S", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockRejectedValueOnce("plain string failure");

    const res = await runConsolidationBatch("shop-1");
    expect(res.errors[0]).toContain("[group:O-S:S-S]");
    expect(res.errors[0]).toContain("plain string failure");
  });

  it("does not include fyndPayloadJson when fyndPayload is undefined", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndConsolidateReturns: true },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-np", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
    ]);
    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "R-1",
      // fyndPayload absent
    });

    await runConsolidationBatch("shop-1");
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.fyndPayloadJson).toBeUndefined();
  });
});

describe("runConsolidationForAllShops — extra branches", () => {
  it("queries shopSettings.findMany with fyndConsolidateReturns:true and select shopId", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    await runConsolidationForAllShops();

    expect(prismaMock.shopSettings.findMany).toHaveBeenCalledWith({
      where: { fyndConsolidateReturns: true },
      select: { shopId: true },
    });
  });

  it("captures non-Error thrown values via String(err) in per-shop catch", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([{ shopId: "s-x" }]);
    prismaMock.shop.findUnique.mockRejectedValueOnce("totally raw failure");

    const results = await runConsolidationForAllShops();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      shopId: "s-x",
      groupsProcessed: 0,
      casesUpdated: 0,
      errors: ["totally raw failure"],
    });
  });

  it("aggregates groupsProcessed/casesUpdated from each shop's batch", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([{ shopId: "s-1" }, { shopId: "s-2" }]);

    prismaMock.shop.findUnique
      .mockResolvedValueOnce({ id: "s-1", settings: { fyndConsolidateReturns: true } })
      .mockResolvedValueOnce({ id: "s-2", settings: { fyndConsolidateReturns: true } });

    prismaMock.returnCase.findMany
      .mockResolvedValueOnce([
        { id: "rc-1", fyndOrderId: "O-1", fyndShipmentId: "S-1", shopifyOrderName: "#1", items: [] },
      ])
      .mockResolvedValueOnce([]); // shop 2 has no pending

    createFyndClientMock.mockResolvedValueOnce({ ok: true, client: fakeFyndClient });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "R-1" });

    const results = await runConsolidationForAllShops();
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(expect.objectContaining({ shopId: "s-1", groupsProcessed: 1, casesUpdated: 1 }));
    expect(results[1]).toEqual(expect.objectContaining({ shopId: "s-2", groupsProcessed: 0, casesUpdated: 0 }));
  });

  it("processes shops sequentially (later throw doesn't drop earlier successful results)", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      { shopId: "s-good" },
      { shopId: "s-bad" },
    ]);
    prismaMock.shop.findUnique
      .mockResolvedValueOnce({ id: "s-good", settings: { fyndConsolidateReturns: true } })
      .mockRejectedValueOnce(new Error("boom"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const results = await runConsolidationForAllShops();
    expect(results).toHaveLength(2);
    expect(results[0].shopId).toBe("s-good");
    expect(results[0].errors).toEqual([]);
    expect(results[1].shopId).toBe("s-bad");
    expect(results[1].errors).toEqual(["boom"]);
  });
});
