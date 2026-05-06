import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  createFyndClientOrErrorMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd.server", () => ({ createFyndClientOrError: createFyndClientOrErrorMock }));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
}));

import { loader } from "../api.returns.$id.diagnose";

function mkReq() {
  return new Request("https://app.example/api/returns/rc-1/diagnose");
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  fetchOrderMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
});

describe("GET /api/returns/:id/diagnose", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("404 when return case not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("returns diagnostic payload with DB fields + analysis when Fynd disabled", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      returnRequestNo: "R-1",
      shopifyOrderId: "gid://shopify/Order/123",
      shopifyOrderName: "#1001",
      status: "pending",
      fyndOrderId: null,
      fyndReturnId: null,
      fyndShipmentId: null,
      items: [
        {
          id: "it-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          sku: "SKU-1",
          qty: 1,
          price: "10",
          reasonCode: "defective",
          title: "Item",
          fyndShipmentId: null,
          fyndBagId: null,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
      createdByChannel: "portal",
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerAddress1: null,
      customerZip: null,
      forwardAwb: null,
      returnAwb: null,
      shopifyReturnId: null,
      refundStatus: null,
      resolutionType: "refund",
      fyndCurrentStatus: null,
      fyndReturnNo: null,
    });
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-1" });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dbColumns.id).toBe("rc-1");
    expect(body.dbItems).toHaveLength(1);
    expect(body.analysis.externalOrderId).toBe("1001");
    expect(body.analysis.affiliateOrderId).toBe("AFF-1");
    expect(body.analysis.wouldUseFastPath).toBe(false); // no shipment ID derived
    expect(body.fyndClientError).toMatch(/Fynd not configured/);
    expect(body.apiTrace).toEqual([]);
  });

  it("derives fast path when fyndShipmentId is set + items have SKUs", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      returnRequestNo: "R-1",
      shopifyOrderId: "manual:FY123",
      shopifyOrderName: "#1001",
      status: "approved",
      fyndOrderId: null,
      fyndReturnId: null,
      fyndShipmentId: "SH-DERIVED",
      items: [
        {
          id: "it-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          sku: "SKU-1",
          qty: 2,
          price: "10",
          reasonCode: "size",
          title: "Item",
          fyndShipmentId: null,
          fyndBagId: null,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
      createdByChannel: "portal",
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerAddress1: null,
      customerZip: null,
      forwardAwb: null,
      returnAwb: null,
      shopifyReturnId: null,
      refundStatus: null,
      resolutionType: "refund",
      fyndCurrentStatus: null,
      fyndReturnNo: null,
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.wouldUseFastPath).toBe(true);
    expect(body.analysis.derivedTargetShipId).toBe("SH-DERIVED");
    expect(body.fastPathPayload).toBeDefined();
    expect(body.fastPathPayload._endpoint).toMatch(/status-internal/);
    expect(body.fastPathPayload.statuses[0].shipments[0].identifier).toBe("SH-DERIVED");
  });

  it("captures Shopify order fetch error in analysis", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderId: null,
      shopifyOrderName: "#1001",
      items: [],
      fyndOrderId: null,
      fyndReturnId: null,
      fyndShipmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
      returnRequestNo: null,
      status: "pending",
      createdByChannel: "portal",
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerAddress1: null,
      customerZip: null,
      forwardAwb: null,
      returnAwb: null,
      shopifyReturnId: null,
      refundStatus: null,
      resolutionType: null,
      fyndCurrentStatus: null,
      fyndReturnNo: null,
    });
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("shopify down"));

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.shopifyOrderFetchError).toBe("shopify down");
  });

  it("runs live Fynd API trace when client available", async () => {
    const searchMock = vi
      .fn()
      .mockResolvedValue({ items: [{ shipment_id: "SH-1" }], orderId: "O-1" });
    const getShipmentsMock = vi.fn().mockResolvedValue({ order: { id: "O-1" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: getShipmentsMock },
    });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderId: null,
      shopifyOrderName: "#1001",
      items: [],
      fyndOrderId: null,
      fyndReturnId: null,
      fyndShipmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
      returnRequestNo: null,
      status: "pending",
      createdByChannel: "portal",
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerAddress1: null,
      customerZip: null,
      forwardAwb: null,
      returnAwb: null,
      shopifyReturnId: null,
      refundStatus: null,
      resolutionType: null,
      fyndCurrentStatus: null,
      fyndReturnNo: null,
    });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.apiTrace.length).toBeGreaterThan(0);
    expect(body.apiTrace[0].step).toMatch(/Search by external_order_id/);
    expect(body.apiTrace[0].response.body.items).toHaveLength(1);
  });

  it("adds error entry in apiTrace when search throws", async () => {
    const searchMock = vi.fn().mockRejectedValue(new Error("Fynd 500"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopifyOrderId: null,
      shopifyOrderName: "#1001",
      items: [],
      fyndOrderId: null,
      fyndReturnId: null,
      fyndShipmentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      currency: "USD",
      returnRequestNo: null,
      status: "pending",
      createdByChannel: "portal",
      customerName: null,
      customerEmailNorm: null,
      customerPhoneNorm: null,
      customerCity: null,
      customerAddress1: null,
      customerZip: null,
      forwardAwb: null,
      returnAwb: null,
      shopifyReturnId: null,
      refundStatus: null,
      resolutionType: null,
      fyndCurrentStatus: null,
      fyndReturnNo: null,
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.apiTrace[0].error).toBe("Fynd 500");
  });
});
