/**
 * Gap coverage for GET /api/admin/return-items-data/:id
 *
 * Targets line 86:
 *   const shipments = Array.isArray(rawItems) ? rawItems : [];
 *
 * The false branch fires when searchRes.items (or .shipments) exists but is
 * NOT an array (e.g., an object). Existing tests only exercise the true branch
 * and the default-empty-array fallback; this test pins the falsy path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, createFyndClientOrErrorMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd.server", () => ({ createFyndClientOrError: createFyndClientOrErrorMock }));

import { loader } from "../api.admin.return-items-data.$id";

function mkReq() {
  return new Request("https://app.example/api/admin/return-items-data/rc-1");
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

describe("api.admin.return-items-data.$id — gap (line 86 false branch)", () => {
  it("coerces non-array searchRes.items value to empty shipments list", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      returnRequestNo: "R-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid",
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "portal",
      createdAt: new Date(),
      items: [],
    });

    // searchRes.items is an OBJECT, not an array — exercises the false branch
    // of `Array.isArray(rawItems) ? rawItems : []` on line 86.
    const searchMock = vi.fn().mockResolvedValue({
      items: { unexpected: "shape" },
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({
      request: mkReq(),
      params: { id: "rc-1" },
      context: {},
    } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledOnce();
    expect(Array.isArray(body.liveFyndData)).toBe(true);
    expect(body.liveFyndData).toEqual([]);
    expect(body.liveFyndError).toBeNull();
  });

  it("coerces non-array searchRes.shipments value to empty shipments list", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      returnRequestNo: "R-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid",
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "portal",
      createdAt: new Date(),
      items: [],
    });

    // No `items` key → falls through to `shipments`, which is also non-array.
    const searchMock = vi.fn().mockResolvedValue({
      shipments: "not-an-array",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({
      request: mkReq(),
      params: { id: "rc-1" },
      context: {},
    } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.liveFyndData)).toBe(true);
    expect(body.liveFyndData).toEqual([]);
    expect(body.liveFyndError).toBeNull();
  });
});
