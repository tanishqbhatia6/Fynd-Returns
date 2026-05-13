/**
 * Deeper branch-coverage tests for handleProcessRefund.
 *
 * Complements process-handlers.test.ts by targeting under-covered branches:
 *   - bonus credit calculation paths (explicit, auto-calc, disabled, no prices)
 *   - refund method = "both" splits in BOTH percentage and amount modes
 *   - location requirement skipping on green returns
 *   - Fynd allowlist with multiple allowed statuses (positive + negative)
 *   - line-item resolution Strategy 0 (PCDA-safe GID), 0b (PCDA-safe name),
 *     and full-fetchOrder fallback
 *   - Fynd transition partial-failure (subset failed) — must still log
 *     fynd_refund_synced but include partialFailures
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

// ─────────────────── Bonus credit calculation paths ───────────────────
describe("handleProcessRefund — bonus credit", () => {
  it("uses explicit body bonusAmount when provided and feature enabled", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true, bonusCreditPct: 10 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
        bonusAmount: 7.5,
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(7.5);
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { bonusCreditAmount?: string };
    };
    expect(finalUpdate.data.bonusCreditAmount).toBe("7.50");
  });

  it("auto-calculates bonus from item price when method=store_credit and no explicit amount", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 2,
            sku: "S",
            price: "25.00",
            reasonCode: null,
            notes: null,
            title: "T",
          },
        ],
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true, bonusCreditPct: 20 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // 2 * 25 = 50; 20% = 10.00
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(10);
  });

  it("auto-calculates bonus when method=both", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: "S",
            price: "100.00",
            reasonCode: null,
            notes: null,
            title: "T",
          },
        ],
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true, bonusCreditPct: 15 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "both",
        storeCreditPct: 50,
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(15); // 100 * 0.15
  });

  it("does NOT calculate bonus when method=original", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true, bonusCreditPct: 20 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "original",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(0);
  });

  it("does NOT calculate bonus when bonusCreditEnabled=false even with store_credit method", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: false, bonusCreditPct: 20 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(0);
  });

  it("zero bonus when items have null prices (auto-calc skipped)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: "S",
            price: null,
            reasonCode: null,
            notes: null,
            title: "T",
          },
        ],
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true, bonusCreditPct: 25 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(0);
    // bonusCreditAmount NOT included in update payload when 0
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: Record<string, unknown>;
    };
    expect(finalUpdate.data.bonusCreditAmount).toBeUndefined();
  });

  it("uses default bonusCreditPct=10 when settings.bonusCreditPct is undefined", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: "S",
            price: "50.00",
            reasonCode: null,
            notes: null,
            title: "T",
          },
        ],
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { bonusCreditEnabled: true },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // 50 * 0.10 = 5.00
    const opts = createRefundMock.mock.calls[0][6] as unknown as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(5);
  });
});

// ─────────────────── Refund method = "both" splits ───────────────────
describe("handleProcessRefund — refund method 'both' splits", () => {
  it("percentage mode: passes storeCreditPct to refund cfg", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        refundMethod: "both",
        storeCreditPct: 60,
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as {
      method: string;
      storeCreditPct?: number;
      storeCreditAmount?: number;
    };
    expect(cfg.method).toBe("both");
    expect(cfg.storeCreditPct).toBe(60);
    expect(cfg.storeCreditAmount).toBeUndefined();
  });

  it("percentage mode: rejects storeCreditPct < 5", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      storeCreditPct: 4,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("percentage mode: rejects NaN storeCreditPct", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      storeCreditPct: NaN,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("percentage mode: falls back to settings.refundStoreCreditPct when body missing", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { refundStoreCreditPct: 40 },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "both",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("amount mode: passes both numeric amounts to refund cfg", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        refundMethod: "both",
        splitMode: "amount",
        splitScAmount: 6,
        splitOrigAmount: 4,
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as {
      method: string;
      storeCreditAmount?: number;
      originalAmount?: number;
    };
    expect(cfg.method).toBe("both");
    expect(cfg.storeCreditAmount).toBe(6);
    expect(cfg.originalAmount).toBe(4);
  });

  it("amount mode: accepts one zero amount (only one greater than zero)", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        refundMethod: "both",
        splitMode: "amount",
        splitScAmount: 10,
        splitOrigAmount: 0,
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const cfg = createRefundMock.mock.calls[0][5] as unknown as {
      storeCreditAmount?: number;
      originalAmount?: number;
    };
    expect(cfg.storeCreditAmount).toBe(10);
    expect(cfg.originalAmount).toBe(0);
  });

  it("amount mode: rejects NaN amount", async () => {
    const res = await handleProcessRefund(mkCtx(), {
      action: "process_refund",
      refundMethod: "both",
      splitMode: "amount",
      splitScAmount: "abc" as unknown as number,
      splitOrigAmount: 5,
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });
});

// ─────────────────── Location requirement (green return) ───────────────────
describe("handleProcessRefund — location handling", () => {
  it("passes locationId when supplied and not green-return", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), {
        action: "process_refund",
        locationId: "gid://shopify/Location/42",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const locArg = createRefundMock.mock.calls[0][4];
    expect(locArg).toBe("gid://shopify/Location/42");
    const opts = createRefundMock.mock.calls[0][6] as unknown as { skipLocation: boolean };
    expect(opts.skipLocation).toBe(false);
  });

  it("forces null location and skipLocation=true on green return regardless of body", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, isGreenReturn: true } as never,
    });
    await expectRedirect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        locationId: "gid://shopify/Location/42",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const locArg = createRefundMock.mock.calls[0][4];
    expect(locArg).toBeNull();
    const opts = createRefundMock.mock.calls[0][6] as unknown as { skipLocation: boolean };
    expect(opts.skipLocation).toBe(true);
    // refund payload should mark greenReturn: true
    const finalUpdate = prismaMock.returnCase.update.mock.calls.at(-1)![0] as {
      data: { refundJson: string };
    };
    expect(JSON.parse(finalUpdate.data.refundJson).greenReturn).toBe(true);
  });

  it("passes undefined location when no locationId and not green return", async () => {
    await expectRedirect(
      handleProcessRefund(mkCtx(), { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const locArg = createRefundMock.mock.calls[0][4];
    expect(locArg).toBeUndefined();
  });
});

// ─────────────────── Fynd allowlist (multiple statuses) ───────────────────
describe("handleProcessRefund — Fynd allowlist with multiple statuses", () => {
  it("allows refund when current status is one of multiple allowed values", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "credit_note_generated",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          allowedFyndStatusesForRefund: JSON.stringify([
            "return_bag_delivered",
            "credit_note_generated",
            "return_accepted",
          ]),
        },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("blocks refund when current status not in 3-entry allowlist", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "in_transit",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          allowedFyndStatusesForRefund: JSON.stringify([
            "return_bag_delivered",
            "credit_note_generated",
            "return_accepted",
          ]),
        },
      },
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("return_bag_delivered");
    expect(body.error).toContain("credit_note_generated");
  });

  it("normalizes Fynd credit-note status labels before enforcing allowlist", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "Credit Note Generated",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          allowedFyndStatusesForRefund: JSON.stringify(["credit_note_generated"]),
        },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("allowlist with empty array is treated as feature disabled (refund proceeds)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "in_transit",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { allowedFyndStatusesForRefund: JSON.stringify([]) },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("allowlist matches case-insensitively (uppercase current status)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "RETURN_BAG_DELIVERED",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          allowedFyndStatusesForRefund: JSON.stringify(["return_bag_delivered"]),
        },
      },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

describe("handleProcessRefund — refund line item safety", () => {
  it("coalesces duplicate Shopify line items before creating the refund", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
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
          {
            id: "li-2",
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
    });

    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );

    expect(createRefundMock.mock.calls[0][2]).toEqual([
      { id: "gid://shopify/LineItem/1", quantity: 2 },
    ]);
  });
});

// ─────────────────── Line-item resolution Strategies 0/0b/full-fallback ───────────────────
describe("handleProcessRefund — line-item resolution fallbacks", () => {
  it("Strategy 0: PCDA-safe GID via fetchOrderLineItemsOnly when items empty", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          // bare numeric id forces lineItemsForRefund to start empty
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
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/A", title: "A", sku: "X", quantity: 2 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderLineItemsOnlyMock).toHaveBeenCalled();
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    // Caps qty by total return-item qty (1) — never refunds the full ordered qty (2).
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/A", quantity: 1 }]);
  });

  it("Strategy 0b: PCDA-safe by-name when GID lookup fails", async () => {
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
      id: "gid://shopify/Order/2",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/B", title: "B", sku: "Y", quantity: 1 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderLineItemsByNameMock).toHaveBeenCalledWith(expect.anything(), "1001");
    // Strategy 0b updated orderIdForRefund — verify update was called
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    const orderIdUpdate = updates.find((d) => d.shopifyOrderId === "gid://shopify/Order/2");
    expect(orderIdUpdate).toBeDefined();
  });

  it("full fetchOrder fallback when both PCDA-safe strategies fail", async () => {
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
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      lineItems: [{ id: "gid://shopify/LineItem/C", title: "C", sku: "Z", quantity: 3 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchOrderMock).toHaveBeenCalled();
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    // Caps qty at return-item qty (1) instead of full ordered qty (3).
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/C", quantity: 1 }]);
  });

  it("Strategy 0: SKU match preferred over fallback to all items", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 5,
            sku: "MATCH-ME",
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [
        { id: "gid://shopify/LineItem/X", title: "X", sku: "OTHER", quantity: 1 },
        { id: "gid://shopify/LineItem/Y", title: "Y", sku: "match-me", quantity: 99 },
      ],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    // Should match by SKU and use ri.qty (5), not Shopify quantity (99)
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/Y", quantity: 5 }]);
  });

  it("Strategy 0: SKU mismatch falls back to ALL Shopify line items", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "i1",
            shopifyLineItemId: "9999",
            qty: 1,
            sku: "DOES-NOT-EXIST",
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
    });
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [
        { id: "gid://shopify/LineItem/X", title: "X", sku: "OTHER", quantity: 1 },
        { id: "gid://shopify/LineItem/Y", title: "Y", sku: "ANOTHER", quantity: 2 },
      ],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    // Total return qty is 1; fallback distributes across line items in order
    // (first line takes 1, remaining 0 → second line skipped). Never refunds
    // the full ordered qty across multiple lines.
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/X", quantity: 1 }]);
  });

  it("caps refund qty at total return qty when no return items have SKU", async () => {
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
    fetchOrderLineItemsOnlyMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/Q", title: "Q", sku: null, quantity: 4 }],
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const liArg = createRefundMock.mock.calls[0][2] as unknown as Array<{
      id: string;
      quantity: number;
    }>;
    // Caps at return-item qty (1), never refunds full ordered qty (4).
    expect(liArg).toEqual([{ id: "gid://shopify/LineItem/Q", quantity: 1 }]);
  });
});

// ─────────────────── Fynd transition retry on subset failure ───────────────────
describe("handleProcessRefund — Fynd transition partial failure", () => {
  it("logs fynd_refund_synced with partialFailures when 1 of 2 transitions fails", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_bag_delivered",
      } as never,
      shop: {
        ...mkCtx().shop,
        settings: { fyndApiType: "platform", syncRefundToFynd: true },
      } as never,
    });
    let call = 0;
    const updateShipmentStatus = vi.fn(async () => {
      call++;
      if (call === 2) throw new Error("transient Fynd 500");
      return undefined;
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    await expectRedirect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledTimes(2);
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const synced = events.find((e) => e.eventType === "fynd_refund_synced");
    expect(synced).toBeDefined();
    const payload = JSON.parse(synced!.payloadJson) as {
      transitions: string[];
      partialFailures?: Array<{ status: string; error: string }>;
    };
    expect(payload.transitions).toHaveLength(1); // only first succeeded
    expect(payload.partialFailures).toBeDefined();
    expect(payload.partialFailures).toHaveLength(1);
    // No fynd_refund_sync_failed when at least one transition succeeded
    expect(events.find((e) => e.eventType === "fynd_refund_sync_failed")).toBeUndefined();
  });

  it("skips return_accepted transition when current status is already in completed-set", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
        fyndCurrentStatus: "return_accepted",
      } as never,
      shop: {
        ...mkCtx().shop,
        settings: { fyndApiType: "platform", syncRefundToFynd: true },
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
    // Only credit_note_generated should be pushed (return_accepted skipped)
    expect(updateShipmentStatus).toHaveBeenCalledTimes(1);
    const callArg = updateShipmentStatus.mock.calls[0][1] as unknown as {
      statuses: Array<{ status: string }>;
    };
    expect(callArg.statuses[0].status).toBe("credit_note_generated");
  });

  it("uses fyndOrderId as callId when present, else fyndShipmentId", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: null,
        fyndCurrentStatus: "return_accepted",
      } as never,
      shop: {
        ...mkCtx().shop,
        settings: { fyndApiType: "platform", syncRefundToFynd: true },
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
    // Falls back to shipmentId
    expect(updateShipmentStatus.mock.calls[0][0]).toBe("SH-1");
  });
});
