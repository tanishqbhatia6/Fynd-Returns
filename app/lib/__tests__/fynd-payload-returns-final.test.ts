import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Final coverage push for fynd-payload.server.ts and fynd-returns.server.ts.
 *
 *  fynd-payload.server.ts targets:
 *    - 80, 94: valueToString null → "—" + skip empty branch in collectFields
 *    - 84: valueToString recursion into nested object via array
 *    - 155-163: toDisplayString — number, boolean, and nested-object resolution
 *      (string match / number → String(n) / no-key → null) reached via
 *      parseFyndOrderDetailsForTab + extractAddressFields
 *    - 170-176: toFullDisplayString — number, boolean, full-object branches
 *      reached via extractShippingDetailsFromFyndPayload (carrier extraction)
 *
 *  fynd-returns.server.ts targets:
 *    - 301: searchRes.shipmentId fallback when chosen shipment object has no
 *      identifier fields (search-path match by targetShipId via "identifier"
 *      stripped to empty)
 */

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
  getFyndShipmentDisplayFields,
  parseFyndOrderDetailsForTab,
  extractShippingDetailsFromFyndPayload,
} from "../fynd-payload.server";
import { createReturnOnFynd } from "../fynd-returns.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

/* ── fynd-payload.server.ts ───────────────────────────────────────── */

describe("collectFields/valueToString — null + nested-object branches", () => {
  it("skips top-level null values (line 80 valueToString + line 94 skip)", () => {
    // null value → valueToString returns "—" → push() skips at line 94.
    const fields = getFyndShipmentDisplayFields({
      legitimate_field: "kept",
      null_field: null,
    });
    expect(fields.find((f) => f.key === "null_field")).toBeUndefined();
    expect(fields.find((f) => f.key === "legitimate_field")?.value).toBe("kept");
  });

  it("recurses into objects nested in arrays via valueToString (line 84)", () => {
    // Array values are joined via Array.map(valueToString).
    // When an array element is itself an object, valueToString hits the
    // typeof === "object" branch and JSON.stringifies it.
    const fields = getFyndShipmentDisplayFields({
      // Use a key the LABEL_MAP doesn't translate so we keep array shape;
      // also avoid keys treated specially (bags/meta/tracking_details).
      custom_array_of_objects: [{ nested: 1 }, "plain"],
    });
    const f = fields.find((x) => x.key === "custom_array_of_objects");
    expect(f).toBeDefined();
    // Joined via ", " — first element JSON stringified, second kept as string.
    expect(f!.value).toContain('{"nested":1}');
    expect(f!.value).toContain("plain");
  });
});

