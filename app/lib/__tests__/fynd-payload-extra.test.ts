import { describe, it, expect } from "vitest";
import {
  isLikelyFyndId,
  buildTrackingUrlFromCourierAndAwb,
  getTrackingInfoFromFyndPayload,
  parseFyndPayloadForDisplay,
  getPickupAddressFromFyndPayload,
  parseFyndOrderDetailsForTab,
  extractCustomerFromFyndPayload,
  extractShippingDetailsFromFyndPayload,
  extractAffiliateOrderIdFromFyndPayload,
  extractFyndJourney,
} from "../fynd-payload.server";

/* ────────────────────────────────────────────────────────────
   Fynd Payload — supplemental coverage
   ────────────────────────────────────────────────────────────
   These tests target branches not exercised by the original
   suite: edge inputs, fallback chains, normalization quirks
   and dedupe / sort ordering for parseFyndOrderDetailsForTab.
   All tests are pure JSON-in / value-out — no mocks. */

describe("isLikelyFyndId — additional cases", () => {
  it("returns true for boundary 15-digit string", () => {
    expect(isLikelyFyndId("123456789012345")).toBe(true);
  });
  it("returns false for 14-digit numeric string", () => {
    expect(isLikelyFyndId("12345678901234")).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isLikelyFyndId("")).toBe(false);
  });
  it("returns false for digits with embedded space", () => {
    expect(isLikelyFyndId("12345 67890123456")).toBe(false);
  });
  it("returns false for arrays of digits", () => {
    expect(isLikelyFyndId(["123456789012345"])).toBe(false);
  });
});

describe("buildTrackingUrlFromCourierAndAwb — additional cases", () => {
  it("is case-insensitive (uppercase courier)", () => {
    expect(buildTrackingUrlFromCourierAndAwb("DELHIVERY", "DL1")).toBe(
      "https://www.delhivery.com/track/package/DL1",
    );
  });
  it("ignores spaces inside courier name", () => {
    expect(buildTrackingUrlFromCourierAndAwb("D T D C", "DT1")).toBe(
      "https://www.dtdc.in/tracking.asp?ref=DT1",
    );
  });
  it("trims AWB whitespace", () => {
    expect(buildTrackingUrlFromCourierAndAwb("Delhivery", "  DL2  ")).toBe(
      "https://www.delhivery.com/track/package/DL2",
    );
  });
  it("returns null for whitespace-only AWB", () => {
    expect(buildTrackingUrlFromCourierAndAwb("Delhivery", "   ")).toBe(null);
  });
  it("treats nullish courier name defensively (no match)", () => {
    expect(buildTrackingUrlFromCourierAndAwb(null as unknown as string, "X1")).toBe(null);
  });
  it("Dunzo is intentionally aliased to Delhivery URL", () => {
    expect(buildTrackingUrlFromCourierAndAwb("Dunzo Direct", "DZ1")).toBe(
      "https://www.delhivery.com/track/package/DZ1",
    );
  });
  it("ekartlogistics single-token also matches", () => {
    expect(buildTrackingUrlFromCourierAndAwb("ekartlogistics", "EK1")).toBe(
      "https://ekartlogistics.com/track/EK1",
    );
  });
});

