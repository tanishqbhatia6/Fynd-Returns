import { describe, it, expect } from "vitest";
import {
  isLikelyFyndId,
  buildTrackingUrlFromCourierAndAwb,
  normalizeFyndPayload,
  getTrackingInfoFromFyndPayload,
  getFyndShipmentDisplayFields,
  parseFyndPayloadForDisplay,
  getPickupAddressFromFyndPayload,
  parseFyndOrderDetailsForTab,
  extractCustomerFromFyndPayload,
  extractShippingDetailsFromFyndPayload,
  extractAffiliateOrderIdFromFyndPayload,
  extractFyndJourney,
} from "../fynd-payload.server";

/* ────────────────────────────────────────────────────────────
   Fynd Payload — pure-logic unit tests
   ────────────────────────────────────────────────────────────
   Fynd payloads come in many shapes (single obj, { items }, { shipments },
   { order: { shipments } }, array at root). These tests lock down the
   normalisation + extraction functions so regressions surface immediately.
   All functions are pure — no mocks required. */

describe("isLikelyFyndId", () => {
  it("returns true for 15+ digit numeric strings", () => {
    expect(isLikelyFyndId("123456789012345")).toBe(true);
    expect(isLikelyFyndId("16834567890123456")).toBe(true);
  });
  it("returns false for shorter numeric strings (real AWBs)", () => {
    expect(isLikelyFyndId("AWB12345")).toBe(false);
    expect(isLikelyFyndId("1234567890")).toBe(false);
  });
  it("trims whitespace before testing", () => {
    expect(isLikelyFyndId("  123456789012345  ")).toBe(true);
  });
  it("returns false for non-string inputs", () => {
    expect(isLikelyFyndId(null)).toBe(false);
    expect(isLikelyFyndId(undefined)).toBe(false);
    expect(isLikelyFyndId(12345678901234567)).toBe(false);
    expect(isLikelyFyndId({ id: "123" })).toBe(false);
  });
  it("returns false for alphanumeric AWBs", () => {
    expect(isLikelyFyndId("ABC123456789012")).toBe(false);
  });
});

describe("buildTrackingUrlFromCourierAndAwb", () => {
  // The matcher checks substrings in a fixed order: xpress → delhivery →
  // bluedart → dtdc → ekart → shadowfax → ecom → shiprocket → pickrr → dunzo.
  // Test each carrier with a canonical form that only matches itself.
  const cases: Array<[string, string, string | null]> = [
    ["Xpressbees", "XB12345", "https://www.xpressbees.com/track/XB12345"],
    ["Delhivery", "DL111", "https://www.delhivery.com/track/package/DL111"],
    ["Bluedart", "BD333", "https://www.bluedart.com/tracking.html?track=BD333"],
    ["Blue Dart", "BD444", "https://www.bluedart.com/tracking.html?track=BD444"],
    ["DTDC", "DT555", "https://www.dtdc.in/tracking.asp?ref=DT555"],
    ["Ekart Logistics", "EK666", "https://ekartlogistics.com/track/EK666"],
    ["Shadowfax", "SF777", "https://track.shadowfax.in/track/SF777"],
    ["Ecom", "EC888", "https://ecomexpress.in/tracking/?awb=EC888"],
    ["Shiprocket", "SR999", "https://track.shiprocket.in/tracking/SR999"],
    ["Pickrr", "PK000", "https://track.pickrr.com/?tracking_id=PK000"],
    ["Dunzo", "DZ111", "https://www.delhivery.com/track/package/DZ111"],
  ];

  it.each(cases)("builds tracking URL for %s + %s", (courier, awb, expected) => {
    expect(buildTrackingUrlFromCourierAndAwb(courier, awb)).toBe(expected);
  });

  // Regression: the broad "xpress" substring test can swallow any carrier
  // whose name happens to contain "Express" (BlueDart Express, Ecom Express).
  // Locked in here as the current behaviour — if the matcher ever gets
  // narrowed to "xpressb" these assertions will fail, which is the signal
  // to update the test + review downstream tracking-URL correctness.
  it('"Express"-containing names currently route to Xpressbees', () => {
    expect(buildTrackingUrlFromCourierAndAwb("BlueDart Express", "BD1"))
      .toBe("https://www.xpressbees.com/track/BD1");
    expect(buildTrackingUrlFromCourierAndAwb("Ecom Express", "EC1"))
      .toBe("https://www.xpressbees.com/track/EC1");
  });

  it("returns null for unknown couriers", () => {
    expect(buildTrackingUrlFromCourierAndAwb("UnknownCo", "AB123")).toBe(null);
  });
  it("returns null for empty AWB", () => {
    expect(buildTrackingUrlFromCourierAndAwb("Delhivery", "")).toBe(null);
  });
  it("handles null/undefined defensively", () => {
    // Empty carrier name with valid AWB returns null — no carrier matched.
    expect(buildTrackingUrlFromCourierAndAwb("", "AB123")).toBe(null);
    expect(buildTrackingUrlFromCourierAndAwb("Delhivery", null as unknown as string)).toBe(null);
  });
});

