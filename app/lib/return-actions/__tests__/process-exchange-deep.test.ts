/**
 * Deeper branch-coverage tests for handleProcessExchange.
 *
 * Complements process-handlers.test.ts by drilling into branches that
 * the higher-level integration tests do not exercise:
 *
 *   - portalVariants extraction from returnEvent.payloadJson (multi-event,
 *     malformed JSON, missing key, empty array, picks newest first)
 *   - fetchVariantInfo gating on `gid://shopify/ProductVariant/` prefix
 *   - multi-line price-diff arithmetic (mixed up/down deltas, qty>1,
 *     non-numeric prices, currency fallback)
 *   - completed_with_refund retry — createRefund throwing vs.
 *     returning success:false
 *   - draftOrderComplete error branches: graphql throw, top-level errors,
 *     userErrors all swallowed (downstream still proceeds)
 *   - Fynd transition push success + failure on the success path
 *   - customer notification copy by flow (invoice_pending /
 *     completed_with_refund / completed_free) + missing email skip
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
    refundAmount: "3.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
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

/**
 * Build an admin GraphQL mock that serves draftOrderCreate then
 * draftOrderComplete in order. Behaviours can be overridden per-call.
 */
function mkAdmin(
  opts: {
    createOverride?: () => Promise<unknown>;
    completeOverride?: () => Promise<unknown>;
  } = {},
): { admin: AdminLike; calls: { create: number; complete: number } } {
  const calls = { create: 0, complete: 0 };
  const admin = {
    graphql: vi.fn(async (q: string) => {
      if (q.includes("draftOrderCreate")) {
        calls.create++;
        if (opts.createOverride) {
          return { json: async () => await opts.createOverride!() };
        }
        return {
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
        };
      }
      if (q.includes("draftOrderComplete")) {
        calls.complete++;
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
  return { admin, calls };
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
    admin: mkAdmin().admin,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, frag: string): Promise<void> {
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

/** Convenience: extract the most recent exchange_created event payload. */
function lastExchangeCreatedPayload(): Record<string, unknown> {
  const evs = prismaMock.returnEvent.create.mock.calls
    .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
    .filter((d) => d.eventType === "exchange_created");
  expect(evs.length).toBeGreaterThan(0);
  return JSON.parse(evs[evs.length - 1].payloadJson);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createRefundMock.mockReset().mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/1",
    refundAmount: "3.00",
    refundCurrency: "USD",
    refundCreatedAt: new Date().toISOString(),
    refundMethod: "original",
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

// ───────────── portalVariants extraction ─────────────
describe("handleProcessExchange — portalVariants extraction", () => {
  function baseOrder() {
    return {
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      currencyCode: "USD",
    };
  }

  it("picks the newest event with a non-empty exchangeVariants array", async () => {
    fetchOrderMock.mockResolvedValueOnce(baseOrder());
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/V_NEW",
          {
            id: "gid://shopify/ProductVariant/V_NEW",
            price: "10.00",
            inventoryAvailable: 5,
            productTitle: "New",
            variantTitle: "Default Title",
            sku: "SKU-NEW",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-newest",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/V_NEW",
            },
          ],
        }),
        happenedAt: new Date(),
      },
      {
        id: "ev-older",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/V_OLD",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    const adminMock = mkAdmin();
    ctx.admin = adminMock.admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // Confirm we fetched the newest variant id only
    expect(fetchVariantInfoMock).toHaveBeenCalledWith(expect.anything(), [
      "gid://shopify/ProductVariant/V_NEW",
    ]);
  });

  it("skips events without payloadJson and malformed JSON, falls through to legacy path", async () => {
    fetchOrderMock.mockResolvedValueOnce(baseOrder());
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      { id: "ev-1", payloadJson: null, happenedAt: new Date() },
      { id: "ev-2", payloadJson: "{ not_json", happenedAt: new Date() },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // No variant prefix-matching ids => fetchVariantInfo never called
    expect(fetchVariantInfoMock).not.toHaveBeenCalled();
  });

  it("skips event whose exchangeVariants is an empty array (legacy fall-through)", async () => {
    fetchOrderMock.mockResolvedValueOnce(baseOrder());
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-empty",
        payloadJson: JSON.stringify({ exchangeVariants: [] }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchVariantInfoMock).not.toHaveBeenCalled();
  });

  it("ignores events lacking the exchangeVariants key", async () => {
    fetchOrderMock.mockResolvedValueOnce(baseOrder());
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      { id: "ev-1", payloadJson: JSON.stringify({ unrelated: true }), happenedAt: new Date() },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchVariantInfoMock).not.toHaveBeenCalled();
  });

  it("recovers when prisma.returnEvent.findMany rejects (non-fatal)", async () => {
    fetchOrderMock.mockResolvedValueOnce(baseOrder());
    prismaMock.returnEvent.findMany.mockRejectedValueOnce(new Error("db down"));
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ───────────── variant info fetching ─────────────
describe("handleProcessExchange — variant info fetching", () => {
  it("filters non-GID-prefixed variant ids before calling fetchVariantInfo", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            { lineItemId: "gid://shopify/LineItem/1", variantId: "12345" }, // numeric — skip
            { lineItemId: "gid://shopify/LineItem/1", variantId: "gid://shopify/Product/Bad" }, // wrong type — skip
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchVariantInfoMock).not.toHaveBeenCalled();
  });

  it("uses raw variantId when fetchVariantInfo returns no entry", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(new Map()); // resolves empty
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/1",
              variantId: "gid://shopify/ProductVariant/MISSING",
              variantTitle: "Custom Title",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.variantIdsResolved).toBe(1);
  });

  it("matches by index when portalVariants length matches returnedItems count and lineItemId is missing", async () => {
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
          "gid://shopify/ProductVariant/IDX",
          {
            id: "gid://shopify/ProductVariant/IDX",
            price: "11.00",
            inventoryAvailable: 5,
            productTitle: "Idx Match",
            variantTitle: "Default Title",
            sku: "SKU-IDX",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          // No lineItemId — should match by index
          exchangeVariants: [{ variantId: "gid://shopify/ProductVariant/IDX" }],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.variantIdsResolved).toBe(1);
  });

  it("strips ' — Default Title' suffix from replacement title", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/X",
          {
            id: "gid://shopify/ProductVariant/X",
            price: "10.00",
            inventoryAvailable: 5,
            productTitle: "Cool Tee",
            variantTitle: "Default Title",
            sku: "SKU-X",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            { lineItemId: "gid://shopify/LineItem/1", variantId: "gid://shopify/ProductVariant/X" },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].replacementTitle).toBe("Cool Tee");
  });
});

