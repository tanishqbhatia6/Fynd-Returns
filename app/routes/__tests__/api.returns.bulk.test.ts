import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, sendApprovalMock, sendRejectionMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  sendApprovalMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRejectionMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/notification.server", () => ({
  sendApprovalNotification: sendApprovalMock,
  sendRejectionNotification: sendRejectionMock,
}));

import { action } from "../api.returns.bulk";

function mkJsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/returns/bulk", init);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  sendApprovalMock.mockReset().mockResolvedValue(undefined);
  sendRejectionMock.mockReset().mockResolvedValue(undefined);
});

describe("guards", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: mkJsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkJsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("400 on invalid JSON", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const bad = new Request("https://app.example/api/returns/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    const res = await action({ request: bad, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 on invalid action type", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkJsonReq({ action: "nuke", returnIds: ["rc-1"] }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when resolutionType missing on bulk_change_resolution", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkJsonReq({ action: "bulk_change_resolution", returnIds: ["rc-1"] }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when returnIds empty or non-array", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1" });
    const res1 = await action({ request: mkJsonReq({ action: "bulk_approve", returnIds: [] }), params: {}, context: {} } as never);
    expect(res1.status).toBe(400);
    const res2 = await action({ request: mkJsonReq({ action: "bulk_approve", returnIds: "not-array" }), params: {}, context: {} } as never);
    expect(res2.status).toBe(400);
  });

  it("400 when returnIds length > 100 (MAX_BULK_IDS)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const ids = Array.from({ length: 101 }, (_, i) => `rc-${i}`);
    const res = await action({ request: mkJsonReq({ action: "bulk_approve", returnIds: ids }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when bulk_reject has no reason", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: mkJsonReq({ action: "bulk_reject", returnIds: ["rc-1"] }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when rejectionReason > 500 chars", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: mkJsonReq({ action: "bulk_reject", returnIds: ["rc-1"], rejectionReason: "x".repeat(501) }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("404 when all returnIds belong to other shops", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-other"] }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(404);
  });
});

describe("bulk_approve", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1" });
  });

  it("approves pending returns + emails the customer", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: "u@x.com", shopifyOrderName: "#1001" },
    ]);
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"] }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.results[0].success).toBe(true);
    expect(sendApprovalMock).toHaveBeenCalled();
  });

  it("skips terminal-status returns with per-row error", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "approved", customerEmailNorm: null, shopifyOrderName: "#1001" },
    ]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"] }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.errorCount).toBe(1);
    expect(body.results[0].error).toMatch(/already approved/);
  });

  it("treats updateMany count=0 as 'already approved' (idempotent)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1001" },
    ]);
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"] }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].success).toBe(true);
    expect(body.results[0].error).toMatch(/Already approved/);
  });

  it("honours optional resolutionType on bulk_approve (default refund)", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: null },
    ]);
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"], resolutionType: "exchange" }),
      params: {}, context: {},
    } as never);
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ resolutionType: "exchange" }),
    }));
  });

  it("swallows notification failures without failing the row", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: "u@x.com", shopifyOrderName: "#1001" },
    ]);
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    sendApprovalMock.mockRejectedValueOnce(new Error("smtp"));
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"] }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].success).toBe(true);
  });

  it("reports per-row error when DB update throws", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: null },
    ]);
    prismaMock.returnCase.updateMany.mockRejectedValueOnce(new Error("deadlock"));
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1"] }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].success).toBe(false);
    expect(body.results[0].error).toMatch(/deadlock/);
  });

  it("appends 'not found' entries for ids not in shop", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: null },
    ]);
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await action({
      request: mkJsonReq({ action: "bulk_approve", returnIds: ["rc-1", "rc-missing"] }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    const missingResult = body.results.find((r: { id: string }) => r.id === "rc-missing");
    expect(missingResult.success).toBe(false);
    expect(missingResult.error).toMatch(/not found/);
  });
});

describe("bulk_reject", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1" });
  });

  it("rejects with reason + emails customer", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", customerEmailNorm: "u@x.com", shopifyOrderName: "#1001" },
    ]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_reject", returnIds: ["rc-1"], rejectionReason: "duplicate" }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].success).toBe(true);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "rejected", rejectionReason: "duplicate" }),
    }));
    expect(sendRejectionMock).toHaveBeenCalled();
  });

  it("skips terminal returns", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "completed", customerEmailNorm: null },
    ]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_reject", returnIds: ["rc-1"], rejectionReason: "dup" }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.errorCount).toBe(1);
  });
});

describe("bulk_change_resolution", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1" });
  });

  it("updates resolutionType + emits event", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "pending", resolutionType: "refund" },
    ]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_change_resolution", returnIds: ["rc-1"], resolutionType: "exchange" }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].success).toBe(true);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { resolutionType: "exchange" },
    }));
  });

  it("rejects rejected/cancelled returns", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-1", status: "rejected", resolutionType: "refund" },
      { id: "rc-2", status: "cancelled", resolutionType: "refund" },
    ]);
    const res = await action({
      request: mkJsonReq({ action: "bulk_change_resolution", returnIds: ["rc-1", "rc-2"], resolutionType: "exchange" }),
      params: {}, context: {},
    } as never);
    const body = await res.json();
    expect(body.errorCount).toBe(2);
  });
});
