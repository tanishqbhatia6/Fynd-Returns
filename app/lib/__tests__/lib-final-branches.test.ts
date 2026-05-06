/**
 * Final branch-coverage tests pushing remaining lib files toward >=95% on
 * branches/functions. Targets specific uncovered paths in:
 *
 *   - app/lib/return-actions/process-refund.server.ts (88% br):
 *       * malformed allowedFyndStatusesForRefund JSON falls through silently
 *       * empty currentFyndStatus with non-empty allowlist → 400 error
 *       * Fynd transition mixed result: some successful, some failed → both
 *         events created (fynd_refund_synced + non-empty partialFailures)
 *       * Fynd transition all-failed (none successful) → only
 *         fynd_refund_sync_failed event
 *       * COD detection via displayFinancialStatus=PENDING → method coerced
 *         to store_credit
 *       * notification path executes when customerEmailNorm present + sendRefund
 *         throws (warn-and-continue branch)
 *       * explicit bodyBonusAmount > 0 with bonusCreditEnabled → bonus pinned
 *
 *   - app/lib/return-actions/refresh-fynd-details.server.ts (88% br):
 *       * search response items at root .shipments
 *       * full getShipments returning a bare Array (Array.isArray branch)
 *       * full getShipments returning { shipments: [...] } (alternative path)
 *       * "manual:" shopifyOrderId triggers external-order-id guard
 *       * settings absent (undefined) triggers Fynd-not-configured branch
 *
 *   - app/lib/return-actions/retry-fynd-sync.server.ts (89% br, 57% fn):
 *       * fyndPayload JSON.stringify throws (circular) → payloadJson stays
 *         null but synced update still proceeds
 *       * items=null on success path → maps to empty array safely
 *
 * NO source mods. NO existing tests altered. Self-contained mocks per the
 * pattern used in `process-refund-final.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ---------------------------------------------------------------------------
// Hoisted mocks — shared across the three handler suites in this file.
// ---------------------------------------------------------------------------
const {
  prismaMock,
  createRefundMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByNameMock,
  closeShopifyReturnBestEffortMock,
  createShopifyReturnMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  sendRefundNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createRefundMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderByFyndAffiliateIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderLineItemsOnlyMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderLineItemsByNameMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  closeShopifyReturnBestEffortMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  sendRefundNotificationMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../shopify-admin.server", () => ({
  createRefund: createRefundMock,
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderLineItemsOnly: fetchOrderLineItemsOnlyMock,
  fetchOrderLineItemsByName: fetchOrderLineItemsByNameMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  createShopifyReturn: createShopifyReturnMock,
}));
vi.mock("../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../notification.server", () => ({
  sendRefundNotification: sendRefundNotificationMock,
}));

import { handleProcessRefund } from "../return-actions/process-refund.server";
import { handleRefreshFyndDetails } from "../return-actions/refresh-fynd-details.server";
import { handleRetryFyndSync } from "../return-actions/retry-fynd-sync.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../return-actions/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function mkRefundCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
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
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

function mkRefreshCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      adminNotes: null,
      returnRequestNo: "RQ-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid://shopify/Order/1",
      customerEmailNorm: "user@example.com",
      status: "pending",
      items: [],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

function mkRetryCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "RQ-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      shopifyReturnId: "gid://shopify/Return/EXISTING", // skip side-effect to keep tests focused
      fyndReturnId: null,
      fyndShipmentId: null,
      fyndSyncStatus: null,
      fyndSyncRetries: 0,
      customerAddress1: null,
      customerCity: null,
      isGreenReturn: false,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      items: [],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: { graphql: vi.fn() } as never,
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
    throw new Error("expected handler to throw a redirect");
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
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/Z" });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  createReturnOnFyndMock.mockReset();
  sendRefundNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────────────────────
// process-refund branch gaps
// ───────────────────────────────────────────────────────────────────────────
describe("handleProcessRefund — branch gaps", () => {
  it("malformed allowedFyndStatusesForRefund JSON is silently ignored (catch path)", async () => {
    // Source: try { JSON.parse(raw) } catch { /* malformed JSON — feature off */ }
    // With Fynd integration but malformed JSON, the allowlist enforcement is
    // skipped entirely → refund should succeed.
    const ctx = mkRefundCtx({
      returnCase: {
        ...mkRefundCtx().returnCase,
        fyndOrderId: "FY-1",
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: "delivered",
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          fyndApiType: "platform",
          allowedFyndStatusesForRefund: "{not valid json",
        },
      },
    });
    await expect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    // Refund proceeded → createRefund called.
    expect(createRefundMock).toHaveBeenCalled();
  });

  it("empty currentFyndStatus with non-empty allowlist returns 400 'has not been received'", async () => {
    const ctx = mkRefundCtx({
      returnCase: {
        ...mkRefundCtx().returnCase,
        fyndOrderId: "FY-1",
        fyndShipmentId: "SH-1",
        fyndCurrentStatus: null,
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          fyndApiType: "platform",
          allowedFyndStatusesForRefund: JSON.stringify(["delivered"]),
        },
      },
    });
    const res = await handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
    const body = await (res as Response).json();
    expect(body.error).toMatch(/has not been received/);
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it("Fynd refund-sync mixed transitions: some succeed, some fail → records both events", async () => {
    // Force one transition to succeed and the next to fail. With current
    // status='delivered' (not in the skip list), TWO transitions are pushed:
    // return_accepted then credit_note_generated.
    const updateShipmentStatus = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("locked"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() } as never,
    });
    const ctx = mkRefundCtx({
      returnCase: {
        ...mkRefundCtx().returnCase,
        fyndOrderId: "FYO-1",
        fyndShipmentId: "FYSH-1",
        fyndCurrentStatus: "delivered",
      } as never,
    });
    await expect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    expect(updateShipmentStatus).toHaveBeenCalledTimes(2);
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const synced = events.find((e) => e.eventType === "fynd_refund_synced");
    expect(synced).toBeDefined();
    const syncedPayload = JSON.parse(synced!.payloadJson) as {
      transitions: string[];
      partialFailures?: unknown[];
    };
    expect(syncedPayload.transitions).toContain("return_accepted");
    expect(syncedPayload.partialFailures).toBeDefined();
    expect((syncedPayload.partialFailures as unknown[]).length).toBe(1);
    // Did NOT also write fynd_refund_sync_failed (success > 0)
    expect(events.find((e) => e.eventType === "fynd_refund_sync_failed")).toBeUndefined();
  });

  it("Fynd refund-sync: ALL transitions fail → only fynd_refund_sync_failed event", async () => {
    const updateShipmentStatus = vi.fn().mockRejectedValue(new Error("locked"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() } as never,
    });
    const ctx = mkRefundCtx({
      returnCase: {
        ...mkRefundCtx().returnCase,
        fyndOrderId: "FYO-1",
        fyndShipmentId: "FYSH-1",
        fyndCurrentStatus: "delivered",
      } as never,
    });
    await expect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    expect(events.find((e) => e.eventType === "fynd_refund_synced")).toBeUndefined();
    const failed = events.find((e) => e.eventType === "fynd_refund_sync_failed");
    expect(failed).toBeDefined();
    const payload = JSON.parse(failed!.payloadJson) as { failures: unknown[] };
    expect(payload.failures.length).toBeGreaterThan(0);
  });

  it("COD detection via displayFinancialStatus=PENDING coerces method to store_credit", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      paymentGatewayNames: [],
      displayFinancialStatus: "PENDING",
      lineItems: [],
    });
    const ctx = mkRefundCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        // Force settings-based path (no body refundMethod) and "original".
        settings: {
          fyndApiType: "platform",
          refundPaymentMethod: "original",
          refundStoreCreditPct: 100,
        },
      },
    });
    await expect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    // createRefund called with refundMethodCfg coerced to store_credit
    const args = createRefundMock.mock.calls[0]!;
    const refundMethodCfg = args[5] as { method: string } | null;
    expect(refundMethodCfg?.method).toBe("store_credit");
  });

  it("notification path: sendRefundNotification rejection is swallowed (warn-and-continue)", async () => {
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const ctx = mkRefundCtx({
      returnCase: {
        ...mkRefundCtx().returnCase,
        customerEmailNorm: "buyer@example.com",
      } as never,
    });
    // Should still throw redirect (refund succeeded).
    await expect(
      handleProcessRefund(ctx, { action: "process_refund" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    expect(sendRefundNotificationMock).toHaveBeenCalled();
  });

  it("createRefund returns success=false → enrichRefundError + 400 with refund_failed event", async () => {
    createRefundMock.mockResolvedValueOnce({
      success: false,
      error: "Insufficient funds",
    });
    const res = await handleProcessRefund(mkRefundCtx(), {
      action: "process_refund",
      refundMethod: "original",
      note: "n1",
    } as ReturnActionBody);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
    const body = await (res as Response).json();
    expect(body.error).toContain("Insufficient");
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data,
    );
    expect(events.some((e) => e.eventType === "refund_failed")).toBe(true);
  });

  it("top-level catch: refundEvent.create rejects → swallowed by inner try/catch", async () => {
    // Force createRefund to throw a generic Error → falls into the outer
    // catch (line 560+). Then make the refund_failed event create reject so
    // the inner try/catch (line 575-577) records the logger.error and
    // continues to return Response 500.
    createRefundMock.mockRejectedValueOnce(new Error("generic refund crash"));
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("event-write down"));
    const res = await handleProcessRefund(mkRefundCtx(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(500);
  });

  it("explicit bodyBonusAmount > 0 with bonusCreditEnabled pins bonus (skips itemTotal calc)", async () => {
    const ctx = mkRefundCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: {
          fyndApiType: "platform",
          bonusCreditEnabled: true,
          bonusCreditPct: 10,
          refundPaymentMethod: "store_credit",
          refundStoreCreditPct: 100,
        },
      },
    });
    await expect(
      handleProcessRefund(ctx, {
        action: "process_refund",
        refundMethod: "store_credit",
        bonusAmount: 7,
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    const args = createRefundMock.mock.calls[0]!;
    const opts = args[6] as { bonusAmount: number };
    expect(opts.bonusAmount).toBe(7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// refresh-fynd-details branch gaps
// ───────────────────────────────────────────────────────────────────────────
describe("handleRefreshFyndDetails — branch gaps", () => {
  it("reads items from root .shipments when .items is absent", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-S1",
      shipments: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    await expectRedirect(
      handleRefreshFyndDetails(mkRefreshCtx(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as {
      data: { fyndOrderId?: string; fyndPayloadJson?: string };
    };
    expect(update.data.fyndOrderId).toBe("FY-S1");
  });

  it("getShipments returning a bare Array is preferred over search payload", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-ARR",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const fullArr = [
      { shipment_id: "S-1", journey_type: "forward" },
      {
        shipment_id: "S-2",
        journey_type: "return",
        status: "return_initiated",
        dp_name: "Delhivery",
        awb_no: "DEL-1",
      },
    ];
    const getShipments = vi.fn(async () => fullArr);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search, getShipments },
    });
    await expectRedirect(
      handleRefreshFyndDetails(mkRefreshCtx(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as {
      data: { fyndPayloadJson: string };
    };
    const stored = JSON.parse(update.data.fyndPayloadJson);
    // Stored payload is the bare array (length=2) not the search obj.
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(2);
  });

  it("getShipments returning { shipments: [...] } is preferred when non-empty", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-OBJ-SH",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const full = { shipments: [{ shipment_id: "S-1" }, { shipment_id: "S-2" }] };
    const getShipments = vi.fn(async () => full);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search, getShipments },
    });
    await expectRedirect(
      handleRefreshFyndDetails(mkRefreshCtx(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as {
      data: { fyndPayloadJson: string };
    };
    const stored = JSON.parse(update.data.fyndPayloadJson);
    // Full object preferred — contains the .shipments key.
    expect(stored.shipments).toHaveLength(2);
  });

  it("redirects with fyndError when shopifyOrderId starts with 'manual:'", async () => {
    const ctx = mkRefreshCtx({
      returnCase: {
        ...mkRefreshCtx().returnCase,
        shopifyOrderId: "manual:abc",
        shopifyOrderName: "#1001",
      } as never,
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("redirects with fyndError when shop settings is undefined (Fynd not configured)", async () => {
    const ctx = mkRefreshCtx({
      shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
    // Settings is falsy → skipped client construction.
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("missing returnRequestNo + missing shopifyOrderName → fyndError redirect", async () => {
    // Exercise the falsy branch on returnRequestNo + the shopifyOrderName ?? "".
    const ctx = mkRefreshCtx({
      returnCase: {
        ...mkRefreshCtx().returnCase,
        returnRequestNo: null,
        shopifyOrderName: null,
      } as never,
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("invoice with label_url + invoice_url top-level fields (skips invLinks fallback)", async () => {
    // dp.name fallback (not display_name) + AWB present.
    const search = vi.fn(async () => ({
      orderId: "FY-INV2",
      items: [
        {
          shipment_id: "R-1",
          journey_type: "return",
          delivery_partner_details: { name: "DTDC2", awb_no: "DT-77" },
          invoice: {
            label_url: "https://x.com/L.pdf",
            invoice_url: "https://x.com/I.pdf",
          },
          tracking_url: "https://t.example/abc",
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    await expectRedirect(
      handleRefreshFyndDetails(mkRefreshCtx(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as {
      data: { returnLabelJson: string };
    };
    const stored = JSON.parse(update.data.returnLabelJson);
    expect(stored.labelUrl).toBe("https://x.com/L.pdf");
    expect(stored.invoiceUrl).toBe("https://x.com/I.pdf");
    expect(stored.carrier).toBe("DTDC2");
    expect(stored.trackingNumber).toBe("DT-77");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// retry-fynd-sync branch gaps
// ───────────────────────────────────────────────────────────────────────────
describe("handleRetryFyndSync — branch gaps", () => {
  it("circular fyndPayload → JSON.stringify catch sets payloadJson to null but synced still proceeds", async () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as never,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FY-CIRC",
      fyndPayload: circular,
    });
    await expectRedirect(
      handleRetryFyndSync(mkRetryCtx(), { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    // The synced update still ran. Because payloadJson===null after catch,
    // the conditional spread omits fyndPayloadJson from the data object.
    const updates = prismaMock.returnCase.update.mock.calls;
    const synced = updates.find(
      (c) => (c[0] as { data: { fyndSyncStatus?: string } }).data.fyndSyncStatus === "synced",
    );
    expect(synced).toBeDefined();
    expect((synced![0] as { data: Record<string, unknown> }).data.fyndPayloadJson).toBeUndefined();
    expect((synced![0] as { data: Record<string, unknown> }).data.fyndReturnId).toBe("FY-CIRC");
  });

  it("crash branch + returnEvent.create rejection → empty .catch() arrow runs (line 106)", async () => {
    // Force createReturnOnFynd to throw → enters crash branch (line 87+).
    // Then make the subsequent returnEvent.create reject so the
    // `.catch(() => {})` empty arrow on line 106 is exercised.
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as never,
    });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("fynd boom"));
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("event-write down"));
    await expectRedirect(
      handleRetryFyndSync(mkRetryCtx(), { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("failure branch (success=false) + returnCase.update rejection → empty .catch() arrow runs (line 204)", async () => {
    // success=false → enters the failure path at line 197+.
    // Make returnCase.update reject so the `.catch(() => {})` arrow at
    // line 204 fires.
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as never,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "rejected by fynd" });
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db fail"));
    await expectRedirect(
      handleRetryFyndSync(mkRetryCtx(), { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("Shopify Return side-effect: returnCase.update rejection → .catch() arrow (line 177)", async () => {
    // Force the success-path branch where shopifyReturnId is missing AND
    // createShopifyReturn returns a real id, so the inner
    // `prisma.returnCase.update({...}).catch(() => {})` on line 177 fires.
    // Make THAT update reject. The redirect must still succeed.
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as never,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-X" });
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-1" });
    createShopifyReturnMock.mockResolvedValueOnce({
      success: true,
      shopifyReturnId: "gid://shopify/Return/SIDE-EFFECT",
    });
    // First update (synced) succeeds; second update (shopifyReturnId persist) rejects.
    prismaMock.returnCase.update
      .mockResolvedValueOnce({ id: "rc-1" })
      .mockRejectedValueOnce(new Error("update boom"));

    const ctx = mkRetryCtx({
      returnCase: {
        ...mkRetryCtx().returnCase,
        shopifyReturnId: null,
        shopifyOrderId: "gid://shopify/Order/77",
      } as never,
    });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalled();
  });

  it("returnCase.items=null on success path → empty items array passed to createShopifyReturn", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() } as never,
    });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-ITEMS-NULL" });
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-X" });

    const ctx = mkRetryCtx({
      returnCase: {
        ...mkRetryCtx().returnCase,
        items: null, // forces (returnCase.items ?? []) ?? [] branch
        shopifyReturnId: null, // need the side-effect to attempt createShopifyReturn
        shopifyOrderId: "gid://shopify/Order/77",
      } as never,
    });
    await expectRedirect(
      handleRetryFyndSync(ctx, { action: "retry_fynd_sync" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    // createShopifyReturn called with empty items array.
    const args = createShopifyReturnMock.mock.calls[0]!;
    expect(Array.isArray(args[2])).toBe(true);
    expect((args[2] as unknown[]).length).toBe(0);
  });
});
