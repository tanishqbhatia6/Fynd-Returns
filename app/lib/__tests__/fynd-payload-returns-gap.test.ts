import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gap-coverage suite for fynd-payload.server.ts and fynd-returns.server.ts.
 * Targets specific uncovered lines without modifying source:
 *
 *  fynd-payload.server.ts
 *    - 522-523: toNumStr() string return / undefined fallback inside
 *      shipment-level pricing extraction (parseFyndOrderDetailsForTab)
 *    - 559-560: bag.articles where articles is a plain object (not array)
 *    - 568-569: pkg.items where items is a plain object (not array)
 *
 *  fynd-returns.server.ts
 *    - 304-305: "Could not determine Fynd shipment ID" error path when
 *      the matched shipment object has no usable identifier and search
 *      returned no shipmentId
 *    - 399:    inner retry catch — throw updateErr after 404 retry fails
 *    - 401-402: outer else throw — non-404 update error in
 *      executeReturnUpdate (search-path) bubbles through to the outer
 *      catch and is returned as failure
 */

/* ── Mocks for fynd-returns dependencies (must be top-level) ─────── */

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s?: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 0,
}));

vi.mock("../observability/metrics.server", () => ({
  fyndApiDuration: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));

import {
  parseFyndOrderDetailsForTab,
  getFyndShipmentDisplayFields,
  getPickupAddressFromFyndPayload,
  extractCustomerFromFyndPayload,
  extractShippingDetailsFromFyndPayload,
} from "../fynd-payload.server";
import { createReturnOnFynd } from "../fynd-returns.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

/* ── Helpers for fynd-returns tests ──────────────────────────────── */

type ClientOverrides = {
  searchImpl?: ReturnType<typeof vi.fn>;
  getShipmentsImpl?: ReturnType<typeof vi.fn>;
  updateImpl?: ReturnType<typeof vi.fn>;
};

function makeClient(o: ClientOverrides = {}) {
  const search =
    o.searchImpl ??
    vi.fn().mockResolvedValue({
      items: [{ id: "FY1", order_id: "FYMP1234567890", shipment_id: "FY1" }],
      orderId: "FYMP1234567890",
      shipmentId: "FY1",
    });
  const getShipments =
    o.getShipmentsImpl ??
    vi.fn().mockResolvedValue({
      shipments: [{ id: "FY1", identifier: "FY1", order_id: "FYMP1234567890" }],
    });
  const update = o.updateImpl ?? vi.fn().mockResolvedValue({ return_id: "RID1" });
  const client: Record<string, unknown> = {
    searchShipmentsByExternalOrderId: search,
    getShipments,
    updateShipmentStatus: update,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  };
  return client as unknown as FyndPlatformClient & {
    searchShipmentsByExternalOrderId: ReturnType<typeof vi.fn>;
    getShipments: ReturnType<typeof vi.fn>;
    updateShipmentStatus: ReturnType<typeof vi.fn>;
  };
}

function makeCase(
  overrides: Partial<ReturnCase & { items: ReturnItem[]; fyndOrderId?: string | null }> = {},
): ReturnCase & { items: ReturnItem[] } {
  return {
    id: "rc-gap",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/999",
    shopifyOrderName: "#9999",
    customerEmail: "gap@example.com",
    fyndReturnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: "ri-gap-1",
        returnCaseId: "rc-gap",
        sku: "GAP-SKU",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 1,
        reasonCode: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ReturnItem,
    ],
    ...overrides,
  } as unknown as ReturnCase & { items: ReturnItem[] };
}

/* ── parseFyndOrderDetailsForTab — pricing toNumStr branches (522-523) ─ */

