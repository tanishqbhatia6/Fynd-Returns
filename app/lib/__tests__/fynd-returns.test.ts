import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fynd-returns.server.ts tests.
 * ────────────────────────────────────────────────────────────────────
 * createReturnOnFynd orchestrates the Fynd-side return creation by
 * resolving a shipment ID (fast path / search path / direct lookup),
 * building the bag/products payload, and calling updateShipmentStatus.
 *
 * We mock:
 *   - The Fynd platform client (search / getShipments / updateShipmentStatus)
 *   - observability/logger.server (silent loggers)
 *   - observability/tracing.server (withSpan -> just runs the fn)
 *   - observability/metrics.server (no-op counters/histograms)
 *
 * Coverage targets:
 *   - manual-return rejection
 *   - missing/invalid order ID
 *   - fast path success when targetShipmentId + items are provided
 *   - fast path "Invalid State Transition" -> alreadyExists branch
 *   - fast path failure falls through to search path
 *   - bag/products mapping (line_number, sku, fyndSellerIdentifier, qty)
 *   - reasons mapping with reasonCode override + default fallback
 *   - default products fallback when no items have valid sku
 *   - search path with external_order_id
 *   - search-path 404 + searchItems fallback
 *   - search-path 404 + targetShipId stub fallback
 *   - "Order not found" empty shipments error
 *   - getShipments thrown error (not 404) propagates
 *   - statuses[].shipments[].status non-200 -> error
 *   - already-exists detection via nested status message
 *   - delivery_address built from pickupAddress option
 *   - shipment-only-id search response uses search items directly
 *   - return_no surfaced from update response
 */

/* ── Mocks ────────────────────────────────────────────────────────── */

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

/* ── SUT imports (must come after vi.mock) ────────────────────────── */

import { createReturnOnFynd } from "../fynd-returns.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

/* ── Fixtures / helpers ───────────────────────────────────────────── */

type MockClientOverrides = {
  search?: { items?: unknown[]; shipments?: unknown[]; orderId?: string; shipmentId?: string };
  searchImpl?: ReturnType<typeof vi.fn>;
  getShipments?: unknown;
  getShipmentsImpl?: ReturnType<typeof vi.fn>;
  update?: unknown;
  updateImpl?: ReturnType<typeof vi.fn>;
  omitSearch?: boolean;
};

function makeClient(o: MockClientOverrides = {}) {
  const search =
    o.searchImpl ??
    vi.fn().mockResolvedValue(
      o.search ?? {
        items: [{ id: "FYSHIP001", order_id: "FYMP698CC0", shipment_id: "FYSHIP001" }],
        orderId: "FYMP698CC0",
        shipmentId: "FYSHIP001",
      },
    );
  const getShipments =
    o.getShipmentsImpl ??
    vi.fn().mockResolvedValue(
      o.getShipments ?? {
        shipments: [{ id: "FYSHIP001", identifier: "FYSHIP001", order_id: "FYMP698CC0" }],
      },
    );
  const update =
    o.updateImpl ??
    vi.fn().mockResolvedValue(o.update ?? { return_id: "FYRET001", return_no: "R-001" });

  const client: Record<string, unknown> = {
    getShipments,
    updateShipmentStatus: update,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  };
  if (!o.omitSearch) {
    client.searchShipmentsByExternalOrderId = search;
  }
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
    id: "rc-1",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/123",
    shopifyOrderName: "#1234",
    customerEmail: "test@example.com",
    fyndReturnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: "ri-1",
        returnCaseId: "rc-1",
        sku: "SKU-001",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 1,
        reasonCode: "Defective",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ReturnItem,
    ],
    ...overrides,
  } as unknown as ReturnCase & { items: ReturnItem[] };
}

/* ── Tests ────────────────────────────────────────────────────────── */

describe("createReturnOnFynd — guard clauses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects manual returns immediately", async () => {
    const client = makeClient();
    const rc = makeCase({ shopifyOrderId: "manual:abc" });
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Manual returns/i);
    expect(client.searchShipmentsByExternalOrderId).not.toHaveBeenCalled();
  });

  it("returns Invalid order ID when no order name + no affiliate id + no stored fynd id", async () => {
    const client = makeClient();
    const rc = makeCase({ shopifyOrderName: "" });
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid order ID/i);
  });
});

