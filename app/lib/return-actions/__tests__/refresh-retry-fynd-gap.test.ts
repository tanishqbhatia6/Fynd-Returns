/**
 * Gap-coverage tests for handleRefreshFyndDetails and handleRetryFyndSync.
 *
 * The deep test files cover most happy/error branches. This file targets the
 * remaining uncovered lines reported by v8 coverage:
 *
 *   refresh-fynd-details.server.ts:
 *     - line 20-23 second branch: shopifyOrderId starts with "manual:"
 *     - lines 36-38: storefront-only client lacks searchShipmentsByExternalOrderId
 *     - lines 125-128: outer catch path increments error/appError counters
 *
 *   retry-fynd-sync.server.ts:
 *     - line 119: payloadJson catch when JSON.stringify throws (circular)
 *     - line 164: items defaulting to [] when returnCase.items is null/undefined
 *     - lines 229-232: outer catch path increments error/appError counters
 *
 * These tests use a separate metrics-throwing mock to drive the outer catch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createShopifyReturnMock,
  returnActionCounterAdd,
  appErrorCounterAdd,
  returnActionDurationRecord,
  fyndSyncCounterAdd,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  returnActionCounterAdd: vi.fn(),
  appErrorCounterAdd: vi.fn(),
  returnActionDurationRecord: vi.fn(),
  fyndSyncCounterAdd: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  createShopifyReturn: createShopifyReturnMock,
}));
vi.mock("../../observability/metrics.server", () => ({
  returnActionCounter: { add: returnActionCounterAdd },
  returnActionDuration: { record: returnActionDurationRecord },
  appErrorCounter: { add: appErrorCounterAdd },
  fyndSyncCounter: { add: fyndSyncCounterAdd },
}));

import { handleRefreshFyndDetails } from "../refresh-fynd-details.server";
import { handleRetryFyndSync } from "../retry-fynd-sync.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const REFRESH_BODY = { action: "refresh_fynd_details" } as ReturnActionBody;
const RETRY_BODY = { action: "retry_fynd_sync" } as ReturnActionBody;

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

function mkRetryClient(overrides: Record<string, unknown> = {}) {
  return { getShipments: vi.fn(async () => ({ items: [] })), ...overrides };
}

function mkRetryCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  const base = {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "RQ-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      shopifyReturnId: null,
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
  } as ReturnHandlerContext;
  return { ...base, ...overrides };
}

async function expectRedirect(p: Promise<unknown>, expectedFrag: string) {
  try {
    await p;
    throw new Error("expected handler to throw a redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(expectedFrag);
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientOrErrorMock.mockReset();
  createReturnOnFyndMock.mockReset();
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/99" });
  returnActionCounterAdd.mockReset();
  appErrorCounterAdd.mockReset();
  returnActionDurationRecord.mockReset();
  fyndSyncCounterAdd.mockReset();
});

describe("handleRefreshFyndDetails — gap coverage", () => {
  it("redirects with fyndError when shopifyOrderId starts with 'manual:' (manual return)", async () => {
    const ctx = mkRefreshCtx({
      returnCase: {
        ...mkRefreshCtx().returnCase,
        // valid order name, but the manual: prefix triggers the second branch
        shopifyOrderName: "#1001",
        shopifyOrderId: "manual:abc-123",
      } as never,
    });

    await expectRedirect(handleRefreshFyndDetails(ctx, REFRESH_BODY), "fyndError=");
    // Should redirect with the "No order number" message
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("redirects with fyndError when createFyndClientOrError returns ok=false", async () => {
    // Exercises lines 30-32: fyndResult not ok → error counters + redirect
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: false,
      error: "Fynd creds missing",
    });

    let captured: Response | null = null;
    try {
      await handleRefreshFyndDetails(mkRefreshCtx(), REFRESH_BODY);
    } catch (err) {
      captured = err as Response;
    }
    expect(captured).toBeInstanceOf(Response);
    const loc = decodeURIComponent(captured!.headers.get("Location") ?? "");
    expect(loc).toContain("fyndError=");
    expect(loc).toContain("Fynd creds missing");
    // Error-outcome counter recorded for this branch
    expect(returnActionCounterAdd).toHaveBeenCalledWith(1, {
      action: "refresh_fynd_details",
      outcome: "error",
    });
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("redirects with platform-required error when client lacks searchShipmentsByExternalOrderId (storefront-only)", async () => {
    // ok client but no search method — exercises the storefront guard at lines 36-38
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        /* no searchShipmentsByExternalOrderId */
      },
    });

    let captured: Response | null = null;
    try {
      await handleRefreshFyndDetails(mkRefreshCtx(), REFRESH_BODY);
    } catch (err) {
      captured = err as Response;
    }
    expect(captured).toBeInstanceOf(Response);
    const loc = decodeURIComponent(captured!.headers.get("Location") ?? "");
    expect(loc).toContain("fyndError=");
    expect(loc).toContain("Platform API");
    // Storefront-only short-circuit happens before any DB write.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("propagates a non-Response error through the outer catch (increments appErrorCounter)", async () => {
    // Make returnActionCounter.add throw on the FIRST call (line 21).
    // That throws after the externalOrderId guard hits the manual: path —
    // the throw escapes the outer try and lands in the outer catch at line 124.
    let calls = 0;
    returnActionCounterAdd.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("metrics down");
    });
    const ctx = mkRefreshCtx({
      returnCase: {
        ...mkRefreshCtx().returnCase,
        shopifyOrderId: "manual:abc",
      } as never,
    });

    await expect(handleRefreshFyndDetails(ctx, REFRESH_BODY)).rejects.toThrow(/metrics down/);
    // appErrorCounter should have been incremented in the outer catch (line 126)
    expect(appErrorCounterAdd).toHaveBeenCalledWith(1, { action: "refresh_fynd_details" });
  });
});

