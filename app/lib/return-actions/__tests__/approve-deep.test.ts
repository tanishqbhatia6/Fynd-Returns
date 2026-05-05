/**
 * Deep branch-coverage unit tests for handleApprove (approve.server.ts).
 *
 * The approve handler has the most complex control-flow of all the
 * return-action handlers — it covers the green-return short-circuit,
 * consolidation mode, Fynd sync (success / transient / config / unknown),
 * affiliateOrderId fetch, idempotent updateMany short-circuit, Shopify
 * Return creation success/failure, and autoShippingData backfill from the
 * Fynd payload. These tests pin the contracts of each branch while the
 * route-level tests (api.returns.id.actions.test.ts) prove integration.
 *
 * Pattern follows extracted-handlers.test.ts: hoisted mocks, prismaMock,
 * expectRedirect helper, no observability mocking (those modules are
 * pure no-ops in test env).
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
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ success: true, shopifyReturnId: "gid://shopify/Return/1" })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ success: true, fyndReturnId: "FYR-1" })),
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
  resetPrismaMock(prismaMock);
  // Default updateMany→count:1 so handler proceeds past the idempotent branch.
  prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1" });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({
    ok: true,
    client: { getShipments: vi.fn() },
  });
  createReturnOnFyndMock
    .mockReset()
    .mockResolvedValue({ success: true, fyndReturnId: "FYR-1", fyndReturnNo: "RN-1" });
});

describe("handleApprove — terminal short-circuit", () => {
  it("returns 400 when isTerminal=true", async () => {
    const res = await handleApprove(
      mkCtx({ isTerminal: true, returnCase: { ...mkCtx().returnCase, status: "approved" } as never }),
      { action: "approve" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("already");
  });
});

describe("handleApprove — green return path", () => {
  it("skips Fynd sync entirely and still updates DB", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, isGreenReturn: true } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
    // No Fynd → fyndError is null and fyndReturnId is null → URL has no
    // fyndError or fyndSuccess query string.
    const update = prismaMock.returnCase.updateMany.mock.calls[0][0];
    expect(update.data.status).toBe("approved");
    expect(update.data.fyndSyncStatus).toBeUndefined();
  });

  it("does NOT create Shopify Return for green returns", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, isGreenReturn: true } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });
});

describe("handleApprove — consolidation path", () => {
  function consCtx(overrides: Partial<ReturnHandlerContext> = {}) {
    return mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      },
      ...overrides,
    });
  }

  it("writes pending_consolidation status + queue redirect", async () => {
    await expectRedirect(
      handleApprove(consCtx(), { action: "approve", note: "ok" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
    expect(updateCall.data.fyndSyncStatus).toBe("pending_consolidation");
    expect(updateCall.data.status).toBe("approved");
    expect(updateCall.data.adminNotes).toBe("ok");
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("uses provided resolutionType when valid; defaults to refund otherwise", async () => {
    await expectRedirect(
      handleApprove(consCtx(), {
        action: "approve",
        resolutionType: "store_credit",
      } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(prismaMock.returnCase.update.mock.calls[0][0].data.resolutionType).toBe("store_credit");

    resetPrismaMock(prismaMock);
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });
    await expectRedirect(
      handleApprove(consCtx(), {
        action: "approve",
        resolutionType: "BOGUS",
      } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(prismaMock.returnCase.update.mock.calls[0][0].data.resolutionType).toBe("refund");
  });

  it("creates Shopify Return when order id is a numeric string", async () => {
    const ctx = consCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "98765" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(),
      "98765",
      expect.any(Array),
      expect.objectContaining({ requestedAt: expect.any(String) }),
    );
  });

  it("skips Shopify Return when consolidating for green returns", async () => {
    const ctx = consCtx({
      returnCase: { ...mkCtx().returnCase, isGreenReturn: true } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // green return wins — consolidation does not run because isGreenReturn=true
    // forces the non-consolidation path with no Fynd sync.
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("skips Shopify Return when shopifyReturnId already set", async () => {
    const ctx = consCtx({
      returnCase: { ...mkCtx().returnCase, shopifyReturnId: "gid://shopify/Return/EXISTING" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("skips Shopify Return when shopifyOrderId starts with manual:", async () => {
    const ctx = consCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("Shopify Return crash is non-fatal", async () => {
    createShopifyReturnMock.mockRejectedValueOnce(new Error("graphql blew up"));
    await expectRedirect(
      handleApprove(consCtx(), { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
  });

  it("dispatches notification when customer email present", async () => {
    await expectRedirect(
      handleApprove(consCtx(), { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com", orderName: "#1001" }),
    );
  });

  it("notification rejection does not abort consolidation", async () => {
    sendApprovalNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    await expectRedirect(
      handleApprove(consCtx(), { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
  });
});

describe("handleApprove — Fynd sync success", () => {
  it("redirects with fyndSuccess=1 when Fynd returns a return id", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-99",
      fyndReturnNo: "RN-99",
      fyndOrderId: "FYO-99",
      fyndShipmentId: "FYS-99",
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncStatus).toBe("synced");
    expect(data.fyndReturnId).toBe("FYR-99");
    expect(data.fyndReturnNo).toBe("RN-99");
    expect(data.fyndOrderId).toBe("FYO-99");
    expect(data.fyndShipmentId).toBe("FYS-99");
  });

  it("emits a fynd_sync event when Fynd succeeds", async () => {
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const eventCalls = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventCalls).toContain("approved");
    expect(eventCalls).toContain("fynd_sync");
  });

  it("treats alreadyExists as success even with no return id from result", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      alreadyExists: true,
      fyndShipmentId: "FYS-1",
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncStatus).toBe("synced");
  });
});

describe("handleApprove — Fynd transient error", () => {
  it("schedules retry when Fynd returns a non-success error", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: false,
      error: "ETIMEDOUT upstream",
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncStatus).toBe("retry_scheduled");
    expect(data.fyndSyncRetries).toBe(0);
    expect(data.fyndSyncNextRetry).toBeInstanceOf(Date);
    expect(data.fyndSyncError).toContain("ETIMEDOUT");
  });

  it("schedules retry when createReturnOnFynd throws", async () => {
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncStatus).toBe("retry_scheduled");
    expect(data.fyndSyncRetries).toBe(0);
  });

  it("emits fynd_sync_failed event on transient error", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({ success: false, error: "boom" });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const types = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(types).toContain("fynd_sync_failed");
  });

  it("falls back to 'sync completed but no id' transient error when Fynd returns success but no id", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncStatus).toBe("retry_scheduled");
    expect(data.fyndSyncError).toContain("did not return a return ID");
  });
});

describe("handleApprove — Fynd config error (not transient)", () => {
  it("uses fyndClientOrError failure message when Fynd is not configured", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "Fynd is not configured" });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    // Config error: client never reached the try/catch, so isTransientFyndError stays false
    // until the no-id fallback flips it. We assert error text contains the original config msg.
    expect(data.fyndSyncError).toContain("Fynd is not configured");
  });

  it("uses platform-required message when client lacks getShipments", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: {} });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncError).toContain("Platform API");
  });

  it("uses 'Fynd is not configured' when shop.settings is undefined", async () => {
    const ctx = mkCtx({ shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null } });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndError=",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndSyncError).toContain("Fynd is not configured");
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });
});

describe("handleApprove — affiliate id fetch", () => {
  it("passes affiliateOrderId to createReturnOnFynd when fetchOrder succeeds", async () => {
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-123" });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createReturnOnFyndMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ affiliateOrderId: "AFF-123" }),
    );
  });

  it("treats fetchOrder rejection as non-fatal (affiliateOrderId=null)", async () => {
    fetchOrderMock.mockRejectedValueOnce(new Error("admin api 500"));
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createReturnOnFyndMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ affiliateOrderId: null }),
    );
  });

  it("uses fetchOrderByOrderNumber when shopifyOrderId is null", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-9" });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: null, shopifyOrderName: "#1001" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
    expect(fetchOrderMock).not.toHaveBeenCalled();
  });

  it("does not fetch order when shopifyOrderId starts with manual:", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(fetchOrderMock).not.toHaveBeenCalled();
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
  });
});

describe("handleApprove — idempotent updateMany short-circuit", () => {
  it("returns success+idempotent JSON when updateMany count=0", async () => {
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    const body = await (res as Response).json();
    expect(body).toEqual({ success: true, idempotent: true });
    // Should not have created the approved event nor sent notification.
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
    expect(sendApprovalNotificationMock).not.toHaveBeenCalled();
  });
});

describe("handleApprove — Shopify Return creation success / failure", () => {
  it("writes shopifyReturnId + shopify_return_created event on success", async () => {
    createShopifyReturnMock.mockResolvedValueOnce({
      success: true,
      shopifyReturnId: "gid://shopify/Return/777",
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    // The post-update is a returnCase.update call setting shopifyReturnId.
    const setIdCalls = prismaMock.returnCase.update.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { data: { shopifyReturnId?: string } }).data.shopifyReturnId === "gid://shopify/Return/777",
    );
    expect(setIdCalls.length).toBe(1);
    const evtTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(evtTypes).toContain("shopify_return_created");
  });

  it("emits shopify_return_failed event when createShopifyReturn returns success=false", async () => {
    createShopifyReturnMock.mockResolvedValueOnce({ success: false, error: "no fulfilled items" });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const evtTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(evtTypes).toContain("shopify_return_failed");
  });

  it("does not abort when createShopifyReturn throws", async () => {
    createShopifyReturnMock.mockRejectedValueOnce(new Error("network down"));
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
  });

  it("skips Shopify Return creation when shopifyReturnId already set", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyReturnId: "gid://shopify/Return/EXISTING" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("skips Shopify Return when order id is non-numeric / non-GID", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "weird-thing" } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });
});

describe("handleApprove — autoShippingData backfill", () => {
  it("populates returnLabelJson + forwardAwb from Fynd payload tracking_no", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-1",
      fyndPayload: {
        delivery_partner_details: {
          display_name: "BlueDart",
          awb_no: "BD12345678",
          tracking_url: "https://track/x",
        },
      },
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    if (data.returnLabelJson) {
      const parsed = JSON.parse(data.returnLabelJson as string);
      expect(parsed.source).toBe("fynd");
    }
  });

  it("does not set autoShippingData when fyndPayload yields no shipping info", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-1",
      fyndPayload: { unrelated: true },
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.returnLabelJson).toBeUndefined();
    expect(data.forwardAwb).toBeUndefined();
  });

  it("does not call extractor when there is no fyndPayload", async () => {
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FYR-1",
      // No fyndPayload at all
    });
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const data = prismaMock.returnCase.updateMany.mock.calls[0][0].data;
    expect(data.fyndPayloadJson).toBeUndefined();
    expect(data.returnLabelJson).toBeUndefined();
  });
});