describe("createReturnOnFynd — fast path (known shipment ID)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses fast path when targetShipmentId + items present", async () => {
    const client = makeClient();
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP123" });
    expect(res.success).toBe(true);
    // Fast path skips search + getShipments
    expect(client.searchShipmentsByExternalOrderId).not.toHaveBeenCalled();
    expect(client.getShipments).not.toHaveBeenCalled();
    expect(client.updateShipmentStatus).toHaveBeenCalledOnce();
    // Identifier in payload should be the targetShipmentId
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].identifier).toBe("FYSHIP123");
  });

  it("falls through fast path when no usable items (only manual lines)", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "ri-m",
          returnCaseId: "rc-1",
          sku: null,
          shopifyLineItemId: "manual",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP999" });
    // No fast-path; must fall back to search path
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalled();
  });

  it("returns alreadyExists=true on Invalid State Transition in fast path", async () => {
    const client = makeClient({
      updateImpl: vi
        .fn()
        .mockRejectedValue(new Error("Invalid State Transition to return_initiated")),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP777" });
    expect(res.success).toBe(true);
    expect(res.alreadyExists).toBe(true);
    expect(res.fyndShipmentId).toBe("FYSHIP777");
    expect(res.fyndReturnId).toBe("FYSHIP777");
  });

  it("falls through to search path when fast path fails with non-state error", async () => {
    let calls = 0;
    const update = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("Network timeout");
      return Promise.resolve({ return_id: "FYRET-OK" });
    });
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIPX" });
    expect(res.success).toBe(true);
    // Search was triggered after fast-path miss
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalled();
  });

  it("derives target shipment ID from stored fyndOrderId when it looks like a shipment", async () => {
    const client = makeClient();
    const rc = makeCase({ fyndOrderId: "123456789012345" } as Partial<ReturnCase>);
    await createReturnOnFynd(client, rc);
    // Long numeric -> treated as shipment ID -> fast path used
    expect(client.updateShipmentStatus).toHaveBeenCalled();
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].identifier).toBe("123456789012345");
  });
});