describe("getTrackingInfoFromFyndPayload — additional cases", () => {
  it("returns null when payload normalizes to empty array", () => {
    // Plain string root → parses but normalizeFyndPayload returns []
    // because string is not an array nor an object with item-array fields.
    expect(getTrackingInfoFromFyndPayload(JSON.stringify("just-a-string"))).toBe(null);
  });
  it("uses delivery_partner_details over dp_details when both exist", () => {
    const json = JSON.stringify({
      delivery_partner_details: {
        display_name: "Bluedart",
        awb_no: "BD1",
        track_url: "https://bd/1",
      },
      dp_details: { display_name: "Delhivery", awb_no: "DL1" },
    });
    const info = getTrackingInfoFromFyndPayload(json)!;
    expect(info.logisticsPartner).toBe("Bluedart");
    expect(info.awbNo).toBe("BD1");
    expect(info.trackingUrl).toBe("https://bd/1");
  });
  it("returns null fyndStatus when status object has no string fields", () => {
    const json = JSON.stringify({ status: { code: 42 } });
    expect(getTrackingInfoFromFyndPayload(json)?.fyndStatus).toBe(null);
  });
  it("returns null trackingUrl when not a string", () => {
    const json = JSON.stringify({ tracking_url: 12345, dp_name: "Delhivery" });
    expect(getTrackingInfoFromFyndPayload(json)?.trackingUrl).toBe(null);
  });
  it("returns null awbNo when array's first element is a Fynd ID", () => {
    const json = JSON.stringify({ awb_no: ["16834567890123456"], dp_name: "X" });
    expect(getTrackingInfoFromFyndPayload(json)?.awbNo).toBe(null);
  });
  it("returns null when payload's first item is not an object", () => {
    expect(getTrackingInfoFromFyndPayload(JSON.stringify([42]))).toBe(null);
  });
  it("falls back to top-level courierName when dp_details absent", () => {
    const json = JSON.stringify({ courierName: "DTDC", awb: "AB1" });
    expect(getTrackingInfoFromFyndPayload(json)?.logisticsPartner).toBe("DTDC");
  });
});

describe("parseFyndPayloadForDisplay — additional cases", () => {
  it("returns null when JSON.parse throws", () => {
    expect(parseFyndPayloadForDisplay("not json at all {{{")).toBe(null);
  });
  it("returns shipments empty array when payload is empty object", () => {
    const r = parseFyndPayloadForDisplay("{}")!;
    expect(r).not.toBeNull();
    expect(r.shipments).toEqual([]);
    expect(r.rawJson).toBe("{}");
  });
  it("preserves raw JSON string verbatim", () => {
    const json = JSON.stringify({ shipments: [{ shipment_id: "s1" }] });
    expect(parseFyndPayloadForDisplay(json)?.rawJson).toBe(json);
  });
  it("each shipment exposes a non-empty fields list", () => {
    const json = JSON.stringify({ shipments: [{ shipment_id: "S1", awb_no: "AB" }] });
    const r = parseFyndPayloadForDisplay(json)!;
    expect(r.shipments[0].fields.length).toBeGreaterThan(0);
  });
  it("returns null for empty string input", () => {
    expect(parseFyndPayloadForDisplay("")).toBe(null);
  });
});

describe("getPickupAddressFromFyndPayload — additional cases", () => {
  it("returns null for empty string", () => {
    expect(getPickupAddressFromFyndPayload("")).toBe(null);
  });
  it("returns null when first item is not an object", () => {
    expect(getPickupAddressFromFyndPayload(JSON.stringify(["string"]))).toBe(null);
  });
  it("uses pickupAddress (camelCase) variant", () => {
    const json = JSON.stringify({
      pickupAddress: { city: "Bengaluru", pincode: "560001" },
    });
    expect(getPickupAddressFromFyndPayload(json)?.city).toBe("Bengaluru");
  });
  it("uses returnAddress (camelCase) variant", () => {
    const json = JSON.stringify({
      returnAddress: { city: "Pune" },
    });
    expect(getPickupAddressFromFyndPayload(json)?.city).toBe("Pune");
  });
  it("falls back to address when other keys absent", () => {
    const json = JSON.stringify({ address: { city: "Hyderabad" } });
    expect(getPickupAddressFromFyndPayload(json)?.city).toBe("Hyderabad");
  });
  it("composes formatted string from non-empty parts only", () => {
    const json = JSON.stringify({
      pickup_address: { city: "Mumbai", pincode: "400001" },
    });
    const a = getPickupAddressFromFyndPayload(json)!;
    expect(a.formatted).toBe("Mumbai, 400001");
  });
  it("formatted is undefined when address has no recognizable parts", () => {
    const json = JSON.stringify({ pickup_address: { phone: "9999" } });
    const a = getPickupAddressFromFyndPayload(json)!;
    expect(a.formatted).toBeUndefined();
    expect(a.phone).toBe("9999");
  });
  it("uses address.street as fallback for address1", () => {
    const json = JSON.stringify({ pickup_address: { street: "100 ABC Rd" } });
    expect(getPickupAddressFromFyndPayload(json)?.address1).toBe("100 ABC Rd");
  });
  it("uses province as fallback for state", () => {
    const json = JSON.stringify({ pickup_address: { province: "MH" } });
    expect(getPickupAddressFromFyndPayload(json)?.state).toBe("MH");
  });
});

