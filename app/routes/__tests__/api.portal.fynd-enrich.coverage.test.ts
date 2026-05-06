/**
 * Extended coverage tests for app/routes/api.portal.fynd-enrich.ts
 *
 * Complements api.portal.fynd-enrich.test.ts by exercising:
 *   - type=order vs type=returns vs unknown branches
 *   - Fynd error fallback (createFyndClientOrError fail / null settings)
 *   - Search-result extractSearchItems variations (items / shipments / data.items / results)
 *   - Shop domain normalization
 *   - Mapping upsert payload shape (single + multiple shipment IDs)
 *   - Returns enrichment edge cases (no journey_type, empty items)
 */
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

import { action, loader } from "../api.portal.fynd-enrich";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/portal/fynd-enrich", init);
}

function getMappingMock() {
  return (prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
    .fyndOrderMapping.upsert;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const upsert = getMappingMock();
  upsert.mockReset();
  upsert.mockResolvedValue({});
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  parseFyndOrderDetailsMock.mockReset().mockReturnValue({ orderInfo: { name: "#1001" } });
  extractFyndJourneyMock.mockReset().mockReturnValue([{ status: "delivery_done" }]);
  getTrackingInfoMock.mockReset().mockReturnValue({ awb: "AWB-1" });
  getPickupAddressMock.mockReset().mockReturnValue({ city: "SF" });
});

describe("loader (extra)", () => {
  it("returns null for non-OPTIONS requests", async () => {
    const res = await loader({
      request: new Request("https://a/x", { method: "GET" }),
      params: {},
      context: {},
    } as never);
    expect(res).toBe(null);
  });
});

describe("action — shop domain handling", () => {
  it("treats shop value with a dot as full domain (no append)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });

    const res = await action({
      request: jsonReq({ shop: "store.myshopify.com", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: "store.myshopify.com" } }),
    );
  });

  it("appends .myshopify.com to plain shop slug", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });

    await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: "store.myshopify.com" } }),
    );
  });
});

describe("action — Fynd error fallback", () => {
  it("returns empty payload when shop has no settings record", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });

    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
    // createFyndClientOrError should NOT be called when settings is null
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("returns empty payload when createFyndClientOrError errors", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndPlatformId: "p" },
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "auth_failed" });

    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "1001" }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
  });
});

describe("action — type=order branch and search variations", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("extracts items from `shipments` field when `items` is absent", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      shipments: [{ shipment_id: "SH-A", order_id: "O-A", journey_type: "forward" }],
    });
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
    expect(body.fyndData).not.toBe(null);
    expect(parseFyndOrderDetailsMock).toHaveBeenCalled();
  });

  it("extracts items from nested `data.items` field", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      data: { items: [{ shipment_id: "SH-NESTED", journey_type: "forward" }] },
    });
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
    expect(body.fyndData).not.toBe(null);
  });

  it("extracts items from `results` field", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      results: [{ shipment_id: "SH-RES", journey_type: "forward" }],
    });
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
    expect(body.fyndData).not.toBe(null);
  });

  it("returns null fyndData when search response has no recognizable items", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({ unrelated: "field" });
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
    expect(parseFyndOrderDetailsMock).not.toHaveBeenCalled();
  });

  it("uses external_order_id search type and forwards fulfillment options", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [{ shipment_id: "SH-1", journey_type: "forward" }],
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

    expect(searchMock).toHaveBeenCalledWith(
      "1001",
      expect.objectContaining({
        searchType: "external_order_id",
        fulfillmentType: "FULFILLMENT",
        parentViewSlug: "all",
        childViewSlug: "all",
      }),
    );
  });

  it("caches multiple shipment IDs comma-separated", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [
        { shipment_id: "SH-1", order_id: "O-1", journey_type: "forward" },
        { shipment_id: "SH-2", order_id: "O-1", journey_type: "forward" },
        { shipment_id: "SH-3", order_id: "O-1", journey_type: "forward" },
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
    await new Promise((r) => setImmediate(r));

    const upsert = getMappingMock();
    expect(upsert.mock.calls.length).toBeGreaterThan(0);
    const payload = upsert.mock.calls[0][0] as {
      create: { fyndShipmentId: string; searchStrategy: string };
    };
    expect(payload.create.fyndShipmentId).toBe("SH-1,SH-2,SH-3");
    expect(payload.create.searchStrategy).toBe("external_order_id");
  });

  it("does not attempt order search when type is not 'order'", async () => {
    const searchMock = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });

    const res = await action({
      request: jsonReq({ shop: "store", type: "unknown", orderName: "1001" }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("does not attempt order search when type=order but orderName is missing", async () => {
    const searchMock = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });

    const res = await action({
      request: jsonReq({ shop: "store", type: "order" }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body.fyndData).toBe(null);
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe("action — type=returns branch", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("returns empty enrichments when returnIds array is empty", async () => {
    const searchMock = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });

    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: [] }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body).toEqual({ fyndData: null, returnEnrichments: {} });
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("uses RETURN fulfillmentType when searching for return shipments", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipment_id: "SH-RET", journey_type: "return" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "SH-RET", fyndPayloadJson: null },
    ]);

    await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);

    expect(searchMock).toHaveBeenCalledWith(
      "5001",
      expect.objectContaining({ fulfillmentType: "RETURN" }),
    );
  });

  it("falls back to first item when no journey_type='return' shipment is present", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipment_id: "SH-NOJT" /* no journey_type */ }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "SH-NOJT", fyndPayloadJson: null },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body.returnEnrichments["r-1"]).toBeDefined();
    expect(body.returnEnrichments["r-1"].fyndShipmentId).toBe("SH-NOJT");
  });

  it("skips enrichment for return whose Fynd search throws (non-fatal)", async () => {
    const searchMock = vi.fn().mockRejectedValue(new Error("fynd 502"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "SH-X", fyndPayloadJson: null },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returnEnrichments).toEqual({});
  });

  it("returns no enrichment entry when no items match (empty Fynd response)", async () => {
    const searchMock = vi.fn().mockResolvedValue({ items: [] });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "SH-X", fyndPayloadJson: null },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body.returnEnrichments["r-1"]).toBeUndefined();
  });
});