describe("createReturnOnFynd — bag/products mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps items with sku + qty + line_number into products + reasons", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "SKU-A",
          shopifyLineItemId: "li1",
          qty: 2,
          reasonCode: "Damaged",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
        {
          id: "i2",
          returnCaseId: "rc-1",
          sku: "SKU-B",
          shopifyLineItemId: "li2",
          qty: 3,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });

    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const ship = payload.statuses[0].shipments[0];
    expect(ship.products).toEqual([
      { line_number: 1, quantity: 2, identifier: "SKU-A" },
      { line_number: 2, quantity: 3, identifier: "SKU-B" },
    ]);
    expect(ship.reasons.products[0].data.reason_text).toBe("Damaged");
    expect(ship.reasons.products[1].data.reason_text).toBe("Other"); // default
  });

  it("prefers fyndSellerIdentifier over sku when present", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "PLAIN-SKU",
          fyndSellerIdentifier: "FYND-SELLER-XYZ",
          shopifyLineItemId: "li1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].products[0].identifier).toBe("FYND-SELLER-XYZ");
  });

  it("uses fyndLineNumber when set (not sequential)", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "S1",
          fyndLineNumber: 7,
          shopifyLineItemId: "li1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].products[0].line_number).toBe(7);
  });

  it("filters items by targetShipmentId when items have fyndShipmentId", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "MATCH",
          fyndShipmentId: "SHIP-A",
          shopifyLineItemId: "li1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
        {
          id: "i2",
          returnCaseId: "rc-1",
          sku: "DROP",
          fyndShipmentId: "SHIP-B",
          shopifyLineItemId: "li2",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "SHIP-A" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const products = payload.statuses[0].shipments[0].products;
    expect(products).toHaveLength(1);
    expect(products[0].identifier).toBe("MATCH");
  });

  it("syncs each selected shipment when one return contains items from multiple Fynd shipments", async () => {
    const client = makeClient();
    const rc = makeCase({
      fyndShipmentId: "SHIP-A",
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "SKU-A",
          shopifyLineItemId: "gid://shopify/LineItem/100",
          qty: 1,
          reasonCode: "Size too Big",
          fyndShipmentId: "SHIP-A",
          fyndBagId: "BAG-A",
          fyndLineNumber: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
        {
          id: "i2",
          returnCaseId: "rc-1",
          sku: "SKU-A",
          shopifyLineItemId: "gid://shopify/LineItem/100",
          qty: 1,
          reasonCode: "Size too Big",
          fyndShipmentId: "SHIP-B",
          fyndBagId: "BAG-B",
          fyndLineNumber: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });

    const result = await createReturnOnFynd(client, rc, { targetShipmentId: "SHIP-A" });

    expect(result.success).toBe(true);
    expect(result.fyndShipmentId).toBe("SHIP-A,SHIP-B");
    expect(client.searchShipmentsByExternalOrderId).not.toHaveBeenCalled();
    expect(client.getShipments).not.toHaveBeenCalled();
    expect(client.updateShipmentStatus).toHaveBeenCalledTimes(2);

    const firstPayload = client.updateShipmentStatus.mock.calls[0][1];
    const secondPayload = client.updateShipmentStatus.mock.calls[1][1];
    expect(firstPayload.statuses[0].shipments[0]).toMatchObject({
      identifier: "SHIP-A",
      products: [{ line_number: 1, quantity: 1, identifier: "BAG-A" }],
    });
    expect(secondPayload.statuses[0].shipments[0]).toMatchObject({
      identifier: "SHIP-B",
      products: [{ line_number: 1, quantity: 1, identifier: "BAG-B" }],
    });
  });

  it("emits the default fallback product when no items have a valid sku", async () => {
    const client = makeClient();
    // All items skipped (manual or no sku/lineItem)
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: null,
          shopifyLineItemId: "manual",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc);
    // No fast path -> search path -> update happens
    expect(client.updateShipmentStatus).toHaveBeenCalled();
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const products = payload.statuses[0].shipments[0].products;
    expect(products).toEqual([{ line_number: 1, quantity: 1, identifier: "default" }]);
  });

  it("respects custom defaultReasonId and defaultReasonText", async () => {
    const client = makeClient();
    const rc = makeCase({
      items: [
        {
          id: "i1",
          returnCaseId: "rc-1",
          sku: "S1",
          shopifyLineItemId: "li1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, {
      targetShipmentId: "FYS1",
      defaultReasonId: 999,
      defaultReasonText: "TestReason",
    });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const reason = payload.statuses[0].shipments[0].reasons.products[0].data;
    expect(reason.reason_id).toBe(999);
    expect(reason.reason_text).toBe("TestReason");
  });

  it("attaches delivery_address when pickupAddress option provided", async () => {
    const client = makeClient();
    const rc = makeCase();
    await createReturnOnFynd(client, rc, {
      targetShipmentId: "FYS1",
      pickupAddress: {
        address1: "123 Lane",
        address2: "Apt 4",
        city: "Mumbai",
        province: "MH",
        zip: "400001",
        country: "IN",
        landmark: "Near Park",
        name: "Alice",
        phone: "+91-9999999999",
      },
    });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const da = payload.statuses[0].shipments[0].delivery_address;
    expect(da).toMatchObject({
      address1: "123 Lane",
      city: "Mumbai",
      pincode: "400001",
      country: "IN",
      state: "MH",
    });
  });

  it("omits delivery_address when pickupAddress fields are blank", async () => {
    const client = makeClient();
    const rc = makeCase();
    await createReturnOnFynd(client, rc, {
      targetShipmentId: "FYS1",
      pickupAddress: { address1: null, city: null, zip: null },
    });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].delivery_address).toBeUndefined();
  });
});

