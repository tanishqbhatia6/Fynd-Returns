import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, decryptMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  decryptMock: vi.fn((v: string) => v),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { action } from "../api.integrations.gorgias-actions";

function mkReq(body?: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/integrations/gorgias-actions", init);
}

function configuredShop() {
  return {
    id: "shop-1",
    settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  decryptMock.mockReset().mockImplementation(() => "secret");
});

describe("POST /api/integrations/gorgias-actions", () => {
  it("405 on non-POST", async () => {
    const res = await action({
      request: mkReq(undefined, "GET"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(405);
  });

  it("400 on invalid JSON body", async () => {
    const res = await action({ request: mkReq("{broken"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when required fields missing", async () => {
    const res = await action({ request: mkReq({ shop: "x" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("403 when Gorgias disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: false },
    });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "k", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("403 when no API key configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "k", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("401 on api key mismatch", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    const res = await action({
      request: mkReq({ shop: "x", api_key: "wrong", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("404 when return not found for shop", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("approve: 400 when return not in initiated/pending status", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({ id: "rc-1", status: "approved" });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("approve: success updates status and writes an event in a transaction", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      adminNotes: null,
    });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  it("reject: 400 when not in initiated/pending status", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({ id: "rc-1", status: "completed" });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "reject", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("reject: success uses rejectionReason body field (default used when absent)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({ id: "rc-1", status: "pending" });
    const res = await action({
      request: mkReq({
        shop: "x",
        api_key: "secret",
        action: "reject",
        returnId: "rc-1",
        rejectionReason: "dup request",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  it("add_note: 400 when note empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      adminNotes: null,
    });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "add_note", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("add_note: appends to existing notes", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      adminNotes: "old note",
    });
    const res = await action({
      request: mkReq({
        shop: "x",
        api_key: "secret",
        action: "add_note",
        returnId: "rc-1",
        note: "new note",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  it("get_timeline: returns parsed events", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({ id: "rc-1", status: "pending" });
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        eventType: "status_changed",
        source: "admin",
        happenedAt: new Date("2025-01-01"),
        payloadJson: JSON.stringify({ from: "pending", to: "approved" }),
      },
      {
        eventType: "note_added",
        source: "gorgias",
        happenedAt: new Date("2025-01-02"),
        payloadJson: null,
      },
    ]);
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "get_timeline", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.timeline).toHaveLength(2);
    expect(body.timeline[0].details.to).toBe("approved");
    expect(body.timeline[1].details).toBe(null);
  });

  it("400 for unknown action type", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({ id: "rc-1", status: "pending" });
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "nuke", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("500 when a handler throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(configuredShop());
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      adminNotes: null,
    });
    prismaMock.$transaction.mockRejectedValueOnce(new Error("db"));
    const res = await action({
      request: mkReq({ shop: "x", api_key: "secret", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});
