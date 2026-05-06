/**
 * Final coverage closure: exercise the `returnCase.returnRequestNo || ""`
 * fallback in 3 handlers' withSpan() attribute objects. The truthy path is
 * exercised everywhere; this hits the falsy path so v8 records the
 * partial-branch fallback statement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: vi.fn(async () => null),
  fetchOrderByOrderNumber: vi.fn(async () => null),
  fetchOrderByFyndAffiliateId: vi.fn(async () => null),
  fetchOrderLineItemsOnly: vi.fn(async () => null),
  fetchOrderLineItemsByName: vi.fn(async () => null),
  closeShopifyReturnBestEffort: vi.fn(async () => ({ ok: true })),
  createRefund: vi.fn(async () => ({ success: true })),
  fetchVariantInfo: vi.fn(async () => new Map()),
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: vi.fn(async () => ({ ok: false, error: "disabled" })),
}));
vi.mock("../../notification.server", () => ({
  sendRefundNotification: vi.fn(async () => undefined),
  sendReplacementNotification: vi.fn(async () => undefined),
}));

import { handleProcessRefund } from "../process-refund.server";
import { handleProcessReplacement } from "../process-replacement.server";
import { handleRefreshFyndDetails } from "../refresh-fynd-details.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkCtxWithNullRequestNo(): ReturnHandlerContext {
  return {
    id: "rc-x",
    returnCase: {
      id: "rc-x",
      status: "approved",
      returnRequestNo: null, // ← the focus: fallback `|| ""` path
      shopifyOrderId: "manual:abc",
      shopifyOrderName: "—",
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
      items: [],
    } as never,
    shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn(async () => undefined),
  };
}

beforeEach(() => resetPrismaMock(prismaMock));

describe('handler `returnRequestNo || ""` fallback paths', () => {
  it("handleProcessRefund accepts null returnRequestNo (line 43 fallback)", async () => {
    // Manual-return short-circuit returns 400 before any external calls.
    const res = await handleProcessRefund(mkCtxWithNullRequestNo(), {
      action: "process_refund",
    } as ReturnActionBody);
    expect((res as Response).status).toBe(400);
  });

  it("handleProcessReplacement accepts null returnRequestNo (line 48 fallback)", async () => {
    const res = await handleProcessReplacement(mkCtxWithNullRequestNo(), {
      action: "process_replacement",
    } as ReturnActionBody);
    // Some validation error (no items, no order resolution), but withSpan opened first.
    expect((res as Response).status).toBeGreaterThanOrEqual(400);
  });

  it("handleRefreshFyndDetails accepts null returnRequestNo (line 14 fallback)", async () => {
    // Without Fynd config the handler throws a redirect Response. The
    // withSpan attributes (incl. `returnRequestNo || ""`) evaluate first.
    await expect(
      handleRefreshFyndDetails(mkCtxWithNullRequestNo(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
  });
});