// ───────────── multi-line price-diff calculation ─────────────
describe("handleProcessExchange — multi-line price diff", () => {
  it("sums mixed up/down deltas across lines (qty>1) producing positive net diff", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "A", sku: "A1", price: "10.00", quantity: 2 },
        { id: "gid://shopify/LineItem/2", title: "B", sku: "B1", price: "20.00", quantity: 1 },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/A2",
          {
            id: "gid://shopify/ProductVariant/A2",
            price: "12.00",
            inventoryAvailable: 10,
            productTitle: "A bigger",
            variantTitle: "L",
            sku: "A2",
          },
        ],
        [
          "gid://shopify/ProductVariant/B2",
          {
            id: "gid://shopify/ProductVariant/B2",
            price: "15.00",
            inventoryAvailable: 10,
            productTitle: "B smaller",
            variantTitle: "S",
            sku: "B2",
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
              variantId: "gid://shopify/ProductVariant/A2",
            },
            {
              lineItemId: "gid://shopify/LineItem/2",
              variantId: "gid://shopify/ProductVariant/B2",
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
            sku: "A1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "A",
          },
          {
            id: "li-2",
            shopifyLineItemId: "gid://shopify/LineItem/2",
            qty: 1,
            sku: "B1",
            price: "20.00",
            reasonCode: null,
            notes: null,
            title: "B",
          },
        ],
      } as never,
    });
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // returned subtotal = 10*2 + 20*1 = 40
    // replacement subtotal = 12*2 + 15*1 = 39
    // diff = -1 → completed_with_refund flow (refund of 1.00)
    const payload = lastExchangeCreatedPayload();
    expect(payload.priceDiff).toBe(-1);
    expect(payload.flow).toBe("completed_with_refund");
  });

  it("treats non-numeric replacement price as 0 in subtotal sum", async () => {
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
          "gid://shopify/ProductVariant/V",
          {
            id: "gid://shopify/ProductVariant/V",
            price: "not-a-number",
            inventoryAvailable: 5,
            productTitle: "P",
            variantTitle: "L",
            sku: "V",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            { lineItemId: "gid://shopify/LineItem/1", variantId: "gid://shopify/ProductVariant/V" },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    // returned subtotal=10, replacement subtotal=0 → diff=-10
    expect(payload.priceDiff).toBe(-10);
  });

  it("uses returnCase.currency when order has no currencyCode", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, currency: "INR" } as never,
    });
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.currency).toBe("INR");
  });

  it("price-diff exactly 0 → completed_free flow (no refund call)", async () => {
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
          "gid://shopify/ProductVariant/SAME",
          {
            id: "gid://shopify/ProductVariant/SAME",
            price: "10.00",
            inventoryAvailable: 5,
            productTitle: "Same",
            variantTitle: "Default Title",
            sku: "S1",
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
              variantId: "gid://shopify/ProductVariant/SAME",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(sendDraftOrderInvoiceMock).not.toHaveBeenCalled();
    const payload = lastExchangeCreatedPayload();
    expect(payload.flow).toBe("completed_free");
    expect(payload.priceDiff).toBe(0);
  });
});