describe("toDisplayString — number/boolean/object branches via parseFyndOrderDetailsForTab", () => {
  it("converts numeric address fields to strings (line 155)", () => {
    // delivery_address.pincode/city as numbers → toDisplayString line 155.
    const json = JSON.stringify({
      shipment_id: "S-NUM-ADDR",
      delivery_address: {
        name: "Buyer",
        address1: "1 Main St",
        city: 560001, // number → line 155
        pincode: 560002, // number → line 155
        phone: 9999999999, // number → line 155
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab).not.toBeNull();
    const da = tab!.shipments[0].deliveryAddress;
    expect(da).not.toBeNull();
    expect(da!.city).toBe("560001");
    expect(da!.pincode).toBe("560002");
    expect(da!.phone).toBe("9999999999");
  });

  it("resolves nested object city (.name match — line 158-159)", () => {
    // city is an object — toDisplayString picks .name branch.
    const json = JSON.stringify({
      shipment_id: "S-OBJ-CITY",
      delivery_address: {
        address1: "Plot 5",
        city: { name: "Bengaluru", code: "BLR" },
        state: { display_name: "Karnataka" },
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    const da = tab!.shipments[0].deliveryAddress;
    expect(da!.city).toBe("Bengaluru");
    expect(da!.state).toBe("Karnataka");
  });

  it("converts numeric inner-object value to string (line 160)", () => {
    // city object's .name is a number — line 159 fails (not string),
    // line 160 converts number to String. We use status field as a number-only object.
    const json = JSON.stringify({
      shipment_id: "S-NUM-OBJ",
      delivery_address: {
        address1: "Lane 9",
        // city.id is the only matching field, and it's a number — line 160.
        city: { id: 4242 },
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    expect(tab!.shipments[0].deliveryAddress!.city).toBe("4242");
  });

  it("returns null when nested object has no usable keys (line 161)", () => {
    // city object has no .name/.title/.display_name/.status/.value/.code/.id —
    // toDisplayString returns null at line 161.
    const json = JSON.stringify({
      shipment_id: "S-NULL-OBJ",
      delivery_address: {
        address1: "Ring Rd",
        city: { random: "field" },
      },
    });
    const tab = parseFyndOrderDetailsForTab(json);
    // address1 still produces a deliveryAddress, but city resolves to null.
    expect(tab!.shipments[0].deliveryAddress!.city).toBeNull();
  });
});

describe("toFullDisplayString — number/boolean/object via extractShippingDetailsFromFyndPayload", () => {
  it("converts numeric carrier code to string (line 170)", () => {
    // Top-level dp_name as number → toFullDisplayString hits line 170 (number → String).
    const json = JSON.stringify({
      shipment_id: "S-CARRIER-NUM",
      // No dp_details so toFullDisplayString receives the number directly.
      dp_name: 12345,
      awb_no: "AWB-CARRIER-NUM",
    });
    const out = extractShippingDetailsFromFyndPayload(json);
    expect(out).not.toBeNull();
    expect(out!.carrier).toBe("12345");
  });

  it("converts boolean carrier value (line 170)", () => {
    // Edge defensive case: carrier passed as boolean → "true".
    const json = JSON.stringify({
      shipment_id: "S-CARRIER-BOOL",
      dp_name: true,
      awb_no: "AWB-CARRIER-BOOL",
    });
    const out = extractShippingDetailsFromFyndPayload(json);
    expect(out!.carrier).toBe("true");
  });

  it("returns null carrier when object has no usable name fields (line 174)", () => {
    // dp_details object with only unrelated fields → toFullDisplayString
    // line 173 lookup yields undefined → line 174 returns null.
    const json = JSON.stringify({
      shipment_id: "S-CARRIER-NULL-OBJ",
      dp_details: { random: 1, foo: "bar" },
      awb_no: "AWB-NULL-OBJ",
    });
    const out = extractShippingDetailsFromFyndPayload(json);
    // No usable carrier name from object, but trackingNumber present so
    // function doesn't return null overall.
    expect(out).not.toBeNull();
    expect(out!.carrier).toBeNull();
    expect(out!.trackingNumber).toBe("AWB-NULL-OBJ");
  });

  it("resolves carrier object via parseFyndOrderDetailsForTab logistics_partner branch (line 173 alternates)", () => {
    // logistics_partner is an OBJECT — parseFyndOrderDetailsForTab passes it
    // straight into toFullDisplayString → exercises the object branch
    // (line 171-174) including full_name / long_name alternates.
    const j1 = JSON.stringify({
      shipment_id: "S-FULLNAME",
      logistics_partner: { full_name: "Bluedart Logistics", code: "BD" },
      awb_no: "A1",
    });
    expect(parseFyndOrderDetailsForTab(j1)!.shipments[0].cpName).toBe("Bluedart Logistics");

    const j2 = JSON.stringify({
      shipment_id: "S-LONGNAME",
      logistics_partner: { long_name: "Delhivery Express Couriers" },
      awb_no: "A2",
    });
    expect(parseFyndOrderDetailsForTab(j2)!.shipments[0].cpName).toBe("Delhivery Express Couriers");
  });
});

/* ── fynd-returns.server.ts ───────────────────────────────────────── */

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
    id: "rc-final",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/1234",
    shopifyOrderName: "#1234",
    customerEmail: "final@example.com",
    fyndReturnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: "ri-final-1",
        returnCaseId: "rc-final",
        sku: "SKU-FINAL",
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

describe("createReturnOnFynd — searchRes.shipmentId fallback (line 301)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to searchRes.shipmentId when picked shipment has empty identifier", async () => {
    // search returns a shipmentId fallback value AND items.
    // getShipments returns shipments where every id field is missing/empty so
    // line 298-299 toStr() yields "" (which becomes null via "" || null).
    // We match the targetShipmentId option to one of those empty-id objects so
    // shipment is picked but still resolves to no ID — line 300 truthy check
    // passes (searchRes.shipmentId) and line 301 sets shipmentId from it.
    const search = vi.fn().mockResolvedValue({
      items: [{ identifier: "" }],
      orderId: "FYMP-VALID-12345678",
      shipmentId: "FALLBACK-FROM-SEARCH",
    });
    const getShipments = vi.fn().mockResolvedValue({
      shipments: [{ identifier: "" }], // toStr → "" → falsy → null
    });
    const update = vi.fn().mockResolvedValue({ return_id: "RID-FALLBACK" });
    const client = makeClient({
      searchImpl: search,
      getShipmentsImpl: getShipments,
      updateImpl: update,
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndShipmentId).toBe("FALLBACK-FROM-SEARCH");
    // updateShipmentStatus was called with the fallback shipment ID in the payload.
    expect(update).toHaveBeenCalledTimes(1);
    const callPayload = update.mock.calls[0][1] as {
      statuses: Array<{ shipments: Array<{ identifier: string }> }>;
    };
    expect(callPayload.statuses[0].shipments[0].identifier).toBe("FALLBACK-FROM-SEARCH");
  });
});
