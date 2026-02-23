/**
 * End-to-end test of createReturnOnFynd flow with mock Fynd client.
 * Runs without live credentials.
 */
import { describe, it, expect, vi } from "vitest";
import { createReturnOnFynd } from "../fynd-returns.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

function createMockClient(overrides?: {
  searchReturn?: { items?: unknown[]; orderId?: string; shipmentId?: string };
  getShipmentsReturn?: unknown;
  updateReturn?: unknown;
  searchError?: Error;
  getShipmentsError?: Error;
  updateError?: Error;
}): FyndPlatformClient {
  const searchRes = overrides?.searchReturn ?? {
    items: [{ id: "FYSHIP001", order_id: "FYMP698CC01401C9F4A1", shipment_id: "FYSHIP001" }],
    orderId: "FYMP698CC01401C9F4A1",
    shipmentId: "FYSHIP001",
  };
  const getRes = overrides?.getShipmentsReturn ?? {
    shipments: [{ id: "FYSHIP001", identifier: "FYSHIP001", order_id: "FYMP698CC01401C9F4A1" }],
  };
  const updateRes = overrides?.updateReturn ?? { return_id: "FYRET001", return_no: "R-001" };

  return {
    getReturnReasons: vi.fn().mockResolvedValue(null),
    getShipments: vi.fn().mockImplementation(() => {
      if (overrides?.getShipmentsError) throw overrides.getShipmentsError;
      return Promise.resolve(getRes);
    }),
    searchShipmentsByExternalOrderId: vi.fn().mockImplementation(() => {
      if (overrides?.searchError) throw overrides.searchError;
      return Promise.resolve(searchRes);
    }),
    updateShipmentStatus: vi.fn().mockImplementation(() => {
      if (overrides?.updateError) throw overrides.updateError;
      return Promise.resolve(updateRes);
    }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as FyndPlatformClient;
}

function createMockReturnCase(overrides?: Partial<ReturnCase & { items: ReturnItem[] }>): ReturnCase & { items: ReturnItem[] } {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/123",
    shopifyOrderName: "#1234",
    customerEmail: "test@example.com",
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
      },
    ],
    ...overrides,
  } as ReturnCase & { items: ReturnItem[] };
}

describe("createReturnOnFynd E2E", () => {
  it("rejects manual returns", async () => {
    const client = createMockClient();
    const returnCase = createMockReturnCase({ shopifyOrderId: "manual:xyz" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Manual returns");
  });

  it("rejects when order ID is missing", async () => {
    const client = createMockClient();
    const returnCase = createMockReturnCase({ shopifyOrderName: null, shopifyOrderId: null });
    const result = await createReturnOnFynd(client, returnCase, { affiliateOrderId: null });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid order ID");
  });

  it("full flow: search → getShipments → update status → success", async () => {
    const client = createMockClient();
    const returnCase = createMockReturnCase({ shopifyOrderName: "#FYMP698CC01401C9F4A1" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(true);
    expect(result.fyndReturnId).toBe("FYRET001");
    expect(result.fyndReturnNo).toBe("R-001");
    expect(result.fyndOrderId).toBeDefined();
    expect(result.fyndShipmentId).toBe("FYSHIP001");
  });

  it("uses search result when getShipments returns 404", async () => {
    const client = createMockClient({
      getShipmentsError: new Error("404 Not Found"),
      searchReturn: {
        items: [{ id: "FYSHIP002", shipment_id: "FYSHIP002", order_id: "FYMP698CC01401C9F4A1" }],
        orderId: "FYMP698CC01401C9F4A1",
        shipmentId: "FYSHIP002",
      },
    });
    const returnCase = createMockReturnCase({ shopifyOrderName: "#FYMP698CC01401C9F4A1" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(true);
    expect(result.fyndShipmentId).toBe("FYSHIP002");
  });

  it("uses affiliate_order_id when provided", async () => {
    const client = createMockClient();
    const returnCase = createMockReturnCase({ shopifyOrderName: "#1234" });
    const result = await createReturnOnFynd(client, returnCase, {
      affiliateOrderId: "FYMP698CC01401C9F4A1",
    });
    expect(result.success).toBe(true);
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalled();
  });

  it("extracts shipment_id from Fynd API response (shipment_id field)", async () => {
    const client = createMockClient({
      getShipmentsReturn: {
        shipments: [{ shipment_id: "17708318940301766054", order_id: "FYMP698CC01401C9F4A1" }],
      },
    });
    const returnCase = createMockReturnCase({ shopifyOrderName: "#FYMP698CC01401C9F4A1" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(true);
    expect(result.fyndShipmentId).toBe("17708318940301766054");
  });

  it("uses external_order_id when affiliateOrderId is Shopify/external format (FYNDSHOPIFYX14083)", async () => {
    const client = createMockClient({
      searchReturn: {
        items: [{ id: "FYSHIP001", order_id: "FYMP698CC01401C9F4A1", shipment_id: "FYSHIP001" }],
        orderId: "FYMP698CC01401C9F4A1",
        shipmentId: "FYSHIP001",
      },
    });
    const returnCase = createMockReturnCase({ shopifyOrderName: "#14083" });
    const result = await createReturnOnFynd(client, returnCase, {
      affiliateOrderId: "FYNDSHOPIFYX14083",
    });
    expect(result.success).toBe(true);
    expect(client.searchShipmentsByExternalOrderId).toHaveBeenCalledWith(
      "FYNDSHOPIFYX14083",
      expect.objectContaining({ searchType: "external_order_id" })
    );
  });

  it("returns alreadyExists when return is already created (status 400 Invalid State Transition)", async () => {
    const client = createMockClient({
      updateReturn: {
        statuses: [
          {
            shipments: [
              {
                status: 400,
                message: "Invalid State Transition return_initiated detected for given entity",
                identifier: "17718404850311580665",
              },
            ],
          },
        ],
      },
    });
    const returnCase = createMockReturnCase({ shopifyOrderName: "#FYMP698CC01401C9F4A1" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(true);
    expect(result.alreadyExists).toBe(true);
    expect(result.fyndPayload).toBeDefined();
    expect(result.fyndShipmentId).toBe("FYSHIP001");
  });

  it("parses status-internal nested response (statuses[0].shipments[0].status: 200)", async () => {
    const client = createMockClient({
      updateReturn: {
        statuses: [
          {
            shipments: [
              {
                status: 200,
                final_state: { return_initiated: "return_initiated", shipment_id: "17718404850311580665" },
                identifier: "17708318940301766054",
              },
            ],
          },
        ],
      },
    });
    const returnCase = createMockReturnCase({ shopifyOrderName: "#FYMP698CC01401C9F4A1" });
    const result = await createReturnOnFynd(client, returnCase);
    expect(result.success).toBe(true);
    expect(result.fyndReturnId).toBe("17718404850311580665");
  });

  it("builds payload with correct structure for Fynd API", async () => {
    const client = createMockClient();
    const returnCase = createMockReturnCase();
    await createReturnOnFynd(client, returnCase);
    expect(client.updateShipmentStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        statuses: [
          expect.objectContaining({
            status: "return_initiated",
            shipments: [
              expect.objectContaining({
                identifier: "FYSHIP001",
                products: expect.any(Array),
                reasons: expect.objectContaining({ products: expect.any(Array) }),
              }),
            ],
          }),
        ],
      })
    );
  });
});
