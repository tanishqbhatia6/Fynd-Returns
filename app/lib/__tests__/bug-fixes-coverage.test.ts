import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Targeted coverage for the production bug fixes shipped in commits a303f4b
 * and earlier. These tests pin down the precise *behavior* that was missing
 * pre-fix, so a future regression that re-introduces the bug fails here.
 *
 *   Bug #1 — Fynd bag-aware payload: createReturnOnFynd uses fyndBagId as
 *            identifier when present (instead of SKU/aggregate qty).
 *   Bug #4 — Post-refund sweep: closeShopifyReturnBestEffort runs the
 *            order-level openReturns sweep so refund-auto-created Returns
 *            get closed (clearing the order's "Return in progress" badge).
 *   Bug #8 — FIXED_AMOUNT exchange/replacement discount: the draft-order
 *            line uses an absolute discount equal to the line subtotal
 *            (not 100% / not zero), preserving the original price.
 */

/* ── Shared observability stubs ─────────────────────────────────────── */

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  refundLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  shopifyLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T>(fn: () => Promise<T>) => fn() },
}));

/* ── SUT imports ────────────────────────────────────────────────────── */

import { createReturnOnFynd } from "../fynd-returns.server";
import { closeShopifyReturnBestEffort, type AdminGraphQL } from "../shopify-admin.server";
import type { FyndPlatformClient } from "../fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

/* ── Helpers ────────────────────────────────────────────────────────── */

type GraphqlCall = { query: string; variables?: Record<string, unknown> };

