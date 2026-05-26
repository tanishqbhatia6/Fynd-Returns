/**
 * Bag distribution — pure-module tests.
 *
 * Covers the production scenario the user described: one Shopify order
 * with 3 line items split across 2 Fynd shipments, where line item A is
 * itself split (2 in shipment 1, 1 in shipment 2), and customer asks
 * to return 3 of A. The distributor must allocate 2 from shipment 1 +
 * 1 from shipment 2 — invisibly to the customer.
 */
import { describe, it, expect } from "vitest";
import {
  buildBagIndex,
  distributeBagAllocations,
  shipmentSnapshotsFromFyndPayload,
  type ShipmentSnapshot,
} from "../bag-distribution.server";

const SHOP_FIXTURE: ShipmentSnapshot[] = [
  {
    shipmentId: "FY-SHIP-1",
    eligible: true,
    items: [
      // Line A split across 2 bags in this shipment (qty 2 + 1 = 3 here? no — say bag-A1 has 1, bag-A2 has 1 → total 2 of A in shipment 1)
      {
        id: "gid://shopify/LineItem/A",
        bagId: "BAG-A1",
        sku: "SKU-A",
        quantity: 1,
        fyndArticleId: "ART-A",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 1,
        fyndQuantityAvailable: 1,
      },
      {
        id: "gid://shopify/LineItem/A",
        bagId: "BAG-A2",
        sku: "SKU-A",
        quantity: 1,
        fyndArticleId: "ART-A",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 1,
        fyndQuantityAvailable: 1,
      },
      // Line B has 1 bag of qty 1 in shipment 1
      {
        id: "gid://shopify/LineItem/B",
        bagId: "BAG-B1",
        sku: "SKU-B",
        quantity: 1,
        fyndArticleId: "ART-B",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 2,
        fyndQuantityAvailable: 1,
      },
    ],
  },
  {
    shipmentId: "FY-SHIP-2",
    eligible: true,
    items: [
      // The third unit of line A lives in shipment 2
      {
        id: "gid://shopify/LineItem/A",
        bagId: "BAG-A3",
        sku: "SKU-A",
        quantity: 1,
        fyndArticleId: "ART-A",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 1,
        fyndQuantityAvailable: 1,
      },
      // Line B has another bag in shipment 2
      {
        id: "gid://shopify/LineItem/B",
        bagId: "BAG-B2",
        sku: "SKU-B",
        quantity: 1,
        fyndArticleId: "ART-B",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 2,
        fyndQuantityAvailable: 1,
      },
      // Line C has 2 in shipment 2 (one bag with qty 2)
      {
        id: "gid://shopify/LineItem/C",
        bagId: "BAG-C1",
        sku: "SKU-C",
        quantity: 2,
        fyndArticleId: "ART-C",
        fyndAffiliateLineId: null,
        fyndSellerIdentifier: null,
        fyndItemId: null,
        fyndPriceEffective: null,
        fyndSize: null,
        fyndLineNumber: 3,
        fyndQuantityAvailable: 2,
      },
    ],
  },
];