describe("parseFyndOrderDetailsForTab — additional cases", () => {
  it("returns null for invalid JSON", () => {
    expect(parseFyndOrderDetailsForTab("totally bad")).toBe(null);
  });
  it("captures invoice URL from invoice.links.invoice_a4", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          invoice: { links: { invoice_a4: "https://inv/a4.pdf", label: "https://inv/lab.pdf" } },
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments[0].invoiceUrl).toBe("https://inv/a4.pdf");
    expect(r.shipments[0].labelUrl).toBe("https://inv/lab.pdf");
  });
  it("falls back to building tracking URL when courier known + AWB present", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          dp_details: { display_name: "Delhivery", awb_no: "DL2" },
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments[0].trackingUrl).toBe("https://www.delhivery.com/track/package/DL2");
  });
  it("routes AWB to returnAwb when journey_type is 'return'", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          journey_type: "return",
          dp_details: { display_name: "Delhivery", awb_no: "DL3" },
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments[0].forwardAwb).toBe(null);
    expect(r.shipments[0].returnAwb).toBe("DL3");
  });
  it("dedupes identical shipmentId, keeping the most-recent updated_at", () => {
    const p = JSON.stringify({
      shipments: [
        { shipment_id: "DUP", shipment_status: "placed", updated_at: "2026-01-01T10:00:00Z" },
        { shipment_id: "DUP", shipment_status: "delivered", updated_at: "2026-02-01T10:00:00Z" },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments).toHaveLength(1);
    expect(r.shipments[0].shipmentStatus).toBe("delivered");
  });
  it("preserves multiple shipments with distinct IDs", () => {
    const p = JSON.stringify({
      shipments: [
        { shipment_id: "S1", dp_name: "A" },
        { shipment_id: "S2", dp_name: "B" },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments).toHaveLength(2);
    const ids = r.shipments.map((s) => s.shipmentId).sort();
    expect(ids).toEqual(["S1", "S2"]);
  });
  it("parses items from bags.articles when no top-level items", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          bags: [{ articles: [{ name: "Shoes", quantity: 2, price: 1000 }] }],
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments[0].items).toHaveLength(1);
    expect(r.shipments[0].items[0].title).toBe("Shoes");
    expect(r.shipments[0].items[0].quantity).toBe(2);
  });
  it("parses items from packages[].items as last-resort fallback", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          packages: [{ items: [{ name: "Hat" }] }],
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.shipments[0].items).toHaveLength(1);
    expect(r.shipments[0].items[0].title).toBe("Hat");
  });
  it("extracts shipmentStatus from object-shaped status field", () => {
    const p = JSON.stringify({
      shipments: [
        { shipment_id: "S1", shipment_status: { title: "Delivered", status: "delivered" } },
      ],
    });
    expect(parseFyndOrderDetailsForTab(p)!.shipments[0].shipmentStatus).toBe("Delivered");
  });
  it("composes fulfillmentStore as 'name, city' when both present", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          fulfilling_store: { store_name: "Store A", city: "Mumbai" },
        },
      ],
    });
    expect(parseFyndOrderDetailsForTab(p)!.shipments[0].fulfillmentStore).toBe("Store A, Mumbai");
  });
  it("captures pricing fields from orderPrice", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          orderPrice: {
            subtotal: 1000,
            orderTotalAmount: 1100,
            currency: "INR",
            discount: 100,
            deliveryCharges: 50,
          },
        },
      ],
    });
    const pr = parseFyndOrderDetailsForTab(p)!.shipments[0].pricing!;
    expect(pr.subtotal).toBe("1000");
    expect(pr.total).toBe("1100");
    expect(pr.currency).toBe("INR");
    expect(pr.discount).toBe("100");
    expect(pr.deliveryCharges).toBe("50");
  });
  it("captures pricing from breakup array when orderPrice absent", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          breakup: [
            { type: "subtotal", value: 500 },
            { type: "total", value: 600 },
            { type: "discount", value: 50 },
          ],
        },
      ],
    });
    const pr = parseFyndOrderDetailsForTab(p)!.shipments[0].pricing!;
    expect(pr.subtotal).toBe("500");
    expect(pr.total).toBe("600");
    expect(pr.discount).toBe("50");
  });
  it("captures order-level paymentMethod and supportUrl", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          payment_mode: "COD",
          need_help_url: "https://help.example",
        },
      ],
    });
    const r = parseFyndOrderDetailsForTab(p)!;
    expect(r.paymentMethod).toBe("COD");
    expect(r.supportUrl).toBe("https://help.example");
  });
  it("extracts trackingDetails timeline", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          tracking_details: [
            { status: "Picked", time: "2026-01-01T10:00:00Z", message: "Picked up" },
            { status: "Delivered", time: "2026-01-02T10:00:00Z" },
          ],
        },
      ],
    });
    const td = parseFyndOrderDetailsForTab(p)!.shipments[0].trackingDetails!;
    expect(td).toHaveLength(2);
    expect(td[0].status).toBe("Picked");
    expect(td[0].message).toBe("Picked up");
  });
  it("extracts dimensions when length/width/height all present", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          size_info: { length: 10, width: 5, height: 3, unit_of_measurement: "cm" },
        },
      ],
    });
    expect(parseFyndOrderDetailsForTab(p)!.shipments[0].dimensions).toBe("10 × 5 × 3 cm");
  });
  it("emits weightInfo with kg suffix for numeric weight", () => {
    const p = JSON.stringify({
      shipments: [{ shipment_id: "S1", weight: 2.5 }],
    });
    expect(parseFyndOrderDetailsForTab(p)!.shipments[0].weightInfo).toBe("2.5 kg");
  });
  it("returns shipmentId '—' when no id field present", () => {
    const p = JSON.stringify({ shipments: [{ dp_name: "X" }] });
    expect(parseFyndOrderDetailsForTab(p)!.shipments[0].shipmentId).toBe("—");
  });
  it("captures returnPickupAddress from return_address", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          return_address: { name: "WH", address1: "1 Road", city: "Delhi" },
        },
      ],
    });
    const a = parseFyndOrderDetailsForTab(p)!.shipments[0].returnPickupAddress!;
    expect(a.city).toBe("Delhi");
    expect(a.formatted).toContain("WH");
  });
  it("captures deliveryAddress when shipping_address present", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "S1",
          shipping_address: { name: "Cust", address1: "Foo St", city: "Mumbai" },
        },
      ],
    });
    const a = parseFyndOrderDetailsForTab(p)!.shipments[0].deliveryAddress!;
    expect(a.city).toBe("Mumbai");
  });
});