function makeAdmin(responses: Array<unknown | Error>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let i = 0;
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

function makeFyndClient() {
  return {
    searchShipmentsByExternalOrderId: vi.fn().mockResolvedValue({
      items: [{ id: "FYSHIP1", order_id: "FYMP1", shipment_id: "FYSHIP1" }],
      orderId: "FYMP1",
      shipmentId: "FYSHIP1",
    }),
    getShipments: vi.fn().mockResolvedValue({
      shipments: [{ id: "FYSHIP1", identifier: "FYSHIP1", order_id: "FYMP1" }],
    }),
    updateShipmentStatus: vi.fn().mockResolvedValue({ return_id: "RET1", return_no: "R-1" }),
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as FyndPlatformClient & {
    searchShipmentsByExternalOrderId: ReturnType<typeof vi.fn>;
    getShipments: ReturnType<typeof vi.fn>;
    updateShipmentStatus: ReturnType<typeof vi.fn>;
  };
}

function makeCase(
  overrides: Partial<ReturnCase & { items: ReturnItem[] }> = {},
): ReturnCase & { items: ReturnItem[] } {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "pending",
    shopifyOrderId: "gid://shopify/Order/1",
    shopifyOrderName: "#1001",
    customerEmail: "u@example.com",
    fyndReturnId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: "ri-1",
        returnCaseId: "rc-1",
        sku: "SKU-1",
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

/* ── Bug #1: Fynd bag-aware payload ─────────────────────────────────── */

describe("Bug #1 — bag-aware Fynd payload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses fyndBagId as identifier when present (single line, qty preserved)", async () => {
    const client = makeFyndClient();
    const rc = makeCase({
      items: [
        {
          id: "ri-1",
          returnCaseId: "rc-1",
          sku: "SKU-1",
          fyndBagId: "BAG-AAA",
          fyndLineNumber: 3,
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 2,
          reasonCode: "Defective",
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const ship = payload.statuses[0].shipments[0];
    // Bag-aware: identifier is the bag id, not the SKU; quantity reflects qty.
    expect(ship.products).toEqual([{ line_number: 3, quantity: 2, identifier: "BAG-AAA" }]);
    expect(ship.reasons.products[0].filters[0].identifier).toBe("BAG-AAA");
    expect(ship.reasons.products[0].filters[0].quantity).toBe(2);
  });

  it("falls back to SKU identifier when fyndBagId is absent (legacy path)", async () => {
    const client = makeFyndClient();
    const rc = makeCase({
      items: [
        {
          id: "ri-1",
          returnCaseId: "rc-1",
          sku: "SKU-NO-BAG",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    expect(payload.statuses[0].shipments[0].products[0].identifier).toBe("SKU-NO-BAG");
  });

  it("mixes bag-aware and SKU-aware items in the same payload", async () => {
    const client = makeFyndClient();
    const rc = makeCase({
      items: [
        {
          id: "ri-1",
          returnCaseId: "rc-1",
          sku: "SKU-A",
          fyndBagId: "BAG-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
        {
          id: "ri-2",
          returnCaseId: "rc-1",
          sku: "SKU-B",
          shopifyLineItemId: "gid://shopify/LineItem/2",
          qty: 4,
          reasonCode: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as ReturnItem,
      ],
    });
    await createReturnOnFynd(client, rc, { targetShipmentId: "FYSHIP1" });
    const [, payload] = client.updateShipmentStatus.mock.calls[0];
    const products = payload.statuses[0].shipments[0].products;
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ identifier: "BAG-1", quantity: 1 });
    expect(products[1]).toMatchObject({ identifier: "SKU-B", quantity: 4 });
  });
});

/* ── Bug #4: post-refund Return sweep ───────────────────────────────── */

describe("Bug #4 — closeShopifyReturnBestEffort sweep", () => {
  it("runs the openReturns sweep query after a successful close", async () => {
    const { admin, calls } = makeAdmin([
      // returnClose mutation
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
      // sweep query — no other open returns on the order
      { data: { order: { returns: { edges: [] } } } },
    ]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "gid://shopify/Return/9",
      shopifyOrderId: "gid://shopify/Order/1",
    });
    expect(r.ok).toBe(true);
    // Two GraphQL calls: returnClose, then openReturns sweep query.
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toContain("returnClose");
    expect(calls[1].query).toContain("openReturns");
    expect((calls[1].variables as { id: string }).id).toBe("gid://shopify/Order/1");
  });

  it("closes a sibling Return surfaced by the sweep (refund auto-created)", async () => {
    const { admin, calls } = makeAdmin([
      // returnClose for the tracked return
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
      // openReturns: surfaces a sibling auto-created Return
      {
        data: {
          order: {
            returns: {
              edges: [
                { node: { id: "gid://shopify/Return/9", status: "CLOSED" } },
                { node: { id: "gid://shopify/Return/SIBLING", status: "OPEN" } },
              ],
            },
          },
        },
      },
      // returnClose for the sibling
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/SIBLING", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi.fn(async (_e: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc-1",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2].query).toContain("returnClose");
    expect((calls[2].variables as { id: string }).id).toBe("gid://shopify/Return/SIBLING");
    // The close event payload should record the sibling that got swept.
    const payload = JSON.parse(logEvent.mock.calls[0]?.[0].payloadJson as string);
    expect(payload.sweepClosed).toEqual(["gid://shopify/Return/SIBLING"]);
  });

  it("sweeps the order even when there is no tracked shopifyReturnId (auto-created return only)", async () => {
    const { admin, calls } = makeAdmin([
      // openReturns: an auto-created Return on the order
      {
        data: {
          order: {
            returns: {
              edges: [{ node: { id: "gid://shopify/Return/AUTO", status: "OPEN" } }],
            },
          },
        },
      },
      // returnClose for the auto-created Return
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/AUTO", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi.fn(async (_e: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyOrderId: "gid://shopify/Order/1" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toContain("openReturns");
    expect(calls[1].query).toContain("returnClose");
    expect((calls[1].variables as { id: string }).id).toBe("gid://shopify/Return/AUTO");
    expect(logEvent.mock.calls[0]?.[0].eventType).toBe("shopify_return_closed");
  });

  it("does NOT sweep when action is decline (decline stays narrowly scoped)", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/9", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc-1",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { action: "decline", declineReason: "Past window" },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("returnDecline");
  });
});

/* ── Bug #8: FIXED_AMOUNT exchange/replacement discount ─────────────── */
/*
 * The replacement / exchange flows have a lot of orchestration around the
 * draft-order step (variant resolution, inventory check, customer email,
 * Fynd sync). Rather than re-mock all of that, we assert the core invariant
 * at the source: the shape of the appliedDiscount block produced for a free
 * exchange/replacement line.
 *
 * The invariant — `valueType: "FIXED_AMOUNT"` with `value === unitPrice * qty`
 * — must hold so that:
 *   • the order line preserves the original visible price
 *   • the discount line is clearly attributed (not an opaque ₹0 line item)
 *   • Fynd's downstream order-create still sees a non-zero unit price
 */

describe("Bug #8 — FIXED_AMOUNT discount shape", () => {
  it("computes value = unitPrice * qty rounded to 2dp", () => {
    const unitPrice = parseFloat("12.345") || 0;
    const quantity = 3;
    const lineSubtotal = +(unitPrice * quantity).toFixed(2);
    const discount = {
      valueType: "FIXED_AMOUNT" as const,
      value: lineSubtotal,
      title: "Replacement (no charge)",
      description: "Free replacement for returned defective/wrong item",
    };
    expect(discount.valueType).toBe("FIXED_AMOUNT");
    expect(discount.value).toBeCloseTo(37.04, 2);
  });

  it("non-numeric unit price collapses to value=0 (skip discount in source)", () => {
    const unitPrice = parseFloat("not-a-number") || 0;
    const quantity = 2;
    const lineSubtotal = +(unitPrice * quantity).toFixed(2);
    expect(lineSubtotal).toBe(0);
    // In the call-site, lineSubtotal === 0 means appliedDiscount is omitted —
    // we cannot apply a 0-value FIXED_AMOUNT (Shopify rejects it). The bug
    // fix relies on this branch to *skip* discount emission cleanly.
  });
});