describe("parseFyndOrderDetailsForTab — pricing toNumStr string/undefined branches", () => {
  it("propagates string subtotal/total/discount values through toNumStr", () => {
    // toNumStr returns the raw string when value is a string (line 522)
    const json = JSON.stringify({
      shipment_id: "S-STR-PRICING",
      orderPrice: {
        subtotal: "1500.50",
        orderTotalAmount: "1499.99",
        discount: "100",
        deliveryCharges: "50",
        codAmount: "0",
        promotion: "25",
        coupon: "10",
        currency: "INR",
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab).not.toBeNull();
    const ship = tab!.shipments[0];
    expect(ship.pricing).toBeDefined();
    expect(ship.pricing!.subtotal).toBe("1500.50");
    expect(ship.pricing!.total).toBe("1499.99");
    expect(ship.pricing!.discount).toBe("100");
    expect(ship.pricing!.deliveryCharges).toBe("50");
    expect(ship.pricing!.codAmount).toBe("0");
    expect(ship.pricing!.promotions).toBe("25");
    expect(ship.pricing!.coupon).toBe("10");
    expect(ship.pricing!.currency).toBe("INR");
  });

  it("treats non-numeric/non-string pricing values as undefined (toNumStr fallback line 523)", () => {
    // Boolean / object discount values should fall through toNumStr → undefined.
    // We still need at least one truthy field so pricing object is created.
    const json = JSON.stringify({
      shipment_id: "S-WEIRD",
      orderPrice: {
        subtotal: 100, // numeric path triggers pricing creation
        discount: true, // boolean → toNumStr returns undefined
        deliveryCharges: { nested: "no" }, // object → toNumStr returns undefined
        codAmount: null,
        promotion: false,
        coupon: [1, 2, 3], // array → toNumStr returns undefined
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    const p = tab!.shipments[0].pricing!;
    expect(p.subtotal).toBe("100");
    expect(p.discount).toBeUndefined();
    expect(p.deliveryCharges).toBeUndefined();
    expect(p.codAmount).toBeUndefined();
    expect(p.promotions).toBeUndefined();
    expect(p.coupon).toBeUndefined();
  });

  it("uses toNumStr string path for shipping/transfer/marked prices on items", () => {
    // Wrap in shipments[] so `items` at shipment level is treated as the
    // order line items (not as the normalize array).
    const json = JSON.stringify({
      shipments: [
        {
          shipment_id: "S-ITEM-STR",
          orderItems: [
            {
              item_id: "I1",
              orderItemPrice: {
                totalMarkedPrice: "999",
                transferPrice: "850",
                shippingCharges: "40",
                totalItemPrice: "899",
                discount: "100",
              },
              quantity: 1,
              name: "Sample",
            },
          ],
        },
      ],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    const item = tab!.shipments[0].items[0];
    expect(item.markedPrice).toBe("999");
    expect(item.transferPrice).toBe("850");
    expect(item.shippingCharges).toBe("40");
  });
});

/* ── parseFyndOrderDetailsForTab — bag.articles object (line 559-560) ── */

describe("parseFyndOrderDetailsForTab — bag.articles single object branch", () => {
  it("captures bag.articles when it is a plain object (not array)", () => {
    const json = JSON.stringify({
      shipment_id: "S-BAG-OBJ",
      bags: [
        {
          // articles is a single object — must be wrapped into orderItems
          articles: { item_id: "BAG-ART-1", name: "Bag Article", quantity: 1 },
        },
      ],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab).not.toBeNull();
    const items = tab!.shipments[0].items;
    expect(items.length).toBe(1);
    expect(items[0].itemId).toBe("BAG-ART-1");
    expect(items[0].title).toBe("Bag Article");
  });

  it("ignores bag.articles when it is null/undefined", () => {
    const json = JSON.stringify({
      shipment_id: "S-BAG-NULL",
      bags: [{ articles: null, items: null, item: null }],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab!.shipments[0].items.length).toBe(0);
  });
});

/* ── parseFyndOrderDetailsForTab — package.items object (line 568-569) ── */

describe("parseFyndOrderDetailsForTab — package.items single object branch", () => {
  it("captures pkg.items when it is a plain object (not array)", () => {
    const json = JSON.stringify({
      shipment_id: "S-PKG-OBJ",
      packages: [{ items: { item_id: "PKG-1", name: "Package Article", quantity: 2 } }],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab).not.toBeNull();
    const items = tab!.shipments[0].items;
    expect(items.length).toBe(1);
    expect(items[0].itemId).toBe("PKG-1");
    expect(items[0].quantity).toBe(2);
  });

  it("yields no items when packages contain only null primitives", () => {
    const json = JSON.stringify({
      shipment_id: "S-PKG-NULL",
      packages: [{ items: null }, { articles: null }, { item: null }],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab!.shipments[0].items.length).toBe(0);
  });
});

/* ── createReturnOnFynd — "Could not determine shipment ID" (304-305) ── */

describe("createReturnOnFynd — could not determine shipment ID", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns failure when shipment object lacks any ID field and search has no shipmentId", async () => {
    // Shipment object has no shipment_id/id/identifier/_id fields.
    // searchRes.shipmentId is also undefined, so fallback at line 300-301
    // doesn't fire → line 304-305 hit.
    const client = makeClient({
      searchImpl: vi.fn().mockResolvedValue({
        items: [{ name: "no-id-shipment" }],
        orderId: "FYMPVALID1234567",
        // Note: no shipmentId field
      }),
      getShipmentsImpl: vi.fn().mockResolvedValue({
        shipments: [{ name: "still-no-id" }], // No identifier fields at all
      }),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Could not determine Fynd shipment ID/i);
  });
});

/* ── createReturnOnFynd — retry inner-throw (line 399) ──────────────── */

describe("createReturnOnFynd — 404 retry inner throw", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws original error when retry on 404 also fails", async () => {
    // First update call fails with 404 → enters retry branch.
    // Retry call also fails → inner catch at line 398-400 throws original updateErr.
    // Outer catch at 320-325 returns failure with original message.
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error("404 Not Found - first call"))
      .mockRejectedValueOnce(new Error("retry also failed"));
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    // Original error is rethrown, so message should match the first error
    expect(res.error).toMatch(/404 Not Found - first call/);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("does not retry when shipmentId equals fyndOrderId on 404", async () => {
    // When shipmentId === fyndOrderId, the retry branch is skipped
    // (line 393 condition false) and we hit the else throw at line 401-402.
    // We force this by making the search return same orderId == shipmentId.
    const sameId = "FYMPSAMEIDXYZ123";
    const client = makeClient({
      searchImpl: vi.fn().mockResolvedValue({
        items: [{ id: sameId, order_id: sameId, shipment_id: sameId }],
        orderId: sameId,
        shipmentId: sameId,
      }),
      getShipmentsImpl: vi.fn().mockResolvedValue({
        shipments: [{ id: sameId, identifier: sameId, shipment_id: sameId }],
      }),
      updateImpl: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/404/);
  });
});

/* ── createReturnOnFynd — non-404 update error in search path (401) ── */

describe("createReturnOnFynd — non-404 update errors bypass retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("propagates 422 errors without retrying", async () => {
    const update = vi.fn().mockRejectedValue(new Error("422 Unprocessable Entity"));
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/422/);
    // Ensures no retry was attempted (single update call)
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("propagates non-Error throw values stringified", async () => {
    const update = vi.fn().mockRejectedValue("plain string error");
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toBe("plain string error");
    expect(update).toHaveBeenCalledTimes(1);
  });
});

/* ── createReturnOnFynd — fast path failure metric branch (line 159) ── */

describe("createReturnOnFynd — fast path failure outcome metric", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hits the failure-metric branch when fast-path update returns success=false", async () => {
    // Update returns a non-200 nested status that is NOT 'Invalid State Transition'
    // → executeReturnUpdate returns {success:false}, and the fast path code
    // path at line 158-160 records the failure metric.
    const update = vi.fn().mockResolvedValue({
      statuses: [
        {
          shipments: [{ status: 422, message: "Some other error", identifier: "FYS-FAST" }],
        },
      ],
    });
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc, { targetShipmentId: "FYS-FAST" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Some other error/);
    // Fast path used — no search/getShipments
    expect(client.searchShipmentsByExternalOrderId).not.toHaveBeenCalled();
  });
});

/* ── createReturnOnFynd — alt search retry branch (lines 224-227) ──── */

describe("createReturnOnFynd — alternate search retry with fyndOrderId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries search with fyndOrderId when first search returns no items", async () => {
    // First search call returns empty items but resolves an orderId,
    // so the code retries with the resolved orderId.
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        orderId: "FYMP-RESOLVED-1234",
      })
      .mockResolvedValueOnce({
        items: [{ shipment_id: "FYS-ALT", id: "FYS-ALT" }],
        orderId: "FYMP-ALT-9999",
      });
    const client = makeClient({
      searchImpl: search,
      getShipmentsImpl: vi.fn().mockResolvedValue({
        shipments: [{ id: "FYS-ALT", identifier: "FYS-ALT" }],
      }),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
    expect(res.fyndOrderId).toBe("FYMP-ALT-9999");
  });
});

/* ── createReturnOnFynd — getShipments 404 + targetShipId fallback (264-265) ── */

describe("createReturnOnFynd — getShipments 404 + targetShipId stub fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("constructs minimal shipment when getShipments 404s and search has no items but targetShipId is known", async () => {
    // Items have fyndShipmentId so they survive the filter; targetShipId
    // doesn't trigger the fast path (we use a non-numeric ID so it doesn't
    // trigger looksLikeShipmentId on stored fields, and we don't pass it
    // through targetShipmentId option directly — we set it via a stored
    // numeric fyndOrderId, then control how search behaves).
    const search = vi.fn().mockResolvedValue({
      items: [],
      orderId: "FYMP-NEEDS-LOOKUP-1",
    });
    const getShipments = vi.fn().mockRejectedValue(new Error("404 Not Found"));
    const update = vi.fn().mockResolvedValue({ return_id: "FALLBACK-OK" });
    const client = makeClient({
      searchImpl: search,
      getShipmentsImpl: getShipments,
      updateImpl: update,
    });
    // Stored fyndOrderId is a 15+ digit numeric → looksLikeShipmentId true →
    // targetShipId is set → fast path triggers FIRST. We force fast path to
    // throw a non-state-transition error so we fall through to search/getShipments.
    update
      .mockReset()
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({ return_id: "FALLBACK-OK" });

    const rc = makeCase({
      fyndOrderId: "111122223333444",
    } as Partial<ReturnCase>);
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndShipmentId).toBe("111122223333444");
    expect(getShipments).toHaveBeenCalled();
  });
});

