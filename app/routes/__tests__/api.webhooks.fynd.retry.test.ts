import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  processFyndWebhookMock,
  unwrapFyndWebhookPayloadMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({
    payload: JSON.parse(raw), eventType: "shipment.updated",
  }));
});

describe("method gate", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: jsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });
});

describe("single retry (logId)", () => {
  it("404 when log not found", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: jsonReq({ logId: "missing" }), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("400 when rawPayload missing", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({ id: "log-1", rawPayload: null });
    const res = await action({ request: jsonReq({ logId: "log-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("success: deletes old ignored log + returns new action", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-1", action: "ignored", rawPayload: JSON.stringify({ shipment_id: "SH-1" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "updated", returnCaseId: "rc-1" });
    const res = await action({ request: jsonReq({ logId: "log-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({ where: { id: "log-1" } });
  });

  it("success but still ignored: does NOT delete", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-1", action: "ignored", rawPayload: JSON.stringify({ shipment_id: "SH-1" }),
    });
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await action({ request: jsonReq({ logId: "log-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndWebhookLog.delete).not.toHaveBeenCalled();
  });

  it("500 when processFyndWebhook throws", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-1", action: "ignored", rawPayload: JSON.stringify({}),
    });
    processFyndWebhookMock.mockRejectedValueOnce(new Error("boom"));
    const res = await action({ request: jsonReq({ logId: "log-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });

  it("passes through ok:false from processFyndWebhook without 500", async () => {
    prismaMock.fyndWebhookLog.findUnique.mockResolvedValueOnce({
      id: "log-1", action: "ignored", rawPayload: JSON.stringify({}),
    });
    processFyndWebhookMock.mockResolvedValueOnce({ ok: false, error: "DB error" });
    const res = await action({ request: jsonReq({ logId: "log-1" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("DB error");
  });
});

describe("bulk retry (action=retry_all_ignored)", () => {
  it("processes all ignored logs, counts succeeded/still/failed", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "l-1", rawPayload: JSON.stringify({ a: 1 }) },
      { id: "l-2", rawPayload: JSON.stringify({ a: 2 }) },
      { id: "l-3", rawPayload: null },
      { id: "l-4", rawPayload: JSON.stringify({ a: 4 }) },
    ]);
    processFyndWebhookMock
      .mockResolvedValueOnce({ ok: true, action: "updated", returnCaseId: "rc-1" })
      .mockResolvedValueOnce({ ok: true, action: "ignored" })
      .mockRejectedValueOnce(new Error("crash"));

    const res = await action({ request: jsonReq({ action: "retry_all_ignored" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.succeeded).toBe(1);
    expect(body.stillIgnored).toBe(1);
    expect(body.failed).toBe(2); // null-rawPayload + crash
  });
});

describe("invalid body", () => {
  it("400 on unrecognised payload", async () => {
    const res = await action({ request: jsonReq({ random: "stuff" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });
});