describe("extractFyndJourney — additional cases", () => {
  it("returns [] for empty string", () => {
    expect(extractFyndJourney("", "forward")).toEqual([]);
  });
  it("returns [] for empty payload object", () => {
    expect(extractFyndJourney("{}", "forward")).toEqual([]);
  });
  it("uses status_updates when bag_status missing", () => {
    const p = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              status_updates: [
                {
                  status: "ready",
                  state_mapper: { display_name: "Ready", journey_type: "forward" },
                  updated_at: "2026-03-01T10:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    const steps = extractFyndJourney(p, "forward");
    expect(steps).toHaveLength(1);
    expect(steps[0].displayName).toBe("Ready");
  });
  it("falls back to status when displayName/name absent", () => {
    const p = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                {
                  status: "shipped",
                  bag_state_mapper: { journey_type: "forward" },
                  updated_at: "2026-04-01T10:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(extractFyndJourney(p, "forward")[0].displayName).toBe("shipped");
  });
  it("'—' when both status and displayName missing", () => {
    const p = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                {
                  bag_state_mapper: { journey_type: "forward" },
                  updated_at: "2026-04-01T10:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    const s = extractFyndJourney(p, "forward");
    expect(s).toHaveLength(1);
    expect(s[0].displayName).toBe("—");
  });
  it("each step carries the journey type tag", () => {
    const p = JSON.stringify({
      shipments: [
        {
          bags: [{ bag_status: [{ status: "x", bag_state_mapper: { journey_type: "return" } }] }],
        },
      ],
    });
    expect(extractFyndJourney(p, "return")[0].journeyType).toBe("return");
  });
  it("sort is ascending by parsed time", () => {
    const p = JSON.stringify({
      shipments: [
        {
          bags: [
            {
              bag_status: [
                {
                  status: "third",
                  bag_state_mapper: { journey_type: "forward" },
                  updated_at: "2026-03-01T00:00:00Z",
                },
                {
                  status: "first",
                  bag_state_mapper: { journey_type: "forward" },
                  updated_at: "2026-01-01T00:00:00Z",
                },
                {
                  status: "second",
                  bag_state_mapper: { journey_type: "forward" },
                  updated_at: "2026-02-01T00:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });
    const ordered = extractFyndJourney(p, "forward").map((s) => s.status);
    expect(ordered).toEqual(["first", "second", "third"]);
  });

  it("filters return journey by bag id so one order's old return does not leak into a new return", () => {
    const p = JSON.stringify({
      shipments: [
        {
          shipment_id: "SHIP-1",
          bags: [
            {
              bag_id: "BAG-OLD",
              bag_status: [
                {
                  status: "return_accepted",
                  bag_state_mapper: { display_name: "Return Accepted", journey_type: "return" },
                  updated_at: "2026-05-01T10:00:00Z",
                },
              ],
            },
            {
              bag_id: "BAG-NEW",
              bag_status: [
                {
                  status: "return_initiated",
                  bag_state_mapper: { display_name: "Return Initiated", journey_type: "return" },
                  updated_at: "2026-05-02T10:00:00Z",
                },
              ],
            },
          ],
        },
      ],
    });

    const scoped = extractFyndJourney(p, "return", { bagIds: ["BAG-NEW"] });
    expect(scoped.map((s) => s.status)).toEqual(["return_initiated"]);
  });
});

describe("getTrackingInfoFromFyndPayload — non-string payload", () => {
  it("returns null when payload is not a string", () => {
    expect(getTrackingInfoFromFyndPayload(123 as unknown as string)).toBe(null);
  });
});

describe("parseFyndOrderDetailsForTab — empty string", () => {
  it("returns null for empty string", () => {
    expect(parseFyndOrderDetailsForTab("")).toBe(null);
  });
});

describe("extractCustomerFromFyndPayload — additional cases", () => {
  it("returns null for invalid JSON", () => {
    expect(extractCustomerFromFyndPayload("nope {")).toBe(null);
  });
  it("returns null for empty string", () => {
    expect(extractCustomerFromFyndPayload("")).toBe(null);
  });
  it("returns null when first item isn't an object", () => {
    expect(extractCustomerFromFyndPayload(JSON.stringify([1, 2, 3]))).toBe(null);
  });
  it("uses 'name' field directly when present", () => {
    const p = JSON.stringify({ delivery_address: { name: "Alice", phone: "9" } });
    expect(extractCustomerFromFyndPayload(p)?.name).toBe("Alice");
  });
  it("captures address1, address2, province, landmark", () => {
    const p = JSON.stringify({
      delivery_address: {
        first_name: "Z",
        address1: "Line1",
        address2: "Line2",
        province: "MH",
        landmark: "Near park",
      },
    });
    const c = extractCustomerFromFyndPayload(p)!;
    expect(c.address1).toBe("Line1");
    expect(c.address2).toBe("Line2");
    expect(c.province).toBe("MH");
    expect(c.landmark).toBe("Near park");
  });
  it("falls back from address1 to address, area for address2", () => {
    const p = JSON.stringify({
      delivery_address: {
        first_name: "Z",
        address: "Whole address",
        area: "Some area",
      },
    });
    const c = extractCustomerFromFyndPayload(p)!;
    expect(c.address1).toBe("Whole address");
    expect(c.address2).toBe("Some area");
  });
  it("falls back from pincode to zip to postal_code", () => {
    const p = JSON.stringify({
      delivery_address: { first_name: "Z", postal_code: "12345" },
    });
    expect(extractCustomerFromFyndPayload(p)?.zip).toBe("12345");
  });
  it("uses meta.phone when address phone/mobile absent", () => {
    const p = JSON.stringify({
      delivery_address: { first_name: "Z" },
      meta: { phone: "7777" },
    });
    expect(extractCustomerFromFyndPayload(p)?.phone).toBe("7777");
  });
});

describe("extractShippingDetailsFromFyndPayload — additional cases", () => {
  it("returns null for empty string", () => {
    expect(extractShippingDetailsFromFyndPayload("")).toBe(null);
  });
  it("returns null for invalid JSON", () => {
    expect(extractShippingDetailsFromFyndPayload("{not}")).toBe(null);
  });
  it("falls back to invoice_number when invoice missing", () => {
    const p = JSON.stringify({
      dp_details: { display_name: "Delhivery", awb_no: "X1" },
      invoice_number: "INV-X",
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.invoiceNumber).toBe("INV-X");
  });
  it("uses invoice.links.invoice_a4 when invoice_url missing", () => {
    const p = JSON.stringify({
      invoice: { links: { invoice_a4: "https://i/a4.pdf" } },
      dp_details: { display_name: "X", awb_no: "Y" },
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.invoiceUrl).toBe("https://i/a4.pdf");
  });
  it("uses invoice.links.label when label_url missing", () => {
    const p = JSON.stringify({
      invoice: { links: { label: "https://l.pdf" } },
      dp_details: { display_name: "X", awb_no: "Y" },
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.labelUrl).toBe("https://l.pdf");
  });
  it("returns null when first list item isn't an object", () => {
    expect(extractShippingDetailsFromFyndPayload(JSON.stringify([null]))).toBe(null);
  });
  it("trims tracking URL whitespace", () => {
    const p = JSON.stringify({
      dp_details: { display_name: "X", awb_no: "Y", track_url: "   https://t/abc   " },
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.trackingUrl).toBe("https://t/abc");
  });
});

describe("extractAffiliateOrderIdFromFyndPayload — additional cases", () => {
  it("returns null for empty string input", () => {
    expect(extractAffiliateOrderIdFromFyndPayload("")).toBe(null);
  });
  it("returns null for non-string parameter", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(123 as unknown as string)).toBe(null);
  });
  it("reads channel_order_id from top-level when affiliate_order_id missing", () => {
    expect(
      extractAffiliateOrderIdFromFyndPayload(JSON.stringify({ channel_order_id: "1234" })),
    ).toBe("1234");
  });
  it("returns null when value is non-string number", () => {
    expect(
      extractAffiliateOrderIdFromFyndPayload(JSON.stringify({ affiliate_order_id: 1234 })),
    ).toBe(null);
  });
  it("returns null when first list item isn't an object", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(JSON.stringify(["x"]))).toBe(null);
  });
});
