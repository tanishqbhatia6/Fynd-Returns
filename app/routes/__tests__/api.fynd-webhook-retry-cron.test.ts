import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, processFyndWebhookMock, unwrapFyndWebhookPayloadMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

// The route dynamically imports db.server and fynd-webhook.server at runtime.
vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));

import { loader, action } from "../api.fynd-webhook-retry-cron";

const origEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...origEnv };
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({ payload: JSON.parse(raw), eventType: "shipment.updated" }));
});
afterEach(() => {
  process.env = { ...origEnv };
});

function mkReq(opts: { method?: string; auth?: string; host?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("Authorization", opts.auth);
  if (opts.host) headers.set("Host", opts.host);
  return new Request("https://app.example/api/fynd-webhook-retry-cron", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("auth gating", () => {
  it("401 when CRON_SECRET set but missing auth", async () => {
    process.env.CRON_SECRET = "s";
    const res = await action({ request: mkReq({ method: "POST" }), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("401 on GET without auth", async () => {
    process.env.CRON_SECRET = "s";
    const res = await loader({ request: mkReq({ method: "GET" }), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("allows localhost when CRON_SECRET unset", async () => {
    delete process.env.CRON_SECRET;
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq({ method: "POST", host: "127.0.0.1:3000" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("retry processing", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "s";
  });

  it("returns zero counts when no eligible logs", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body).toEqual({ ok: true, processed: 0, succeeded: 0, rescheduled: 0, exhausted: 0 });
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("deletes log + counts succeeded when processFyndWebhook no longer ignores", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "log-1", rawPayload: JSON.stringify({ a: 1 }), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "updated" });
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.succeeded).toBe(1);
    expect(body.rescheduled).toBe(0);
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({ where: { id: "log-1" } });
  });

  it("reschedules with backoff when webhook still ignored", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "log-2", rawPayload: JSON.stringify({ a: 1 }), retryCount: 1 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.rescheduled).toBe(1);
    const updateCall = prismaMock.fyndWebhookLog.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: "log-2" });
    expect(updateCall.data.retryCount).toBe(2);
    expect(updateCall.data.retryAfter).toBeInstanceOf(Date);
  });

  it("marks exhausted when retryCount reaches MAX_RETRIES", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "log-3", rawPayload: JSON.stringify({ a: 1 }), retryCount: 4 }, // newCount=5 === MAX
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "ignored" });
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.exhausted).toBe(1);
    const call = prismaMock.fyndWebhookLog.update.mock.calls[0][0];
    expect(call.data.retryCount).toBe(5);
    expect(call.data.retryAfter).toBe(null);
    expect(call.data.error).toMatch(/Exhausted/);
  });

  it("handles processFyndWebhook throwing (parse/processing error)", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "log-4", rawPayload: JSON.stringify({ a: 1 }), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockRejectedValueOnce(new Error("boom"));
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.rescheduled).toBe(1); // newCount=1 < MAX_RETRIES
  });

  it("skips logs with null rawPayload", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "log-5", rawPayload: null, retryCount: 0 },
    ]);
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer s" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.succeeded).toBe(0);
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });
});