describe("normalizeFyndPayload", () => {
  it("returns empty array for null/undefined", () => {
    expect(normalizeFyndPayload(null)).toEqual([]);
    expect(normalizeFyndPayload(undefined)).toEqual([]);
  });
  it("returns the array as-is if already an array", () => {
    const a = [{ id: 1 }, { id: 2 }];
    expect(normalizeFyndPayload(a)).toEqual(a);
  });
  it("unwraps { items } shape", () => {
    expect(normalizeFyndPayload({ items: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it("unwraps { shipments } shape", () => {
    expect(normalizeFyndPayload({ shipments: [{ id: "s1" }] })).toEqual([{ id: "s1" }]);
  });
  it("unwraps { results } shape", () => {
    expect(normalizeFyndPayload({ results: [{ r: 1 }] })).toEqual([{ r: 1 }]);
  });
  it("unwraps { data: { items } } shape", () => {
    expect(normalizeFyndPayload({ data: { items: [{ x: 1 }] } })).toEqual([{ x: 1 }]);
  });
  it("unwraps { order: { shipments } }", () => {
    expect(normalizeFyndPayload({ order: { shipments: [{ s: 1 }] } })).toEqual([{ s: 1 }]);
  });
  it("unwraps { order: { bags } } when shipments missing", () => {
    expect(normalizeFyndPayload({ order: { bags: [{ b: 1 }] } })).toEqual([{ b: 1 }]);
  });
  it("falls back to [payload] for plain objects", () => {
    const obj = { shipment_id: "abc" };
    expect(normalizeFyndPayload(obj)).toEqual([obj]);
  });
  it("returns [] for empty object", () => {
    expect(normalizeFyndPayload({})).toEqual([]);
  });
});

describe("getTrackingInfoFromFyndPayload", () => {
  it("returns null for missing input", () => {
    expect(getTrackingInfoFromFyndPayload(null)).toBe(null);
    expect(getTrackingInfoFromFyndPayload(undefined)).toBe(null);
    expect(getTrackingInfoFromFyndPayload("")).toBe(null);
  });
  it("returns null for invalid JSON", () => {
    expect(getTrackingInfoFromFyndPayload("{not json")).toBe(null);
  });
  it("extracts top-level tracking_url + dp_name", () => {
    const json = JSON.stringify({
      tracking_url: "https://track.example/abc",
      dp_name: "Delhivery",
      shipment_status: "in_transit",
      awb_no: "AWB1234",
    });
    const info = getTrackingInfoFromFyndPayload(json);
    expect(info).toEqual({
      trackingUrl: "https://track.example/abc",
      logisticsPartner: "Delhivery",
      fyndStatus: "in_transit",
      awbNo: "AWB1234",
    });
  });
  it("prefers dp_details over top-level fields", () => {
    const json = JSON.stringify({
      dp_details: { display_name: "Bluedart", awb_no: "BD99", track_url: "https://bd/99" },
      shipment_status: "picked_up",
    });
    const info = getTrackingInfoFromFyndPayload(json)!;
    expect(info.logisticsPartner).toBe("Bluedart");
    expect(info.awbNo).toBe("BD99");
    expect(info.trackingUrl).toBe("https://bd/99");
  });
  it("filters out Fynd shipment IDs from awb", () => {
    const json = JSON.stringify({
      awb_no: "16834567890123456",
      dp_name: "Delhivery",
    });
    const info = getTrackingInfoFromFyndPayload(json);
    expect(info?.awbNo).toBe(null);
  });
  it("extracts status from object-shaped status field", () => {
    const json = JSON.stringify({
      status: { title: "Delivered", status: "delivered" },
    });
    expect(getTrackingInfoFromFyndPayload(json)?.fyndStatus).toBe("Delivered");
  });
  it("returns first awb when awb field is array", () => {
    const json = JSON.stringify({ awb: ["AB1", "AB2"], dp_name: "X" });
    expect(getTrackingInfoFromFyndPayload(json)?.awbNo).toBe("AB1");
  });
});

describe("getFyndShipmentDisplayFields", () => {
  it("returns empty array for null", () => {
    expect(getFyndShipmentDisplayFields(null)).toEqual([]);
  });
  it("returns empty array for non-object", () => {
    expect(getFyndShipmentDisplayFields("string")).toEqual([]);
  });
  it("maps known keys to human labels", () => {
    const fields = getFyndShipmentDisplayFields({
      shipment_id: "16834567890123456",
      awb_no: "AB1234",
      dp_name: "Delhivery",
    });
    const byLabel = Object.fromEntries(fields.map(f => [f.label, f.value]));
    expect(byLabel["Fynd Shipment ID"]).toBe("16834567890123456");
    expect(byLabel["Forward AWB / Tracking number"]).toBe("AB1234");
    expect(byLabel["Logistics Partner"]).toBe("Delhivery");
  });
  it("renders bags array as count", () => {
    const fields = getFyndShipmentDisplayFields({ bags: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    const bagField = fields.find(f => f.key === "bags");
    expect(bagField?.value).toBe("3 bag(s)");
  });
  it("flattens meta with awb/cp_name/invoice", () => {
    const fields = getFyndShipmentDisplayFields({
      meta: { cp_name: "Bluedart", awb_no: "BD1", invoice_id: "INV-1" },
    });
    const labels = fields.map(f => f.label);
    expect(labels).toContain("Logistics Partner");
    expect(labels).toContain("Forward AWB");
    expect(labels).toContain("Invoice ID");
  });
  it("dedupes repeated nested keys via seen-set", () => {
    const fields = getFyndShipmentDisplayFields({
      nested: { courier_name: "DTDC" },
    });
    const courierFields = fields.filter(f => f.label === "Logistics Partner");
    expect(courierFields.length).toBe(1);
  });
});

describe("parseFyndPayloadForDisplay", () => {
  it("returns null for invalid JSON / missing input", () => {
    expect(parseFyndPayloadForDisplay(null)).toBe(null);
    expect(parseFyndPayloadForDisplay("{nope")).toBe(null);
  });
  it("returns structured shipments with 1-indexed index", () => {
    const json = JSON.stringify({
      shipments: [{ shipment_id: "A" }, { shipment_id: "B" }],
    });
    const res = parseFyndPayloadForDisplay(json)!;
    expect(res.shipments).toHaveLength(2);
    expect(res.shipments[0].index).toBe(1);
    expect(res.shipments[1].index).toBe(2);
    expect(res.rawJson).toBe(json);
  });
});

describe("getPickupAddressFromFyndPayload", () => {
  it("returns null for missing/invalid input", () => {
    expect(getPickupAddressFromFyndPayload(null)).toBe(null);
    expect(getPickupAddressFromFyndPayload("bad")).toBe(null);
  });
  it("extracts pickup_address", () => {
    const json = JSON.stringify({
      pickup_address: {
        name: "Warehouse 1",
        address1: "12 Main St",
        city: "Mumbai",
        state: "MH",
        pincode: "400001",
        country: "India",
        phone: "9999",
      },
    });
    const addr = getPickupAddressFromFyndPayload(json)!;
    expect(addr.name).toBe("Warehouse 1");
    expect(addr.city).toBe("Mumbai");
    expect(addr.pincode).toBe("400001");
    expect(addr.formatted).toContain("Mumbai");
  });
  it("falls back to return_address", () => {
    const json = JSON.stringify({ return_address: { city: "Delhi", pincode: "110001" } });
    expect(getPickupAddressFromFyndPayload(json)?.city).toBe("Delhi");
  });
  it("falls back to bag return_config.return_address", () => {
    const json = JSON.stringify({
      bags: [{ return_config: { return_address: { city: "Chennai" } } }],
    });
    expect(getPickupAddressFromFyndPayload(json)?.city).toBe("Chennai");
  });
  it("returns null when no address present", () => {
    expect(getPickupAddressFromFyndPayload("{}")).toBe(null);
  });
});

describe("parseFyndOrderDetailsForTab", () => {
  it("returns null for missing input", () => {
    expect(parseFyndOrderDetailsForTab(null)).toBe(null);
  });
  it("extracts fyndOrderId from various keys", () => {
    const p = JSON.stringify({ order_id: "ORD-1" });
    expect(parseFyndOrderDetailsForTab(p)?.fyndOrderId).toBe("ORD-1");
  });
  it("returns empty shipments array for empty payload", () => {
    expect(parseFyndOrderDetailsForTab("{}")?.shipments).toEqual([]);
  });
  it("extracts shipment_id + AWB + cp_name from a shipment", () => {
    const p = JSON.stringify({
      shipments: [{
        shipment_id: "SHIP1",
        dp_details: { display_name: "Delhivery", awb_no: "AB1234" },
      }],
    });
    const res = parseFyndOrderDetailsForTab(p)!;
    expect(res.shipments).toHaveLength(1);
    expect(res.shipments[0].shipmentId).toBe("SHIP1");
    expect(res.shipments[0].forwardAwb).toBe("AB1234");
    expect(res.shipments[0].cpName).toBe("Delhivery");
  });
});

describe("extractCustomerFromFyndPayload", () => {
  it("returns null for missing", () => {
    expect(extractCustomerFromFyndPayload(null)).toBe(null);
  });
  it("pulls name/email/phone from delivery_address", () => {
    const p = JSON.stringify({
      delivery_address: {
        first_name: "Alice", last_name: "Singh",
        email: "a@x.com", phone: "9999",
        city: "Mumbai", country: "India", pincode: "400001",
      },
    });
    const c = extractCustomerFromFyndPayload(p)!;
    expect(c.name).toBe("Alice Singh");
    expect(c.email).toBe("a@x.com");
    expect(c.phone).toBe("9999");
    expect(c.city).toBe("Mumbai");
    expect(c.zip).toBe("400001");
  });
  it("falls back to meta.email / meta.mobile", () => {
    const p = JSON.stringify({
      delivery_address: { first_name: "Bob" },
      meta: { email: "b@x.com", mobile: "8888" },
    });
    const c = extractCustomerFromFyndPayload(p)!;
    expect(c.email).toBe("b@x.com");
    expect(c.phone).toBe("8888");
  });
  it("returns null when no name/email/phone available", () => {
    expect(extractCustomerFromFyndPayload(JSON.stringify({ delivery_address: {} }))).toBe(null);
  });
  it("uses billing_address when delivery missing", () => {
    const p = JSON.stringify({
      billing_address: { name: "Carol", email: "c@x.com" },
    });
    expect(extractCustomerFromFyndPayload(p)?.name).toBe("Carol");
  });
});

describe("extractShippingDetailsFromFyndPayload", () => {
  it("returns null for missing", () => {
    expect(extractShippingDetailsFromFyndPayload(null)).toBe(null);
  });
  it("extracts carrier + AWB + tracking URL + invoice from dp_details/invoice", () => {
    const p = JSON.stringify({
      dp_details: { display_name: "Delhivery", awb_no: "DL1", track_url: "https://track/dl1" },
      invoice: {
        invoice_url: "https://inv.example/1.pdf",
        label_url: "https://label.example/1.pdf",
        store_invoice_id: "INV-1",
      },
    });
    const s = extractShippingDetailsFromFyndPayload(p)!;
    expect(s.carrier).toBe("Delhivery");
    expect(s.trackingNumber).toBe("DL1");
    expect(s.trackingUrl).toBe("https://track/dl1");
    expect(s.invoiceUrl).toBe("https://inv.example/1.pdf");
    expect(s.labelUrl).toBe("https://label.example/1.pdf");
    expect(s.invoiceNumber).toBe("INV-1");
  });
  it("falls back to building tracking URL when not provided", () => {
    const p = JSON.stringify({
      dp_details: { display_name: "Xpressbees", awb_no: "XB1" },
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.trackingUrl)
      .toBe("https://www.xpressbees.com/track/XB1");
  });
  it("filters out Fynd IDs from tracking number", () => {
    const p = JSON.stringify({
      dp_details: { display_name: "Delhivery", awb_no: "16834567890123456" },
    });
    expect(extractShippingDetailsFromFyndPayload(p)?.trackingNumber).toBe(null);
  });
  it("returns null when all fields absent", () => {
    expect(extractShippingDetailsFromFyndPayload("{}")).toBe(null);
  });
});

describe("extractAffiliateOrderIdFromFyndPayload", () => {
  it("returns null for missing/invalid", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(null)).toBe(null);
    expect(extractAffiliateOrderIdFromFyndPayload("bad")).toBe(null);
  });
  it("reads top-level affiliate_order_id", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(
      JSON.stringify({ affiliate_order_id: "1001" }),
    )).toBe("1001");
  });
  it("reads nested order.external_order_id", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(
      JSON.stringify({ order: { external_order_id: "#1001" } }),
    )).toBe("#1001");
  });
  it("reads meta.channel_order_id as fallback", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(
      JSON.stringify({ meta: { channel_order_id: "1001" } }),
    )).toBe("1001");
  });
  it("trims whitespace", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(
      JSON.stringify({ affiliate_order_id: "  1001  " }),
    )).toBe("1001");
  });
  it("returns null for empty string value", () => {
    expect(extractAffiliateOrderIdFromFyndPayload(
      JSON.stringify({ affiliate_order_id: "  " }),
    )).toBe(null);
  });
});

