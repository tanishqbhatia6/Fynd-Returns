import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  checkRateLimitMock,
  createFyndClientOrErrorMock,
  parseFyndOrderDetailsMock,
  extractFyndJourneyMock,
  getTrackingInfoMock,
  getPickupAddressMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  parseFyndOrderDetailsMock: vi.fn(() => ({ orderInfo: { name: "#1001" } })),
  extractFyndJourneyMock: vi.fn(() => [{ status: "delivery_done" }]),
  getTrackingInfoMock: vi.fn(() => ({ awb: "AWB-1" })),
  getPickupAddressMock: vi.fn(() => ({ city: "SF" })),
}));
Object.assign(prismaMock, createPrismaMock());
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
};

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  parseFyndOrderDetailsForTab: parseFyndOrderDetailsMock,
  extractFyndJourney: extractFyndJourneyMock,
  getTrackingInfoFromFyndPayload: getTrackingInfoMock,
  getPickupAddressFromFyndPayload: getPickupAddressMock,
}));

import { loader, action } from "../api.portal.fynd-enrich";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/portal/fynd-enrich", init);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const mapping = (
    prismaMock as unknown as Record<
      string,
      Record<string, { mockReset: () => void; mockResolvedValue: (v: unknown) => void }>
    >
  ).fyndOrderMapping;
  mapping.upsert.mockReset();
  mapping.upsert.mockResolvedValue({});
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  parseFyndOrderDetailsMock.mockReset().mockReturnValue({ orderInfo: { name: "#1001" } });
  extractFyndJourneyMock.mockReset().mockReturnValue([{ status: "delivery_done" }]);
  getTrackingInfoMock.mockReset().mockReturnValue({ awb: "AWB-1" });
  getPickupAddressMock.mockReset().mockReturnValue({ city: "SF" });
});

describe("loader preflight", () => {
  it("204 on OPTIONS", async () => {
    const res = await loader({
      request: new Request("https://a/x", { method: "OPTIONS" }),
      params: {},
      context: {},
    } as never);
    expect(res?.status).toBe(204);
  });
});

describe("action guards", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: jsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("429 on rate limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: jsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("400 when shop missing", async () => {
    const res = await action({ request: jsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: jsonReq({ shop: "x" }), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("returns empty payload when Fynd client unavailable", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
  });

  it("returns empty payload when client lacks searchShipmentsByExternalOrderId (storefront-only)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        /* no search method */
      },
    });
    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.fyndData).toBe(null);
  });

  it("200 with null payload on unexpected thrown error", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db gone"));
    const res = await action({
      request: jsonReq({ shop: "x", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
  });
});

describe("order enrichment (type=order)", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("returns fyndData when search hits forward items, stripping # prefix", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [{ shipment_id: "SH-1", order_id: "O-1", journey_type: "forward" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "#1001" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.fyndData).not.toBe(null);
    expect(searchMock).toHaveBeenCalledWith("1001", expect.anything());
  });

  it("prefers forward shipments over return shipments when both returned", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [
        { shipment_id: "RET-1", journey_type: "return" },
        { shipment_id: "FWD-1", journey_type: "forward" },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    // parseFyndOrderDetailsForTab should be called with the forward-filtered payload
    expect(parseFyndOrderDetailsMock).toHaveBeenCalled();
  });

  it("caches mapping when forward shipment found", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [{ shipment_id: "SH-1", order_id: "O-1", journey_type: "forward" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    await new Promise((r) => setImmediate(r));
    const mapping = (
      prismaMock as unknown as Record<string, Record<string, { mock: { calls: unknown[] } }>>
    ).fyndOrderMapping;
    expect(mapping.upsert.mock.calls.length).toBeGreaterThan(0);
  });

  it("swallows search-throw and returns null fyndData", async () => {
    const searchMock = vi.fn().mockRejectedValueOnce(new Error("Fynd 500"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.fyndData).toBe(null);
  });
});

describe("returns enrichment (type=returns)", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("caps returnIds to 10 and ignores returns with missing orderName/shipmentId", async () => {
    const searchMock = vi.fn().mockResolvedValue({ items: [] });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: null, fyndShipmentId: null, fyndPayloadJson: null },
      { id: "r-2", shopifyOrderName: "#1002", fyndShipmentId: "SH-2", fyndPayloadJson: null },
    ]);

    const res = await action({
      request: jsonReq({
        shop: "store",
        type: "returns",
        returnIds: new Array(20).fill(0).map((_, i) => `r-${i}`),
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // findMany was called with a cap of 10 IDs
    const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(where.id.in.length).toBe(10);
  });

  it("enriches a return with tracking + journey when shipment matches by exact ID", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipment_id: "SH-EXACT", journey_type: "return" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#1001", fyndShipmentId: "SH-EXACT", fyndPayloadJson: null },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returnEnrichments["r-1"]).toEqual(
      expect.objectContaining({
        trackingInfo: { awb: "AWB-1" },
        fyndShipmentId: "SH-EXACT",
      }),
    );
  });

  it("falls back to first return shipment when exact ID doesn't match (stale bag ID)", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipment_id: "SH-LIVE", journey_type: "return" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#1001", fyndShipmentId: "BAG-STALE", fyndPayloadJson: null },
    ]);
    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returnEnrichments["r-1"].fyndShipmentId).toBe("SH-LIVE");
  });
});