describe("distributeBagAllocations — production multi-shipment-multi-line scenario", () => {
  it("builds a shipment snapshot from Fynd's existing placed webhook payload shape", () => {
    const snapshots = shipmentSnapshotsFromFyndPayload({
      event: { name: "shipment", type: "create" },
      payload: {
        shipment: {
          status: "delivery_done",
          shipment_id: "17797917699901820308",
          bags: [
            {
              bag_id: 3881011,
              line_number: 1,
              quantity: 1,
              article: {
                _id: "69e0be738dd8d8e41fdb57cf",
                seller_identifier: "RETURN3",
                size: "M",
              },
              affiliate_bag_details: {
                affiliate_bag_id: "3881011",
                affiliate_meta: {
                  affiliate_line_id: 17555511443606,
                  affiliate_sku: "RETURN3",
                },
              },
              prices: { price_effective: 100 },
            },
            {
              bag_id: 3881012,
              line_number: 2,
              quantity: 1,
              article: {
                _id: "69e0be738dd8d8e41fdb57cf",
                seller_identifier: "RETURN3",
                size: "M",
              },
              affiliate_bag_details: {
                affiliate_bag_id: "3881012",
                affiliate_meta: {
                  affiliate_line_id: 17555511443606,
                  affiliate_sku: "RETURN3",
                },
              },
              prices: { price_effective: 100 },
            },
          ],
        },
      },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      shipmentId: "17797917699901820308",
      eligible: true,
    });
    expect(snapshots[0].items).toEqual([
      expect.objectContaining({
        id: "gid://shopify/LineItem/17555511443606",
        bagId: "3881011",
        sku: "RETURN3",
        quantity: 1,
        fyndSellerIdentifier: "RETURN3",
        fyndLineNumber: 1,
      }),
      expect.objectContaining({
        id: "gid://shopify/LineItem/17555511443606",
        bagId: "3881012",
        sku: "RETURN3",
        quantity: 1,
        fyndSellerIdentifier: "RETURN3",
        fyndLineNumber: 2,
      }),
    ]);
  });

  it("marks placed webhook snapshots ineligible unless the merchant explicitly allows placed", () => {
    const raw = {
      payload: {
        shipment: {
          status: "placed",
          shipment_id: "SHIP-PLACED",
          bags: [
            {
              bag_id: "BAG-1",
              line_number: 1,
              article: { seller_identifier: "RETURN3" },
              affiliate_bag_details: {
                affiliate_meta: { affiliate_line_id: "17555511443606" },
              },
            },
          ],
        },
      },
    };

    expect(shipmentSnapshotsFromFyndPayload(raw)[0].eligible).toBe(false);
    expect(shipmentSnapshotsFromFyndPayload(raw, { allowedStatuses: ["placed"] })[0].eligible).toBe(
      true,
    );
  });

  it("splits a 3-unit return for line A across shipment 1 (2 bags) + shipment 2 (1 bag)", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 3 }],
      bagIndex,
    );
    expect(items).toHaveLength(3);
    // Each output entry is qty=1 (each bag has cap 1)
    expect(items.every((i) => i.qty === 1)).toBe(true);
    // First two bags from shipment 1, third from shipment 2
    expect(items[0].fyndShipmentId).toBe("FY-SHIP-1");
    expect(items[0].fyndBagId).toBe("BAG-A1");
    expect(items[1].fyndShipmentId).toBe("FY-SHIP-1");
    expect(items[1].fyndBagId).toBe("BAG-A2");
    expect(items[2].fyndShipmentId).toBe("FY-SHIP-2");
    expect(items[2].fyndBagId).toBe("BAG-A3");
    // Every output unit is fully satisfied
    expect(unsatisfied.size).toBe(0);
  });

  it("collapses to ONE bag entry when the line is fully in a single multi-qty bag", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/C", qty: 2 }],
      bagIndex,
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
    expect(items[0].fyndBagId).toBe("BAG-C1");
    expect(unsatisfied.size).toBe(0);
  });

  it("returns 1 of line A from the first available bag (greedy)", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 1 }],
      bagIndex,
    );
    expect(items).toHaveLength(1);
    expect(items[0].fyndBagId).toBe("BAG-A1");
    expect(items[0].fyndShipmentId).toBe("FY-SHIP-1");
  });

  it("handles two simultaneous returns (A:1, B:1) without re-using the same bag", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items } = distributeBagAllocations(
      [
        { lineItemId: "gid://shopify/LineItem/A", qty: 1 },
        { lineItemId: "gid://shopify/LineItem/B", qty: 1 },
      ],
      bagIndex,
    );
    expect(items.map((i) => i.fyndBagId)).toEqual(["BAG-A1", "BAG-B1"]);
  });

  it("skips bags from ineligible shipments (e.g. Fynd shipment not yet delivered)", () => {
    const fixture: ShipmentSnapshot[] = [
      {
        shipmentId: "FY-SHIP-PENDING",
        eligible: false, // ← undeliverable; bags here must be excluded
        items: [
          {
            id: "gid://shopify/LineItem/A",
            bagId: "BAG-A1",
            sku: "SKU-A",
            quantity: 1,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndPriceEffective: null,
            fyndSize: null,
            fyndLineNumber: 1,
            fyndQuantityAvailable: 1,
          },
        ],
      },
      {
        shipmentId: "FY-SHIP-OK",
        eligible: true,
        items: [
          {
            id: "gid://shopify/LineItem/A",
            bagId: "BAG-A2",
            sku: "SKU-A",
            quantity: 1,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndPriceEffective: null,
            fyndSize: null,
            fyndLineNumber: 1,
            fyndQuantityAvailable: 1,
          },
        ],
      },
    ];
    const bagIndex = buildBagIndex(fixture);
    const { items } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 1 }],
      bagIndex,
    );
    expect(items).toHaveLength(1);
    // Skipped the pending shipment, used the eligible one
    expect(items[0].fyndShipmentId).toBe("FY-SHIP-OK");
    expect(items[0].fyndBagId).toBe("BAG-A2");
  });

  it("subtracts already-returned qty from a bag via the reserved map", () => {
    // Line C has 1 bag of qty 2; 1 already returned. Customer asks for 2 — only 1 left.
    const bagIndex = buildBagIndex(SHOP_FIXTURE, { "FY-SHIP-2::BAG-C1": 1 });
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/C", qty: 2 }],
      bagIndex,
    );
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(1);
    expect(unsatisfied.get("gid://shopify/LineItem/C")).toBe(1); // 1 unit unsatisfiable
  });

  it("populates Fynd metadata on each output item", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items } = distributeBagAllocations(
      [
        {
          lineItemId: "gid://shopify/LineItem/A",
          qty: 1,
          reasonCode: "DEFECTIVE",
          notes: "size too big",
        },
      ],
      bagIndex,
    );
    expect(items[0].fyndArticleId).toBe("ART-A");
    expect(items[0].fyndLineNumber).toBe(1);
    expect(items[0].fyndQuantityAvailable).toBe(1);
    expect(items[0].reasonCode).toBe("DEFECTIVE");
    expect(items[0].notes).toBe("size too big");
  });

  it("returns empty + full unsatisfied map when no bags exist for the requested line", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/UNKNOWN", qty: 2 }],
      bagIndex,
    );
    expect(items).toEqual([]);
    expect(unsatisfied.get("gid://shopify/LineItem/UNKNOWN")).toBe(2);
  });

  it("ignores qty=0 inputs without producing items or unsatisfied entries", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 0 }],
      bagIndex,
    );
    expect(items).toEqual([]);
    expect(unsatisfied.size).toBe(0);
  });

  it("treats negative / NaN qty as zero", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    const { items, unsatisfied } = distributeBagAllocations(
      [
        { lineItemId: "gid://shopify/LineItem/A", qty: -1 },
        { lineItemId: "gid://shopify/LineItem/A", qty: NaN },
      ],
      bagIndex,
    );
    expect(items).toEqual([]);
    expect(unsatisfied.size).toBe(0);
  });

  it("supports bagId-only (no shipment prefix) in the reserved map", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE, { "BAG-C1": 2 });
    const { items, unsatisfied } = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/C", qty: 2 }],
      bagIndex,
    );
    expect(items).toEqual([]);
    expect(unsatisfied.get("gid://shopify/LineItem/C")).toBe(2);
  });

  it("decrements bagIndex in place across consecutive calls (anti-double-claim)", () => {
    const bagIndex = buildBagIndex(SHOP_FIXTURE);
    // Claim line A qty=2 — uses BAG-A1 + BAG-A2
    const r1 = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 2 }],
      bagIndex,
    );
    expect(r1.items).toHaveLength(2);
    expect(r1.unsatisfied.size).toBe(0);
    // Now ask for 2 more — only 1 unit left (BAG-A3); 1 must be unsatisfied
    const r2 = distributeBagAllocations(
      [{ lineItemId: "gid://shopify/LineItem/A", qty: 2 }],
      bagIndex,
    );
    expect(r2.items).toHaveLength(1);
    expect(r2.items[0].fyndBagId).toBe("BAG-A3");
    expect(r2.unsatisfied.get("gid://shopify/LineItem/A")).toBe(1);
  });
});
