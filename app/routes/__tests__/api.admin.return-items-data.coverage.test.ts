/**
 * Extra coverage for GET /api/admin/return-items-data/:id
 *
 * Focuses on:
 *   - Fynd item enrichment (varied article/bag shapes)
 *   - Missing payload fallback (no settings, empty order name, empty results)
 *   - Line item resolution (multiple items, partial fields, returnCase metadata)
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

function mkReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    returnRequestNo: "R-1",
    shopifyOrderName: "#1001",
    shopifyOrderId: "gid://shopify/Order/1",
    fyndOrderId: null,
    fyndShipmentId: null,
    fyndReturnId: null,
    fyndReturnNo: null,
    status: "pending",
    createdByChannel: "portal",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    items: [],
    ...overrides,
  };
}

function mkItem(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

describe("api.admin.return-items-data.$id — extra coverage", () => {
  // ───── Missing payload fallback ─────

  it("returns null liveFyndData when shop has no settings", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [mkItem()] }));

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.liveFyndData).toBeNull();
    expect(body.liveFyndError).toBeNull();
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("does NOT call Fynd search when order name is empty/missing", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ shopifyOrderName: "", items: [] }),
    );
    const searchMock = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(searchMock).not.toHaveBeenCalled();
    expect(body.liveFyndData).toBeNull();
    expect(body.liveFyndError).toBeNull();
  });

  it("treats null shopifyOrderName as empty (no search call)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ shopifyOrderName: null, items: [] }),
    );
    const searchMock = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(searchMock).not.toHaveBeenCalled();
    expect(body.liveFyndData).toBeNull();
  });

  it("strips leading '#' from order name before searching", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ shopifyOrderName: "#1042", items: [] }),
    );
    const searchMock = vi.fn().mockResolvedValue({ items: [] });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);

    expect(searchMock).toHaveBeenCalledWith(
      "1042",
      expect.objectContaining({
        searchType: "external_order_id",
        pageSize: 50,
      }),
    );
  });

  it("returns empty liveFyndData array when search returns no items/shipments key", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({}); // no items / shipments
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(Array.isArray(body.liveFyndData)).toBe(true);
    expect(body.liveFyndData).toEqual([]);
  });

  it("falls back to 'shipments' key when 'items' key is absent", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      shipments: [{ shipment_id: "SH-X", status: "pending", bags: [] }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(body.liveFyndData).toHaveLength(1);
    expect(body.liveFyndData[0].shipment_id).toBe("SH-X");
  });

  it("ignores client without getShipments method (non-platform)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "affiliate" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { someOtherMethod: vi.fn() }, // no getShipments
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(body.liveFyndData).toBeNull();
    expect(body.liveFyndError).toBeNull();
  });

  // ───── Fynd item enrichment ─────

  it("enriches articles using shipment.id and bag.id fallbacks", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        {
          // no shipment_id, fall back to id
          id: "SH-FALLBACK",
          // no status, fall back to shipment_status
          shipment_status: "in_transit",
          bags: [
            {
              // no bag_id, fall back to id
              id: "BAG-FALLBACK",
              quantity: 3,
              // no affiliate_bag_details — should be {}
              articles: [
                {
                  // article fallback to _id
                  _id: "ART-FALLBACK",
                  seller_identifier: "SELL-1",
                  // no .item — falls through to article-level
                  item_id: "ITM-1",
                  name: "Top",
                  size: "M",
                  quantity_available: 7,
                  // price_info on article (no bag.prices)
                  price_info: { price_effective: "11.00", transfer_price: "9.00" },
                },
              ],
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
    const ship = body.liveFyndData[0];

    expect(ship.shipment_id).toBe("SH-FALLBACK");
    expect(ship.status).toBe("in_transit");
    expect(ship.bags[0].bag_id).toBe("BAG-FALLBACK");
    expect(ship.bags[0].affiliate_bag_details.affiliate_line_id).toBeUndefined();
    const art = ship.bags[0].articles[0];
    expect(art.article_id).toBe("ART-FALLBACK");
    expect(art.item_id).toBe("ITM-1");
    expect(art.name).toBe("Top");
    expect(art.size).toBe("M");
    expect(art.price_effective).toBe("11.00");
    expect(art.transfer_price).toBe("9.00");
  });

  it("resolves articles from bag.items array when bag.articles missing", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        {
          shipment_id: "SH-2",
          status: "delivered",
          bags: [
            {
              bag_id: "BAG-2",
              // articles missing → fall back to items
              items: [
                {
                  article_id: "A-2",
                  seller_identifier: "S-2",
                  item: { item_id: "I-2", item_name: "Pants", size: "32" },
                },
              ],
              price_info: { price_effective: "30", transfer_price: "25" },
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
    const art = body.liveFyndData[0].bags[0].articles[0];
    expect(art.article_id).toBe("A-2");
    // item_name fallback to name
    expect(art.name).toBe("Pants");
    // size from itemObj when article-level absent
    expect(art.size).toBe("32");
    expect(art.price_effective).toBe("30");
  });

  it("resolves single-article bag via bag.item fallback", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        {
          shipment_id: "SH-3",
          bags: [
            {
              bag_id: "BAG-3",
              // no articles, no items — single .item
              item: {
                article_id: "A-3",
                seller_identifier: "S-3",
                item: { _id: "I-3", name: "Hat" },
              },
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
    const arts = body.liveFyndData[0].bags[0].articles;
    expect(arts).toHaveLength(1);
    // item_id falls back to itemObj._id
    expect(arts[0].item_id).toBe("I-3");
    expect(arts[0].name).toBe("Hat");
  });

  it("returns empty articles when bag has none of articles/items/item", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        {
          shipment_id: "SH-4",
          bags: [{ bag_id: "BAG-4", quantity: 0 }],
        },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndData[0].bags[0].articles).toEqual([]);
  });

  it("treats non-array bags field as empty list", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipment_id: "SH-5", bags: "not-an-array" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndData[0].bags).toEqual([]);
  });

  it("captures non-Error thrown by Fynd client (string) in liveFyndError", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));
    const searchMock = vi.fn().mockImplementation(() => {
      throw "raw string failure";
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: vi.fn() },
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.liveFyndError).toBe("raw string failure");
    expect(body.liveFyndData).toBeNull();
  });

  // ───── Line item resolution ─────

  it("preserves order and per-item indexing in missingFields paths", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({
        items: [
          mkItem({ id: "it-A", sku: null, fyndItemId: "FI-1" }), // missing sku
          mkItem({ id: "it-B", sku: "SKU-B", fyndShipmentId: "FS-2" }), // missing others
        ],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe("it-A");
    expect(body.items[1].id).toBe("it-B");
    // First item missing sku
    expect(body.missingFields).toContain("items[0].sku");
    expect(body.missingFields).not.toContain("items[1].sku");
    // First item has fyndItemId set
    expect(body.missingFields).not.toContain("items[0].fyndItemId");
    expect(body.missingFields).toContain("items[1].fyndItemId");
    // Second item has fyndShipmentId set
    expect(body.missingFields).toContain("items[0].fyndShipmentId");
    expect(body.missingFields).not.toContain("items[1].fyndShipmentId");
    expect(body.missingFieldCount).toBe(body.missingFields.length);
  });

  it("treats undefined Fynd fields as missing (== null check)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    // Provide an item where some fynd fields are explicitly undefined
    const partial = {
      id: "it-X",
      shopifyLineItemId: "gid://shopify/LineItem/9",
      title: "X",
      variantTitle: null,
      sku: undefined,
      price: "5",
      qty: 1,
      reasonCode: "wrong_size",
      // Most fynd fields not present at all
    };
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [partial] }));

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    // JSON.stringify omits undefined values, so the property is absent
    expect(body.items[0].sku).toBeUndefined();
    expect(body.missingFields).toContain("items[0].sku");
    // 10 fynd fields total, all should be missing
    expect(body.missingFieldCount).toBe(10);
  });

  it("returnCase metadata round-trips fynd-related identifiers", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({
        fyndOrderId: "FO-1",
        fyndShipmentId: "FSHP-1",
        fyndReturnId: "FR-1",
        fyndReturnNo: "RNO-1",
        status: "approved",
        createdByChannel: "fynd",
        items: [],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();

    expect(body.returnCase.fyndOrderId).toBe("FO-1");
    expect(body.returnCase.fyndShipmentId).toBe("FSHP-1");
    expect(body.returnCase.fyndReturnId).toBe("FR-1");
    expect(body.returnCase.fyndReturnNo).toBe("RNO-1");
    expect(body.returnCase.status).toBe("approved");
    expect(body.returnCase.createdByChannel).toBe("fynd");
    expect(body.items).toEqual([]);
    expect(body.missingFieldCount).toBe(0);
    expect(body.missingFields).toEqual([]);
  });

  it("scopes return lookup by both id and shopId", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-XYZ", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ items: [] }));

    await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);

    expect(prismaMock.returnCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "rc-1", shopId: "shop-XYZ" }),
        include: expect.objectContaining({ items: true }),
      }),
    );
  });
});
