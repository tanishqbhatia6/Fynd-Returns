/**
 * Bug #15 final-fix branch coverage — handleApprove behaviour when the
 * claim+create wrapper reports claimed=false (another worker already
 * persisted the Shopify return id). The handler must:
 *
 *   - NOT emit a fresh "shopify_return_created" event (the event
 *     represents this worker's creation, not an existing one).
 *   - Still log success with the claimed=false ternary arm.
 *
 * These branches are not exercised by the deeper approve tests because
 * those run the real claim wrapper against the prisma mock — which
 * always reports claimed=true. Mocking the wrapper directly here is
 * the cleanest way to drive both arms of the ternary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  sendApprovalNotificationMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  claimAndCreateShopifyReturnMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: true,
    client: { getShipments: vi.fn() },
  })),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    fyndReturnId: "FYR-1",
    fyndReturnNo: "RN-1",
  })),
  claimAndCreateShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    success: true,
    shopifyReturnId: "gid://shopify/Return/REUSED",
    claimed: false,
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
  createShopifyReturn: vi.fn(),
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../shopify-return-claim.server", () => ({
  claimAndCreateShopifyReturn: claimAndCreateShopifyReturnMock,
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
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyReturnId: null,
      customerEmailNorm: null,
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
      settings: { fyndApiType: "platform", fyndConsolidateReturns: false },
    } as never,
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 1,
    logShopifyReturnEvent: vi.fn() as never,
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, frag: string) {
  try {
    await p;
    throw new Error("expected a redirect Response to be thrown");
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
  prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({
    ok: true,
    client: { getShipments: vi.fn() },
  });
  createReturnOnFyndMock
    .mockReset()
    .mockResolvedValue({ success: true, fyndReturnId: "FYR-1", fyndReturnNo: "RN-1" });
  claimAndCreateShopifyReturnMock.mockReset().mockResolvedValue({
    success: true,
    shopifyReturnId: "gid://shopify/Return/REUSED",
    claimed: false,
  });
});

describe("handleApprove (regular path) — claim wrapper reports claimed=false", () => {
  it("does NOT emit shopify_return_created event when claim is reused", async () => {
    await expectRedirect(
      handleApprove(mkCtx(), { action: "approve" } as ReturnActionBody),
      "fyndSuccess=1",
    );
    const evtTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(evtTypes).not.toContain("shopify_return_created");
  });
});

describe("handleApprove (consolidation path) — claim wrapper reports claimed=false", () => {
  it("redirects to consolidationQueued and logs reused-id branch", async () => {
    const ctx = mkCtx({
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform", fyndConsolidateReturns: true },
      } as never,
    });
    await expectRedirect(
      handleApprove(ctx, { action: "approve" } as ReturnActionBody),
      "consolidationQueued=1",
    );
    expect(claimAndCreateShopifyReturnMock).toHaveBeenCalled();
  });
});
