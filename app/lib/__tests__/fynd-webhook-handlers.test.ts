import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Deep tests for processFyndWebhook in fynd-webhook.server.ts.
 *
 * The function orchestrates: identifier extraction → multi-strategy lookup →
 * customer/shipping backfill → bag_status_history backfill → session lookup →
 * Shopify order resolution → refund classification (in_progress / complete /
 * auto_refund / journey) → event + log persistence.
 *
 * Companion to fynd-webhook.pure.test.ts (pure helpers). This file mocks
 * Prisma + Shopify admin + notification side effects and asserts on
 * action outcomes, returnEvent rows, logWebhook calls, and createRefund
 * payload shape across success / failure branches.
 */

const {
  prismaMock,
  createAdminClientMock,
  createRefundMock,
  closeShopifyReturnBestEffortMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  extractShopifyOrderNumberVariantsMock,
  withRestCredentialsMock,
  sendRefundNotificationMock,
  isLikelyFyndIdMock,
} = vi.hoisted(() => ({
  prismaMock: {
    returnCase: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    returnEvent: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    fyndOrderMapping: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    shop: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    session: {
      findFirst: vi.fn(),
    },
    shopSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    fyndWebhookLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
  createAdminClientMock: vi.fn().mockReturnValue({ kind: "admin-client" }),
  createRefundMock: vi.fn(),
  closeShopifyReturnBestEffortMock: vi.fn().mockResolvedValue(undefined),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  extractShopifyOrderNumberVariantsMock: vi.fn((s: string) => [s.replace(/^#/, "")]),
  withRestCredentialsMock: vi.fn((c: unknown) => c),
  sendRefundNotificationMock: vi.fn().mockResolvedValue(undefined),
  isLikelyFyndIdMock: vi.fn().mockReturnValue(false),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../shopify-admin.server", () => ({
  createAdminClient: createAdminClientMock,
  createRefund: createRefundMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  extractShopifyOrderNumberVariants: extractShopifyOrderNumberVariantsMock,
  withRestCredentials: withRestCredentialsMock,
}));

vi.mock("../notification.server", () => ({
  sendRefundNotification: sendRefundNotificationMock,
}));

vi.mock("../fynd-payload.server", () => ({
  isLikelyFyndId: isLikelyFyndIdMock,
}));

import { processFyndWebhook, type FyndWebhookPayload } from "../fynd-webhook.server";

// ─── Test helpers ───────────────────────────────────────────────────────────

type ReturnCaseFixture = {
  id: string;
  shopId: string;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  fyndShipmentId: string | null;
  fyndOrderId: string | null;
  fyndCurrentStatus: string | null;
  fyndSyncStatus: string | null;
  refundStatus: string | null;
  status: string;
  customerName: string | null;
  customerEmailNorm: string | null;
  returnLabelJson: string | null;
  items: Array<{
    shopifyLineItemId: string;
    qty: number;
    sku?: string | null;
    title?: string | null;
  }>;
  shop: { id: string; shopDomain: string };
};

function mkReturnCase(over: Partial<ReturnCaseFixture> = {}): ReturnCaseFixture {
  // Use `in`-checks so callers can pass `null` explicitly for fields that
  // also have a non-null default — e.g. `fyndShipmentId: null` must NOT
  // collapse back to "SHIP-1" via the `??` fallback.
  const pick = <K extends keyof ReturnCaseFixture>(
    k: K,
    dflt: ReturnCaseFixture[K],
  ): ReturnCaseFixture[K] => (k in over ? (over[k] as ReturnCaseFixture[K]) : dflt);
  return {
    id: pick("id", "rc-1"),
    shopId: pick("shopId", "shop-1"),
    shopifyOrderId: pick("shopifyOrderId", "gid://shopify/Order/100"),
    shopifyOrderName: pick("shopifyOrderName", "#1001"),
    fyndShipmentId: pick("fyndShipmentId", "SHIP-1"),
    fyndOrderId: pick("fyndOrderId", "FY-1"),
    fyndCurrentStatus: pick("fyndCurrentStatus", null),
    fyndSyncStatus: pick("fyndSyncStatus", "synced"),
    refundStatus: pick("refundStatus", null),
    status: pick("status", "approved"),
    customerName: pick("customerName", "Jane"),
    customerEmailNorm: pick("customerEmailNorm", "jane@example.com"),
    returnLabelJson: pick("returnLabelJson", null),
    items: pick("items", [{ shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 }]),
    shop: pick("shop", { id: "shop-1", shopDomain: "test.myshopify.com" }),
  };
}

function mkSession() {
  return { id: "sess-1", shop: "test.myshopify.com", isOnline: false, accessToken: "tok" };
}

function mkPayload(over: Partial<FyndWebhookPayload> = {}): FyndWebhookPayload {
  return {
    shipment_id: "SHIP-1",
    order_id: "FY-1",
    refund_status: over.refund_status ?? "bag_picked",
    ...over,
  } as FyndWebhookPayload;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default behaviours that vi.clearAllMocks resets.
  prismaMock.returnCase.findFirst.mockResolvedValue(null);
  prismaMock.returnCase.findMany.mockResolvedValue([]);
  prismaMock.returnCase.update.mockResolvedValue({});
  prismaMock.returnCase.updateMany.mockResolvedValue({});
  prismaMock.returnEvent.create.mockResolvedValue({});
  prismaMock.returnEvent.findMany.mockResolvedValue([]);
  prismaMock.fyndOrderMapping.findFirst.mockResolvedValue(null);
  prismaMock.fyndOrderMapping.upsert.mockResolvedValue({});
  prismaMock.shop.findUnique.mockResolvedValue(null);
  prismaMock.shopSettings.findUnique.mockResolvedValue(null);
  prismaMock.fyndWebhookLog.create.mockResolvedValue({});
  prismaMock.session.findFirst.mockResolvedValue(mkSession());
  createAdminClientMock.mockReturnValue({ kind: "admin-client" });
  withRestCredentialsMock.mockImplementation((c: unknown) => c);
  fetchOrderMock.mockResolvedValue({
    id: "gid://shopify/Order/100",
    name: "#1001",
    lineItems: [{ id: "gid://shopify/LineItem/1", quantity: 1, sku: "SKU1", title: "Widget" }],
    fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
    paymentGatewayNames: ["shopify_payments"],
    displayFinancialStatus: "PAID",
  });
  fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockResolvedValue(null);
  createRefundMock.mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/500",
    refundAmount: "10.00",
    refundCurrency: "USD",
    refundCreatedAt: "2026-05-05T00:00:00Z",
    refundMethod: "original",
  });
  isLikelyFyndIdMock.mockReturnValue(false);
});

// ─── Identifier extraction / lookup ─────────────────────────────────────────

describe("processFyndWebhook — identifier handling", () => {
  it("ignores webhooks with no extractable identifiers", async () => {
    const r = await processFyndWebhook({} as FyndWebhookPayload);
    expect(r).toEqual({ ok: true, action: "ignored", returnCaseId: undefined });
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ignored",
          error: expect.stringContaining("No shipment/order ID found"),
        }),
      }),
    );
  });

  it("ignores when no return case matches via any strategy", async () => {
    const r = await processFyndWebhook(mkPayload());
    expect(r.ok).toBe(true);
    expect((r as { action: string }).action).toBe("ignored");
    // Strategy 1 (shipment) and 2 (orderIds) both fired
    expect(prismaMock.returnCase.findFirst).toHaveBeenCalled();
  });

  it("looks up by fyndShipmentId first", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    expect(prismaMock.returnCase.findFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { fyndShipmentId: "SHIP-1" } }),
    );
  });

  it("falls back to fyndOrderId when shipment lookup misses", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst
      .mockResolvedValueOnce(null) // shipment lookup
      .mockResolvedValueOnce(rc); // order lookup
    await processFyndWebhook(mkPayload({ shipment_id: undefined, order_id: "FY-1" }));
    expect(prismaMock.returnCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { fyndOrderId: "FY-1" } }),
    );
  });

  it("uses FyndOrderMapping reverse lookup as strategy 3", async () => {
    // Strategy 1 (shipment) + Strategy 2 (loop over orderIds: AFF-9, FY-1) → 3 nulls
    prismaMock.returnCase.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce({
      shopId: "shop-1",
      shopifyOrderName: "#1001",
    });
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(
      mkPayload({ refund_status: "bag_picked", affiliate_order_id: "AFF-9" }),
    );
    expect(prismaMock.fyndOrderMapping.findFirst).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });

  it("uses shopifyOrderName variant matching as strategy 4", async () => {
    // shipment_id absent → strategy 1 skipped. orderIds = [STORE-1001, FY-1].
    // Strategy 2 loops both → 2 nulls. Strategy 3 mapping null. Strategy 4
    // calls extractShopifyOrderNumberVariants and finds rc.
    prismaMock.returnCase.findFirst
      .mockResolvedValueOnce(null) // strategy 2 oid 1
      .mockResolvedValueOnce(null); // strategy 2 oid 2
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    const rc = mkReturnCase();
    extractShopifyOrderNumberVariantsMock.mockReturnValueOnce(["1001"]);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(
      mkPayload({ shipment_id: undefined, affiliate_order_id: "STORE-1001" }),
    );
    expect(extractShopifyOrderNumberVariantsMock).toHaveBeenCalledWith("STORE-1001");
  });

  it("falls back to case-insensitive fyndOrderId match (strategy 5)", async () => {
    prismaMock.returnCase.findFirst
      .mockResolvedValueOnce(null) // ship
      .mockResolvedValueOnce(null) // order
      .mockResolvedValueOnce(null) // strategy 4 variant
      .mockResolvedValueOnce(null); // strategy 4 #variant
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ shipment_id: undefined, affiliate_order_id: "AFF-X" }));
    // Strategy 5 fires with case-insensitive equals
    const calls = prismaMock.returnCase.findFirst.mock.calls;
    const hasInsensitive = calls.some(
      (c) =>
        JSON.stringify(c[0]).includes('"mode":"insensitive"') &&
        JSON.stringify(c[0]).includes("fyndOrderId"),
    );
    expect(hasInsensitive).toBe(true);
  });

  it("matches on shopifyOrderId when payload contains a Shopify GID", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    const rc = mkReturnCase();
    // Strategy 7 should hit eventually
    prismaMock.returnCase.findFirst.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { shopifyOrderId?: string } };
      if (a.where?.shopifyOrderId === "gid://shopify/Order/999") return rc;
      return null;
    });
    const r = await processFyndWebhook(
      mkPayload({ shipment_id: undefined, order_id: "gid://shopify/Order/999" }),
    );
    expect(r.ok).toBe(true);
  });

  it("matches on shopifyOrderId when payload contains numeric Shopify ID", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { shopifyOrderId?: string } };
      if (a.where?.shopifyOrderId === "gid://shopify/Order/12345") return rc;
      return null;
    });
    await processFyndWebhook(mkPayload({ shipment_id: undefined, order_id: "12345" }));
    // Verify the strategy 7 call shape happened
    const calls = prismaMock.returnCase.findFirst.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.some((s) => s.includes("gid://shopify/Order/12345"))).toBe(true);
  });

  it("matches via shop-scoped lookup using payload _shop_domain (strategy 8)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x.myshopify.com",
    });
    const rc = mkReturnCase();
    extractShopifyOrderNumberVariantsMock.mockReturnValueOnce(["2001"]);
    prismaMock.returnCase.findFirst.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { shopId?: string } };
      if (a.where?.shopId === "shop-1") return rc;
      return null;
    });
    await processFyndWebhook(
      mkPayload({
        shipment_id: undefined,
        affiliate_order_id: "AFF-2001",
        _shop_domain: "x.myshopify.com",
      }),
    );
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith({
      where: { shopDomain: "x.myshopify.com" },
    });
  });
});