/* ── getFyndShipmentDisplayFields — collectFields/valueToString branches ── */

describe("getFyndShipmentDisplayFields — collectFields branches", () => {
  it("returns empty array for non-object input", () => {
    expect(getFyndShipmentDisplayFields(null)).toEqual([]);
    expect(getFyndShipmentDisplayFields(undefined)).toEqual([]);
    expect(getFyndShipmentDisplayFields(42)).toEqual([]);
  });

  it("stringifies arrays via valueToString and treats bags array specially", () => {
    const fields = getFyndShipmentDisplayFields({
      tags: ["a", "b", 1],
      bags: [{ x: 1 }, { y: 2 }],
    });
    const map = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    expect(map.tags).toBe("a, b, 1");
    expect(map.bags).toBe("2 bag(s)");
  });

  it("skips ignored keys (tracking_details, size_info, currency_info)", () => {
    const fields = getFyndShipmentDisplayFields({
      tracking_details: [{ status: "ok" }],
      size_info: { width: 1 },
      currency_info: { code: "INR" },
      kept: "yes",
    });
    expect(fields.find((f) => f.key === "tracking_details")).toBeUndefined();
    expect(fields.find((f) => f.key === "size_info")).toBeUndefined();
    expect(fields.find((f) => f.key === "currency_info")).toBeUndefined();
    expect(fields.find((f) => f.key === "kept")?.value).toBe("yes");
  });

  it("expands meta.cp_name / meta.awb_no / meta.invoice_id", () => {
    const fields = getFyndShipmentDisplayFields({
      meta: {
        cp_name: "Bluedart",
        awb_no: "AWB-12345",
        invoice_id: "INV-001",
      },
    });
    const cp = fields.find((f) => f.key === "cp_name");
    const awb = fields.find((f) => f.key === "awb");
    const inv = fields.find((f) => f.key === "invoice_id");
    expect(cp?.value).toBe("Bluedart");
    expect(awb?.value).toBe("AWB-12345");
    expect(inv?.value).toBe("INV-001");
  });

  it("flattens small nested object via collectFields recursion (line 122)", () => {
    const fields = getFyndShipmentDisplayFields({
      payment_info: { method: "COD", paid: true },
    });
    expect(fields.find((f) => f.key === "payment_info.method")?.value).toBe("COD");
    expect(fields.find((f) => f.key === "payment_info.paid")?.value).toBe("true");
  });

  it("stringifies large nested objects (>8 keys) instead of recursing (line 124)", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) big[`k${i}`] = i;
    const fields = getFyndShipmentDisplayFields({ deep: big });
    const f = fields.find((f) => f.key === "deep");
    expect(f).toBeDefined();
    expect(f!.value.startsWith("{")).toBe(true);
  });

  it("uses nested.title/name/value when collecting nested object (line 120)", () => {
    const fields = getFyndShipmentDisplayFields({
      status: { title: "Delivered", code: "DLV" },
    });
    expect(fields.find((f) => f.key === "status")?.value).toBe("Delivered");
  });
});

