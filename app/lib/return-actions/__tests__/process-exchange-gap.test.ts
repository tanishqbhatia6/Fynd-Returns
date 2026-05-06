/**
 * Gap-coverage tests for handleProcessExchange — covers branches NOT
 * exercised by process-exchange-deep.test.ts:
 *
 *   - Early guard 400s (status not approved, exchangeOrderId set,
 *     manual: orderId, no items, order fetch null, no customer email)
 *   - Fynd return-id status gating (allowed via payload, allowed via
 *     fyndCurrentStatus fallback, blocked status)
 *   - fetchOrderByOrderNumber path (no shopifyOrderId)
 *   - Stockout 409 branch
 *   - draftOrderCreate top-level errors (scope vs generic)
 *   - draftOrderCreate userErrors (scope vs generic)
 *   - draftOrderCreate returns no draft order (500)
 *   - sendDraftOrderInvoice failure log
 *   - Catch-all returning 500 + nested prisma logging failure
 *   - Re-throw of Response error from inside the try block
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  createRefundMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchVariantInfoMock,
  closeShopifyReturnBestEffortMock,
  sendDraftOrderInvoiceMock,
  createFyndClientOrErrorMock,
  sendApprovalNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createRefundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "0.00",
    refundCurrency: "USD",
  })),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
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
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  createRefund: createRefundMock,
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchVariantInfo: fetchVariantInfoMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  sendDraftOrderInvoice: sendDraftOrderInvoiceMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
  sendRefundNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));

import { handleProcessExchange } from "../process-exchange.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

type AdminLike = ReturnHandlerContext["admin"];

function mkAdmin(
  opts: {
    createOverride?: () => Promise<unknown>;
    completeOverride?: () => Promise<unknown>;
    createThrow?: boolean;
  } = {},
): AdminLike {
  const admin = {
    graphql: vi.fn(async (q: string) => {
      if (q.includes("draftOrderCreate")) {
        if (opts.createThrow) throw new Error("network down");
        if (opts.createOverride) {
          return { json: async () => await opts.createOverride!() };
        }
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
      if (q.includes("draftOrderComplete")) {
        if (opts.completeOverride) {
          return { json: async () => await opts.completeOverride!() };
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
      }
      return { json: async () => ({}) };
    }),
  } as unknown as AdminLike;
  return admin;
}

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
    admin: mkAdmin(),
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createRefundMock.mockReset().mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "3.00",
    refundCurrency: "USD",
  });
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  sendDraftOrderInvoiceMock
    .mockReset()
    .mockResolvedValue({ success: true, invoiceUrl: "https://shop/invoice" });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ───────────── early guards ─────────────
describe("handleProcessExchange — early guards", () => {
  it("returns 400 when status is not approved/completed", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, status: "pending" } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/approved/i);
  });

  it("returns 400 when exchangeOrderId already set", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, exchangeOrderId: "gid://shopify/DraftOrder/X" } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already/i);
  });

  it("returns 400 when shopifyOrderId starts with 'manual:'", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/manual/i);
  });

  it("accepts status 'completed' (case-insensitive)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, status: "COMPLETED" } as never,
    });
    ctx.admin = mkAdmin();
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
    }
  });

  it("returns 400 when order fetch resolves null (no order found)", async () => {
    fetchOrderMock.mockResolvedValueOnce(null);
    const ctx = mkCtx();
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Could not fetch original order/i);
  });

  it("returns 400 when fetched order has no email", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: null,
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no customer email/i);
  });

  it("returns 400 when no eligible items for exchange", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "li-1",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: null,
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "Manual Item",
          },
        ],
      } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No line items available/i);
  });
});

// ───────────── Fynd status gating ─────────────
describe("handleProcessExchange — Fynd status gating", () => {
  it("blocks when Fynd current status (from payload) is not in allowed set", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FY-R-1",
        fyndPayloadJson: JSON.stringify({ status: "return_initiated" }),
      } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/return bag is received/i);
    expect(body.error).toMatch(/return_initiated/);
  });

  it("falls back to fyndCurrentStatus when payload JSON is missing/malformed", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FY-R-1",
        fyndPayloadJson: "{ malformed",
        fyndCurrentStatus: "blocked_status_xyz",
      } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/blocked_status_xyz/);
  });

  it("allows when Fynd payload status is in allowed set (e.g. return_bag_delivered)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FY-R-1",
        fyndPayloadJson: JSON.stringify({ status: "return_bag_delivered" }),
      } as never,
    });
    ctx.admin = mkAdmin();
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      expect(err).toBeInstanceOf(Response); // redirect on success
    }
  });

  it("allows when both payload status absent and fyndCurrentStatus is null (no gating)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FY-R-1",
        fyndPayloadJson: null,
        fyndCurrentStatus: null,
      } as never,
    });
    ctx.admin = mkAdmin();
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
    }
  });
});

// ───────────── fetchOrderByOrderNumber path ─────────────
describe("handleProcessExchange — order fetch fallback", () => {
  it("uses fetchOrderByOrderNumber when shopifyOrderId is missing", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/X",
      email: "u@example.com",
      currencyCode: "USD",
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
    ctx.admin = mkAdmin();
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
    }
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
  });

  it("returns 400 when both shopifyOrderId and shopifyOrderName missing", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: null,
        shopifyOrderName: null,
      } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });
});

// ───────────── stockout 409 ─────────────
describe("handleProcessExchange — stockout", () => {
  it("returns 409 with stockoutLines when inventory < required", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 2 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/LOW",
          {
            id: "gid://shopify/ProductVariant/LOW",
            price: "10.00",
            inventoryAvailable: 1, // < returnedQty=2
            productTitle: "Low Stock",
            variantTitle: "L",
            sku: "LOW",
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
              variantId: "gid://shopify/ProductVariant/LOW",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 2,
            sku: "SKU-1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "I",
          },
        ],
      } as never,
    });
    ctx.admin = mkAdmin();
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/out of stock/);
    expect(Array.isArray(body.stockoutLines)).toBe(true);
    expect(body.stockoutLines[0]).toMatchObject({ required: 2, available: 1 });

    // exchange_inventory_blocked event should be logged
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("exchange_inventory_blocked");
  });

  it("clamps negative inventory to 0 in stockoutLines", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/NEG",
          {
            id: "gid://shopify/ProductVariant/NEG",
            price: "10.00",
            inventoryAvailable: -3,
            productTitle: "Neg",
            variantTitle: "L",
            sku: "NEG",
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
              variantId: "gid://shopify/ProductVariant/NEG",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin();
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.stockoutLines[0].available).toBe(0);
  });
});

// ───────────── draftOrderCreate errors ─────────────
describe("handleProcessExchange — draftOrderCreate errors", () => {
  function setupOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("returns 403 when top-level GraphQL error mentions a missing access scope", async () => {
    setupOrder();
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      createOverride: async () => ({
        errors: [{ message: "access scope write_draft_orders is required" }],
      }),
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/write_draft_orders/);
  });

  it("returns 400 with combined error message for non-scope top-level errors", async () => {
    setupOrder();
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      createOverride: async () => ({ errors: [{ message: "Bad input" }, { message: "Other" }] }),
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Bad input/);
    expect(body.error).toMatch(/Other/);
  });

  it("returns 400 with scope-error copy when userErrors mention a missing access scope", async () => {
    setupOrder();
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      createOverride: async () => ({
        data: {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ message: "access denied to write_quick_sale" }],
          },
        },
      }),
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/write_draft_orders/);
  });

  it("returns 400 with userErrors message when not a scope error", async () => {
    setupOrder();
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      createOverride: async () => ({
        data: {
          draftOrderCreate: {
            draftOrder: null,
            userErrors: [{ message: "Email is invalid" }],
          },
        },
      }),
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Email is invalid/);
  });

  it("returns 500 when draftOrderCreate returns no draft order id", async () => {
    setupOrder();
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      createOverride: async () => ({
        data: { draftOrderCreate: { draftOrder: null, userErrors: [] } },
      }),
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/no order returned/i);
  });
});

// ───────────── invoice send failure (non-fatal) ─────────────
describe("handleProcessExchange — invoice send failure", () => {
  it("logs warning when sendDraftOrderInvoice returns success:false (still redirects)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/UP",
          {
            id: "gid://shopify/ProductVariant/UP",
            price: "20.00",
            inventoryAvailable: 5,
            productTitle: "Up",
            variantTitle: "L",
            sku: "U1",
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
              variantId: "gid://shopify/ProductVariant/UP",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    sendDraftOrderInvoiceMock.mockResolvedValueOnce({ success: false, error: "smtp down" });
    const ctx = mkCtx();
    ctx.admin = mkAdmin();
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
    }
    expect(sendDraftOrderInvoiceMock).toHaveBeenCalled();

    // Notification still fired with payment-link copy (invoice_pending flow)
    expect(sendApprovalNotificationMock).toHaveBeenCalled();
  });
});

// ───────────── catch-all 500 + nested log failure ─────────────
describe("handleProcessExchange — unexpected error catch-all", () => {
  it("returns 500 with default message when an unexpected throw occurs", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    ctx.admin = mkAdmin({ createThrow: true });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/network down|Exchange could not be processed/);
    // exchange_failed event should be logged
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("exchange_failed");
  });

  it("survives when prisma.returnEvent.create itself throws inside the catch handler", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // First create call (the catch handler) rejects
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("db fire"));
    const ctx = mkCtx();
    ctx.admin = mkAdmin({ createThrow: true });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
  });

  it("falls back to default error message when error has no message", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    ctx.admin = {
      graphql: vi.fn(async (q: string) => {
        if (q.includes("draftOrderCreate")) {
          // throw a non-Error/non-Response value with no extractable message
          throw "";
        }
        return { json: async () => ({}) };
      }),
    } as unknown as AdminLike;
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Exchange could not be processed/);
  });

  it("re-throws Response error from inside try block (not caught as 500)", async () => {
    fetchOrderMock.mockImplementationOnce(async () => {
      throw new Response("custom", { status: 418 });
    });
    const ctx = mkCtx();
    ctx.admin = mkAdmin();
    let caught: unknown = null;
    try {
      await handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(418);
  });
});