// ─── Session / refund_in_progress ───────────────────────────────────────────

describe("processFyndWebhook — refund_in_progress branch", () => {
  it("returns error when no offline session exists", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_initiated" }));
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("No offline session"),
    });
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error" }),
      }),
    );
  });

  it("flips refundStatus to in_progress on refund_initiated", async () => {
    const rc = mkReturnCase({ refundStatus: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_initiated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_in_progress" });
    const updateCalls = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const flipped = updateCalls.some(
      (u) => (u as { data?: { refundStatus?: string } }).data?.refundStatus === "in_progress",
    );
    expect(flipped).toBe(true);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "refund_in_progress" }),
      }),
    );
  });

  it("idempotent on duplicate refund_initiated when already in_progress", async () => {
    const rc = mkReturnCase({ refundStatus: "in_progress" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_pending" }));
    expect(r.ok).toBe(true);
    expect((r as { action: string }).action).toBe("refund_in_progress");
    // The event payload should mark idempotent: true
    const eventCalls = prismaMock.returnEvent.create.mock.calls;
    const idempotent = eventCalls.some((c) => {
      const data = (c[0] as { data?: { eventType?: string; payloadJson?: string } }).data;
      return (
        data?.eventType === "refund_in_progress" &&
        (data?.payloadJson ?? "").includes('"idempotent":true')
      );
    });
    expect(idempotent).toBe(true);
  });

  it("logs refund_in_progress webhook with shopDomain and refund status", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "refund_pending" }));
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "refund_in_progress",
          shopDomain: "test.myshopify.com",
          refundStatus: "refund_pending",
        }),
      }),
    );
  });
});