describe("createReturnOnFynd — search path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls search with external_order_id by default", async () => {
    const client = makeClient();
    const rc = makeCase();
    await createReturnOnFynd(client, rc);
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalledWith(
      "1234",
      expect.objectContaining({ searchType: "external_order_id" }),
    );
  });

  it("returns 'Order not found' when shipments list is empty", async () => {
    const client = makeClient({
      search: { items: [] },
      getShipments: { shipments: [] },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Order not found|no shipments/i);
  });

  it("falls back to search items when getShipments throws 404", async () => {
    const client = makeClient({
      search: {
        items: [{ shipment_id: "FYS-FALLBACK", id: "FYS-FALLBACK" }],
        orderId: "FYMPABC1234567",
      },
      getShipmentsImpl: vi.fn().mockRejectedValue(new Error("404 Not Found")),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndShipmentId).toBe("FYS-FALLBACK");
  });

  it("propagates non-404 getShipments errors as failure", async () => {
    const client = makeClient({
      search: { items: [], orderId: "FYMPABC1234567" },
      getShipmentsImpl: vi.fn().mockRejectedValue(new Error("500 internal error")),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/500/);
  });

  it("uses search response when only shipmentId (no orderId) is returned", async () => {
    const client = makeClient({
      search: {
        items: [{ shipment_id: "FYS-DIRECT", id: "FYS-DIRECT" }],
        shipmentId: "FYS-DIRECT",
      },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndShipmentId).toBe("FYS-DIRECT");
    // getShipments must NOT have been called since search-only path took over
    expect(client.getShipments).not.toHaveBeenCalled();
  });

  it("surfaces return_no from update response", async () => {
    const client = makeClient({
      update: { return_id: "RID-1", return_no: "RN-XYZ" },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndReturnNo).toBe("RN-XYZ");
    expect(res.fyndReturnId).toBe("RID-1");
  });

  it("uses affiliateOrderId option as the primary search value", async () => {
    const client = makeClient();
    const rc = makeCase();
    await createReturnOnFynd(client, rc, { affiliateOrderId: "AFF-12345" });
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalledWith(
      "AFF-12345",
      expect.any(Object),
    );
  });
});

describe("createReturnOnFynd — already-exists nested status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects 'Invalid State Transition' in nested statuses[].shipments[].message", async () => {
    const client = makeClient({
      update: {
        statuses: [
          {
            shipments: [
              {
                status: 400,
                message: "Invalid State Transition to return_initiated",
                identifier: "FYS-EXISTS",
              },
            ],
          },
        ],
      },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.alreadyExists).toBe(true);
    expect(res.fyndShipmentId).toBe("FYSHIP001");
  });

  it("returns failure when nested shipment status is non-200 and message is unrelated", async () => {
    const client = makeClient({
      update: {
        statuses: [
          {
            shipments: [{ status: 422, message: "Quantity exceeds available", identifier: "FYS1" }],
          },
        ],
      },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Quantity exceeds/);
  });

  it("derives fyndReturnId from final_state when status=200 + no top-level id", async () => {
    const client = makeClient({
      update: {
        statuses: [
          {
            shipments: [
              {
                status: 200,
                identifier: "FYSHIP001",
                final_state: { return_id: "FROM-FINAL-STATE" },
              },
            ],
          },
        ],
      },
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndReturnId).toBe("FROM-FINAL-STATE");
  });
});

describe("createReturnOnFynd — error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns failure when updateShipmentStatus throws non-404 error in search path", async () => {
    const client = makeClient({
      updateImpl: vi.fn().mockRejectedValue(new Error("503 service unavailable")),
    });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/503/);
  });

  it("retries updateShipmentStatus with shipmentId on 404", async () => {
    let n = 0;
    const update = vi.fn().mockImplementation(() => {
      n += 1;
      if (n === 1) throw new Error("404 Not Found");
      return Promise.resolve({ return_id: "RETRY-OK" });
    });
    const client = makeClient({ updateImpl: update });
    const rc = makeCase();
    const res = await createReturnOnFynd(client, rc);
    expect(res.success).toBe(true);
    expect(res.fyndReturnId).toBe("RETRY-OK");
    expect(update).toHaveBeenCalledTimes(2);
  });
});
