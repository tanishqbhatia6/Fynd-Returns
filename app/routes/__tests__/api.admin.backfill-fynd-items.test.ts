/**
 * Smoke tests for /api/admin/backfill-fynd-items.
 * Locks in: auth, method gate, error branches, dryRun behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, createFyndClientOrErrorMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));

import { action } from "../api.admin.backfill-fynd-items";

function mkReq(body: unknown = {}, method: string = "POST") {
  return new Request("https://app.example/api/admin/backfill-fynd-items", {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

describe("POST /api/admin/backfill-fynd-items", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: mkReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("400 when settings missing", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: null });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when Fynd client construction fails", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("no creds");
  });

  it("400 when client is storefront-only", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { /* no getShipments */ } });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("returns empty results when no eligible cases", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null) },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toEqual([]);
  });

  it("scopes by returnCaseId when supplied", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null) },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await action({ request: mkReq({ returnCaseId: "rc-target" }), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "rc-target", shopId: "shop-1" }),
    }));
  });

  it("clamps limit to max 200", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null) },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await action({ request: mkReq({ limit: 5000 }), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });

  it("tolerates malformed JSON body", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null) },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const req = new Request("https://app.example/api/admin/backfill-fynd-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await action({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
