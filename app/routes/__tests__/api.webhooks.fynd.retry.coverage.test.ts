/**
 * Coverage tests for app/routes/api.webhooks.fynd.retry.ts
 *
 * Complements api.webhooks.fynd.retry.test.ts by exercising:
 *   • Replaying a single ignored webhook (success branches, delete fallback,
 *     non-Error thrown values, non-string logId, returnCaseId echoed back).
 *   • Bulk replay branches (empty list, all-still-ignored, unwrap errors,
 *     bulk delete failure non-fatal, ordering / take limit pass-through).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, processFyndWebhookMock, unwrapFyndWebhookPayloadMock } =
  vi.hoisted(() => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateMock: vi.fn(),
    processFyndWebhookMock: vi.fn(),
    unwrapFyndWebhookPayloadMock: vi.fn(),
  }));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));

import { action } from "../api.webhooks.fynd.retry";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://app.example/api/webhooks/fynd/retry", init);
}

const ctx: { params: Record<string, string>; context: unknown; unstable_pattern: string } = {
  params: {},
  context: {},
  unstable_pattern: "",
};

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({
    payload: JSON.parse(raw),
    eventType: "shipment.updated",
  }));
});

describe("replay an ignored webhook (single retry edge cases)", () => {
  it("echoes returnCaseId in body when reprocess succeeds with new action", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-A",
      action: "ignored",
      rawPayload: JSON.stringify({ shipment_id: "SH-A" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "created",
      returnCaseId: "rc-A",
    });
    const res = await action({ request: jsonReq({ logId: "log-A" }), ...ctx } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      action: "created",
      returnCaseId: "rc-A",
    });
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({
      where: { id: "log-A" },
    });
  });

  it("does not delete when new action equals old action (still effectively unchanged)", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-B",
      action: "updated",
      rawPayload: JSON.stringify({ shipment_id: "SH-B" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-B",
    });
    const res = await action({ request: jsonReq({ logId: "log-B" }), ...ctx } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndWebhookLog.delete).not.toHaveBeenCalled();
  });

  it("swallows delete failure (non-fatal) and still returns 200", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-C",
      action: "ignored",
      rawPayload: JSON.stringify({ shipment_id: "SH-C" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "created",
      returnCaseId: "rc-C",
    });
    prismaMock.fyndWebhookLog.delete.mockRejectedValueOnce(new Error("FK constraint"));
    const res = await action({ request: jsonReq({ logId: "log-C" }), ...ctx } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("created");
  });

  it("stringifies non-Error throw values into 500 error body", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-D",
      action: "ignored",
      rawPayload: JSON.stringify({}),
    });
    // unwrap throws a plain string — exercises the `String(err)` branch
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw "not-an-error-instance";
    });
    const res = await action({ request: jsonReq({ logId: "log-D" }), ...ctx } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not-an-error-instance");
  });

  it("non-string logId falls through and returns 400 invalid body", async () => {
    const res = await action({
      request: jsonReq({ logId: 12345 }),
      ...ctx,
    });
    expect(res.status).toBe(400);
    expect(prismaMock.fyndWebhookLog.findUnique).not.toHaveBeenCalled();
  });

  it("returns ok:true with action when reprocess yields ignored (no delete branch)", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-E",
      action: "ignored",
      rawPayload: JSON.stringify({ shipment_id: "SH-E" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "ignored",
    });
    const res = await action({ request: jsonReq({ logId: "log-E" }), ...ctx } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("ignored");
    expect(prismaMock.fyndWebhookLog.delete).not.toHaveBeenCalled();
  });
});

describe("replay all (bulk retry branches)", () => {
  it("returns zero counts when there are no ignored logs", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    const res = await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      total: 0,
      succeeded: 0,
      stillIgnored: 0,
      failed: 0,
    });
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("queries with action=ignored, rawPayload!=null, desc order, take<=500", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    expect(prismaMock.fyndWebhookLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "ignored", rawPayload: { not: null } },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: { id: true, rawPayload: true },
      }),
    );
  });

  it("counts every still-ignored result without deleting any logs", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "x-1", rawPayload: JSON.stringify({ a: 1 }) },
      { id: "x-2", rawPayload: JSON.stringify({ a: 2 }) },
    ]);
    processFyndWebhookMock
      .mockResolvedValueOnce({ ok: true, action: "ignored" })
      .mockResolvedValueOnce({ ok: false, error: "still no order" });
    const res = await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(0);
    expect(body.stillIgnored).toBe(2);
    expect(body.failed).toBe(0);
    expect(prismaMock.fyndWebhookLog.delete).not.toHaveBeenCalled();
  });

  it("counts unwrap throw as failed (catch branch)", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "u-1", rawPayload: "not-json{{" },
      { id: "u-2", rawPayload: JSON.stringify({ ok: true }) },
    ]);
    unwrapFyndWebhookPayloadMock
      .mockImplementationOnce(() => {
        throw new Error("malformed");
      })
      .mockImplementationOnce((raw: string) => ({
        payload: JSON.parse(raw),
        eventType: "shipment.updated",
      }));
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-u2",
    });
    const res = await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.stillIgnored).toBe(0);
  });

  it("treats bulk delete failure as non-fatal (still increments succeeded)", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "d-1", rawPayload: JSON.stringify({ a: 1 }) },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "created",
      returnCaseId: "rc-d1",
    });
    prismaMock.fyndWebhookLog.delete.mockRejectedValueOnce(new Error("locked row"));
    const res = await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.succeeded).toBe(1);
    expect(body.stillIgnored).toBe(0);
    expect(body.failed).toBe(0);
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({
      where: { id: "d-1" },
    });
  });

  it("handles ok:false (no error throw) as stillIgnored, not failed", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "f-1", rawPayload: JSON.stringify({}) },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: false,
      error: "validation failed",
    });
    const res = await action({
      request: jsonReq({ action: "retry_all_ignored" }),
      ...ctx,
    });
    const body = await res.json();
    expect(body.failed).toBe(0);
    expect(body.stillIgnored).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(prismaMock.fyndWebhookLog.delete).not.toHaveBeenCalled();
  });
});
