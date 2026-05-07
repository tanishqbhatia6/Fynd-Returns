/**
 * Bug #11 — multi-bag Fynd return sync.
 *
 * Production error:
 *   "Requested quantity is greater than available bags quantity for
 *    line_number: 1 and shipment_id: 17780781373031127304"
 *
 * Root cause: a Shopify line item with qty=3 maps to 3 separate Fynd
 * bags (each with qty=1). The portal collapsed multi-bag selections
 * into a single ReturnItem with `qty=3` and ONE `fyndBagId`, which
 * Fynd rejected because each bag is qty=1.
 *
 * Fix layers:
 *   1. createReturnOnFynd's buildProductsPayload caps qty against
 *      `fyndQuantityAvailable` (defaults to 1 if missing).
 *   2. api.portal.create-return.ts caps qty at submit time when
 *      fyndBagId is set.
 *   3. Portal HTML caps the qty input's max to `li.quantity` on
 *      bag-aware rows so the user must tick multiple bag rows for
 *      multi-bag returns.
 *
 * This file pins the buildProductsPayload contract — the other layers
 * have their own tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s?: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 0,
}));
vi.mock("../observability/metrics.server", () => ({
  fyndApiDuration: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));

import { createReturnOnFynd } from "../fynd-returns.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

function makeClient() {
  return {
    searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({
      items: [{ id: "FYS1", order_id: "FYMP1", shipment_id: "FYS1" }],
      orderId: "FYMP1",
      shipmentId: "FYS1",
    }),
    getShipments: vi.fn().mockResolvedValue({
      shipments: [{ id: "FYS1", identifier: "FYS1", order_id: "FYMP1" }],
    }),
    updateShipmentStatus: vi.fn().mockResolvedValue({ return_id: "RET1", return_no: "R-1" }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as FyndPlatformClient & {
    updateShipmentStatus: ReturnType<typeof vi.fn>;
    searchShipmentsByExternalOrderId: ReturnType<typeof vi.fn>;
    getShipments: ReturnType<typeof vi.fn>;
  };
}

function makeCase(items: Partial<ReturnItem>[]): ReturnCase & { items: ReturnItem[] } {
  return {
    id: "rc-multi",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/100",
    shopifyOrderName: "#1001",
    customerEmail: "u@example.com",
    fyndReturnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: items.map(
      (it, i) =>
        ({
          id: `ri-${i + 1}`,
          returnCaseId: "rc-multi",
          sku: "SKU-A",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...it,
        }) as unknown as ReturnItem,
    ),
  } as unknown as ReturnCase & { items: ReturnItem[] };
}

beforeEach(() => vi.clearAllMocks());

describe("Bug #11 — multi-bag Fynd return payload", () => {
  it("caps quantity to bag's fyndQuantityAvailable when qty exceeds it (regression)", async () => {
    // Pre-fix scenario: ONE return item with qty=3 + bagId targeting a
    // single bag whose true capacity is 1. Without the cap, we'd send
    // {quantity: 3, identifier: <bagId>} → Fynd rejects.
    const client = makeClient();
    const rc = makeCase([
      {
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 3,
        fyndBagId: "BAG-1",
        fyndShipmentId: "FYS1",
        fyndQuantityAvailable: 1,
      } as unknown as ReturnItem,
    ]);
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const ship = payload.statuses[0].shipments[0];
    // Cap kicked in: qty=1, not 3
    expect(ship.products).toEqual([{ line_number: 1, quantity: 1, identifier: "BAG-1" }]);
    expect(ship.reasons.products[0].filters[0].quantity).toBe(1);
  });

  it("uses bag capacity > 1 when Fynd actually has a multi-qty bag", async () => {
    // Edge case: Fynd CAN have a single bag with qty>1 (rare, but valid).
    // We should respect that and let qty up to the bag's capacity.
    const client = makeClient();
    const rc = makeCase([
      {
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 5,
        fyndBagId: "BAG-MULTI",
        fyndShipmentId: "FYS1",
        fyndQuantityAvailable: 3, // bag has qty=3
      } as unknown as ReturnItem,
    ]);
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const ship = payload.statuses[0].shipments[0];
    expect(ship.products[0].quantity).toBe(3); // capped at bag capacity
  });

  it("fans out one entry per bag when multiple ReturnItems target different bags", async () => {
    // Post-fix happy path: 3 ReturnItems, each with its own bagId
    // and qty=1. This is what the portal will produce when the user
    // ticks all 3 bag rows for a multi-qty Shopify line item.
    const client = makeClient();
    const rc = makeCase([
      {
        id: "ri-1",
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 1,
        fyndBagId: "BAG-1",
        fyndShipmentId: "FYS1",
        fyndLineNumber: 1,
        fyndQuantityAvailable: 1,
      } as unknown as ReturnItem,
      {
        id: "ri-2",
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 1,
        fyndBagId: "BAG-2",
        fyndShipmentId: "FYS1",
        fyndLineNumber: 2,
        fyndQuantityAvailable: 1,
      } as unknown as ReturnItem,
      {
        id: "ri-3",
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 1,
        fyndBagId: "BAG-3",
        fyndShipmentId: "FYS1",
        fyndLineNumber: 3,
        fyndQuantityAvailable: 1,
      } as unknown as ReturnItem,
    ]);
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const products = payload.statuses[0].shipments[0].products;
    expect(products).toHaveLength(3);
    expect(products).toEqual([
      { line_number: 1, quantity: 1, identifier: "BAG-1" },
      { line_number: 2, quantity: 1, identifier: "BAG-2" },
      { line_number: 3, quantity: 1, identifier: "BAG-3" },
    ]);
  });

  it("defaults bag capacity to 1 when fyndQuantityAvailable is null", async () => {
    // Legacy ReturnItems pre-date fyndQuantityAvailable capture. Default
    // assumption: each Fynd bag holds 1 unit (the most common shape).
    const client = makeClient();
    const rc = makeCase([
      {
        sku: "SKU-A",
        shopifyLineItemId: "gid://shopify/LineItem/1",
        qty: 5,
        fyndBagId: "BAG-LEGACY",
        fyndShipmentId: "FYS1",
        fyndQuantityAvailable: null,
      } as unknown as ReturnItem,
    ]);
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYS1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].products[0].quantity).toBe(1);
  });
});
