/**
 * Coverage-gap tests for approve.server.ts and approve-cancellation.server.ts.
 *
 * The deep tests cover the canonical happy/sad paths. This file targets the
 * residual uncovered statements / functions / branches surfaced by the v8
 * coverage report:
 *
 * approve.server.ts gaps:
 *   - L106: consolidation Shopify-Return success=false (warn-only branch).
 *   - L187: JSON.stringify catch on a circular fyndPayload.
 *   - L390: notification rejection in the non-consolidation success path.
 *   - L409-412: outer catch for a non-Response, non-redirect error.
 *   - The four `.catch(() => {})` arrow functions at L103 / L346 / L358 / L373.
 *
 * approve-cancellation.server.ts gaps:
 *   - L155: outer catch when a non-redirect Response is thrown post-close.
 *   - The `.catch(() => {})` arrow at L116 (fynd_cancel_failed event create).
 *
 * NOTE: source files MUST NOT be modified — these tests prove the existing
 * runtime behaviour at each branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

// ────────────────────────────────────────────────────────────────────────────
// approve.server.ts gap suite
// ────────────────────────────────────────────────────────────────────────────
const {
  approvePrismaMock,
  sendApprovalNotificationMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createShopifyReturnMock,
  createFyndClientOrErrorApproveMock,
  createReturnOnFyndMock,
} = vi.hoisted(() => ({
  approvePrismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ success: true, shopifyReturnId: "gid://shopify/Return/1" })),
  createFyndClientOrErrorApproveMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ success: true, fyndReturnId: "FYR-1" })),
}));
Object.assign(approvePrismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: approvePrismaMock }));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
  // approve-cancellation imports sendCancellationNotification from same module —
  // declaring it here keeps the module mock surface complete for both handlers.
  sendCancellationNotification: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
}));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  createShopifyReturn: createShopifyReturnMock,
  // approve-cancellation needs this — stub here so the same module mock works.
  closeShopifyReturnBestEffort: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorApproveMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../webhook-dispatch.server", () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import { handleApprove } from "../approve.server";
import { handleApproveCancellation } from "../approve-cancellation.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkApproveCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      adminNotes: null,
      returnRequestNo: "RQ-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid://shopify/Order/12345",
      shopifyReturnId: null,
      customerEmailNorm: "user@example.com",
      status: "pending",
      items: [
        {
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          reasonCode: "DAMAGED",
          notes: null,
          sku: "SKU-1",
        },
      ],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      fyndShipmentId: null,
      customerAddress1: null,
      customerAddress2: null,
      customerCity: null,
      customerProvince: null,
      customerZip: null,
      customerCountry: null,
      customerLandmark: null,
      customerName: null,
      customerPhoneNorm: null,
    } as never,
    shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: { fyndApiType: "platform" } },
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, expectedPathFrag: string) {
  try {
    await p;
    throw new Error("expected handler to throw a redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(expectedPathFrag);
  }
}

beforeEach(() => {
  resetPrismaMock(approvePrismaMock);
  approvePrismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1" });
  createFyndClientOrErrorApproveMock.mockReset().mockResolvedValue({
    ok: true,
    client: { getShipments: vi.fn() },
  });
  createReturnOnFyndMock
    .mockReset()
    .mockResolvedValue({ success: true, fyndReturnId: "FYR-1", fyndReturnNo: "RN-1" });
});

describe("handleApprove — coverage gaps", () => {
  it("L106: consolidation logs warning when createShopifyReturn returns success=false", async () => {
    // Consolidation enabled + numeric order id → enters consolidation Shopify-
    // return creation; success=false hits the warn-only branch.
    createShopifyReturnMock.mockResolvedValueOnce({ success: false, error: "no fulfillable items" });
    const ctx = mkApproveCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      },
      returnCase: { ...mkApproveCtx().returnCase, shopifyOrderId: "98765" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalledTimes(1);
  });

  it("L103 callback: consolidation returnCase.update rejection is swallowed", async () => {
    // Force the post-success `.update({ shopifyReturnId }).catch(() => {})` callback to fire.
    // First update is the status flip; second update is the shopifyReturnId set.
    approvePrismaMock.returnCase.update
      .mockResolvedValueOnce({ id: "rc-1" }) // status flip succeeds
      .mockRejectedValueOnce(new Error("db write blip")); // shopifyReturnId update fails
    const ctx = mkApproveCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      },
      returnCase: { ...mkApproveCtx().returnCase, shopifyOrderId: "98765" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
  });

  it("L187: circular fyndPayload trips the JSON.stringify catch (sets fyndPayloadJson=null)", async () => {
    type Cycle = { self?: Cycle };
    const cycle: Cycle = {};
    cycle.self = cycle; // JSON.stringify throws TypeError on cycle
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-CIRC",
      fyndPayload: cycle,
    });
    await expectRedirect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = approvePrismaMock.returnCase.updateMany.mock.calls[0][0].data;
    // The catch sets fyndPayloadJson=null; the spread `...(fyndPayloadJson != null && {…})` then omits it.
    expect(data.fyndPayloadJson).toBeUndefined();
    expect(data.returnLabelJson).toBeUndefined();
  });

  it("L390: notification rejection in non-consolidation path does not abort the redirect", async () => {
    sendApprovalNotificationMock.mockRejectedValueOnce(new Error("smtp dead"));
    await expectRedirect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("L346 callback: post-create returnCase.update rejection is swallowed", async () => {
    // Non-consolidation path. updateMany succeeds; subsequent .update setting
    // shopifyReturnId rejects → its `.catch(() => {})` fires.
    approvePrismaMock.returnCase.update.mockRejectedValueOnce(new Error("update blip"));
    await expectRedirect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("L358 callback: shopify_return_created event create rejection is swallowed", async () => {
    // Non-consolidation success path. The 'shopify_return_created' event is
    // the second returnEvent.create after 'approved' + 'fynd_sync'. Index 2.
    approvePrismaMock.returnEvent.create
      .mockResolvedValueOnce({}) // approved
      .mockResolvedValueOnce({}) // fynd_sync
      .mockRejectedValueOnce(new Error("event create blip")); // shopify_return_created
    await expectRedirect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("L373 callback: shopify_return_failed event create rejection is swallowed", async () => {
    createShopifyReturnMock.mockResolvedValueOnce({ success: false, error: "no items" });
    // approved → fynd_sync → shopify_return_failed (rejects)
    approvePrismaMock.returnEvent.create
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("event create blip"));
    await expectRedirect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("L409-412: non-Response error in updateMany surfaces through the outer catch", async () => {
    // updateMany rejects with a plain Error → catch executes its non-redirect
    // branch (returnActionCounter.add error, appErrorCounter.add, duration.record, throw).
    const boom = new Error("db down");
    approvePrismaMock.returnCase.updateMany.mockRejectedValueOnce(boom);
    await expect(
      handleApprove(mkApproveCtx(), { action: "approve" } as ReturnActionBody),
    ).rejects.toThrow("db down");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// approve-cancellation.server.ts gap suite
// ────────────────────────────────────────────────────────────────────────────

describe("handleApproveCancellation — coverage gaps", () => {
  function mkCancelCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
    return {
      id: "rc-1",
      returnCase: {
        id: "rc-1",
        status: "approved",
        cancellationRequestedAt: new Date("2026-01-01T00:00:00Z"),
        cancellationReason: "user changed mind",
        returnRequestNo: "RQ-1",
        shopifyOrderName: "#1001",
        customerEmailNorm: "user@example.com",
        customerPhoneNorm: "+15555550101",
        fyndReturnId: null,
        fyndShipmentId: null,
        fyndOrderId: null,
        fyndSyncStatus: null,
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

  it("L155: a non-redirect Response thrown post-close re-throws unchanged", async () => {
    // Post-close, the cancellation_approved returnEvent.create runs; if we
    // make it throw a 4xx Response the outer catch hits the second guard:
    //   if (err instanceof Response) throw err;
    // (isRedirectResponse is false because status is 4xx, not 3xx.)
    const nonRedirect = new Response(JSON.stringify({ error: "blocked" }), { status: 409 });
    // The first post-close write is returnCase.update (status=cancelled).
    // Make it succeed, then the next returnEvent.create (cancellation_approved)
    // throws the Response.
    approvePrismaMock.returnCase.update.mockResolvedValueOnce({ id: "rc-1" });
    approvePrismaMock.returnEvent.create.mockImplementationOnce(async () => {
      throw nonRedirect;
    });
    await expect(
      handleApproveCancellation(mkCancelCtx(), { action: "approve_cancellation" } as ReturnActionBody),
    ).rejects.toBe(nonRedirect);
  });

  it("L116 callback: fynd_cancel_failed event create rejection is swallowed", async () => {
    // Configure Fynd cancel path so that updateShipmentStatus throws → handler
    // tries to write a 'fynd_cancel_failed' event whose .catch(() => {}) we
    // need to exercise.
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("fynd 500");
    });
    createFyndClientOrErrorApproveMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    // Sequence after close-success:
    //   1) returnCase.update      (status=cancelled)
    //   2) returnEvent.create     (cancellation_approved)
    //   3) returnEvent.create     (fynd_cancel_failed)  ← reject this one
    approvePrismaMock.returnCase.update.mockResolvedValueOnce({ id: "rc-1" });
    approvePrismaMock.returnEvent.create
      .mockResolvedValueOnce({}) // cancellation_approved
      .mockRejectedValueOnce(new Error("event store down")); // fynd_cancel_failed
    await expectRedirect(
      handleApproveCancellation(
        mkCancelCtx({
          returnCase: {
            ...mkCancelCtx().returnCase,
            fyndReturnId: "FY-RET-1",
            fyndShipmentId: "FY-SH-1",
            fyndOrderId: "FY-ORD-1",
          } as never,
        }),
        { action: "approve_cancellation" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledTimes(1);
  });
});