// ─── Refund completed branch ────────────────────────────────────────────────

describe("processFyndWebhook — refund_completed branch", () => {
  it("processes Shopify refund on refund_done and marks completed", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed", returnCaseId: "rc-1" });
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/100",
      [{ id: "gid://shopify/LineItem/1", quantity: 1 }],
      expect.stringContaining("Refund processed via Fynd webhook"),
      expect.anything(),
      expect.anything(),
    );
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalled();
    expect(sendRefundNotificationMock).toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "refund_processed" }),
      }),
    );
  });

  it("handles 'manual:' shopifyOrderId without calling createRefund", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "manual:abc" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refunded" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "refund_marked_complete" }),
      }),
    );
    expect(sendRefundNotificationMock).toHaveBeenCalled();
  });

  it("returns error when no Shopify orderId can be resolved", async () => {
    const rc = mkReturnCase({ shopifyOrderId: null, shopifyOrderName: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("Could not determine Shopify order"),
    });
  });

  it("treats 'already refunded' Shopify error as success and marks complete", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    createRefundMock.mockResolvedValueOnce({
      success: false,
      error: "Order has already been refunded for this amount",
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "refund_already_done" }),
      }),
    );
  });

  it("returns error on generic Shopify refund failure", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    createRefundMock.mockResolvedValueOnce({ success: false, error: "Insufficient funds" });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toEqual({ ok: false, error: "Insufficient funds" });
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error", error: "Insufficient funds" }),
      }),
    );
  });

  it("skips refund when already refunded (idempotent)", async () => {
    const rc = mkReturnCase({ refundStatus: "refunded" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it("backfills shopifyOrderId from fetchOrderByFyndAffiliateId", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "store-1001", shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/777",
      name: "#1001",
      lineItems: [{ id: "gid://shopify/LineItem/lookup-1", quantity: 2 }],
    });
    const r = await processFyndWebhook(
      mkPayload({ refund_status: "refund_done", affiliate_order_id: "STORE-1001" }),
    );
    expect(r.ok).toBe(true);
    // The backfill update should have set shopifyOrderId
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(updates.some((u) => u.includes("gid://shopify/Order/777"))).toBe(true);
  });

  it("falls back to COD store_credit method when payment is COD", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundLocationId: null,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/1", quantity: 1 }],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["Cash on Delivery (COD)"],
      displayFinancialStatus: "PENDING",
    });
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ method: "store_credit" }),
    );
  });

  it("uses configured refundLocationId from shopSettings", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundLocationId: "gid://shopify/Location/CONFIG",
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "gid://shopify/Location/CONFIG",
      expect.anything(),
    );
  });

  it("resolves non-GID line items via SKU match", async () => {
    const rc = mkReturnCase({
      items: [{ shopifyLineItemId: "fynd-bag-1", qty: 1, sku: "WIDGET-A" }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [
        { id: "gid://shopify/LineItem/REAL", quantity: 5, sku: "WIDGET-A", title: "Widget A" },
        { id: "gid://shopify/LineItem/OTHER", quantity: 5, sku: "OTHER", title: "Other" },
      ],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [{ id: "gid://shopify/LineItem/REAL", quantity: 1 }],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ─── Auto-refund (credit_note_generated) ────────────────────────────────────

describe("processFyndWebhook — auto-refund branch", () => {
  it("auto-refunds when autoRefundEnabled + credit_note_generated", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      refundLocationId: null,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
      allowedFyndStatusesForRefund: null,
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining("Auto-refund triggered by Fynd credit note"),
      expect.anything(),
      expect.anything(),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "auto_refund_processed" }),
      }),
    );
  });

  it("does NOT auto-refund when autoRefundEnabled is off — emits credit_note_generated event", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: false,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "credit_note_generated" }),
      }),
    );
  });

  it("blocks auto-refund when fyndCurrentStatus is not in allowed list", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "bag_picked" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      allowedFyndStatusesForRefund: JSON.stringify(["return_accepted"]),
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "auto_refund_blocked_by_status_gate",
        }),
      }),
    );
  });

  it("allows auto-refund when fyndCurrentStatus matches allowed list", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "return_accepted" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      allowedFyndStatusesForRefund: JSON.stringify(["return_accepted", "delivery_done"]),
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(createRefundMock).toHaveBeenCalled();
  });

  it("fails closed (blocks refund) on malformed allowedFyndStatusesForRefund JSON", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "return_accepted" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      allowedFyndStatusesForRefund: "{not-json",
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "auto_refund_blocked_by_config_error",
        }),
      }),
    );
  });

  it("logs auto_refund_failed event when createRefund fails during auto-refund", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
      allowedFyndStatusesForRefund: null,
    });
    createRefundMock.mockResolvedValueOnce({ success: false, error: "Gateway timeout" });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    // After the auto-refund attempt fails, control falls through to journey
    // status processing — final action should be status_noted.
    expect(r.ok).toBe(true);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "auto_refund_failed" }),
      }),
    );
  });
});

