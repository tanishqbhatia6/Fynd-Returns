/**
 * Final-mile branch coverage closers for the eight return-action handlers.
 *
 * Targets specific uncovered branches identified from `coverage-final.json`
 * after running the existing test suite. Each test exercises one or more
 * remaining `b[]` indexes and is documented inline.
 *
 * No source modifications. Each describe block scopes mocks to a single
 * source file — coordinate is preserved by `vi.resetModules` between
 * blocks so the module-level import binds to the right mock.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

// ───────────────────────────────────────────────────────────────────
// Shared hoisted mocks
// ───────────────────────────────────────────────────────────────────
const {
  prismaMock,
  // shopify-admin
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByNameMock,
  fetchVariantInfoMock,
  closeShopifyReturnBestEffortMock,
  createShopifyReturnMock,
  createRefundMock,
  sendDraftOrderInvoiceMock,
  // fynd
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  // notifications
  sendApprovalNotificationMock,
  sendRefundNotificationMock,
  sendRejectionNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  fetchOrderMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByFyndAffiliateIdMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderLineItemsOnlyMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderLineItemsByNameMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  fetchVariantInfoMock: vi.fn<(...a: unknown[]) => Promise<Map<string, unknown>>>(async () => new Map()),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  createShopifyReturnMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ success: true, shopifyReturnId: "gid://shopify/Return/1" })),
  createRefundMock: vi.fn<(...a: unknown[]) => Promise<any>>(async () => ({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "10.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
  })),
  sendDraftOrderInvoiceMock: vi.fn<(...a: unknown[]) => Promise<any>>(async () => ({ success: true, invoiceUrl: "https://invoice/x" })),
  createFyndClientOrErrorMock: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  createReturnOnFyndMock: vi.fn<(...a: unknown[]) => Promise<any>>(async () => ({ success: true, fyndReturnId: "FYR-1" })),
  sendApprovalNotificationMock: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRefundNotificationMock: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRejectionNotificationMock: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnly: fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByName: fetchOrderLineItemsByNameMock,
  fetchVariantInfo: fetchVariantInfoMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  createShopifyReturn: createShopifyReturnMock,
  createRefund: createRefundMock,
  sendDraftOrderInvoice: sendDraftOrderInvoiceMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
  sendRefundNotification: sendRefundNotificationMock,
  sendRejectionNotification: sendRejectionNotificationMock,
}));

import { handleProcessReplacement } from "../process-replacement.server";
import { handleProcessExchange } from "../process-exchange.server";
import { handleProcessRefund } from "../process-refund.server";
import { handleApprove } from "../approve.server";
import { handleCancelOrder } from "../cancel-order.server";
import { handleRefreshFyndDetails } from "../refresh-fynd-details.server";
import { handleRetryFyndSync } from "../retry-fynd-sync.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const DRAFT_OK = {
  data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1", invoiceUrl: null, totalPrice: "0" }, userErrors: [] } },
};
const COMPLETE_OK = {
  data: { draftOrderComplete: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1", order: { id: "gid://shopify/Order/9", name: "#9" } }, userErrors: [] } },
};

function mkAdmin(createRes: unknown, completeRes: unknown): ReturnHandlerContext["admin"] {
  let n = 0;
  return {
    graphql: vi.fn(async () => {
      n++;
      return { json: async () => (n === 1 ? createRes : completeRes) };
    }),
  } as never;
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

function baseRC(extra: Record<string, unknown> = {}) {
  return {
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
      { id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1, sku: "SKU-1", price: "10.00", reasonCode: null, notes: null, title: "Item 1" },
    ],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    customerAddress1: null,
    customerAddress2: null,
    customerCity: null,
    customerProvince: null,
    customerZip: null,
    customerCountry: null,
    customerLandmark: null,
    customerName: null,
    ...extra,
  };
}

function mkCtx(rc: Record<string, unknown> = {}, ctxOverrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: baseRC(rc) as never,
    shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: { fyndApiType: "platform" } },
    admin: { graphql: vi.fn(async () => ({ json: async () => DRAFT_OK })) } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
    ...ctxOverrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  fetchOrderLineItemsOnlyMock.mockReset().mockResolvedValue(null);
  fetchOrderLineItemsByNameMock.mockReset().mockResolvedValue(null);
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createShopifyReturnMock.mockReset().mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1" });
  createRefundMock.mockReset().mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "10.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
  });
  sendDraftOrderInvoiceMock.mockReset().mockResolvedValue({ success: true, invoiceUrl: "https://invoice/x" });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  createReturnOnFyndMock.mockReset().mockResolvedValue({ success: true, fyndReturnId: "FYR-1" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  sendRefundNotificationMock.mockReset().mockResolvedValue(undefined);
  sendRejectionNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────
// process-replacement: residual branches
// ─────────────────────────────────────────────
describe("process-replacement final branches", () => {
  it("falls back to fetchOrderByOrderNumber when shopifyOrderId is null (line 82-84)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({ shopifyOrderId: null }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalled();
  });

  it("returns 400 when both shopifyOrderId and shopifyOrderName are null (line 82-84 false:false)", async () => {
    const ctx = mkCtx({ shopifyOrderId: null, shopifyOrderName: null });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Could not fetch original order");
  });

  it("returns 400 when fetched order has no email (line 91-95)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: null,
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const res = await handleProcessReplacement(
      mkCtx(),
      { action: "process_replacement" } as ReturnActionBody,
    ) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no customer email");
  });

  it("returns 400 when no line items remain after filter (manual-only items)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({
      items: [
        { id: "li-m", shopifyLineItemId: "manual", qty: 1, sku: "M", price: "5", reasonCode: null, notes: null, title: "M" },
      ],
    });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No line items available");
  });
});

// ─────────────────────────────────────────────
// process-exchange: residual branches
// ─────────────────────────────────────────────
describe("process-exchange final branches", () => {
  it("uses fetchOrderByOrderNumber when shopifyOrderId is null (line 105)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({ shopifyOrderId: null }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalled();
  });

  it("returns 400 when no usable line items (manual-only) (line 138-143)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({
      items: [{ id: "li-m", shopifyLineItemId: "manual", qty: 1, sku: "M", price: "5", reasonCode: null, notes: null, title: "M" }],
    });
    const res = await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No line items available");
  });

  it("falls back to item.sku for title when shopifyItem.title and item.title absent (line 157-158, 171)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      // No matching shopify item — so shopifyItem is undefined
      lineItems: [],
    });
    const ctx = mkCtx({
      items: [{ id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/X", qty: 1, sku: "SKUONLY", price: null, reasonCode: null, notes: null, title: null }],
    }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // Confirm exchangeItemsJson contains SKUONLY as title fallback
    const update = prismaMock.returnCase.update.mock.calls[0][0] as { data: { exchangeItemsJson: string } };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].returnedTitle).toBe("SKUONLY");
  });

  it("ultimate title fallback to 'Item' when no title/sku at all", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [],
    });
    const ctx = mkCtx({
      items: [{ id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/X", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null }],
    }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as { data: { exchangeItemsJson: string } };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].returnedTitle).toBe("Item");
  });
});

// ─────────────────────────────────────────────
// process-refund: residual branches
// ─────────────────────────────────────────────
describe("process-refund final branches", () => {
  it("applyResolvedOrder: matched-by-SKU branch when shopifyOrder.lineItems exist (line 124-140)", async () => {
    // orderIdForRefund is non-GID/non-numeric so resolution flow runs
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/A", name: "#A",
      lineItems: [
        { id: "gid://shopify/LineItem/100", sku: "SKU-1", quantity: 2 },
        { id: "gid://shopify/LineItem/101", sku: "OTHER", quantity: 1 },
      ],
    });
    const ctx = mkCtx({ shopifyOrderId: "FYND-AFF-1" });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // createRefund called with matched line items (only SKU-1 match)
    const args = createRefundMock.mock.calls[0];
    const lineItems = args[2] as Array<{ id: string; quantity: number }>;
    expect(lineItems.some((li) => li.id === "gid://shopify/LineItem/100")).toBe(true);
  });

  it("applyResolvedOrder: SKU match falls through to capped fallback when zero matches (line 141-144)", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/A", name: "#A",
      lineItems: [
        { id: "gid://shopify/LineItem/100", sku: "DIFF-1", quantity: 2 },
        { id: "gid://shopify/LineItem/101", sku: "DIFF-2", quantity: 1 },
      ],
    });
    const ctx = mkCtx({ shopifyOrderId: "FYND-AFF-2" });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = createRefundMock.mock.calls[0];
    const lineItems = args[2] as Array<{ id: string; quantity: number }>;
    // No SKU matched → fallback distributes the customer's actual return qty
    // across line items (never the full ordered qty). Sum stays at total
    // return qty, so we may end up with 1 item taking the entire qty.
    const totalQty = lineItems.reduce((s, li) => s + li.quantity, 0);
    expect(totalQty).toBeLessThanOrEqual(2);
    expect(lineItems.length).toBeGreaterThanOrEqual(1);
  });

  it("applyResolvedOrder: no item.sku → uses all shopify lineItems (line 145-147)", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/A", name: "#A",
      lineItems: [{ id: "gid://shopify/LineItem/100", sku: "X", quantity: 1 }],
    });
    const ctx = mkCtx({
      shopifyOrderId: "FYND-AFF-3",
      items: [{ id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/Y", qty: 1, sku: null, price: "10", reasonCode: null, notes: null, title: "I" }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = createRefundMock.mock.calls[0];
    const lineItems = args[2] as Array<{ id: string; quantity: number }>;
    expect(lineItems[0].id).toBe("gid://shopify/LineItem/100");
  });

  it("PCDA-safe: minimalOrder via fetchOrderLineItemsByName when fetchOrderLineItemsOnly null (line 253-266)", async () => {
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/X", name: "#X",
      lineItems: [{ id: "gid://shopify/LineItem/77", title: "T", sku: "SKU-1", quantity: 1 }],
    });
    // Force lineItemsForRefund.length === 0 by giving items without GID-shaped ids
    const ctx = mkCtx({
      items: [{ id: "li-1", shopifyLineItemId: "non-gid-99", qty: 1, sku: "SKU-1", price: "10", reasonCode: null, notes: null, title: "I" }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderLineItemsByNameMock).toHaveBeenCalled();
  });

  it("COD detection: switches original→store_credit when gateway is COD-like (line 366-374)", async () => {
    // Need refundMethodCfg from settings (not body), and orderId to be GID
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["Cash on Delivery"],
      displayFinancialStatus: "PAID",
    });
    const ctx = mkCtx({}, {
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", refundPaymentMethod: "original" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund", refundMethod: undefined } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // createRefund called with method "store_credit" because COD downgrade
    const args = createRefundMock.mock.calls[0];
    const cfg = args[5] as { method?: string } | null;
    expect(cfg?.method).toBe("store_credit");
  });

  it("bonus credit: bodyBonusAmount overrides settings calc when bonusCreditEnabled (line 379-380)", async () => {
    const ctx = mkCtx({}, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", bonusCreditEnabled: true, refundPaymentMethod: "store_credit" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund", bonusAmount: 5.5 } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = createRefundMock.mock.calls[0];
    const opts = args[6] as { bonusAmount?: number };
    expect(opts.bonusAmount).toBe(5.5);
  });

  it("Fynd refund sync: writes fynd_refund_synced when transitions succeed (line 498-510)", async () => {
    const updateShipmentStatus = vi.fn(async () => undefined);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({ fyndShipmentId: "SH-1", fyndOrderId: "FY-O-1", fyndCurrentStatus: "return_bag_delivered" });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map((c) => (c[0] as any).data.eventType);
    expect(eventTypes).toContain("fynd_refund_synced");
  });

  it("Fynd refund sync: per-transition error captured in failedTransitions (line 491-495, 512-523)", async () => {
    const updateShipmentStatus = vi.fn(async () => { throw new Error("transition rejected"); });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({ fyndShipmentId: "SH-2", fyndOrderId: "FY-O-2", fyndCurrentStatus: "return_bag_delivered" });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map((c) => (c[0] as any).data.eventType);
    expect(eventTypes).toContain("fynd_refund_sync_failed");
  });

  it("outer catch swallows secondary returnEvent.create rejection (line 575-577)", async () => {
    // Primary failure inside try → goes to catch
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("primary"));
    // Secondary: refund_failed write also throws
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("secondary"));
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("primary");
  });
});

// ─────────────────────────────────────────────
// approve: residual branches
// ─────────────────────────────────────────────
describe("approve final branches", () => {
  it("uses 'shop-admin' fallback identity when sessionEmail is null (line 290)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF-1" });
    const ctx = mkCtx({ status: "pending" }, { sessionEmail: null });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("affiliateOrderId fetch swallows order-fetch error (line 157-159)", async () => {
    fetchOrderMock.mockRejectedValueOnce(new Error("order fetch boom"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as any,
    });
    const ctx = mkCtx({ status: "pending" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("uses fetchOrderByOrderNumber when shopifyOrderId is null (line 154-155)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF-Z" });
    // Need Fynd client with getShipments to enter the affiliateOrderId-fetch block
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as any,
    });
    const ctx = mkCtx({ status: "pending", shopifyOrderId: null });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalled();
  });

  it("validResolutionTypes: invalid bodyResolutionType falls back to 'refund' (line 216-217)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({ status: "pending" });
    await expectRedirect(
      handleApprove(ctx, { action: "approve", resolutionType: "garbage" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const upd = prismaMock.returnCase.updateMany.mock.calls[0][0] as any;
    expect(upd.data.resolutionType).toBe("refund");
  });

  it("notification rejection swallowed in main approve flow (line 388-391)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    sendApprovalNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const ctx = mkCtx({ status: "pending" });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────────────────────────────────
// cancel-order: residual branches
// ─────────────────────────────────────────────
describe("cancel-order final branches", () => {
  it("returns 400 when orderId is non-numeric/non-GID and shopifyOrderName is null (line 49-55)", async () => {
    const ctx = mkCtx({ shopifyOrderId: "not-a-gid", shopifyOrderName: null }, {
      admin: { graphql: vi.fn(async () => ({ json: async () => ({ data: { orderCancel: { orderCancelUserErrors: [] } } }) })) } as never,
    });
    const res = await handleCancelOrder(ctx, { action: "cancel_order" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Could not resolve");
  });

  it("resolves shopifyOrderId via fetchOrderByOrderNumber when not GID/numeric (line 49-57)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/55" });
    const ctx = mkCtx({ shopifyOrderId: "fynd-aff-x" }, {
      admin: { graphql: vi.fn(async () => ({ json: async () => ({ data: { orderCancel: { orderCancelUserErrors: [] } } }) })) } as never,
    });
    await expectRedirect(
      handleCancelOrder(ctx, { action: "cancel_order" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// refresh-fynd-details: residual branches
// ─────────────────────────────────────────────
describe("refresh-fynd-details final branches", () => {
  it("getShipments returns object with .items shape (line 60-62)", async () => {
    const getShipments = vi.fn(async () => ({ items: [{ shipment_id: "S1" }] }));
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ shipment_id: "S1", journey_type: "return", status: "return_bag_delivered" }],
      orderId: "FY-O-1",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId, getShipments } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });

  it("getShipments returns nested .shipments shape with empty list (line 62, 71)", async () => {
    const getShipments = vi.fn(async () => ({ shipments: [] }));
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ journey_type: "return" }],
      orderId: "FY-O-2",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId, getShipments } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });

  it("returnShipment with carrier+awb populates returnLogisticsData (line 80-101)", async () => {
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{
        journey_type: "return",
        delivery_partner_details: { display_name: "BlueDart", awb_no: "AWB-1" },
        invoice: { label_url: "https://lbl", invoice_url: "https://inv" },
        tracking_url: "https://tr",
      }],
      orderId: "FY-O-3",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId } as any, // no getShipments → skip line 56-70
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const upd = prismaMock.returnCase.update.mock.calls[0][0] as any;
    expect(upd.data.returnLabelJson).toBeDefined();
    expect(upd.data.returnAwb).toBe("AWB-1");
  });
});

// ─────────────────────────────────────────────
// retry-fynd-sync: residual branches
// ─────────────────────────────────────────────
describe("retry-fynd-sync final branches", () => {
  it("uses fetchOrderByOrderNumber when shopifyOrderId is null (line 60-62)", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF-X" });
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments } as any,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-2", fyndShipmentId: "FSH-2" });
    const ctx = mkCtx({ shopifyOrderId: null });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalled();
  });

  it("pickup address built from city when address1 is null (line 69-79)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments } as any,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-3" });
    const ctx = mkCtx({ customerCity: "NYC" });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    // pickupAddress passed in second argument's options
    const opts = createReturnOnFyndMock.mock.calls[0][2] as any;
    expect(opts.pickupAddress).not.toBeNull();
    expect(opts.pickupAddress.city).toBe("NYC");
  });

  it("alreadyExists: redirects with 'already_exists' (line 194)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments } as any,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, alreadyExists: true, fyndReturnId: "FYR-EX" });
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=already_exists",
    );
  });

  it("failure path with fyndResult.error empty: uses fallback message (line 197-199)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments } as any,
    });
    // fyndResult.success false with no fyndReturnId/fyndShipmentId/alreadyExists, error empty
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "" });
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map((c) => (c[0] as any).data.eventType);
    expect(eventTypes).toContain("fynd_sync_failed");
  });

  it("createShopifyReturn crash inside try block is swallowed (line 182-184)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments } as any,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-7", fyndShipmentId: "FSH-7" });
    createShopifyReturnMock.mockRejectedValueOnce(new Error("shopify create burned"));
    // shopifyReturnId null → goes into createShopifyReturn block
    const ctx = mkCtx({ shopifyReturnId: null });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });
});

// ─────────────────────────────────────────────
// Round 2: residual branch closures
// ─────────────────────────────────────────────
describe("process-replacement extra branches", () => {
  it("stockout: blocks when inventory below required quantity (line 130-152)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{
        id: "gid://shopify/LineItem/1", title: "Item 1", sku: "SKU-1",
        price: "10.00", quantity: 1,
        variantId: "gid://shopify/ProductVariant/V1",
      }],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(new Map<string, any>([
      ["gid://shopify/ProductVariant/V1", { id: "gid://shopify/ProductVariant/V1", inventoryAvailable: 0 }],
    ]));
    const ctx = mkCtx({}, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("out of stock");
  });

  it("matches shopify lineItem by SKU lowercase fallback (line 100-103)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/Z", title: "Z", sku: "sku-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      items: [{ id: "li-1", shopifyLineItemId: "DIFFERENT", qty: 1, sku: "SKU-1", price: "10", reasonCode: null, notes: null, title: "I" }],
    }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("draftOrderCreate userErrors with scope error returns 403", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const errorAdmin = {
      graphql: vi.fn(async () => ({ json: async () => ({
        errors: [{ message: "access scope write_draft_orders is required" }],
      }) })),
    } as never;
    const ctx = mkCtx({}, { admin: errorAdmin });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(403);
  });

  it("draftOrderCreate userErrors path (non-scope) returns 400", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const errorAdmin = {
      graphql: vi.fn(async () => ({ json: async () => ({
        data: { draftOrderCreate: { draftOrder: null, userErrors: [{ message: "Invalid input" }] } },
      }) })),
    } as never;
    const ctx = mkCtx({}, { admin: errorAdmin });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
  });

  it("draftOrderComplete error captured (line 254-256)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const completeErrorRes = {
      data: { draftOrderComplete: { draftOrder: null, userErrors: [{ message: "Cannot complete" }] } },
    };
    const ctx = mkCtx({}, { admin: mkAdmin(DRAFT_OK, completeErrorRes) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("fyndPayloadJson with disallowed status blocks (line 66-77)", async () => {
    const ctx = mkCtx({
      fyndReturnId: "FYR",
      fyndPayloadJson: JSON.stringify({ status: "shipment_created" }),
    });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Replacement order can only");
  });
});

describe("process-refund extra branches", () => {
  it("returns 400 when refundStatus already 'refunded' (line 53-55)", async () => {
    const ctx = mkCtx({ refundStatus: "refunded" });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("already been processed");
  });

  it("manual: order returns helpful error (line 57-63)", async () => {
    const ctx = mkCtx({ shopifyOrderId: "manual:#42", shopifyOrderName: "#42" });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("manual return");
  });

  it("Fynd allowed-statuses: blocks when current status not allowed (line 85-99)", async () => {
    const ctx = mkCtx({
      fyndOrderId: "FY-1",
      fyndCurrentStatus: "pending",
    }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", allowedFyndStatusesForRefund: JSON.stringify(["return_completed"]) },
      } as never,
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not in the allowed list");
  });

  it("Fynd allowed-statuses: blocks when status missing (line 87-91)", async () => {
    const ctx = mkCtx({
      fyndOrderId: "FY-1",
      fyndCurrentStatus: null,
    }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", allowedFyndStatusesForRefund: JSON.stringify(["return_completed"]) },
      } as never,
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("status has not been received");
  });

  it("body refundMethod=both with invalid pct returns 400 (line 328-333)", async () => {
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund", refundMethod: "both", storeCreditPct: 1 } as any) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Store credit percentage");
  });

  it("body refundMethod=both with split amount=0/0 returns 400 (line 343-345)", async () => {
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund", refundMethod: "both", splitMode: "amount", splitScAmount: 0, splitOrigAmount: 0 } as any) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("greater than zero");
  });

  it("body refundMethod=discount_code returns 400", async () => {
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund", refundMethod: "discount_code" } as any) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no longer supported");
  });

  it("createRefund failure returns enriched error (line 399-407)", async () => {
    createRefundMock.mockResolvedValueOnce({ success: false, error: "Shopify rejected" });
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Shopify rejected");
  });

  it("non-resolved fyndy order id (resolution all strategies fail)", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    const ctx = mkCtx({
      shopifyOrderId: "fynd-aff-no-match",
      fyndPayloadJson: JSON.stringify({ items: [{ affiliate_order_id: "candidate" }] }),
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("could not be found in Shopify");
  });

  it("clears cancellationRequestedAt when set (line 65-69)", async () => {
    const ctx = mkCtx({ cancellationRequestedAt: new Date("2026-01-01") });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => (c[0] as any).data);
    expect(updates.some((u) => u.cancellationRequestedAt === null)).toBe(true);
  });

  it("bonus credit: settings-driven calculation when no body bonus (line 381-388)", async () => {
    const ctx = mkCtx({
      items: [
        { id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/1", qty: 2, sku: "SKU-1", price: "20.00", reasonCode: null, notes: null, title: "I1" },
      ],
    }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", bonusCreditEnabled: true, bonusCreditPct: 10, refundPaymentMethod: "store_credit" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = createRefundMock.mock.calls[0];
    const opts = args[6] as { bonusAmount?: number };
    expect(opts.bonusAmount).toBeGreaterThan(0); // 20*2*0.1 = 4
  });

  it("malformed allowedFyndStatusesForRefund json is treated as disabled (line 76-82 catch)", async () => {
    const ctx = mkCtx({ fyndOrderId: "FY-1" }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", allowedFyndStatusesForRefund: "{not-json" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

describe("refresh-fynd extra branches", () => {
  it("returns redirect with error when shopifyOrderName is empty (line 19-23)", async () => {
    const ctx = mkCtx({ shopifyOrderName: null });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("returns redirect with error when fynd client not configured (line 26-32)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "not configured" });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("returns redirect when client missing searchShipmentsByExternalOrderId (line 35-39)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { foo: vi.fn() } as any, // no searchShipmentsByExternalOrderId
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when no items found (line 51-53 inner catch)", async () => {
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({ items: [] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("getShipments throws — falls through gracefully (line 67-69)", async () => {
    const getShipments = vi.fn(async () => { throw new Error("boom"); });
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ shipment_id: "S1", journey_type: "forward" }],
      orderId: "FY-O-99",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId, getShipments } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });
});

describe("retry-fynd-sync extra branches", () => {
  it("returns 400 when status not approved/completed (line 22-24)", async () => {
    const ctx = mkCtx({ status: "pending" });
    const res = await handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
  });

  it("redirects to already_synced when fyndReturnId set and not failed (line 28-32)", async () => {
    const ctx = mkCtx({ fyndReturnId: "FYR-EXIST", fyndSyncStatus: "synced" });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "already_synced",
    );
  });

  it("returns redirect when fynd not configured (line 40-45)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("returns redirect when client missing getShipments (line 47-52)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { foo: vi.fn() } as any });
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("createReturnOnFynd throws — caught and reported as crash (line 82-110)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("network down"));
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map((c) => (c[0] as any).data.eventType);
    expect(eventTypes).toContain("fynd_sync_failed");
  });

  it("manual: order skips fetchOrder block (line 59-64)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-M" });
    const ctx = mkCtx({ shopifyOrderId: "manual:#1" });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(fetchOrderMock).not.toHaveBeenCalled();
  });
});

describe("approve extra branches", () => {
  it("isTerminal returns 400 (line 37-39)", async () => {
    const ctx = mkCtx({ status: "completed" }, { isTerminal: true });
    const res = await handleApprove(ctx, { action: "approve" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
  });

  it("idempotent path when updateMany returns count=0 (line 265-267)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 0 });
    const ctx = mkCtx({ status: "pending" });
    const res = await handleApprove(ctx, { action: "approve" } as ReturnActionBody) as Response;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotent).toBe(true);
  });

  it("consolidation flow: redirects with consolidationQueued=1 (line 58-134)", async () => {
    prismaMock.returnCase.update.mockResolvedValueOnce({ id: "rc-1" });
    const ctx = mkCtx({ status: "pending" }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
  });

  it("greenReturn: skips fynd sync (line 140-141)", async () => {
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({ status: "pending", isGreenReturn: true });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("fynd sync error: createReturnOnFynd returns error (line 191-196)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF" });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments: vi.fn() } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "Fynd rejected" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({ status: "pending" });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("fynd client lacks getShipments: surface platform-required error (line 204-208)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { foo: vi.fn() } as any });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({ status: "pending" });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
  });
});

// ─────────────────────────────────────────────
// Round 3: nullish-coalesce / OR-fallback branch closures
// Many remaining `branch_idx=1` are RHS of `||` / `??` short-circuits
// activated only when the LHS is falsy.
// ─────────────────────────────────────────────
describe("nullish/OR fallback branches", () => {
  it("approve: returnRequestNo='', items=null, customerName=null hits fallback branches", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: null });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments: vi.fn() } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-A", fyndReturnNo: null, fyndPayload: null });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({
      status: "pending",
      returnRequestNo: "", // empty triggers || fallback
      items: null,         // null triggers ?? [] fallback
      shopifyOrderName: null, // empty triggers || "your order"
      customerEmailNorm: null, // skips notification block
      customerName: null,
      customerAddress1: "1 Main St", // truthy → enters pickupAddress block
      customerAddress2: null,
      customerCity: null,
      customerProvince: null,
      customerZip: null,
      customerCountry: null,
      customerLandmark: null,
      customerPhoneNorm: null,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("approve: fyndReturnId truthy + sessionEmail null → 'shop-admin' fallback (line 290 etc)", async () => {
    fetchOrderMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: "AFF-X" });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments: vi.fn() } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-B" });
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    const ctx = mkCtx({ status: "pending" }, { sessionEmail: null });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("cancel-order: shopifyOrderName=null fallback path inside non-numeric resolution (line 49-50)", async () => {
    // shopifyOrderId is non-GID/non-numeric AND name is null → triggers null branch on `replace` and resolution fails
    const ctx = mkCtx({ shopifyOrderId: "fy-aff", shopifyOrderName: null }, {
      admin: { graphql: vi.fn(async () => ({ json: async () => ({ data: { orderCancel: { orderCancelUserErrors: [] } } }) })) } as never,
    });
    const res = await handleCancelOrder(ctx, { action: "cancel_order" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
  });

  it("process-replacement: items=null hits ?? [] fallback (line 97)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [],
    });
    const ctx = mkCtx({ items: null });
    const res = await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody) as Response;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No line items");
  });

  it("process-replacement: shopifyOrderName=null when shopifyOrderId set hits replace-fallback (line 159)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({ shopifyOrderName: null }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("process-replacement: empty fyndPayloadJson with parse error covered (line 69)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    const ctx = mkCtx({ fyndReturnId: "FYR", fyndPayloadJson: "{not-json" }, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("retry-fynd-sync: shopifyOrderName=null fallback (line 62)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-N" });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/1", affiliateOrderId: null });
    const ctx = mkCtx({ shopifyOrderId: null, shopifyOrderName: null });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("retry-fynd-sync: pickupAddress includes nullable fields on fallback (line 72-79)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-AD" });
    const ctx = mkCtx({
      customerAddress1: null,
      customerAddress2: "Apt", // both nulls except some
      customerCity: "BLR",
      customerProvince: null,
      customerZip: null,
      customerCountry: null,
      customerLandmark: null,
      customerName: null,
      customerPhoneNorm: null,
    });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("retry-fynd-sync: success without fyndReturnId but alreadyExists+payload error (line 124-126, 143)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    // alreadyExists path with no fyndReturnId/fyndShipmentId
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      alreadyExists: true,
      fyndReturnId: null,
      fyndShipmentId: null,
      fyndReturnNo: null,
      fyndOrderId: null,
      fyndPayload: { circ: {} } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=already_exists",
    );
  });

  it("refresh-fynd: getShipments with circular payload triggers JSON.stringify caught? — covers line 60-71", async () => {
    const getShipments = vi.fn(async () => null); // returns null, fullShipments != null is false
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ shipment_id: "S1" }],
      orderId: "FY-O-X",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId, getShipments } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });

  it("refresh-fynd: getShipments with empty list keeps original payload (line 62-66 fullList.length === 0)", async () => {
    const getShipments = vi.fn(async () => ({ items: [] }));
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ shipment_id: "S1" }],
      orderId: "FY-O-Y",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId, getShipments } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });

  it("refresh-fynd: returnShipment with only invoice_url filled (line 90)", async () => {
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{
        journey_type: "return",
        invoice: { invoice_url: "https://invoice", links: { invoice_a4: "" } },
      }],
      orderId: "FY-O-Z",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId } as any,
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });

  it("process-refund: lineItem reduce with no price hits || 0 (line 382)", async () => {
    const ctx = mkCtx({
      items: [
        { id: "li-1", shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1, sku: "SKU-1", price: null, reasonCode: null, notes: null, title: "I" },
      ],
    }, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", bonusCreditEnabled: true, bonusCreditPct: 10, refundPaymentMethod: "store_credit" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("process-refund: refundCounter+amount with refundAmount empty/no method (line 547, 551)", async () => {
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: null,
      refundAmount: null,    // line 551 falsy
      refundCurrency: null,
      refundCreatedAt: null, // line 418 fallback
      refundMethod: null,    // line 547 fallback
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("process-refund: outer catch with non-Error err (line 564 'rawMessage empty' fallback)", async () => {
    // Force an inner failure that produces empty extracted message
    prismaMock.returnCase.update.mockRejectedValueOnce(""); // string '' → extractErrorMessage returns ''
    const ctx = mkCtx();
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody) as Response;
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("could not be processed");
  });

  it("process-refund: COD detection negative path (gateway not COD) (line 366-374)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["Stripe"],
      displayFinancialStatus: "PAID",
    });
    const ctx = mkCtx({}, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", refundPaymentMethod: "original" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = createRefundMock.mock.calls[0];
    const cfg = args[5] as { method?: string };
    expect(cfg?.method).toBe("original"); // not downgraded
  });

  it("process-refund: settings refundPaymentMethod 'invalid' is not used (line 362)", async () => {
    const ctx = mkCtx({}, {
      shop: {
        id: "shop-1", shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", refundPaymentMethod: "garbage_method" },
      } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("process-refund: empty returnRequestNo + empty shopifyOrderName + null adminNotes fallbacks", async () => {
    const ctx = mkCtx({
      returnRequestNo: "",
      shopifyOrderName: "",
      adminNotes: null,
      customerEmailNorm: null, // skip notification branch
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund", note: null } as any),
      "/app/returns/rc-1",
    );
  });

  it("process-replacement: empty returnRequestNo + empty shopifyOrderName fallbacks (line 159, 220)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    // userErrors=undefined → ?? [] fallback (line 220)
    const customAdmin = {
      graphql: vi.fn(async (q: string) => {
        if (q.includes("draftOrderCreate")) {
          return { json: async () => ({ data: { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" } /* userErrors absent */ } } }) };
        }
        return { json: async () => COMPLETE_OK };
      }),
    } as never;
    const ctx = mkCtx({
      returnRequestNo: "",
      shopifyOrderName: "",
      customerEmailNorm: null,
    }, { admin: customAdmin });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("process-replacement: realOrderId set → success email uses realOrderName (line 350-351)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1", email: "u@example.com",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "T", sku: "SKU-1", price: "10.00", quantity: 1 }],
    });
    // sendApprovalNotification will receive notes referring to realOrderName
    sendApprovalNotificationMock.mockResolvedValueOnce(undefined);
    const ctx = mkCtx({}, { admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const arg = sendApprovalNotificationMock.mock.calls[0]?.[0] as any;
    expect(arg?.notes).toContain("#9"); // realOrderName from COMPLETE_OK
  });

  it("retry-fynd-sync: empty returnRequestNo + neither orderId nor name (line 17, 62)", async () => {
    const getShipments = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { getShipments } as any });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FYR-NN" });
    const ctx = mkCtx({ returnRequestNo: "", shopifyOrderId: null, shopifyOrderName: null });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("refresh-fynd: empty returnRequestNo (line 14) + null fyndOrderId (line 106)", async () => {
    const searchShipmentsByExternalOrderId = vi.fn(async () => ({
      items: [{ shipment_id: "S1", journey_type: "return" }],
      // no orderId/shipmentId → fyndOrderId stays null → line 106 condition false
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId } as any,
    });
    const ctx = mkCtx({ returnRequestNo: "" });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndRefresh=1",
    );
  });
});
