/**
 * Extra coverage tests for app/routes/api.webhooks.fynd.ts
 *
 * Complements api.webhooks.fynd.test.ts by exercising:
 *   - Various shipment_status / status payload shapes the route flattens to
 *     compute the dedup key (object form, nested order.shipments, refund_status_flag,
 *     shipmentId camel form, top-level id, missing identifiers, etc.).
 *   - The dedup-check error path (findFirst rejects → warn + proceed).
 *   - GET on /api/webhooks/fynd via loader.
 *   - Replay-attack detection via x-webhook-timestamp + x-fynd-timestamp,
 *     including future-skewed timestamps.
 */
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

function mkReq(body: unknown, headers: Record<string, string> = {}) {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://app.example/api/webhooks/fynd", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: bodyStr,
  });
}

beforeEach(() => {
  process.env = { ...origEnv, NODE_ENV: "test" };
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset().mockResolvedValue({
    ok: true,
    action: "updated",
    returnCaseId: "rc-default",
  });
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((body: string) => ({
    payload: JSON.parse(body),
    eventType: "shipment.updated",
  }));
  authenticateWebhookMock.mockReset().mockReturnValue({ ok: true });
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("GET /api/webhooks/fynd (loader)", () => {
  it("returns ok:true with method:POST hint", async () => {
    const res = await loader({
      request: new Request("https://app.example/api/webhooks/fynd"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, method: "POST" });
  });

  it("does not touch Prisma or processor on GET (no DB hits)", async () => {
    await loader({
      request: new Request("https://app.example/api/webhooks/fynd"),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.create).not.toHaveBeenCalled();
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });
});

describe("shipment_status / status path coverage", () => {
  it("uses top-level status string for dedup key (delivered)", async () => {
    await action({
      request: mkReq({ shipment_id: "SH-A", status: "delivered" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shipmentId: "SH-A", refundStatus: "delivered" }),
      }),
    );
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("prefers refund_status over status when both present", async () => {
    await action({
      request: mkReq({ shipment_id: "SH-B", status: "delivered", refund_status: "refund_done" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shipmentId: "SH-B", refundStatus: "refund_done" }),
      }),
    );
  });

  it("falls back to shipmentId (camelCase) when shipment_id missing", async () => {
    await action({
      request: mkReq({ shipmentId: "SH-CAMEL", status: "out_for_delivery" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shipmentId: "SH-CAMEL",
          refundStatus: "out_for_delivery",
        }),
      }),
    );
  });

  it("falls back to top-level id when shipment_id and shipmentId both absent", async () => {
    await action({
      request: mkReq({ id: "SH-FALLBACK", status: "in_transit" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shipmentId: "SH-FALLBACK", refundStatus: "in_transit" }),
      }),
    );
  });

  it("skips dedup query entirely when no shipment id can be derived", async () => {
    await action({
      request: mkReq({ status: "delivered" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).not.toHaveBeenCalled();
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("skips dedup query when no status can be derived", async () => {
    await action({
      request: mkReq({ shipment_id: "SH-NOSTATUS" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).not.toHaveBeenCalled();
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("coerces numeric shipment ids to strings for the where clause", async () => {
    await action({
      request: mkReq({ shipment_id: 12345, status: "delivered" }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.fyndWebhookLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shipmentId: "12345", refundStatus: "delivered" }),
      }),
    );
  });

  it("handles refund_done shipment_status path → forwards to processor", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "refund_triggered",
      returnCaseId: "rc-refund",
    });
    const res = await action({
      request: mkReq({ shipment_id: "SH-REFUND", refund_status: "refund_done" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, action: "refund_triggered", returnCaseId: "rc-refund" });
  });

  it("handles return-journey shipment_status (return_initiated) path", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "return_started",
      returnCaseId: "rc-ret",
    });
    const res = await action({
      request: mkReq({ shipment_id: "SH-RET", status: "return_initiated" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
    const [payloadArg] = processFyndWebhookMock.mock.calls[0];
    expect(payloadArg).toMatchObject({ shipment_id: "SH-RET", status: "return_initiated" });
  });

  it("handles unknown shipment_status (e.g. 'martian_pending') without crashing", async () => {
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "ignored_unknown_status",
      returnCaseId: undefined,
    });
    const res = await action({
      request: mkReq({ shipment_id: "SH-UNK", status: "martian_pending" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe("dedup-check error path", () => {
  it("warns and proceeds when fyndWebhookLog.findFirst rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaMock.fyndWebhookLog.findFirst.mockRejectedValueOnce(new Error("connection reset"));
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-after-dedup-fail",
    });

    const res = await action({
      request: mkReq({ shipment_id: "SH-DUPFAIL", status: "delivered" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dedup check failed"),
      expect.stringContaining("connection reset"),
    );
    warnSpy.mockRestore();
  });

  it("warns and proceeds even with a non-Error thrown value", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaMock.fyndWebhookLog.findFirst.mockRejectedValueOnce("string failure");
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-string-err",
    });

    const res = await action({
      request: mkReq({ shipment_id: "SH-STRERR", status: "in_transit" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dedup check failed"),
      "string failure",
    );
    warnSpy.mockRestore();
  });

  it("returns duplicate_ignored only when dedup query succeeds and finds a hit", async () => {
    prismaMock.fyndWebhookLog.findFirst.mockResolvedValueOnce({ id: "log-existing" });
    const res = await action({
      request: mkReq({ shipment_id: "SH-DUP", status: "delivered" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.action).toBe("duplicate_ignored");
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });
});

describe("replay-attack detection (timestamp drift)", () => {
  it("rejects payload with x-webhook-timestamp 6 minutes in the past", async () => {
    const stale = new Date(Date.now() - 6 * 60_000).toISOString();
    const res = await action({
      request: mkReq(
        { shipment_id: "SH-STALE", status: "delivered" },
        { "x-webhook-timestamp": stale },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/timestamp/i);
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects payload with x-fynd-timestamp 6 minutes in the FUTURE (clock-skew replay)", async () => {
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const res = await action({
      request: mkReq(
        { shipment_id: "SH-FUT", status: "delivered" },
        { "x-fynd-timestamp": future },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("accepts payload with x-fynd-timestamp 1 minute in the past (within window)", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const res = await action({
      request: mkReq(
        { shipment_id: "SH-RECENT", status: "delivered" },
        { "x-fynd-timestamp": recent },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("prefers x-webhook-timestamp over x-fynd-timestamp when both are set", async () => {
    // x-webhook-timestamp is fresh, x-fynd-timestamp is stale → should accept (the
    // route's `??` chain reads x-webhook-timestamp first, ignoring the fallback).
    const fresh = new Date(Date.now() - 30_000).toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const res = await action({
      request: mkReq(
        { shipment_id: "SH-BOTH", status: "delivered" },
        { "x-webhook-timestamp": fresh, "x-fynd-timestamp": stale },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("ignores garbage timestamp header values and processes the webhook", async () => {
    const res = await action({
      request: mkReq(
        { shipment_id: "SH-JUNK", status: "delivered" },
        { "x-webhook-timestamp": "definitely-not-a-date" },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });

  it("skips replay check when no timestamp header present", async () => {
    const res = await action({
      request: mkReq({ shipment_id: "SH-NOHDR", status: "delivered" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(processFyndWebhookMock).toHaveBeenCalledOnce();
  });
});