// ─── Journey status / dedup ─────────────────────────────────────────────────

describe("processFyndWebhook — journey status updates", () => {
  it("returns status_updated for known journey statuses", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    expect(r).toMatchObject({ ok: true, action: "status_updated" });
  });

  it("returns status_noted for unrecognized statuses", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook(mkPayload({ refund_status: "weird_unknown_status" }));
    expect(r).toMatchObject({ ok: true, action: "status_noted" });
  });

  it("advances ReturnCase.status to 'in progress' on bag_picked", async () => {
    const rc = mkReturnCase({ status: "approved" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const advanced = updates.some(
      (u) => (u as { data?: { status?: string } }).data?.status === "in progress",
    );
    expect(advanced).toBe(true);
  });

  it("does NOT downgrade fyndCurrentStatus when out-of-order webhook arrives", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "return_completed" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    // No update should set fyndCurrentStatus back to bag_picked
    const downgraded = updates.some(
      (u) =>
        (u as { data?: { fyndCurrentStatus?: string } }).data?.fyndCurrentStatus === "bag_picked",
    );
    expect(downgraded).toBe(false);
  });

  it("propagates fyndCurrentStatus to sibling return cases sharing fyndShipmentId", async () => {
    const rc = mkReturnCase({ fyndShipmentId: "SHIP-MULTI", fyndCurrentStatus: "bag_confirmed" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-2", fyndCurrentStatus: "bag_confirmed" },
      { id: "rc-3", fyndCurrentStatus: "return_completed" }, // already further along — should NOT advance
    ]);
    await processFyndWebhook(mkPayload({ shipment_id: "SHIP-MULTI", refund_status: "bag_picked" }));
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["rc-2"] } },
        data: { fyndCurrentStatus: "bag_picked" },
      }),
    );
  });

  it("transitions fyndSyncStatus from 'processing' to 'synced' on any webhook receipt", async () => {
    const rc = mkReturnCase({ fyndSyncStatus: "processing" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const synced = updates.some(
      (u) => (u as { data?: { fyndSyncStatus?: string } }).data?.fyndSyncStatus === "synced",
    );
    expect(synced).toBe(true);
  });

  it("emits a timeline event with humanized eventType for journey statuses", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "return_initiated" }));
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "return initiated" }),
      }),
    );
  });
});

