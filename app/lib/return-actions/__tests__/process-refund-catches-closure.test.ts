/**
 * Closure tests for process-refund.server.ts — targets the remaining uncov
 * anonymous fns (mostly `.catch(() => {})` callbacks on fire-and-forget
 * prisma writes) at lines 290, 330, 547, 559, 572, 579, plus line-132
 * statement (fallbackByReturnQty zero-totalReturnQty branch).
 *
 * Each test forces the underlying promise to reject so the catch handler
 * fires, then asserts the action still completes successfully.
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
  fetchOrderByFyndAffiliateIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderLineItemsOnlyMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderLineItemsByNameMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  sendRefundNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
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
      customerEmailNorm: null,
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
        { id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1, sku: "SKU-1", price: "10.00", reasonCode: null, notes: null, title: "Item 1" },
      ],
    } as never,
    shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: { fyndApiType: "platform" } },
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

describe("process-refund closure — uncov anon fns", () => {
  // ─── Line 132: fallbackByReturnQty totalReturnQty <= 0 branch ───
  // returnItems all have qty=0 → totalReturnQty=0 → executes the
  // `shopifyLineItems.map((li) => ({ id: li.id, quantity: li.quantity }))`
  // arrow at line 132. Reached via the empty lineItemsForRefund path that
  // falls through to fetchOrder full → applyResolvedOrder skips SKU match
  // (returnItems all have qty 0 still trigger fallback).
  it("line 132: fallbackByReturnQty returns shopifyLineItems untouched when totalReturnQty=0", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        // empty lineItemsForRefund (manual ids stripped) → triggers the
        // PCDA-safe fetch block at line 268+.
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 0, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    // PCDA-safe fetchOrderLineItemsOnly returns lineItems with qty>0 → goes
    // through "minimalOrder?.lineItems?.length" branch. returnItems is non-
    // empty but no SKU set on any → falls into `fallbackByReturnQty(...)`
    // at line 311 with returnItems whose qty=0 each → totalReturnQty=0 →
    // line-132 map executes.
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [
        { id: "gid://shopify/LineItem/A", title: "A", sku: null, quantity: 3 },
        { id: "gid://shopify/LineItem/B", title: "B", sku: null, quantity: 2 },
      ],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // Should have refunded with both line items at their original quantities
    expect(createRefundMock).toHaveBeenCalled();
    const args = createRefundMock.mock.calls[0];
    expect(args[2]).toEqual([
      { id: "gid://shopify/LineItem/A", quantity: 3 },
      { id: "gid://shopify/LineItem/B", quantity: 2 },
    ]);
  });

  // ─── Line 290: empty lineItems → fetchOrderLineItemsByName resolves new id → update.catch ───
  it("line 290: swallows rejection on shopifyOrderId update after fetchOrderLineItemsByName resolution", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "gid://shopify/Order/OLD",
        shopifyOrderName: "#1001",
        items: [
          // empty lineItems triggers PCDA-safe fetch path at line 268+
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    // fetchOrderLineItemsOnly returns null → falls through to byName branch.
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/NEW", // different id → triggers update at line 290
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/X", title: "X", sku: null, quantity: 1 }],
    });
    // Make returnCase.update reject — this is the line-290 catch we target.
    // (Earlier update calls — for cancellationRequestedAt etc — are skipped
    // since cancellationRequestedAt is null in the fixture.)
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("line-290 update boom"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // The orderIdForRefund should have been swapped to the NEW id.
    expect(createRefundMock).toHaveBeenCalled();
    expect(createRefundMock.mock.calls[0][1]).toBe("gid://shopify/Order/NEW");
  });

  // ─── Line 330: empty lineItems → fetchOrderByOrderNumber resolves new id → update.catch ───
  it("line 330: swallows rejection on shopifyOrderId update after fetchOrderByOrderNumber resolution", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "gid://shopify/Order/OLD",
        shopifyOrderName: "#1001",
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    // PCDA-safe paths return null and minimalOrder remains null → enters
    // the else block at line 314+ that calls fetchOrder + fetchOrderByOrderNumber.
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce(null);
    fetchOrderMock.mockResolvedValueOnce(null);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/NUMBER", // different id → triggers update at 330
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/Y", quantity: 1 }],
    });
    // Force the line-330 update.catch to fire.
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("line-330 update boom"));
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createRefundMock).toHaveBeenCalled();
    expect(createRefundMock.mock.calls[0][1]).toBe("gid://shopify/Order/NUMBER");
  });

  // ─── Line 547 + 559: successful Fynd transitions → status update + event catch ───
  it("lines 547 + 559: swallow rejections on fyndCurrentStatus update + fynd_refund_synced event", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
    });
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    // After main returnCase.update + returnEvent.create (which we want to
    // succeed for the refund flow), force the next returnCase.update — the
    // line-547 fyndCurrentStatus update — to reject. Same for the
    // fynd_refund_synced event create.
    // Track which call we're on: there's one returnCase.update (refunded
    // status) BEFORE the line-547 one. We need the SECOND update to reject.
    let updateCall = 0;
    prismaMock.returnCase.update.mockImplementation(async (arg) => {
      updateCall++;
      if (updateCall === 2) {
        // line-547 fyndCurrentStatus update
        throw new Error("line-547 update boom");
      }
      const a = arg as { where?: unknown; data?: unknown };
      return { ...(a.where as object), ...(a.data as object) };
    });
    // returnEvent.create: refund_processed succeeds, fynd_refund_synced fails.
    let evtCall = 0;
    prismaMock.returnEvent.create.mockImplementation(async (arg) => {
      evtCall++;
      const data = (arg as { data: { eventType: string } }).data;
      if (data.eventType === "fynd_refund_synced") {
        throw new Error("line-559 event boom");
      }
      return { id: `evt-${evtCall}`, ...data };
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalled();
  });

  // ─── Line 572: all transitions failed → fynd_refund_sync_failed event catch ───
  it("line 572: swallows rejection on fynd_refund_sync_failed event when all transitions failed", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
    });
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("Fynd 500");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    // returnEvent.create: refund_processed succeeds, fynd_refund_sync_failed
    // fails (line-572 catch path).
    prismaMock.returnEvent.create.mockImplementation(async (arg) => {
      const data = (arg as { data: { eventType: string } }).data;
      if (data.eventType === "fynd_refund_sync_failed") {
        throw new Error("line-572 event boom");
      }
      return { id: "evt", ...data };
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledTimes(2); // both transitions tried
  });

  // ─── Line 579: outer catch — createFyndClientOrError throws → returnEvent.create catch ───
  it("line 579: swallows rejection on outer-catch fynd_refund_sync_failed returnEvent.create", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
    });
    // Force the outer try block at line 484 to throw (createFyndClientOrError
    // rejects) → enters catch at line 575 → returnEvent.create at 577 rejects
    // → line-579 .catch(() => {}) fires.
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("fynd client boom"));
    prismaMock.returnEvent.create.mockImplementation(async (arg) => {
      const data = (arg as { data: { eventType: string } }).data;
      if (data.eventType === "fynd_refund_sync_failed") {
        throw new Error("line-579 event boom");
      }
      return { id: "evt", ...data };
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});
