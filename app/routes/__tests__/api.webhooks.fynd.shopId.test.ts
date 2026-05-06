import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  processFyndWebhookMock,
  unwrapFyndWebhookPayloadMock,
  readBoundedBodyMock,
  authenticateWebhookMock,
  decryptMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
  readBoundedBodyMock: vi.fn(),
  authenticateWebhookMock: vi.fn(),
  decryptMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  readBoundedBody: readBoundedBodyMock,
  authenticateWebhook: authenticateWebhookMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { loader, action } from "../api.webhooks.fynd.$shopId";

function mkReq(body: string, shopId: string = "shop-1", headers: Record<string, string> = {}) {
  return {
    request: new Request(`https://app.example/api/webhooks/fynd/${shopId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
    params: { shopId },
    context: {},
  } as never;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({
    payload: JSON.parse(raw),
    eventType: "shipment.updated",
  }));
  readBoundedBodyMock
    .mockReset()
    .mockImplementation(async (req: Request) => ({ body: await req.text() }));
  authenticateWebhookMock.mockReset().mockReturnValue({ ok: true });
  decryptMock
    .mockReset()
    .mockImplementation((v: string | null) => (v ? v.replace(/^enc:/, "") : null));
});

describe("loader", () => {
  it("returns simple ok response", async () => {
    const res = await loader({
      request: new Request("https://a/x"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.model).toBe("per-shop");
  });
});

describe("action", () => {
  it("405 on non-POST", async () => {
    const res = await action({
      request: new Request("https://app.example/api/webhooks/fynd/shop-1"),
      params: { shopId: "shop-1" },
      context: {},
    } as never);
    expect(res.status).toBe(405);
  });

  it("400 on invalid shopId shape", async () => {
    const res = await action(mkReq("{}", "bad shop id!"));
    expect(res.status).toBe(400);
  });

  it("400 when shopId > 64 chars", async () => {
    const res = await action(mkReq("{}", "x".repeat(65)));
    expect(res.status).toBe(400);
  });

  it("rejects body-size-exceeded from readBoundedBody", async () => {
    readBoundedBodyMock.mockResolvedValueOnce({
      rejected: Response.json({ error: "too large" }, { status: 413 }),
    });
    const res = await action(mkReq("{}"));
    expect(res.status).toBe(413);
  });

  it("401 when shop not found (anti-enumeration)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action(mkReq("{}"));
    expect(res.status).toBe(401);
  });

  it("401 when shop has no configured secret", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: null },
    });
    const res = await action(mkReq("{}"));
    expect(res.status).toBe(401);
  });

  it("401 when authenticateWebhook fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    authenticateWebhookMock.mockReturnValueOnce({ ok: false, reason: "mismatch" });
    const res = await action(mkReq("{}"));
    expect(res.status).toBe(401);
  });

  it("401 on stale timestamp", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    const oldTs = new Date(Date.now() - 10 * 60_000).toISOString();
    const res = await action(
      mkReq(JSON.stringify({ shipment_id: "SH-1" }), "shop-1", { "x-webhook-timestamp": oldTs }),
    );
    expect(res.status).toBe(401);
  });

  it("400 + logs on JSON parse error", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    unwrapFyndWebhookPayloadMock.mockImplementationOnce(() => {
      throw new Error("bad json");
    });
    const res = await action(mkReq("{broken"));
    expect(res.status).toBe(400);
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error" }),
      }),
    );
  });

  it("injects _shop_domain into payload before processing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "updated",
      returnCaseId: "rc-1",
    });
    await action(mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })));
    const calledWith = processFyndWebhookMock.mock.calls[0][0];
    expect(calledWith._shop_domain).toBe("store.myshopify.com");
  });

  it("returns duplicate_ignored on recent dup", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    prismaMock.fyndWebhookLog.findFirst.mockResolvedValueOnce({ id: "dup" });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })));
    const body = await res.json();
    expect(body.action).toBe("duplicate_ignored");
  });

  it("500 when processFyndWebhook returns ok:false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    processFyndWebhookMock.mockResolvedValueOnce({ ok: false, error: "DB" });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })));
    expect(res.status).toBe(500);
  });

  it("500 when processFyndWebhook throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    processFyndWebhookMock.mockRejectedValueOnce(new Error("crash"));
    const res = await action(mkReq(JSON.stringify({ shipment_id: "SH-1", status: "delivered" })));
    expect(res.status).toBe(500);
  });

  it("happy path: returns {ok:true, action, returnCaseId}", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:secret" },
    });
    processFyndWebhookMock.mockResolvedValueOnce({
      ok: true,
      action: "refund_triggered",
      returnCaseId: "rc-9",
    });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "SH-1", status: "refund_done" })));
    const body = await res.json();
    expect(body).toEqual({ ok: true, action: "refund_triggered", returnCaseId: "rc-9" });
  });
});