// ─── Backfill behaviours ────────────────────────────────────────────────────

describe("processFyndWebhook — backfill", () => {
  it("backfills missing fyndShipmentId / fyndOrderId from payload", async () => {
    const rc = mkReturnCase({ fyndShipmentId: null, fyndOrderId: null });
    prismaMock.returnCase.findFirst
      .mockResolvedValueOnce(null) // shipmentId lookup
      .mockResolvedValueOnce(rc); // orderId lookup
    await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => JSON.stringify(c[0]));
    const backfilled = updates.some(
      (u) => u.includes('"fyndShipmentId":"SHIP-1"') && u.includes('"fyndOrderId":"FY-1"'),
    );
    expect(backfilled).toBe(true);
  });

  it("backfills customer info from delivery_address when missing", async () => {
    const rc = mkReturnCase({ customerName: null, customerEmailNorm: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(
      mkPayload({
        refund_status: "bag_picked",
        delivery_address: {
          first_name: "Alice",
          last_name: "Doe",
          email: "ALICE@Example.com",
          phone: "+19999",
          city: "Mumbai",
        },
      }),
    );
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const backfilled = updates.some((u) => {
      const d = (u as { data?: Record<string, unknown> }).data ?? {};
      return d.customerName === "Alice Doe" && d.customerEmailNorm === "alice@example.com";
    });
    expect(backfilled).toBe(true);
  });

  it("upserts FyndOrderMapping for future track-order lookups", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(
      mkPayload({ refund_status: "bag_picked", affiliate_order_id: "AFF-X" }),
    );
    expect(prismaMock.fyndOrderMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shopId_shopifyOrderName: { shopId: "shop-1", shopifyOrderName: "#1001" },
        },
      }),
    );
  });

  it("backfills missing journey statuses from bag_status_history", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([]); // no existing events
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "delivery_done",
      bags: [
        {
          bag_status_history: [
            { bag_state_mapper: { name: "bag_packed" }, updated_at: "2026-05-01T00:00:00Z" },
            { bag_state_mapper: { name: "bag_picked" }, updated_at: "2026-05-02T00:00:00Z" },
          ],
        },
      ],
    } as FyndWebhookPayload);
    const eventCalls = prismaMock.returnEvent.create.mock.calls;
    const backfillEvents = eventCalls.filter((c) => {
      const data = (c[0] as { data?: { eventType?: string } }).data;
      return data?.eventType === "status_backfill";
    });
    expect(backfillEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("dedupes bag_status_history backfill against existing events", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      { payloadJson: JSON.stringify({ fynd_status: "bag_packed" }) },
    ]);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "delivery_done",
      bags: [
        {
          bag_status_history: [
            { bag_state_mapper: { name: "bag_packed" } },
            { bag_state_mapper: { name: "bag_picked" } },
          ],
        },
      ],
    } as FyndWebhookPayload);
    const backfillEvents = prismaMock.returnEvent.create.mock.calls.filter((c) => {
      const data = (c[0] as { data?: { eventType?: string; payloadJson?: string } }).data;
      return data?.eventType === "status_backfill";
    });
    // Only bag_picked should be created — bag_packed was already seen
    expect(backfillEvents.length).toBe(1);
    const created = (backfillEvents[0][0] as { data: { payloadJson: string } }).data;
    expect(created.payloadJson).toContain("bag_picked");
  });

  it("stores returnLabelJson with carrier + AWB on return-journey shipping events", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "return_dp_assigned",
      delivery_partner_details: {
        display_name: "Delhivery",
        awb_no: "AWB-RETURN-1",
        tracking_url: "https://t.example/AWB-RETURN-1",
      },
    } as FyndWebhookPayload);
    // returnLabelJson is itself a JSON-string field on the update — inspect
    // the raw object instead of double-stringifying.
    const updateData = prismaMock.returnCase.update.mock.calls
      .map((c) => (c[0] as { data?: Record<string, unknown> }).data ?? {})
      .find((d) => typeof d.returnLabelJson === "string") as
      | { returnLabelJson?: string; returnAwb?: string }
      | undefined;
    expect(updateData).toBeDefined();
    expect(updateData?.returnAwb).toBe("AWB-RETURN-1");
    const labelJson = JSON.parse(updateData!.returnLabelJson!) as Record<string, unknown>;
    expect(labelJson.trackingNumber).toBe("AWB-RETURN-1");
    expect(labelJson.carrier).toBe("Delhivery");
    expect(labelJson.source).toBe("fynd_webhook");
  });

  it("routes AWB to forwardAwb on forward-journey shipping events", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "bag_picked",
      delivery_partner_details: {
        display_name: "BlueDart",
        awb_no: "AWB-FWD-1",
      },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-FWD-1")).toBe(true);
    // Forward AWB should NOT be written to returnAwb or returnLabelJson
    expect(updateDatas.every((d) => d.returnAwb === undefined)).toBe(true);
    expect(updateDatas.every((d) => d.returnLabelJson === undefined)).toBe(true);
  });
});

