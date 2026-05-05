/**
 * Extra coverage tests for /api/admin/backfill-fynd-items.
 * Focus areas:
 *   - dryRun preserves the database (no writes)
 *   - populated/happy-path: items get matched + updated
 *   - Fynd shipment fetch error propagation (catch branch)
 *   - per-case skip branches (manual order, missing orderName, no shipments)
 *   - "already complete" no-op + matching strategies
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

function mkShipment(overrides: Record<string, unknown> = {}) {
  return {
    shipment_id: "SHIP-1",
    bags: [
      {
        bag_id: "BAG-1",
        affiliate_bag_details: { affiliate_line_id: "LINE-1" },
        prices: { transfer_price: "100", price_effective: "120" },
        articles: [
          {
            seller_identifier: "SKU-1",
            article_id: "ART-1",
            item_id: "ITM-1",
            quantity_available: 5,
            size: "M",
            item: {
              item_id: "ITM-1",
              name: "Widget",
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function mkReturnItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "ri-1",
    title: "Widget",
    sku: null,
    price: null,
    shopifyLineItemId: null,
    fyndShipmentId: null,
    fyndBagId: null,
    fyndArticleId: null,
    fyndAffiliateLineId: null,
    fyndSellerIdentifier: null,
    fyndItemId: null,
    fyndQuantityAvailable: null,
    fyndPriceEffective: null,
    fyndSize: null,
    ...overrides,
  };
}

function mkReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    returnRequestNo: "RR-1",
    shopifyOrderId: "gid://shopify/Order/100",
    shopifyOrderName: "#1001",
    fyndShipmentId: null,
    items: [mkReturnItem()],
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

describe("POST /api/admin/backfill-fynd-items — extra coverage", () => {
  it("dryRun: matches items but does NOT call returnItem.update or returnCase.update", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ items: [mkShipment()] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq({ dryRun: true }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.dryRun).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.updated).toBe(1);
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    // Status reflects what would happen
    expect(body.results[0].status).toBe("updated");
    expect(body.results[0].itemsUpdated).toBe(1);
    // caseUpdated stays false in dryRun (only flipped in non-dry path)
    expect(body.results[0].caseUpdated).toBe(false);
    expect(body.results[0].details.some((d: string) => d.includes("would update"))).toBe(true);
    expect(body.results[0].details.some((d: string) => d.includes("would set"))).toBe(true);
  });

  it("populated path: writes returnItem.update + returnCase.update with NULL-only fields", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ items: [mkShipment()] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.processed).toBe(1);
    expect(body.updated).toBe(1);
    expect(body.errors).toBe(0);
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    const updateCall = prismaMock.returnItem.update.mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: "ri-1" });
    expect(updateCall.data).toMatchObject({
      fyndShipmentId: "SHIP-1",
      fyndBagId: "BAG-1",
      sku: "SKU-1",
      fyndSellerIdentifier: "SKU-1",
      fyndArticleId: "ART-1",
      fyndAffiliateLineId: "LINE-1",
      fyndItemId: "ITM-1",
      fyndQuantityAvailable: 5,
      // priceEffective prefers price_effective over transfer_price
      fyndPriceEffective: "120",
      fyndSize: "M",
    });
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "rc-1" },
      data: { fyndShipmentId: "SHIP-1" },
    }));
    expect(body.results[0].caseUpdated).toBe(true);
  });

  it("Fynd shipment fetch error: caught and surfaced as result with status=error (does not reject)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => { throw new Error("Fynd 502 bad gateway"); });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.errors).toBe(1);
    expect(body.updated).toBe(0);
    expect(body.results[0]).toMatchObject({
      returnCaseId: "rc-1",
      status: "error",
      itemsUpdated: 0,
      caseUpdated: false,
      error: "Fynd 502 bad gateway",
    });
    // No DB writes when Fynd call throws
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("non-Error thrown from Fynd is stringified into result.error", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => { throw "raw string failure"; });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.errors).toBe(1);
    expect(body.results[0].error).toBe("raw string failure");
  });

  it("skips manual: orders without calling Fynd", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ shopifyOrderId: "manual:abc" }),
    ]);

    const res = await action({ request: mkReq({ returnCaseId: "rc-1" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.results[0].status).toBe("skipped");
    expect(body.results[0].details[0]).toContain("manual order");
    expect(search).not.toHaveBeenCalled();
  });

  it("skips when shopifyOrderName is missing", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ shopifyOrderName: null }),
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.results[0].details[0]).toContain("no shopifyOrderName");
    expect(search).not.toHaveBeenCalled();
  });

  it("skips when Fynd returns zero shipments for the order", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ items: [] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.results[0].status).toBe("skipped");
    expect(body.results[0].details[0]).toContain("no Fynd shipments");
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
  });

  it("already-complete item: matches but produces zero updates and no DB write", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ items: [mkShipment()] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    // Item is fully populated — match-by-bagId hits, but every NULL-guard fails.
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        fyndShipmentId: "SHIP-1",
        items: [
          mkReturnItem({
            sku: "SKU-1",
            fyndShipmentId: "SHIP-1",
            fyndBagId: "BAG-1",
            fyndArticleId: "ART-1",
            fyndAffiliateLineId: "LINE-1",
            fyndSellerIdentifier: "SKU-1",
            fyndItemId: "ITM-1",
            fyndQuantityAvailable: 5,
            fyndPriceEffective: "100",
            fyndSize: "M",
          }),
        ],
      }),
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.skipped).toBe(1);
    expect(body.updated).toBe(0);
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(body.results[0].details.some((d: string) => d.includes("already complete"))).toBe(true);
  });

  it("uses `shipments` payload key when `items` is absent", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ shipments: [mkShipment()] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([mkReturnCase()]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
  });

  it("matches by shopifyLineItemId → affiliate_line_id when sku is unset", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    // Bag has no seller_identifier → SKU match fails; must fall through to LINE-1.
    const shipment = mkShipment({
      bags: [{
        bag_id: "BAG-1",
        affiliate_bag_details: { affiliate_line_id: "LINE-1" },
        prices: { transfer_price: "100" },
        articles: [{
          // no seller_identifier
          article_id: "ART-1",
          item_id: "ITM-1",
          item: { item_id: "ITM-1", name: "Widget" },
        }],
      }],
    });
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        items: [mkReturnItem({
          sku: null,
          shopifyLineItemId: "gid://shopify/LineItem/LINE-1",
        })],
      }),
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.returnItem.update.mock.calls[0][0].data.fyndAffiliateLineId).toBe("LINE-1");
  });

  it("no match for an item: produces 'no Fynd bag match found' detail and no write", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    // Shipment is unrelated — different bag/sku/title and no affiliate_line_id.
    const shipment = {
      shipment_id: "SHIP-X",
      bags: [{
        bag_id: "BAG-X",
        affiliate_bag_details: {},
        prices: {},
        articles: [{
          seller_identifier: "OTHER-SKU",
          article_id: "OTHER-ART",
          item: { name: "Unrelated Product" },
        }],
      }],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        items: [mkReturnItem({ title: "Widget", sku: "SKU-DOES-NOT-EXIST" })],
      }),
    ]);

    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
    expect(prismaMock.returnItem.update).not.toHaveBeenCalled();
    expect(body.results[0].details.some((d: string) => d.includes("no Fynd bag match"))).toBe(true);
  });

  it("strips leading '#' from shopifyOrderName before querying Fynd", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", shopDomain: "x", settings: { fyndApiType: "platform" } });
    const search = vi.fn(async () => ({ items: [] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ shopifyOrderName: "#1234" }),
    ]);

    await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(search).toHaveBeenCalledWith("1234", expect.objectContaining({
      searchType: "external_order_id",
      pageSize: 50,
    }));
  });
});
