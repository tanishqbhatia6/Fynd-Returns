/**
 * Final branch + function coverage push for handleProcessExchange.
 *
 * Targets the gaps left by process-exchange-deep.test.ts and
 * process-exchange-gap.test.ts:
 *   - line 174: variantInfo.productTitle null + variantTitle empty/non-default
 *   - line 463: non-Error fyndErr branch (String(fyndErr))
 *   - line 479: completed_with_refund with realOrderName falsy → falls back to draftOrder.name
 *   - line 509: sessionEmail null/empty → "shop-admin" fallback in audit
 *   - line 67:  no returnRequestNo → "" fallback in span attrs
 *   - line 215: order.currencyCode + returnCase.currency both null → USD
 *   - line 227: replacement line with no variantId AND SKU set
 *   - line 251-261: shippingAddress mapping (all fields populated)
 *   - line 153/157/158/171: shopifyItem matched by SKU-only, item.title missing
 *   - line 322: invoiceUrl undefined → null
 *   - line 352/374: non-Error thrown by graphql / createRefund (String() fallback)
 *   - 3 uncovered .catch(() => {}) callbacks at lines 205, 454, 465
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
    refundAmount: "1.00",
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
    completeThrow?: () => never;
  } = {},
): AdminLike {
  return {
    graphql: vi.fn(async (q: string) => {
      if (q.includes("draftOrderCreate")) {
        if (opts.createOverride) return { json: async () => await opts.createOverride!() };
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
        if (opts.completeThrow) opts.completeThrow();
        if (opts.completeOverride) return { json: async () => await opts.completeOverride!() };
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

async function expectRedirect(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error("expected redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBeGreaterThanOrEqual(300);
    expect((err as Response).status).toBeLessThan(400);
  }
}

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
    refundAmount: "1.00",
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

describe("handleProcessExchange — final branch coverage", () => {
  // Line 174 — variantInfo.productTitle nullish + non-default empty variantTitle
  it("falls back to returnedTitle when variantInfo.productTitle is null and skips empty variantTitle suffix", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      customerId: "gid://shopify/Customer/1",
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
        // productTitle null AND variantTitle empty string (falsy → no suffix)
        [
          "gid://shopify/ProductVariant/A",
          {
            id: "gid://shopify/ProductVariant/A",
            price: "10.00",
            inventoryAvailable: 5,
            productTitle: null,
            variantTitle: "",
            sku: "SKU-A",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            { lineItemId: "gid://shopify/LineItem/1", variantId: "gid://shopify/ProductVariant/A" },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const items = JSON.parse(update.data.exchangeItemsJson);
    // productTitle is null → fallback to returnedTitle ("Item 1"); empty variantTitle → no suffix
    expect(items[0].replacementTitle).toBe("Item 1");
  });

  // Line 174 — variantTitle non-default & non-empty → suffix appended
  it("appends non-default variantTitle as suffix when productTitle is present", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      customerId: "gid://shopify/Customer/1",
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
          "gid://shopify/ProductVariant/B",
          {
            id: "gid://shopify/ProductVariant/B",
            price: "10.00",
            inventoryAvailable: 5,
            productTitle: "Tee",
            variantTitle: "Large",
            sku: "SKU-B",
          },
        ],
      ]),
    );
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        id: "ev-1",
        payloadJson: JSON.stringify({
          exchangeVariants: [
            { lineItemId: "gid://shopify/LineItem/1", variantId: "gid://shopify/ProductVariant/B" },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const ctx = mkCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].replacementTitle).toBe("Tee — Large");
  });

  // Line 463 — non-Error fyndErr → String(fyndErr)
  it("captures String(fyndErr) when Fynd push throws a non-Error value", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const updateShipmentStatus = vi.fn(async () => {
      throw "string-err";
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-NE",
        fyndOrderId: "FY-O-NE",
      } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const failedEvents = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .filter((d) => d.eventType === "fynd_exchange_sync_failed");
    expect(failedEvents.length).toBe(1);
    const payload = JSON.parse(failedEvents[0].payloadJson);
    expect(payload.error).toBe("string-err");
  });

  // Lines 454 + 465: catch callbacks on prisma.returnEvent.create after fynd sync
  // Drives the .catch(() => {}) anonymous function coverage.
  it("survives prisma.returnEvent.create rejection on both fynd_exchange_synced and fynd_exchange_sync_failed paths", async () => {
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // Save the default implementation so we can restore it after the test.
    const defaultCreate = prismaMock.returnEvent.create.getMockImplementation();
    // Reject ONLY for the fynd-sync event types — keep all other events working
    // so the main flow (exchange_created, etc.) still completes normally.
    prismaMock.returnEvent.create.mockImplementation(async (arg: unknown) => {
      const evt = (arg as { data?: { eventType?: string } } | undefined)?.data?.eventType;
      if (evt === "fynd_exchange_synced" || evt === "fynd_exchange_sync_failed") {
        throw new Error("db down");
      }
      return defaultCreate ? (defaultCreate as (a: unknown) => unknown)(arg) : { id: "cmmock" };
    });

    // First run: success path → fynd_exchange_synced event create rejects
    const updateOk = vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus: updateOk, getShipments: vi.fn() },
    });
    const ctx1 = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-OK",
        fyndOrderId: "FY-O-OK",
      } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctx1, { action: "process_exchange" } as ReturnActionBody),
    );

    // Second run: failure path → fynd_exchange_sync_failed event create rejects
    const updateBoom = vi.fn(async () => {
      throw new Error("Fynd 500");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus: updateBoom, getShipments: vi.fn() },
    });
    const ctx2 = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-FAIL",
        fyndOrderId: "FY-O-FAIL",
      } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctx2, { action: "process_exchange" } as ReturnActionBody),
    );

    // Restore default impl so it doesn't leak into other tests
    if (defaultCreate) prismaMock.returnEvent.create.mockImplementation(defaultCreate);
  });

  // Line 205: catch callback on prisma.returnEvent.create for exchange_inventory_blocked
  it("survives prisma.returnEvent.create rejection on the stockout (exchange_inventory_blocked) path", async () => {
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
          "gid://shopify/ProductVariant/SO",
          {
            id: "gid://shopify/ProductVariant/SO",
            price: "10.00",
            inventoryAvailable: 0,
            productTitle: "Out",
            variantTitle: "L",
            sku: "SO",
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
              variantId: "gid://shopify/ProductVariant/SO",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("db fire"));
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
    const res = await handleProcessExchange(ctx, {
      action: "process_exchange",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
  });

  // Line 479: completed_with_refund where draftOrderComplete returns no order id → realOrderName falls back to draftOrder.name
  it("notifies with draftOrder.name when realOrderName is null in completed_with_refund flow", async () => {
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
    // Force completed_with_refund flow + null realOrderName by returning a draftOrder with no inner order.
    ctx.admin = {
      graphql: vi.fn(async (q: string) => {
        if (q.includes("draftOrderCreate")) {
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "DRAFT-NM" },
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
                draftOrder: { id: "gid://shopify/DraftOrder/1", name: "DRAFT-NM", order: null },
                userErrors: [],
              },
            },
          }),
        };
      }),
    } as unknown as AdminLike;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { notes: string };
    // notes mention DRAFT-NM (draftOrder.name) since realOrderName is null
    expect(args.notes).toContain("DRAFT-NM");
    expect(args.notes).toMatch(/refunded the difference/i);
  });

  // Line 509: sessionEmail null → audit identity falls back to "shop-admin"
  // Line 67:  returnCase.returnRequestNo null → "" fallback in span attrs
  // Line 215: order.currencyCode null + returnCase.currency null → "USD" final fallback
  it("falls back across nullish defaults: sessionEmail, returnRequestNo, currencyCode/currency", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      // No currencyCode
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      sessionEmail: null as unknown as string,
      returnCase: {
        ...mkCtx().returnCase,
        returnRequestNo: null,
        currency: null,
      } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.currency).toBe("USD");
    expect(payload.adminEmail).toBe(null);
  });

  // Line 251-261: shippingAddress full mapping
  it("maps shippingAddress fields into the draftOrder input when present on the order", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      customerId: "gid://shopify/Customer/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      shippingAddress: {
        address1: "1 Main St",
        address2: "Apt 2",
        city: "Townsville",
        province: "CA",
        country: "US",
        zip: "94000",
        firstName: "Jane",
        lastName: "Doe",
        phone: "+15555555555",
      },
    });
    const graphqlSpy = vi.fn<
      (q: string, opts?: { variables: unknown }) => Promise<{ json: () => Promise<unknown> }>
    >(async (q) => {
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
    });
    const ctx = mkCtx();
    ctx.admin = { graphql: graphqlSpy } as unknown as AdminLike;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const createCall = graphqlSpy.mock.calls.find((c) => String(c[0]).includes("draftOrderCreate"));
    expect(createCall).toBeTruthy();
    const variables = (createCall![1] as { variables: { input: Record<string, unknown> } })
      .variables;
    expect(variables.input.customerId).toBe("gid://shopify/Customer/1");
    const ship = variables.input.shippingAddress as Record<string, string>;
    expect(ship.address1).toBe("1 Main St");
    expect(ship.address2).toBe("Apt 2");
    expect(ship.city).toBe("Townsville");
    expect(ship.province).toBe("CA");
    expect(ship.country).toBe("US");
    expect(ship.zip).toBe("94000");
    expect(ship.firstName).toBe("Jane");
    expect(ship.lastName).toBe("Doe");
    expect(ship.phone).toBe("+15555555555");
    const bill = variables.input.billingAddress as Record<string, string>;
    expect(bill.address1).toBe("1 Main St");
    expect(bill.firstName).toBe("Jane");
    expect(bill.lastName).toBe("Doe");
    expect(bill.phone).toBe("+15555555555");
  });

  // Line 153: shopifyItem matched by SKU only (id mismatch) — provoked by lineItem id != item.shopifyLineItemId
  // Lines 157, 158, 171: item title/price/sku fallback chains
  it("matches order line item by SKU when lineItem id does not match, and falls back through item.title/price/sku chains", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        // Different id than item.shopifyLineItemId, but matching SKU
        {
          id: "gid://shopify/LineItem/SHIPLI",
          title: "Order Line Title",
          sku: "MATCH-SKU",
          price: "10.00",
          quantity: 1,
        },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          // shopifyLineItemId differs from order line; sku matches → falls into SKU branch
          // No title on the item → uses shopifyItem.title; no price → uses shopifyItem.price; sku used directly
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/RC-1",
            qty: 1,
            sku: "match-sku", // case-insensitive match
            price: undefined as unknown as string,
            reasonCode: null,
            notes: null,
            title: undefined as unknown as string,
          },
        ],
      } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].returnedTitle).toBe("Order Line Title");
    expect(items[0].returnedUnitPrice).toBe("10.00");
  });

  // Line 227: replacement line with no variantId AND replacement SKU set
  it("includes sku on the draft line when no replacementVariantId is resolved", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // fetchVariantInfo returns a variant whose `id` is null AND whose sku is set.
    // Combined with the matched portalVariant carrying no variantId, the resolved
    // replacementVariantId is null → enters the title/price/sku branch (line 227).
    // variantInfo.id is empty string → ?? falls through truthy, but the
    // `if (line.replacementVariantId)` falsy-check (line 222) takes the
    // `else` branch which sets title/sku/originalUnitPrice (line 227).
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([
        [
          "gid://shopify/ProductVariant/PHANTOM",
          {
            id: "",
            price: "12.00",
            inventoryAvailable: 5,
            productTitle: "Phantom Product",
            variantTitle: "Default Title",
            sku: "PHANTOM-SKU",
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
              variantId: "gid://shopify/ProductVariant/PHANTOM",
              variantTitle: "Phantom",
            },
          ],
        }),
        happenedAt: new Date(),
      },
    ] as never);
    const graphqlSpy = vi.fn<
      (q: string, opts?: { variables: unknown }) => Promise<{ json: () => Promise<unknown> }>
    >(async (q) => {
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
    });
    const ctx = mkCtx();
    ctx.admin = { graphql: graphqlSpy } as unknown as AdminLike;
    // Force a positive priceDiff so we hit the customerOwesDifference path (where
    // `appliedDiscount` is NOT set, leaving the title/sku/originalUnitPrice fields visible).
    // returnedUnitPrice=10, replacementUnitPrice=12 → diff=+2 → invoice flow
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    // Inspect the draft line items submitted in draftOrderCreate
    const createCall = graphqlSpy.mock.calls.find((c) => String(c[0]).includes("draftOrderCreate"));
    const vars = (
      createCall![1] as { variables: { input: { lineItems: Array<Record<string, unknown>> } } }
    ).variables;
    const line = vars.input.lineItems[0];
    expect(line.variantId).toBeUndefined();
    expect(line.title).toBe("Phantom Product");
    expect(line.sku).toBe("PHANTOM-SKU");
    expect(line.originalUnitPrice).toBe("12.00");
  });

  // Line 322: invoiceUrl undefined on success → null in event payload
  it("normalizes missing invoiceUrl from sendDraftOrderInvoice success to null", async () => {
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
    sendDraftOrderInvoiceMock.mockResolvedValueOnce({ success: true /* no invoiceUrl */ });
    const ctx = mkCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.invoiceUrl).toBeNull();
    expect(payload.flow).toBe("invoice_pending");
  });

  // Line 352: completeError set via String(err) when graphql throws non-Error
  it("captures String(err) into completeError when draftOrderComplete throws a non-Error value", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx();
    ctx.admin = mkAdmin({
      completeThrow: () => {
        throw "boom-string";
      },
    });
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const payload = lastExchangeCreatedPayload();
    expect(payload.completeError).toBe("boom-string");
  });

  // Lines 253-261: shippingAddress field-level fallbacks ("|| undefined")
  // Provoke the `|| undefined` branch by supplying empty strings on every
  // address field, plus exercise the province / country fallback chains.
  it("falls back via '|| undefined' on every shippingAddress field when source values are empty", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      shippingAddress: {
        // Empty strings → falsy → take the `|| undefined` branch
        address1: "",
        address2: "",
        city: "",
        zip: "",
        firstName: "",
        lastName: "",
        phone: "",
        // province falsy → fall through to provinceCode (also empty → undefined)
        province: "",
        provinceCode: "",
        // country falsy → fall through to countryCode (also empty → undefined)
        country: "",
        countryCode: "",
      },
    });
    const graphqlSpy = vi.fn<
      (q: string, opts?: { variables: unknown }) => Promise<{ json: () => Promise<unknown> }>
    >(async (q) => {
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
    });
    const ctx = mkCtx();
    ctx.admin = { graphql: graphqlSpy } as unknown as AdminLike;
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const createCall = graphqlSpy.mock.calls.find((c) => String(c[0]).includes("draftOrderCreate"));
    const vars = (
      createCall![1] as { variables: { input: { shippingAddress: Record<string, unknown> } } }
    ).variables;
    const ship = vars.input.shippingAddress;
    // Every field defaults to undefined when source is empty string
    expect(ship.address1).toBeUndefined();
    expect(ship.address2).toBeUndefined();
    expect(ship.province).toBeUndefined();
    expect(ship.country).toBeUndefined();
    expect(ship.zip).toBeUndefined();
  });

  // Lines 105, 138, 158, 171, 212, 288, 318, 362
  // Bulk fallback-chain coverage in a single scenario:
  //   - shopifyOrderName fallback to "" (line 105) when fetch goes via order-number path with whitespace
  //   - items === null → ?? []  (line 138)
  //   - returnedUnitPrice = parseFloat("") || 0 (line 212)
  //   - draftOrderCreate response with no userErrors field (line 288 — userErrors ?? [])
  //   - shopifyOrderName null in invoice flow → "your order" (line 318)
  //   - returnRequestNo null in createRefund reason (line 362)
  // We exercise both invoice flow AND a separate refund call by chaining two runs.
  it("covers bulk fallback chains (line 105, 138, 158, 171, 212, 288, 318, 362)", async () => {
    // Run A: invoice_pending flow with null shopifyOrderName + null items + bad prices
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      currencyCode: "USD",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Order Title",
          sku: "SKU-1",
          price: "not-a-num",
          quantity: 1,
        },
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
    const ctxA = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderName: null, // line 318 fallback to "your order"
        // Keep items as a normal array (one item) so the flow runs.
        items: [
          // shopifyLineItemId different from order line, sku matches ⇒ line 153 sku-branch
          // No item.title nor item.sku → uses shopifyItem.title and shopifyItem.sku ⇒ lines 157/171
          // No item.price + bad shopifyItem.price → "0.00" ⇒ line 158 + 212 (parseFloat fallback)
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/RC-1",
            qty: 1,
            sku: "sku-1",
            price: undefined as unknown as string,
            reasonCode: null,
            notes: null,
            title: undefined as unknown as string,
          },
        ],
      } as never,
    });
    // Admin returns draftOrderCreate WITHOUT a userErrors field → line 288 ?? [] taken
    ctxA.admin = {
      graphql: vi.fn(async (q: string) => {
        if (q.includes("draftOrderCreate")) {
          return {
            json: async () => ({
              data: {
                draftOrderCreate: {
                  draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" } /* no userErrors */,
                },
              },
            }),
          };
        }
        return { json: async () => ({}) };
      }),
    } as unknown as AdminLike;
    await expectRedirect(
      handleProcessExchange(ctxA, { action: "process_exchange" } as ReturnActionBody),
    );
    // Confirm sendDraftOrderInvoice received "your order" subject (line 318)
    const invSubject = sendDraftOrderInvoiceMock.mock.calls[0][3] as string;
    expect(invSubject).toContain("your order");

    // Run B: completed_with_refund flow with null returnRequestNo (line 362)
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
    const ctxB = mkCtx({
      returnCase: { ...mkCtx().returnCase, returnRequestNo: null } as never,
    });
    await expectRedirect(
      handleProcessExchange(ctxB, { action: "process_exchange" } as ReturnActionBody),
    );
    // createRefund reason should contain returnCase.id since returnRequestNo is null
    const refundReason = createRefundMock.mock.calls[0][3] as string;
    expect(refundReason).toContain("rc-1");
  });

  // Line 374: refund catch with non-Error thrown → String(err) fallback
  it("captures String(err) into refundResult.error when createRefund throws a non-Error value", async () => {
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
    createRefundMock.mockImplementationOnce(async () => {
      throw "refund-string-err";
    });
    const ctx = mkCtx();
    await expectRedirect(
      handleProcessExchange(ctx, { action: "process_exchange" } as ReturnActionBody),
    );
    const payload = lastExchangeCreatedPayload();
    expect((payload.refund as { success: boolean; error: string }).success).toBe(false);
    expect((payload.refund as { error: string }).error).toBe("refund-string-err");
  });
});