// ─── Tolerance / fault-injection ────────────────────────────────────────────

describe("processFyndWebhook — error tolerance", () => {
  it("survives logWebhook failures", async () => {
    prismaMock.fyndWebhookLog.create.mockRejectedValueOnce(new Error("DB down"));
    const r = await processFyndWebhook({} as FyndWebhookPayload);
    // Should still complete — failure to log is non-fatal
    expect(r.ok).toBe(true);
  });

  it("survives FyndOrderMapping upsert errors", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.fyndOrderMapping.upsert.mockRejectedValueOnce(new Error("unique violation"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "bag_picked" }));
    expect(r.ok).toBe(true);
  });

  it("survives sibling propagation errors", async () => {
    const rc = mkReturnCase({ fyndShipmentId: "SHIP-MULTI", fyndCurrentStatus: "bag_confirmed" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("DB hiccup"));
    const r = await processFyndWebhook(
      mkPayload({ shipment_id: "SHIP-MULTI", refund_status: "bag_picked" }),
    );
    expect(r.ok).toBe(true);
  });

  it("survives bag_status_history backfill errors", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnEvent.findMany.mockRejectedValueOnce(new Error("query failed"));
    const r = await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "bag_picked",
      bags: [{ bag_status_history: [{ bag_state_mapper: { name: "bag_packed" } }] }],
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
  });

  it("survives notification errors silently", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("SMTP down"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });
});