/* ── getPickupAddressFromFyndPayload — null addr branch (line 304) ──── */

describe("getPickupAddressFromFyndPayload — invalid addr fallback", () => {
  it("returns null when no return/pickup/address field is present", () => {
    const json = JSON.stringify({ shipment_id: "S-NO-ADDR" });
    expect(getPickupAddressFromFyndPayload(json)).toBeNull();
  });
});

/* ── extractCustomerFromFyndPayload — no addr/no useful fields (line 777) ── */

describe("extractCustomerFromFyndPayload — empty fallback", () => {
  it("returns null when neither delivery/billing addr nor meta yields anything", () => {
    // No addr, no email/phone in meta, no name → returns null at "if (!fullName && !email && !phone)"
    const json = JSON.stringify({ shipment_id: "S-NOTHING", meta: {} });
    expect(extractCustomerFromFyndPayload(json)).toBeNull();
  });
});

/* ── extractShippingDetailsFromFyndPayload — all-null fallback (line 852) ── */

describe("extractShippingDetailsFromFyndPayload — empty payload returns null", () => {
  it("returns null when no carrier / awb / url / invoice / label exist", () => {
    const json = JSON.stringify({ shipment_id: "S-EMPTY" });
    expect(extractShippingDetailsFromFyndPayload(json)).toBeNull();
  });

  it("extracts carrier from object via toFullDisplayString (lines 170-176)", () => {
    const json = JSON.stringify({
      dp_details: {
        // toFullDisplayString prefers display_name → triggers object branch
        display_name: "Bluedart Express",
      },
      awb_no: "BD-12345",
    });
    const out = extractShippingDetailsFromFyndPayload(json);
    expect(out).not.toBeNull();
    expect(out!.carrier).toBe("Bluedart Express");
    expect(out!.trackingNumber).toBe("BD-12345");
  });

  it("returns null carrier when toFullDisplayString receives non-string object", () => {
    // dp_details is an object with no display name fields
    const json = JSON.stringify({
      dp_details: { random_field: 42 },
      awb_no: "AWB-RAND",
    });
    const out = extractShippingDetailsFromFyndPayload(json);
    // No carrier resolvable → null
    expect(out!.carrier).toBeNull();
    expect(out!.trackingNumber).toBe("AWB-RAND");
  });
});

/* ── parseFyndOrderDetailsForTab — extractAddressFields all-null (423) ── */

describe("parseFyndOrderDetailsForTab — empty address fields", () => {
  it("returns null deliveryAddress when address object has no usable fields", () => {
    const json = JSON.stringify({
      shipment_id: "S-EMPTY-ADDR",
      delivery_address: { unrelated: "field" },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab!.shipments[0].deliveryAddress).toBeNull();
  });
});

/* ── parseFyndOrderDetailsForTab — bag tracking_url fallback (461-462) ── */

describe("parseFyndOrderDetailsForTab — tracking URL from bag fallback", () => {
  it("picks up tracking_url from bag when shipment-level URL absent", () => {
    const json = JSON.stringify({
      shipment_id: "S-BAG-TRACK",
      bags: [{ tracking_url: "https://example.com/track/BAG1" }],
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab!.shipments[0].trackingUrl).toBe("https://example.com/track/BAG1");
  });
});