describe("extractFyndJourney", () => {
  it("returns empty array for missing input", () => {
    expect(extractFyndJourney(null, "forward")).toEqual([]);
    expect(extractFyndJourney("bad", "return")).toEqual([]);
  });
  it("extracts forward-journey steps sorted by updated_at", () => {
    const p = JSON.stringify({
      shipments: [{
        bags: [{
          bag_status: [
            { status: "placed", bag_state_mapper: { display_name: "Placed", journey_type: "forward" }, updated_at: "2026-01-01T10:00:00Z" },
            { status: "in_transit", bag_state_mapper: { display_name: "In Transit", journey_type: "forward" }, updated_at: "2026-01-02T10:00:00Z" },
            { status: "return_initiated", bag_state_mapper: { display_name: "Return Initiated", journey_type: "return" }, updated_at: "2026-01-03T10:00:00Z" },
          ],
        }],
      }],
    });
    const forward = extractFyndJourney(p, "forward");
    expect(forward).toHaveLength(2);
    expect(forward[0].status).toBe("placed");
    expect(forward[1].status).toBe("in_transit");
    const ret = extractFyndJourney(p, "return");
    expect(ret).toHaveLength(1);
    expect(ret[0].status).toBe("return_initiated");
  });
  it("includes steps where journey_type is absent", () => {
    const p = JSON.stringify({
      shipments: [{ bags: [{ bag_status: [{ status: "created", bag_state_mapper: {} }] }] }],
    });
    expect(extractFyndJourney(p, "forward")).toHaveLength(1);
  });
  it("dedupes identical status+time pairs", () => {
    const p = JSON.stringify({
      shipments: [{
        bags: [{
          bag_status: [
            { status: "placed", bag_state_mapper: { journey_type: "forward" }, updated_at: "2026-01-01T10:00:00Z" },
            { status: "placed", bag_state_mapper: { journey_type: "forward" }, updated_at: "2026-01-01T10:00:00Z" },
          ],
        }],
      }],
    });
    expect(extractFyndJourney(p, "forward")).toHaveLength(1);
  });
  it("traverses order.bags path too", () => {
    const p = JSON.stringify({
      order: {
        bags: [{
          bag_status: [{ status: "created", bag_state_mapper: { journey_type: "forward" }, updated_at: "2026-01-01T10:00:00Z" }],
        }],
      },
    });
    expect(extractFyndJourney(p, "forward")).toHaveLength(1);
  });
});
