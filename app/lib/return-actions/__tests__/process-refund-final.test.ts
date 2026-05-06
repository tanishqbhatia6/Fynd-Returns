/**
 * Final coverage tests for handleProcessRefund — closes the last gaps after
 * process-refund-deep.test.ts and process-refund-gap.test.ts:
 *
 *   - Lines 168-169: Strategy 2 fetchOrderByFyndAffiliateId catch handler
 *     (rejection path that swallows the error and returns null).
 *   - Lines 234-238: !orderIdForRefund post-resolution fallback (when
 *     orderIdForRefund is null/empty/manual: stripped and the Fynd resolver
 *     block is bypassed).
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

// ─────────── Strategy 2 catch handler (lines 168-169) ───────────
describe("handleProcessRefund — Strategy 2 rejection swallow path", () => {
  it("Strategy 2 fetchOrderByFyndAffiliateId rejects with Error → catch returns null → 400", async () => {
    // No shopifyOrderName so Strategy 1 is skipped; Strategy 2 throws and is
    // swallowed by the .catch handler at line 167-170. Strategy 3 disabled
    // (no fyndPayloadJson). Result: unresolved → 400 with FY-XYZ in error.
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-XYZ",
        shopifyOrderName: null,
        fyndPayloadJson: null,
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockRejectedValueOnce(new Error("strat2 boom"));
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("FY-XYZ");
    // Confirm the Strategy 2 call happened with the cleaned id
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalledTimes(1);
    expect(fetchOrderByFyndAffiliateIdMock.mock.calls[0][1]).toBe("FY-XYZ");
  });

  it("Strategy 2 rejects with non-Error (string) → err?.message ?? err fallback", async () => {
    // Same as above but rejection value lacks .message — exercises the
    // `err?.message ?? err` fallback branch inside the warn payload.
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "#FY-RAW-STR",
        shopifyOrderName: null,
        fyndPayloadJson: null,
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock.mockRejectedValueOnce("network down");
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    // Cleaned id stripped the leading '#'
    expect(fetchOrderByFyndAffiliateIdMock.mock.calls[0][1]).toBe("FY-RAW-STR");
  });

  it("Strategy 1 throws then Strategy 2 throws → both catches hit, then 400", async () => {
    // shopifyOrderName present → Strategy 1 runs and throws (covered by gap
    // test); Strategy 2 ALSO throws (the line 168-169 catch). Strategy 3
    // disabled. The combination forces both rejection paths in one run.
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "FY-DOUBLE-FAIL",
        shopifyOrderName: "#1001",
        fyndPayloadJson: null,
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    fetchOrderByFyndAffiliateIdMock
      .mockRejectedValueOnce(new Error("s1"))
      .mockRejectedValueOnce(new Error("s2"));
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalledTimes(2);
    expect(fetchOrderByFyndAffiliateIdMock.mock.calls[1][1]).toBe("FY-DOUBLE-FAIL");
  });
});

// ─────────── !orderIdForRefund post-resolution (lines 234-238) ───────────
describe("handleProcessRefund — orderIdForRefund missing fallback", () => {
  it("returnCase.shopifyOrderId is null → !orderIdForRefund branch returns 400 with refund_failed event", async () => {
    // shopifyOrderId is null/empty → isGid=false, isNumericId=false, but the
    // Fynd resolver block at line 154 requires `orderIdForRefund` truthy, so
    // it is skipped. Execution reaches the !orderIdForRefund guard at
    // line 233 which is the target of this test (lines 234-238).
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: null,
        shopifyOrderName: null,
        items: [
          { id: "i1", shopifyLineItemId: "manual", qty: 1, sku: null, price: null, reasonCode: null, notes: null, title: null },
        ],
      } as never,
    });
    const res = await handleProcessRefund(
      ctx,
      { action: "process_refund", note: "missing order" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Could not determine Shopify order. Check that the return has a valid order.");
    // refund_failed event recorded with the missing-order error message
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const failed = events.find((e) => e.eventType === "refund_failed");
    expect(failed).toBeDefined();
    const payload = JSON.parse(failed!.payloadJson) as { error: string; note: string | null };
    expect(payload.error).toContain("Could not determine Shopify order");
    expect(payload.note).toBe("missing order");
    // createRefund was never called
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it("returnCase.shopifyOrderId is empty string → same !orderIdForRefund 400", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "",
        shopifyOrderName: null,
        items: [],
      } as never,
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Could not determine Shopify order");
    expect(createRefundMock).not.toHaveBeenCalled();
    // note: null is preserved in the failed event payload
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const failed = events.find((e) => e.eventType === "refund_failed");
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.payloadJson).note).toBeNull();
  });
});