// ───────────── completed_with_refund retry behaviour ─────────────
describe("handleProcessExchange — completed_with_refund branch", () => {
  function setupRefundCtx(): ReturnHandlerContext {
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
          "gid://shopify/ProductVariant/CHEAP",
          {
            id: "gid://shopify/ProductVariant/CHEAP",
            price: "7.00",
            inventoryAvailable: 5,
            productTitle: "Cheap",
            variantTitle: "S",
            sku: "C1",
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
              variantId: "gid://shopify/ProductVariant/CHEAP",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    return ctx;
  }

  it("calls createRefund with absolute price-diff", async () => {
    const ctx = setupRefundCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createRefundMock).toHaveBeenCalledTimes(1);
    const callArgs = createRefundMock.mock.calls[0];
    // 7th arg is the options object with transactionAmount
    const cfg = callArgs[6] as { transactionAmount: number; skipLocation: boolean };
    expect(cfg.skipLocation).toBe(true);
    expect(cfg.transactionAmount).toBe(3); // |7-10|
  });

  it("captures success:false from createRefund into refund event payload (still redirects)", async () => {
    createRefundMock.mockResolvedValueOnce({ success: false, error: "no transactions to refund" });
    const ctx = setupRefundCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.flow).toBe("completed_with_refund");
    expect((payload.refund as { success: boolean }).success).toBe(false);
    expect((payload.refund as { error: string }).error).toBe("no transactions to refund");
  });

  it("captures createRefund throw into refund event payload (still redirects)", async () => {
    createRefundMock.mockRejectedValueOnce(new Error("network down"));
    const ctx = setupRefundCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect((payload.refund as { success: boolean; error: string }).success).toBe(false);
    expect((payload.refund as { error: string }).error).toBe("network down");
  });

  it("skips createRefund when shopifyOrderId is manual:", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // manual: orders are blocked early — but verify guard triggers a 400 (defensive).
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never,
    });
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
    expect(createRefundMock).not.toHaveBeenCalled();
  });
});

