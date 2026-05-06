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

describe("GET /api/admin/return-items-data/:id", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("404 when return not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("returns item list + missing-fields summary", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
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
      items: [
        {
          id: "it-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          title: "T-shirt",
          variantTitle: "L",
          sku: "SKU-1",
          price: "20",
          qty: 1,
          reasonCode: "defective",
          fyndShipmentId: null,
          fyndBagId: null,
          fyndArticleId: null,
          fyndAffiliateLineId: null,
          fyndSellerIdentifier: null,
          fyndItemId: null,
          fyndQuantityAvailable: null,
          fyndPriceEffective: null,
          fyndSize: null,
        },
      ],
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.missingFieldCount).toBe(9); // sku present, 9 fynd fields null
    expect(body.missingFields.some((f: string) => f.includes("fyndShipmentId"))).toBe(true);
    expect(body.liveFyndData).toBe(null);
  });

  it("captures error from Fynd client creation", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderName: "#1001",
      items: [],
      createdAt: new Date(),
      returnRequestNo: null,
      shopifyOrderId: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "portal",
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndError).toBe("no creds");
  });

  it("extracts live Fynd data (shipment + bag + articles)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderName: "#1001",
      items: [],
      createdAt: new Date(),
      returnRequestNo: null,
      shopifyOrderId: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "portal",
    });
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        {
          shipment_id: "SH-1",
          status: "delivered",
          bags: [
            {
              bag_id: "BAG-1",
              quantity: 2,
              affiliate_bag_details: { affiliate_line_id: "ALI-1" },
              articles: [
                {
                  seller_identifier: "SI-1",
                  article_id: "A-1",
                  item: { item_id: "I-1", name: "Shirt", size: "L" },
                  quantity_available: 5,
                },
              ],
              prices: { price_effective: "20.00", transfer_price: "15.00" },
            },
          ],
        },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndData[0].shipment_id).toBe("SH-1");
    expect(body.liveFyndData[0].bags[0].bag_id).toBe("BAG-1");
    expect(body.liveFyndData[0].bags[0].articles[0].seller_identifier).toBe("SI-1");
    expect(body.liveFyndData[0].bags[0].articles[0].size).toBe("L");
    expect(body.liveFyndData[0].bags[0].articles[0].price_effective).toBe("20.00");
  });

  it("captures error thrown by Fynd search", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderName: "#1001",
      items: [],
      createdAt: new Date(),
      returnRequestNo: null,
      shopifyOrderId: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "portal",
    });
    const searchMock = vi.fn().mockRejectedValue(new Error("Fynd down"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndError).toBe("Fynd down");
  });
});