describe("handleRetryFyndSync — gap coverage", () => {
  it("survives JSON.stringify throwing on circular fyndPayload (sets payloadJson=null)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkRetryClient() });
    // Build a circular payload so JSON.stringify throws.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FY-CIRC",
      fyndPayload: circular,
    });

    await expectRedirect(handleRetryFyndSync(mkRetryCtx(), RETRY_BODY), "fyndSuccess=1");

    const updates = prismaMock.returnCase.update.mock.calls;
    const synced = updates.find((c) => c[0].data?.fyndSyncStatus === "synced");
    expect(synced).toBeDefined();
    // payloadJson key is only spread in when not null — circular payload caught,
    // so the fyndPayloadJson field should NOT appear in the update.
    expect(synced![0].data).not.toHaveProperty("fyndPayloadJson");
    expect(synced![0].data.fyndReturnId).toBe("FY-CIRC");
  });

  it("defaults items to [] when returnCase.items is null (Shopify Return side-effect)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkRetryClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });
    // shopifyReturnId is null + numeric order id + items=null → should still call createShopifyReturn
    // with an empty array (the `?? []` branch on line 164).
    await expectRedirect(
      handleRetryFyndSync(
        mkRetryCtx({
          returnCase: {
            ...mkRetryCtx().returnCase,
            shopifyOrderId: "12345", // numeric, satisfies /^\d+$/
            items: null as never,
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalled();
    const args = createShopifyReturnMock.mock.calls[0]!;
    // args[2] is the items array — should be empty (default branch)
    expect(args[2]).toEqual([]);
  });

  it("maps each return item into Shopify Return payload (covers arrow callback on line 164)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkRetryClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });
    const items = [
      {
        shopifyLineItemId: "gid://shopify/LineItem/100",
        qty: 2,
        reasonCode: "damaged",
        notes: "scratched",
        sku: "SKU-1",
      },
      {
        shopifyLineItemId: "gid://shopify/LineItem/101",
        qty: 1,
        // exercise the ?? null fallbacks for reasonCode/notes/sku
        reasonCode: null,
        notes: null,
        sku: null,
      },
    ];

    await expectRedirect(
      handleRetryFyndSync(
        mkRetryCtx({
          returnCase: {
            ...mkRetryCtx().returnCase,
            shopifyOrderId: "98765",
            items: items as never,
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).toHaveBeenCalled();
    const mappedItems = createShopifyReturnMock.mock.calls[0]![2] as Array<{
      shopifyLineItemId: string;
      qty: number;
      reasonCode: string | null;
      notes: string | null;
      sku: string | null;
    }>;
    expect(mappedItems).toHaveLength(2);
    expect(mappedItems[0].shopifyLineItemId).toBe("gid://shopify/LineItem/100");
    expect(mappedItems[0].qty).toBe(2);
    expect(mappedItems[0].reasonCode).toBe("damaged");
    expect(mappedItems[1].reasonCode).toBeNull();
    expect(mappedItems[1].notes).toBeNull();
    expect(mappedItems[1].sku).toBeNull();
  });

  it("propagates a non-Response error through the outer catch (increments appErrorCounter)", async () => {
    // Make returnActionCounter.add throw on the FIRST call (status guard at line 23).
    // Status is "pending" so the function takes the early return path on line 22-25,
    // which calls returnActionCounter.add — throwing there escapes to the outer catch.
    let calls = 0;
    returnActionCounterAdd.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("metrics down");
    });

    await expect(
      handleRetryFyndSync(
        mkRetryCtx({
          returnCase: { ...mkRetryCtx().returnCase, status: "pending" } as never,
        }),
        RETRY_BODY,
      ),
    ).rejects.toThrow(/metrics down/);
    expect(appErrorCounterAdd).toHaveBeenCalledWith(1, { action: "retry_fynd_sync" });
  });
});