// ───────────── draftOrderComplete error swallowing ─────────────
describe("handleProcessExchange — draftOrderComplete error handling", () => {
  function setupCompletedFreeCtx(opts: {
    completeOverride?: () => Promise<unknown>;
    completeThrow?: boolean;
  }): ReturnHandlerContext {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    if (opts.completeThrow) {
      ctx.admin = {
        graphql: vi.fn(async (q: string) => {
          if (q.includes("draftOrderCreate")) {
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
          throw new Error("graphql network down");
        }),
      } as unknown as AdminLike;
    } else {
      ctx.admin = mkAdmin({ completeOverride: opts.completeOverride }).admin;
    }
    return ctx;
  }

  it("swallows top-level GraphQL errors during draftOrderComplete and still redirects", async () => {
    const ctx = setupCompletedFreeCtx({
      completeOverride: async () => ({ errors: [{ message: "Shopify down" }] }),
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.completeError).toBe("Shopify down");
    // Falls back to the draft order id/name
    expect(payload.orderId).toBeNull();
    expect(payload.flow).toBe("completed_free");
  });

  it("swallows userErrors from draftOrderComplete", async () => {
    const ctx = setupCompletedFreeCtx({
      completeOverride: async () => ({
        data: {
          draftOrderComplete: { draftOrder: null, userErrors: [{ message: "Cannot complete" }] },
        },
      }),
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.completeError).toBe("Cannot complete");
  });

  it("swallows graphql throw during draftOrderComplete (caught at try/catch)", async () => {
    const ctx = setupCompletedFreeCtx({ completeThrow: true });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.completeError).toBe("graphql network down");
  });

  it("falls back to draft id/name when complete returns no order", async () => {
    const ctx = setupCompletedFreeCtx({
      completeOverride: async () => ({
        data: {
          draftOrderComplete: {
            draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1", order: null },
            userErrors: [],
          },
        },
      }),
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.exchangeOrderId).toBe("gid://shopify/DraftOrder/1");
    expect(update.data.exchangeOrderName).toBe("D1");
  });
});

// ───────────── Fynd transition push on success ─────────────
describe("handleProcessExchange — Fynd transition push", () => {
  function setupForFyndPush(fyndShipmentId: string | null): ReturnHandlerContext {
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
        fyndShipmentId,
        fyndOrderId: "FY-O-1",
        fyndReturnId: null,
      } as never,
    });
    ctx.admin = mkAdmin().admin;
    return ctx;
  }

  it("writes fynd_exchange_synced event on successful platform-client push", async () => {
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = setupForFyndPush("SH-1");
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith(
      "FY-O-1",
      expect.objectContaining({
        statuses: [{ shipments: [{ identifier: "SH-1" }], status: "return_completed" }],
        task: false,
        force_transition: false,
      }),
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("fynd_exchange_synced");
  });

  it("writes fynd_exchange_sync_failed event when updateShipmentStatus throws", async () => {
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("Fynd down");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = setupForFyndPush("SH-2");
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).toContain("fynd_exchange_sync_failed");
  });

  it("falls back to fyndShipmentId when fyndOrderId is missing", async () => {
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
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
        fyndShipmentId: "SH-3",
        fyndOrderId: null,
      } as never,
    });
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith("SH-3", expect.anything());
  });

  it("does not call createFyndClientOrError when fyndShipmentId is null", async () => {
    const ctx = setupForFyndPush(null);
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("skips Fynd push when client factory returns ok:false (still redirects)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "disabled" });
    const ctx = setupForFyndPush("SH-9");
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(events).not.toContain("fynd_exchange_synced");
    expect(events).not.toContain("fynd_exchange_sync_failed");
  });
});

// ───────────── customer notification per flow ─────────────
describe("handleProcessExchange — customer notification copy", () => {
  it("invoice_pending: notifies with payment-link copy", async () => {
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
            price: "15.00",
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
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalled();
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { notes: string };
    expect(args.notes).toMatch(/payment link/i);
    expect(args.notes).toMatch(/5\.00 USD/);
  });

  it("completed_with_refund: notifies with refund copy", async () => {
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
          "gid://shopify/ProductVariant/DOWN",
          {
            id: "gid://shopify/ProductVariant/DOWN",
            price: "7.00",
            inventoryAvailable: 5,
            productTitle: "Down",
            variantTitle: "S",
            sku: "D1",
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
              variantId: "gid://shopify/ProductVariant/DOWN",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { notes: string };
    expect(args.notes).toMatch(/refunded the difference/i);
    expect(args.notes).toMatch(/3\.00 USD/);
  });

  it("completed_free: notifies with no-additional-charge copy", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { notes: string };
    expect(args.notes).toMatch(/no additional charge/i);
  });

  it("skips notification when customerEmailNorm is null", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never,
    });
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendApprovalNotificationMock).not.toHaveBeenCalled();
  });

  it("still redirects when sendApprovalNotification throws", async () => {
    sendApprovalNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("uses returnCase.shopifyOrderName as the order label, falls back to 'your order' when missing", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: null } as never,
    });
    ctx.admin = mkAdmin().admin;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { orderName: string };
    expect(args.orderName).toBe("your order");
  });
});
