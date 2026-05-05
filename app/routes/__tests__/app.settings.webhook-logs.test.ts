/**
 * Loader tests for app.settings.webhook-logs.tsx — Fynd webhook log
 * viewer. Verifies filter & search predicate construction, date range
 * inclusion, pagination skip math, success/error/ignored bucket counts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));

import { loader } from "../app.settings.webhook-logs";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  prismaMock.fyndWebhookLog.count.mockResolvedValue(0);
  prismaMock.fyndWebhookLog.findMany.mockResolvedValue([]);
  prismaMock.fyndWebhookLog.groupBy.mockResolvedValue([]);
});

function mkReq(qs = "") {
  return new Request(`https://x?${qs}`);
}

describe("loader", () => {
  it("returns empty page on no logs", async () => {
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.logs).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.totalPages).toBe(1);
  });

  it("scopes count + findMany with action filter when supplied", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("action=refund_in_progress"), params: {}, context: {} } as never);
    expect(prismaMock.fyndWebhookLog.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: "refund_in_progress" } }),
    );
  });

  it("includes status filter when supplied", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("status=delivered"), params: {}, context: {} } as never);
    expect(prismaMock.fyndWebhookLog.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fyndStatus: "delivered" } }),
    );
  });

  it("builds OR clause across 8 fields when q provided", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("q=AWB123"), params: {}, context: {} } as never);
    const arg = prismaMock.fyndWebhookLog.count.mock.calls[0][0];
    expect(Array.isArray(arg.where.OR)).toBe(true);
    expect(arg.where.OR).toHaveLength(8);
  });

  it("ignores invalid date in dateFrom (NaN guard)", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("dateFrom=not-a-date"), params: {}, context: {} } as never);
    const arg = prismaMock.fyndWebhookLog.count.mock.calls[0][0];
    expect(arg.where.createdAt).toBeUndefined();
  });

  it("applies dateFrom + dateTo (with end-of-day on dateTo)", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({
      request: mkReq("dateFrom=2025-01-01&dateTo=2025-01-31"),
      params: {}, context: {},
    } as never);
    const arg = prismaMock.fyndWebhookLog.count.mock.calls[0][0];
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
    expect(arg.where.createdAt.lte).toBeInstanceOf(Date);
    // end-of-day applied
    expect(arg.where.createdAt.lte.getHours()).toBe(23);
  });

  it("clamps page to >=1", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(0);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("page=-3"), params: {}, context: {} } as never);
    expect(prismaMock.fyndWebhookLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0 }),
    );
  });

  it("computes pagination skip for page=2", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(150);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("page=2"), params: {}, context: {} } as never);
    expect(prismaMock.fyndWebhookLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 50 }),
    );
  });

  it("derives success/error/ignored counts from groupBy result", async () => {
    prismaMock.fyndWebhookLog.count.mockResolvedValueOnce(20);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    prismaMock.fyndWebhookLog.groupBy.mockResolvedValueOnce([
      { action: "status_updated", _count: { id: 10 } },
      { action: "error", _count: { id: 4 } },
      { action: "ignored", _count: { id: 6 } },
    ]);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.analytics.successCount).toBe(10);
    expect(data.analytics.errorCount).toBe(4);
    expect(data.analytics.ignoredCount).toBe(6);
    expect(data.analytics.successRate).toBe(80); // (20-4)/20
  });

  it("successRate=100 when no logs at all", async () => {
    prismaMock.fyndWebhookLog.groupBy.mockResolvedValueOnce([]);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.analytics.successRate).toBe(100);
  });
});
