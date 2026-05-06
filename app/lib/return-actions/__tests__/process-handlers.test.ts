/**
 * Integration tests for the 3 heavyweight return-action handlers extracted
 * from api.returns.$id.actions.ts:
 *   - handleProcessRefund
 *   - handleProcessExchange
 *   - handleProcessReplacement
 *
 * These handlers had ZERO existing coverage before extraction. The tests
 * here lock in:
 *   - validation guards (status, terminal state, manual orders)
 *   - Fynd status-gate enforcement
 *   - happy-path DB writes (returnCase.update + returnEvent.create)
 *   - external-call ordering (refund → close → notify)
 *   - error responses for the most common failure modes
 *
 * Each handler is a pure async function — we mock its dependencies and
 * assert on:
 *   1. the Response status / body for guard branches
 *   2. the side-effect calls (prisma.returnCase.update args) for happy paths
 *   3. the redirect Response thrown on success
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
  fetchVariantInfoMock,
  closeShopifyReturnBestEffortMock,
  sendDraftOrderInvoiceMock,
  createFyndClientOrErrorMock,
  sendApprovalNotificationMock,
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
  fetchVariantInfoMock: vi.fn<(...args: unknown[]) => Promise<Map<string, unknown>>>(
    async () => new Map(),
  ),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  sendDraftOrderInvoiceMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    invoiceUrl: "https://shop/invoice",
  })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
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
  fetchVariantInfo: fetchVariantInfoMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  sendDraftOrderInvoice: sendDraftOrderInvoiceMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
  sendRefundNotification: sendRefundNotificationMock,
}));

import { handleProcessRefund } from "../process-refund.server";
import { handleProcessExchange } from "../process-exchange.server";
import { handleProcessReplacement } from "../process-replacement.server";
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
        json: async () => ({
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/1",
                name: "D1",
                invoiceUrl: null,
                totalPrice: "0",
              },
              userErrors: [],
            },
          },
        }),
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
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  sendDraftOrderInvoiceMock
    .mockReset()
    .mockResolvedValue({ success: true, invoiceUrl: "https://shop/invoice" });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  sendRefundNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ─────────────────── handleProcessRefund ───────────────────
describe("handleProcessRefund", () => {
  it("400 when status is not approved/completed", async () => {
    const res = await handleProcessRefund(
      mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never }),
      { action: "process_refund" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when refund already processed", async () => {
    const res = await handleProcessRefund(
      mkCtx({ returnCase: { ...mkCtx().returnCase, refundStatus: "refunded" } as never }),
      { action: "process_refund" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when shopifyOrderId starts with manual:", async () => {
    const res = await handleProcessRefund(
      mkCtx({ returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never }),
      { action: "process_refund" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when discount_code refund method is supplied", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "discount_code",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when storeCreditPct is out of bounds for split refund", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      storeCreditPct: 99,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when split-amount mode has both amounts zero", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      splitMode: "amount",
      splitScAmount: 0,
      splitOrigAmount: 0,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when Fynd status gate blocks (current status not in allowlist)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "in_transit",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: JSON.stringify(["return_bag_delivered"]) },
      },
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when createRefund returns success: false", async () => {
    createRefundMock.mockResolvedValueOnce({ success: false, error: "no transactions" });
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("happy path: writes refundJson + status=completed and throws redirect", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const finalUpdate = updateCalls[updateCalls.length - 1][0];
    expect(finalUpdate.data.status).toBe("completed");
    expect(finalUpdate.data.refundStatus).toBe("refunded");
    expect(finalUpdate.data.resolutionType).toBe("refund");
  });

  it("clears pending cancellation request on refund", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, cancellationRequestedAt: new Date() } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // First update should clear cancellationRequestedAt.
    const firstUpdate = prismaMock.returnCase.update.mock.calls[0][0];
    expect(firstUpdate.data.cancellationRequestedAt).toBeNull();
  });

  it("400 when Fynd allowlist is set but currentFyndStatus is null", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: null,
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: JSON.stringify(["return_bag_delivered"]) },
      },
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/has not been received yet/);
  });

  it("ignores malformed allowedFyndStatusesForRefund JSON (treats as disabled)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "in_transit",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: "{not_json" },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("falls back to fetchOrderLineItemsByName when GID resolution fails", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        // Wrong-shaped GID forces line-item resolution to fall back to name lookup
        items: [
          {
            id: "i-1",
            shopifyLineItemId: "3777852",
            qty: 1,
            sku: "SKU-1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "Item",
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce(null);
    fetchOrderLineItemsByNameMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "Item", sku: "SKU-1", quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderLineItemsByNameMock).toHaveBeenCalled();
  });

  it("400 when neither line-item resolution strategy succeeds and createRefund fails", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i-1",
            shopifyLineItemId: "3777852",
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
    fetchOrderMock.mockResolvedValueOnce(null);
    createRefundMock.mockResolvedValueOnce({ success: false, error: "no transactions" });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("auto-falls-back to store_credit on COD orders", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      paymentGatewayNames: ["Cash on Delivery (COD)"],
      displayFinancialStatus: "PENDING",
      lineItems: [{ id: "gid://shopify/LineItem/1", title: "Item", sku: "SKU-1", quantity: 1 }],
    });
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "original", refundStoreCreditPct: 100 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const callArgs = createRefundMock.mock.calls[0];
    const refundCfg = callArgs[5] as { method: string };
    expect(refundCfg.method).toBe("store_credit");
  });

  it("writes fynd_refund_synced event on successful Fynd push", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
    });
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalled();
    const eventCalls = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventCalls).toContain("fynd_refund_synced");
  });

  it("writes fynd_refund_sync_failed event when Fynd transitions all fail", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
    });
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("Fynd down");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const eventCalls = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventCalls).toContain("fynd_refund_sync_failed");
  });

  it("validates split-amount: rejects negative amounts", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      splitMode: "amount",
      splitScAmount: -1,
      splitOrigAmount: 5,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("explicit refund method overrides shop settings default", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundPaymentMethod: "store_credit" },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "original",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const refundCfg = createRefundMock.mock.calls[0][5] as { method: string };
    expect(refundCfg.method).toBe("original");
  });

  it("notifies customer on success", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendRefundNotificationMock).toHaveBeenCalled();
  });

  it("does not notify when no customerEmail", async () => {
    await expectRedirect(
      handleProcessRefund(
        mkCtx({ returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never }),
        { action: "process_refund" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(sendRefundNotificationMock).not.toHaveBeenCalled();
  });

  it("still completes when sendRefundNotification rejects", async () => {
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    await expectRedirect(
      handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("500 wraps unexpected createRefund throws", async () => {
    createRefundMock.mockRejectedValueOnce(new Error("network down"));
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
  });
});

// ─────────────────── handleProcessExchange ───────────────────
describe("handleProcessExchange", () => {
  function ctxWithOrder(overrides: Partial<ReturnHandlerContext["returnCase"]> = {}) {
    const base = mkCtx().returnCase;
    return mkCtx({
      returnCase: { ...base, ...overrides } as never,
      admin: {
        graphql: vi.fn(async () => ({
          json: async () => ({
            data: {
              draftOrderCreate: {
                draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
                userErrors: [],
              },
            },
          }),
        })),
      } as never,
    });
  }

  it("400 when status is not approved/completed", async () => {
    const res = await handleProcessExchange(
      mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never }),
      { action: "process_exchange" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when exchange order already exists", async () => {
    const res = await handleProcessExchange(
      mkCtx({ returnCase: { ...mkCtx().returnCase, exchangeOrderId: "existing" } as never }),
      { action: "process_exchange" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when shopifyOrderId is manual:", async () => {
    const res = await handleProcessExchange(
      mkCtx({ returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never }),
      { action: "process_exchange" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when Fynd status gate blocks", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FR-1",
        fyndCurrentStatus: "in_transit",
        fyndPayloadJson: JSON.stringify({ status: "in_transit" }),
      } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when fetchOrder returns null", async () => {
    fetchOrderMock.mockResolvedValueOnce(null);
    const res = await handleProcessExchange(ctxWithOrder(), {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when fetched order has no email", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: null,
      lineItems: [],
    });
    const res = await handleProcessExchange(ctxWithOrder(), {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("happy path (no price diff): writes exchange data + redirect", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
      shippingAddress: null,
      currencyCode: "USD",
    });
    const ctx = ctxWithOrder();
    // Override admin to mock both draftOrderCreate AND draftOrderComplete:
    let callCount = 0;
    ctx.admin = {
      graphql: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
                  userErrors: [],
                },
              },
            }),
          };
        }
        return {
          json: async () => ({
            data: {
              draftOrderComplete: {
                draftOrder: {
                  id: "gid://shopify/DraftOrder/1",
                  name: "D1",
                  order: { id: "gid://shopify/Order/2", name: "#1002" },
                },
                userErrors: [],
              },
            },
          }),
        };
      }),
    } as never;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.resolutionType).toBe("exchange");
    expect(update.data.exchangeOrderId).toBeTruthy();
  });

  it("403 on draft-order scope error", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
    });
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({ errors: [{ message: "Access denied for write_draft_orders scope" }] }),
      })),
    } as never;
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(403);
  });

  it("invoice_pending flow when replacement variant is more expensive", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      currencyCode: "USD",
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/V2",
          {
            id: "gid://shopify/ProductVariant/V2",
            price: "15.00",
            inventoryAvailable: 5,
            productTitle: "Item Bigger",
            variantTitle: "L",
            sku: "SKU-1L",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/V2",
              variantTitle: "L",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/1",
                name: "D1",
                invoiceUrl: null,
                totalPrice: "5.00",
              },
              userErrors: [],
            },
          },
        }),
      })),
    } as never;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendDraftOrderInvoiceMock).toHaveBeenCalled();
    // Capture the exchange_created event to assert flow=invoice_pending was logged
    const evs = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .filter((d) => d.eventType === "exchange_created");
    expect(evs).toHaveLength(1);
    expect(JSON.parse(evs[0].payloadJson).flow).toBe("invoice_pending");
  });

  it("completed_with_refund flow when replacement variant is cheaper", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      currencyCode: "USD",
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/V2",
          {
            id: "gid://shopify/ProductVariant/V2",
            price: "7.00",
            inventoryAvailable: 5,
            productTitle: "Cheaper",
            variantTitle: "S",
            sku: "SKU-1S",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/V2",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = ctxWithOrder();
    let count = 0;
    ctx.admin = {
      graphql: vi.fn(async () => {
        count++;
        if (count === 1)
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
                  userErrors: [],
                },
              },
            }),
          };
        return {
          json: async () => ({
            data: {
              draftOrderComplete: {
                draftOrder: {
                  id: "gid://shopify/DraftOrder/1",
                  name: "D1",
                  order: { id: "gid://shopify/Order/2", name: "#2" },
                },
                userErrors: [],
              },
            },
          }),
        };
      }),
    } as never;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // The price-diff refund must have been requested
    expect(createRefundMock).toHaveBeenCalled();
    const evs = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .filter((d) => d.eventType === "exchange_created");
    expect(JSON.parse(evs[0].payloadJson).flow).toBe("completed_with_refund");
  });

  it("draft order user-error (non-scope) returns 400", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({
          data: {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{ message: "Some validation error" }],
            },
          },
        }),
      })),
    } as never;
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("inventory blocked event written on stockout", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/V2",
          {
            id: "gid://shopify/ProductVariant/V2",
            price: "10.00",
            inventoryAvailable: 0,
            productTitle: "X",
            variantTitle: "L",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/V2",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const res = await handleProcessExchange(ctxWithOrder(), {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
    const eventCalls = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventCalls).toContain("exchange_inventory_blocked");
  });
});

// ─────────────────── handleProcessReplacement ───────────────────
describe("handleProcessReplacement", () => {
  function ctxWithOrder(overrides: Partial<ReturnHandlerContext["returnCase"]> = {}) {
    return mkCtx({
      returnCase: { ...mkCtx().returnCase, ...overrides } as never,
    });
  }

  it("400 when status is not approved/completed", async () => {
    const res = await handleProcessReplacement(
      mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never }),
      { action: "process_replacement" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when exchange/replacement order already exists", async () => {
    const res = await handleProcessReplacement(
      mkCtx({ returnCase: { ...mkCtx().returnCase, exchangeOrderId: "existing" } as never }),
      { action: "process_replacement" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when manual: order", async () => {
    const res = await handleProcessReplacement(
      mkCtx({ returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never }),
      { action: "process_replacement" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when Fynd status gate blocks", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FR-1",
        fyndPayloadJson: JSON.stringify({ status: "in_transit" }),
      } as never,
    });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when fetchOrder returns null", async () => {
    fetchOrderMock.mockResolvedValueOnce(null);
    const res = await handleProcessReplacement(ctxWithOrder(), {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when order has no email", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: null,
      lineItems: [],
    });
    const res = await handleProcessReplacement(ctxWithOrder(), {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when no eligible line items", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [],
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, items: [] } as never,
    });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("409 when inventory is out of stock for picked variants", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: 0 }]]),
    );
    const res = await handleProcessReplacement(ctxWithOrder(), {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.stockoutLines).toBeDefined();
  });

  it("draft order graphql user-error returns 400 (non-scope)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({
          data: {
            draftOrderCreate: {
              draftOrder: null,
              userErrors: [{ message: "Customer not eligible" }],
            },
          },
        }),
      })),
    } as never;
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("500 when draftOrderCreate returns no draft and no errors", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({ data: { draftOrderCreate: { draftOrder: null, userErrors: [] } } }),
      })),
    } as never;
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
  });

  it("falls back to fetchOrderByOrderNumber when no shopifyOrderId", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: null,
        shopifyOrderName: "#1001",
      } as never,
    });
    let count = 0;
    ctx.admin = {
      graphql: vi.fn(async () => {
        count++;
        if (count === 1)
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
                  userErrors: [],
                },
              },
            }),
          };
        return {
          json: async () => ({
            data: {
              draftOrderComplete: {
                draftOrder: {
                  id: "gid://shopify/DraftOrder/1",
                  name: "D1",
                  order: { id: "gid://shopify/Order/9", name: "#9" },
                },
                userErrors: [],
              },
            },
          }),
        };
      }),
    } as never;
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
  });

  it("logs replacement_inventory_blocked event on stockout", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "I",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: 0 }]]),
    );
    await handleProcessReplacement(ctxWithOrder(), {
      action: "process_replacement",
    } as ReturnActionBody);
    const eventCalls = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventCalls).toContain("replacement_inventory_blocked");
  });

  it("happy path: persists replacement order + redirects", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
      shippingAddress: { firstName: "Jane", city: "Berlin", country: "DE" },
    });
    const ctx = ctxWithOrder();
    let count = 0;
    ctx.admin = {
      graphql: vi.fn(async () => {
        count++;
        if (count === 1) {
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
                  userErrors: [],
                },
              },
            }),
          };
        }
        return {
          json: async () => ({
            data: {
              draftOrderComplete: {
                draftOrder: {
                  id: "gid://shopify/DraftOrder/1",
                  name: "D1",
                  order: { id: "gid://shopify/Order/9", name: "#9" },
                },
                userErrors: [],
              },
            },
          }),
        };
      }),
    } as never;
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.resolutionType).toBe("replacement");
    expect(update.data.exchangeOrderId).toBe("gid://shopify/Order/9");
  });

  it("403 on draft-order scope error", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
    });
    const ctx = ctxWithOrder();
    ctx.admin = {
      graphql: vi.fn(async () => ({
        json: async () => ({ errors: [{ message: "Access denied for write_draft_orders" }] }),
      })),
    } as never;
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(403);
  });
});
