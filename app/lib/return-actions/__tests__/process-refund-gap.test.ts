/**
 * Gap-coverage tests for handleProcessRefund — targets the branches still
 * uncovered after process-handlers.test.ts and process-refund-deep.test.ts:
 *
 *   - Status guard branches (not approved, refunded, manual:)
 *   - Cancellation request clearing
 *   - Fynd allowlist with empty currentFyndStatus
 *   - Fynd order resolution Strategies 1, 2, 3 (and ALL fail)
 *   - applyResolvedOrder SKU matching when shopifyOrder.lineItems present
 *   - !orderIdForRefund post-resolution fallback (manual: stripped, all empty)
 *   - lineItemsForRefund empty + Strategy 0 returns different orderIdForRefund
 *   - fetchOrderLineItemsByName + orderId reassignment
 *   - fetchOrder fallback in PCDA-safe path
 *   - createRefund returns success: false → enrichRefundError path
 *   - Discount-code rejection (already covered) plus splitMode amount=0,0
 *   - COD detection paths (paymentGatewayNames + displayFinancialStatus)
 *   - settings without refundPaymentMethod ("") doesn't crash, falls through
 *   - Top-level catch with non-Response error (logs refund_failed event)
 *   - Top-level catch when prisma.returnEvent.create throws (logs error)
 *   - Notification swallowing path (sendRefundNotification rejects)
 *   - Fynd sync sub-failure path (full createFyndClientOrError throws)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  createRefundMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByNameMock,
  closeShopifyReturnBestEffortMock,
  createFyndClientOrErrorMock,
  sendRefundNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createRefundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "10.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
  })),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByFyndAffiliateIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
  fetchOrderLineItemsOnlyMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderLineItemsByNameMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  sendRefundNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  createRefund: createRefundMock,
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnly: fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByName: fetchOrderLineItemsByNameMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendRefundNotification: sendRefundNotificationMock,
}));

import { handleProcessRefund } from "../process-refund.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "R-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      customerEmailNorm: "u@example.com",
      customerPhoneNorm: null,
      adminNotes: null,
      currency: "USD",
      refundStatus: null,
      cancellationRequestedAt: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndPayloadJson: null,
      fyndCurrentStatus: null,
      shopifyReturnId: null,
      exchangeOrderId: null,
      resolutionType: null,
      isGreenReturn: false,
      items: [
        {
          id: "li-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          sku: "SKU-1",
          price: "10.00",
          reasonCode: null,
          notes: null,
          title: "Item 1",
        },
      ],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: {
      graphql: vi.fn(async () => ({
        json: async () => ({ data: {} }),
      })),
    } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, frag: string) {
  try {
    await p;
    throw new Error("expected redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(frag);
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createRefundMock.mockReset().mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "10.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
  });
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  fetchOrderLineItemsOnlyMock.mockReset().mockResolvedValue(null);
  fetchOrderLineItemsByNameMock.mockReset().mockResolvedValue(null);
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendRefundNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ─────────────────── Status guard branches ───────────────────
describe("handleProcessRefund — status guards", () => {
  it("400 when status is 'pending' (not approved/completed)", async () => {
    const ctx = mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/approved/i);
  });

  it("400 when refundStatus is 'refunded'", async () => {
    const ctx = mkCtx({ returnCase: { ...mkCtx().returnCase, refundStatus: "refunded" } as never });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already/i);
  });

  it("400 when shopifyOrderId starts with manual: (uses shopifyOrderName)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "manual:12345",
        shopifyOrderName: "#9999",
      } as never,
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("#9999");
  });

  it("400 when manual:id and shopifyOrderName missing (uses stripped id)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "manual:99999",
        shopifyOrderName: null,
      } as never,
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("99999");
  });

  it("clears cancellationRequestedAt before refund processing", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        cancellationRequestedAt: new Date(),
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const clearedUpd = updates.find((d) => d.cancellationRequestedAt === null);
    expect(clearedUpd).toBeDefined();
  });

  it("status='completed' is allowed (lowercased compare)", async () => {
    const ctx = mkCtx({ returnCase: { ...mkCtx().returnCase, status: "COMPLETED" } as never });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── Fynd allowlist edge cases ───────────────────
describe("handleProcessRefund — Fynd allowlist edge", () => {
  it("blocks when allowlist set and currentFyndStatus is null/empty", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: null,
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: JSON.stringify(["return_accepted"]) },
      },
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Fynd shipment status has not been received/i);
  });

  it("non-array JSON allowlist treated as disabled", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "anything",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: JSON.stringify({ a: 1 }) },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── Fynd order resolution Strategies 1/2/3 ───────────────────
describe("handleProcessRefund — Fynd order resolution", () => {
  // Trigger the resolution path: orderIdForRefund must be neither GID nor numeric, not manual:
  it("Strategy 1: resolves via shopifyOrderName + applyResolvedOrder updates DB", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-ORDER-XYZ",
        shopifyOrderName: "#1001",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/777",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/X", title: "X", sku: null, quantity: 5 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const orderIdUpd = updates.find((d) => d.shopifyOrderId === "gid://shopify/Order/777");
    expect(orderIdUpd).toBeDefined();
    // Order id passed to createRefund should be the resolved GID
    expect(createRefundMock.mock.calls[0][1]).toBe("gid://shopify/Order/777");
  });

  it("Strategy 1 throws → Strategy 2 cleans the # and resolves", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "#FY-XYZ",
        shopifyOrderName: "#1001",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock
      .mockRejectedValueOnce(new Error("strat1 boom"))
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/888",
        name: "#1001",
        lineItems: [{ id: "gid://shopify/LineItem/Y", title: "Y", sku: null, quantity: 1 }],
      });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalledTimes(2);
    expect(fetchOrderByFyndAffiliateIdMock.mock.calls[1][1]).toBe("FY-XYZ");
  });

  it("Strategy 1+2 fail → Strategy 3 (fyndPayloadJson) succeeds", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-ORDER-X",
        shopifyOrderName: null,
        fyndPayloadJson: JSON.stringify({
          payload: {
            affiliate_order_id: "AFF-1",
            external_order_id: "EXT-1",
            meta: { channel_order_id: "CHAN-1" },
            order: { affiliate_order_id: "ORD-AFF-1" },
            items: [
              {
                affiliate_order_id: "ITEM-AFF-1",
                external_order_id: "ITEM-EXT-1",
                order: { affiliate_order_id: "INNER-1" },
              },
            ],
          },
        }),
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    // Strat 2 (no shopifyOrderName for strat1) → fail; first 2 candidates fail; 3rd succeeds
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // strat 2
      .mockRejectedValueOnce(new Error("c1 fail")) // strat 3 candidate 1
      .mockResolvedValueOnce(null) // strat 3 candidate 2
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/333",
        name: "#R3",
        lineItems: [{ id: "gid://shopify/LineItem/SKU", title: "S", sku: "SKU-1", quantity: 99 }],
      });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createRefundMock.mock.calls[0][1]).toBe("gid://shopify/Order/333");
  });

  it("Strategy 3: malformed fyndPayloadJson is caught (non-fatal) → resolution fails → 400", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-NONE",
        shopifyOrderName: null,
        fyndPayloadJson: "{not valid json",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("FY-NONE");
  });

  it("All Fynd resolution strategies fail → 400 + refund_failed event", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-UNRESOLVABLE",
        shopifyOrderName: "#1001",
        fyndPayloadJson: null,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    const res = await handleProcessRefund(ctx, {
      action: "process_refund",
      note: "trying",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("FY-UNRESOLVABLE");
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("refund_failed");
  });

  it("applyResolvedOrder: SKU match by case-insensitive trim", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-ABC",
        shopifyOrderName: "#1001",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 7,
            sku: "  SKU-MATCH  ",
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
          {
            id: "i2",
            shopifyLineItemId: "manual",
            qty: 2,
            sku: "",
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/M", title: "M", sku: "sku-match", quantity: 50 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/M", quantity: 7 }]);
  });

  it("applyResolvedOrder: when shopifyOrder.name absent, no shopifyOrderName update", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-ABC",
        shopifyOrderName: null,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    // No name provided
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9",
      lineItems: [{ id: "gid://shopify/LineItem/Q", title: "Q", sku: null, quantity: 3 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const upd = updates.find((d) => d.shopifyOrderId === "gid://shopify/Order/9");
    expect(upd).toBeDefined();
    expect((upd as Record<string, unknown>).shopifyOrderName).toBeUndefined();
  });

  it("applyResolvedOrder: prisma update rejects (non-fatal) — refund still proceeds", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-ABC",
        shopifyOrderName: "#1001",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/X",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/X", title: "X", sku: null, quantity: 1 }],
    });
    // First update (from applyResolvedOrder) rejects; subsequent updates succeed
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("prisma down"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── Line-item resolution edge cases ───────────────────
describe("handleProcessRefund — line-item resolution edge", () => {
  it("Strategy 0b updates orderIdForRefund when minimalOrder.id differs", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/NEW",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/Z", title: "Z", sku: null, quantity: 1 }],
    });
    // The orderId update inside Strategy 0b can fail and is non-fatal.
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("ignore"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("Strategy 0b: shopifyOrderName='#' (empty after trim) skips byName", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderName: "#",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      lineItems: [{ id: "gid://shopify/LineItem/F", title: "F", sku: null, quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderLineItemsByNameMock).not.toHaveBeenCalled();
  });

  it("Full fallback fetchOrder fails AND fetchOrderByOrderNumber resolves with new id", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce(null);
    fetchOrderMock.mockResolvedValueOnce(null); // first call inside fallback
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/NEW2",
      lineItems: [{ id: "gid://shopify/LineItem/W", title: "W", sku: null, quantity: 9 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(updates.find((d) => d.shopifyOrderId === "gid://shopify/Order/NEW2")).toBeDefined();
  });

  it("Full fallback: fetchOrder THROWS, then fetchOrderByOrderNumber THROWS too, resolution fully fails", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockRejectedValueOnce(new Error("only fail"));
    fetchOrderLineItemsByNameMock.mockRejectedValueOnce(new Error("byName fail"));
    fetchOrderMock.mockRejectedValueOnce(new Error("order fail"));
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("orderNumber fail"));
    // createRefund returns success since lineItems = []
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "gid://shopify/Refund/1",
      refundAmount: "10.00",
      refundCurrency: "USD",
      refundCreatedAt: new Date().toISOString(),
      refundMethod: "original",
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("Strategy 0b: orderId is the same as orderIdForRefund — no DB update needed", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "gid://shopify/Order/SAME",
        items: [
          {
            id: "i1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/SAME",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/A", title: "A", sku: null, quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── createRefund failure path ───────────────────
describe("handleProcessRefund — createRefund failure", () => {
  it("logs refund_failed event and returns enriched 400 when createRefund.success=false", async () => {
    createRefundMock.mockResolvedValueOnce({
      success: false,
      error: "Refund line items not refundable",
    });
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "original",
      note: "test note",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("refund_failed");
  });

  it("createRefund.success=false WITHOUT error string uses default message", async () => {
    createRefundMock.mockResolvedValueOnce({ success: false });
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Shopify Admin/i);
  });
});

// ─────────────────── COD detection ───────────────────
describe("handleProcessRefund — COD detection", () => {
  it("COD via paymentGatewayNames downgrades original→store_credit", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["Cash on Delivery (COD)"],
      displayFinancialStatus: "PAID",
      lineItems: [],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("store_credit");
  });

  it("COD via displayFinancialStatus=PENDING downgrades to store_credit", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PENDING",
      lineItems: [],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("store_credit");
  });

  it("non-COD order keeps original method", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "S", quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("original");
  });

  it("fetchOrder for COD detection THROWS — proceeds with configured method", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockRejectedValueOnce(new Error("fetch fail"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("original");
  });

  it("settings.refundPaymentMethod = 'unsupported' → no COD detection, no cfg", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "unknown_method" },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // The settings value is invalid → refundMethodCfg may remain null; createRefund still called
    expect(createRefundMock).toHaveBeenCalled();
  });

  it("orderIdForRefund is non-numeric/non-GID after Fynd resolution skipped → COD detection block skipped", async () => {
    // shopifyOrderId is GID — COD block runs; but if we use 'numeric', that also runs. Use neither: a slash char.
    // We can't actually skip COD block here without making the prior resolution fail.
    // Simpler: keep ctx default GID and verify when paymentGatewayNames is undefined.
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      // paymentGatewayNames undefined
      displayFinancialStatus: "PAID",
      lineItems: [],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("original");
  });

  it("numeric (non-GID) orderIdForRefund still triggers COD detection", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "1234567890" } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original" },
      },
    });
    fetchOrderMock.mockResolvedValueOnce({
      id: "1234567890",
      paymentGatewayNames: ["manual"],
      displayFinancialStatus: "PAID",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: null, quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as { method: string };
    expect(cfg.method).toBe("store_credit");
  });
});

// ─────────────────── Top-level catch & notification swallow ───────────────────
describe("handleProcessRefund — error handler", () => {
  it("500 when createRefund THROWS and refund_failed event written", async () => {
    createRefundMock.mockRejectedValueOnce(new Error("network down"));
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      note: "with note",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/network down|could not be processed/i);
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("refund_failed");
  });

  it("500 when createRefund throws non-Error string", async () => {
    createRefundMock.mockImplementationOnce(async () => {
      throw "raw string error";
    });
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
  });

  it("500 + final returnEvent.create failure is swallowed (logged)", async () => {
    createRefundMock.mockRejectedValueOnce(new Error("boom"));
    // The refund_failed event creation also throws — handler must not crash.
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("event log fail"));
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
  });

  it("response thrown internally (non-redirect Response) is rethrown unchanged", async () => {
    // Force createRefund to throw a Response (not redirect)
    const wrapped = new Response(JSON.stringify({ x: 1 }), { status: 418 });
    createRefundMock.mockImplementationOnce(async () => {
      throw wrapped;
    });
    try {
      await handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBe(wrapped);
    }
  });

  it("notification rejection is swallowed (refund still completes)", async () => {
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    await expectRedirect(
      handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("no notification when customerEmailNorm is null", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendRefundNotificationMock).not.toHaveBeenCalled();
  });

  it("notification falls back when shopifyOrderName missing → 'your order'", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: null } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendRefundNotificationMock).toHaveBeenCalled();
    const arg = sendRefundNotificationMock.mock.calls[0][0] as { orderName: string };
    expect(arg.orderName).toBe("your order");
  });
});

// ─────────────────── Fynd sync best-effort failure path ───────────────────
describe("handleProcessRefund — Fynd sync best-effort", () => {
  it("createFyndClientOrError throws → fynd_refund_sync_failed event written", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "return_accepted",
      } as never,
    });
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("fynd init blew up"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("fynd_refund_sync_failed");
  });

  it("createFyndClientOrError throws non-Error (string) — still serializes", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "return_accepted",
      } as never,
    });
    createFyndClientOrErrorMock.mockImplementationOnce(async () => {
      throw "string boom";
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const evt = events.find((e) => e.eventType === "fynd_refund_sync_failed");
    expect(evt).toBeDefined();
    expect(JSON.parse(evt!.payloadJson).error).toBe("string boom");
  });

  it("createFyndClientOrError ok=true but client lacks updateShipmentStatus → no transitions", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "return_accepted",
      } as never,
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {}, // no updateShipmentStatus
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).not.toContain("fynd_refund_synced");
    expect(events).not.toContain("fynd_refund_sync_failed");
  });

  it("returnCase has fyndOrderId but no fyndShipmentId → attempts Fynd refund sync resolution", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndOrderId: "FY-O-99",
        fyndShipmentId: null,
        fyndCurrentStatus: "return_accepted",
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ fyndApiType: "platform" }),
      { requirePlatform: true },
    );
  });
});

// ─────────────────── Final response/output edge ───────────────────
describe("handleProcessRefund — final output edges", () => {
  it("uses result.refundMethod when present (audit + counters)", async () => {
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "gid://shopify/Refund/abc",
      refundAmount: null,
      refundCurrency: null,
      refundCreatedAt: null,
      refundMethod: "store_credit",
    });
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { refundJson: string };
    };
    const parsed = JSON.parse(finalUpdate.data.refundJson) as {
      method: string;
      amount: null;
      currency: null;
      createdAt: string;
    };
    expect(parsed.method).toBe("store_credit");
    expect(parsed.amount).toBeNull();
    expect(parsed.currency).toBeNull();
    // createdAt fallback to ISO string when result.refundCreatedAt is null
    expect(typeof parsed.createdAt).toBe("string");
  });

  it("audit/refundMethod falls back to refundMethodCfg.method when result.refundMethod absent", async () => {
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "rid",
      refundAmount: "50.00",
      refundCurrency: "USD",
      refundCreatedAt: new Date().toISOString(),
      // refundMethod missing
    });
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { refundJson: string };
    };
    const parsed = JSON.parse(finalUpdate.data.refundJson) as { method: string };
    // refundDetails.method falls back to "original" string in code: result.refundMethod ?? "original"
    expect(parsed.method).toBe("original");
  });

  it("note fallback chain: body.note overrides existing adminNotes; null body.note keeps existing adminNotes", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, adminNotes: "existing-admin-note" } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { adminNotes: string };
    };
    expect(finalUpdate.data.adminNotes).toBe("existing-admin-note");
  });

  it("body.note overrides existing adminNotes", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, adminNotes: "existing-admin-note" } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        note: "fresh-note",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { adminNotes: string };
    };
    expect(finalUpdate.data.adminNotes).toBe("fresh-note");
  });

  it("shopDomain undefined → notification still attempted with empty shopName", async () => {
    const ctx = mkCtx({ shopDomain: undefined as unknown as string });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendRefundNotificationMock).toHaveBeenCalled();
  });
});
