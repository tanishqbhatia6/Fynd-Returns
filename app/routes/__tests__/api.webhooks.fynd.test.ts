import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  processFyndWebhookMock,
  unwrapFyndWebhookPayloadMock,
  authenticateWebhookMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  authenticateWebhook: authenticateWebhookMock,
}));

import { loader, action } from "../api.webhooks.fynd";

const origEnv = { ...process.env };

function mkReq(bodyStr: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  return new Request("https://app.example/api/webhooks/fynd", {
    method: "POST",
    headers: h,
    body: bodyStr,
  });
}

beforeEach(() => {
  process.env = { ...origEnv, NODE_ENV: "test" };
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((body: string) => ({
    payload: JSON.parse(body),
    eventType: "shipment.updated",
  }));
  authenticateWebhookMock.mockReset().mockReturnValue({ ok: true });
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("loader", () => {
  it("returns simple ok response on GET", async () => {
    const res = await loader({
      request: new Request("https://a/x"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

describe("action guards", () => {
  it("405 on non-POST", async () => {
    const req = new Request("https://app.example/api/webhooks/fynd");
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("413 when content-length exceeds 1MB cap", async () => {
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(2_000_000) },
      body: JSON.stringify({ shipment_id: "SH-1" }),
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(413);
  });

  it("413 when body bytes exceed cap (lying content-length)", async () => {
    const huge = "{" + "x".repeat(1_100_000) + "}";
    const req = new Request("https://app.example/api/webhooks/fynd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge,
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(413);
  });

  it("503 in production when FYND_WEBHOOK_SECRET missing", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.FYND_WEBHOOK_SECRET;
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(503);
  });

  it("401 when signature auth fails", async () => {
    process.env.FYND_WEBHOOK_SECRET = "secret";
    authenticateWebhookMock.mockReturnValueOnce({ ok: false, reason: "hmac_mismatch" });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("allows through in dev when no secret set (loader continues past auth)", async () => {
    delete process.env.FYND_WEBHOOK_SECRET;
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-1",
    });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("400 on unparseable JSON; logs to DB", async () => {
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw new Error("bad json");
    });
    const res = await action({
      request: mkReq("{broken"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error" }),
      }),
    );
  });

  it("401 on stale webhook (timestamp > 5min old)", async () => {
    const oldTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" }), {
        "x-webhook-timestamp": oldTs,
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("ignores invalid timestamp values (lets through)", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-1",
    });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" }), {
        "x-webhook-timestamp": "not-a-date",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe("idempotency + dispatch", () => {
  it("returns duplicate_ignored when matching recent log exists", async () => {
    prismaMock.fyndWebhookLog.findFirst.mockResolvedValueOnce({ id: "dup" });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("duplicate_ignored");
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("continues even if dedup query throws", async () => {
    prismaMock.fyndWebhookLog.findFirst.mockRejectedValueOnce(new Error("db"));
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-1",
    });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("calls processFyndWebhook + returns result shape", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "refund_triggered",
      returnCaseId: "rc-9",
    });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "refund_done" })),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body).toEqual({ ok: true, action: "refund_triggered", returnCaseId: "rc-9" });
  });

  it("500 when processFyndWebhook returns ok:false", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({ ok: false, error: "DB locked" });
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });

  it("500 when processFyndWebhook throws", async () => {
    processFyndWebhookMock.mockRejectedValueOnce(new Error("crash"));
    const res = await action({
      request: mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});
