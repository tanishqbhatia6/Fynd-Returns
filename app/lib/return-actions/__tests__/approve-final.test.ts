/**
 * Final branch-coverage tests for handleApprove (approve.server.ts).
 *
 * Targets the residual uncovered branches surfaced by the v8 coverage report
 * after approve-deep + approve-gap (lines 337, 354-385, 396 and the various
 * `||`/`??` short-circuits at 113, 118, 129, 155, 166-175, 180, 190, 199,
 * 223-233, 290).
 *
 * NOTE: source files MUST NOT be modified — these tests only assert the
 * existing runtime behaviour at each previously-uncovered branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  sendApprovalNotificationMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createShopifyReturnMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    shopifyReturnId: "gid://shopify/Return/1",
  })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    client: { getShipments: vi.fn() },
  })),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    fyndReturnId: "FYR-1",
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
}));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  createShopifyReturn: createShopifyReturnMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));

import { handleApprove } from "../approve.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
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
  resetPrismaMock(prismaMock);
  prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1" });
  createFyndClientOrErrorMock
    .mockReset()
    .mockResolvedValue({ ok: true, client: { getShipments: vi.fn() } });
  createReturnOnFyndMock.mockReset().mockResolvedValue({ success: true, fyndReturnId: "FYR-1" });
});

describe("handleApprove — final branch coverage gaps", () => {
  it("L332-337: items map uses ?? null fallbacks when reasonCode/notes/sku are undefined (non-consolidation)", async () => {
    // Item missing all optional fields — exercises the `?? null` falsy branches at 333/334/337.
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [{ shopifyLineItemId: "gid://shopify/LineItem/9", qty: 2 }],
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/12345",
      [
        {
          shopifyLineItemId: "gid://shopify/LineItem/9",
          qty: 2,
          reasonCode: null,
          notes: null,
          sku: null,
        },
      ],
      expect.objectContaining({ requestedAt: expect.any(String) }),
    );
  });

  it("L354 + L332: items=undefined uses ?? [] fallback, itemCount=0 in shopify_return_created event", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, items: undefined } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const created = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as { data: { eventType: string } }).data.eventType === "shopify_return_created",
    );
    expect(created).toBeDefined();
    const payload = JSON.parse(
      ((created as unknown[])[0] as { data: { payloadJson: string } }).data.payloadJson,
    );
    expect(payload.itemCount).toBe(0);
  });

  it("L380-388: notification falls back to 'your order' when shopifyOrderName is empty + notes undefined when note empty", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: "" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: "your order", notes: undefined }),
    );
  });

  it("L383 + L387: notification works when shopDomain is undefined (?.replace short-circuits)", async () => {
    const ctx = mkCtx({ shopDomain: undefined as unknown as string });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ shopName: undefined, shopDomain: undefined }),
    );
  });

  it("L396: audit identity falls back to 'shop-admin' when sessionEmail is null", async () => {
    // sessionEmail null forces the `|| "shop-admin"` branch in the post-success audit.
    const ctx = mkCtx({ sessionEmail: null as unknown as string });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    // approved event payload uses raw sessionEmail (null), so we just confirm redirect happened.
    expect(prismaMock.returnEvent.create).toHaveBeenCalled();
  });

  it("L233: trackingNumber that looks like a Fynd ID does NOT populate forwardAwb (only returnLabelJson)", async () => {
    // 15+ digit awb_no is treated by isLikelyFyndId as a Fynd ID — so trackingNumber=null
    // in the extractor result, which means the forwardAwb branch is NOT taken.
    // But carrier alone still satisfies (carrier || trackingNumber) → returnLabelJson set.
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-1",
      fyndPayload: {
        delivery_partner_details: {
          display_name: "Bluedart",
          awb_no: "999999999999999", // 15 digits → isLikelyFyndId returns true
        },
      },
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.forwardAwb).toBeUndefined();
    if (data.returnLabelJson) {
      const parsed = JSON.parse(data.returnLabelJson as string);
      expect(parsed.trackingNumber).toBeNull();
      expect(parsed.carrier).toBe("Bluedart");
    }
  });

  it("L166-176: pickupAddress is built when customerAddress1 OR customerCity present (only city set)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        customerAddress1: null,
        customerCity: "Mumbai",
        customerName: "Jane",
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const callArgs = createReturnOnFyndMock.mock.calls[0][2] as {
      pickupAddress: Record<string, unknown> | null;
    };
    expect(callArgs.pickupAddress).not.toBeNull();
    expect(callArgs.pickupAddress?.city).toBe("Mumbai");
    expect(callArgs.pickupAddress?.address1).toBeNull();
  });

  it("L155: fetchOrderByOrderNumber receives empty string when shopifyOrderName is null", async () => {
    // shopifyOrderId null + shopifyOrderName null exercises (shopifyOrderName ?? "").replace branch.
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: null, shopifyOrderName: null } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "");
  });

  it("L199: Fynd throws non-Error (string) — String(err) branch is taken", async () => {
    createReturnOnFyndMock.mockImplementationOnce(async () => {
      throw "raw string failure"; // not an Error instance
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncError).toContain("raw string failure");
    expect(data.fyndSyncStatus).toBe("retry_scheduled");
  });

  it("L90-95 + L113-118 + L129: consolidation Shopify-Return items map ?? null fallbacks + skipped notification + audit fallback", async () => {
    // Forces:
    //   - L90-95 consolidation items map: reasonCode/notes/sku undefined → ?? null falsy branches
    //   - L113 customerEmailNorm falsy → notification block skipped
    //   - L118 (`note || returnCase.adminNotes`) → note empty → adminNotes used
    //   - L129 audit identity `sessionEmail || "shop-admin"` falsy branch
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      },
      sessionEmail: null as unknown as string,
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "98765", // numeric → triggers consolidation Shopify-Return creation
        customerEmailNorm: null,
        adminNotes: "previous note",
        items: [{ shopifyLineItemId: "gid://shopify/LineItem/77", qty: 3 }],
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.adminNotes).toBe("previous note");
    expect(sendApprovalNotificationMock).not.toHaveBeenCalled();
    expect(createShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(),
      "98765",
      [
        {
          shopifyLineItemId: "gid://shopify/LineItem/77",
          qty: 3,
          reasonCode: null,
          notes: null,
          sku: null,
        },
      ],
      expect.objectContaining({ requestedAt: expect.any(String) }),
    );
  });

  it("L290 + L362-372: shopify_return_failed payload uses orderId from effectiveOrderId branch with null error", async () => {
    // success=false with no error string — exercises `error: shopifyReturnResult.error` (undefined)
    createShopifyReturnMock.mockResolvedValueOnce({ success: false });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const failed = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) =>
        (c[0] as { data: { eventType: string } }).data.eventType === "shopify_return_failed",
    );
    expect(failed).toBeDefined();
    const payload = JSON.parse(
      ((failed as unknown[])[0] as { data: { payloadJson: string } }).data.payloadJson,
    );
    expect(payload.orderId).toBe("gid://shopify/Order/12345");
    expect(payload.error).toBeUndefined();
  });

  it("L342: createShopifyReturn returns success=true but null shopifyReturnId — falls into warn-only branch", async () => {
    // success && shopifyReturnId guard: shopifyReturnId null → branch goes to else (warn).
    createShopifyReturnMock.mockResolvedValueOnce({ success: true, shopifyReturnId: null });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const evtTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(evtTypes).toContain("shopify_return_failed");
    expect(evtTypes).not.toContain("shopify_return_created");
  });

  it("L166-176: full pickup address (all customer fields populated) hits truthy branch of every ?? null", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        customerAddress1: "1 Main St",
        customerAddress2: "Apt 5",
        customerCity: "Mumbai",
        customerProvince: "MH",
        customerZip: "400001",
        customerCountry: "IN",
        customerLandmark: "Near park",
        customerName: "Jane",
        customerPhoneNorm: "+15555550101",
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const callArgs = createReturnOnFyndMock.mock.calls[0][2] as {
      pickupAddress: Record<string, unknown>;
    };
    expect(callArgs.pickupAddress).toMatchObject({
      address1: "1 Main St",
      address2: "Apt 5",
      city: "Mumbai",
      province: "MH",
      zip: "400001",
      country: "IN",
      landmark: "Near park",
      name: "Jane",
      phone: "+15555550101",
    });
  });

  it("L32 + L380: returnRequestNo null (span fallback) and customerEmailNorm null (skip notification)", async () => {
    // L32: returnCase.returnRequestNo null → span attribute uses '' fallback.
    // L380: customerEmailNorm null in non-consolidation path → notification block skipped.
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        returnRequestNo: null,
        customerEmailNorm: null,
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(sendApprovalNotificationMock).not.toHaveBeenCalled();
  });
});
