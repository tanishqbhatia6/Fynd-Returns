import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Targeted coverage for the auto-refund order resolution branch in
 * processFyndWebhook (fynd-webhook.server.ts) — specifically lines around
 * 1360, 1366, and 1405 which exercise:
 *
 *  - resolving a non-GID, non-numeric shopifyOrderId via
 *    fetchOrderByFyndAffiliateId(shopifyOrderName) (1360)
 *  - falling through to fetchOrderByFyndAffiliateId(affiliateOrderId) when
 *    earlier lookups by name and id both miss (1366)
 *  - the else-branch where lineItemsForRefund is empty AND there are no
 *    non-GID auto items, so we copy order.lineItems wholesale (1405)
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

import { processFyndWebhook, unwrapFyndWebhookPayload, type FyndWebhookPayload } from "../fynd-webhook.server";

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
  items: Array<{ shopifyLineItemId: string; qty: number; sku?: string | null; title?: string | null }>;
  shop: { id: string; shopDomain: string };
};

function mkReturnCase(over: Partial<ReturnCaseFixture> = {}): ReturnCaseFixture {
  const pick = <K extends keyof ReturnCaseFixture>(k: K, dflt: ReturnCaseFixture[K]): ReturnCaseFixture[K] =>
    (k in over ? (over[k] as ReturnCaseFixture[K]) : dflt);
  return {
    id: pick("id", "rc-auto-1"),
    shopId: pick("shopId", "shop-1"),
    // NON-gid, NON-numeric, NON-"manual:" id forces the resolution branch.
    shopifyOrderId: pick("shopifyOrderId", "FY-AFFILIATE-XYZ"),
    shopifyOrderName: pick("shopifyOrderName", "#1001"),
    fyndShipmentId: pick("fyndShipmentId", "SHIP-AUTO-1"),
    fyndOrderId: pick("fyndOrderId", "FY-AUTO-1"),
    fyndCurrentStatus: pick("fyndCurrentStatus", null),
    fyndSyncStatus: pick("fyndSyncStatus", "synced"),
    refundStatus: pick("refundStatus", null),
    status: pick("status", "approved"),
    customerName: pick("customerName", "Jane"),
    customerEmailNorm: pick("customerEmailNorm", null),
    returnLabelJson: pick("returnLabelJson", null),
    // Empty items → lineItemsForRefund starts as [] → triggers fetchOrder fallback (1405).
    items: pick("items", []),
    shop: pick("shop", { id: "shop-1", shopDomain: "test.myshopify.com" }),
  };
}

function mkSession() {
  return { id: "sess-1", shop: "test.myshopify.com", isOnline: false, accessToken: "tok" };
}

function mkAutoRefundPayload(over: Partial<FyndWebhookPayload> = {}): FyndWebhookPayload {
  return {
    shipment_id: "SHIP-AUTO-1",
    order_id: "FY-AUTO-1",
    affiliate_order_id: "AFF-9",
    refund_status: "credit_note_generated",
    ...over,
  } as FyndWebhookPayload;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.returnCase.findFirst.mockResolvedValue(null);
  prismaMock.returnCase.findMany.mockResolvedValue([]);
  prismaMock.returnCase.update.mockResolvedValue({});
  prismaMock.returnCase.updateMany.mockResolvedValue({});
  prismaMock.returnEvent.create.mockResolvedValue({});
  prismaMock.returnEvent.findMany.mockResolvedValue([]);
  prismaMock.fyndOrderMapping.findFirst.mockResolvedValue(null);
  prismaMock.fyndOrderMapping.upsert.mockResolvedValue({});
  prismaMock.shop.findUnique.mockResolvedValue(null);
  prismaMock.shopSettings.findUnique.mockResolvedValue({
    autoRefundEnabled: true,
    allowedFyndStatusesForRefund: null,
    refundLocationId: "gid://shopify/Location/1",
    refundPaymentMethod: "original",
    refundStoreCreditPct: 100,
  });
  prismaMock.fyndWebhookLog.create.mockResolvedValue({});
  prismaMock.session.findFirst.mockResolvedValue(mkSession());
  createAdminClientMock.mockReturnValue({ kind: "admin-client" });
  withRestCredentialsMock.mockImplementation((c: unknown) => c);
  fetchOrderMock.mockResolvedValue({
    id: "gid://shopify/Order/100",
    name: "#1001",
    lineItems: [
      { id: "gid://shopify/LineItem/1", quantity: 2, sku: "SKU1", title: "Widget" },
    ],
    fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
    paymentGatewayNames: ["shopify_payments"],
    displayFinancialStatus: "PAID",
  });
  fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockResolvedValue(null);
  createRefundMock.mockResolvedValue({
    success: true,
    refundId: "gid://shopify/Refund/500",
    refundAmount: "20.00",
    refundCurrency: "USD",
    refundCreatedAt: "2026-05-05T00:00:00Z",
    refundMethod: "original",
  });
  isLikelyFyndIdMock.mockReturnValue(false);
});

describe("processFyndWebhook — auto-refund order resolution branches", () => {
  it("resolves non-GID shopifyOrderId via fetchOrderByFyndAffiliateId(shopifyOrderName) [line 1360]", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      // 1) Upfront backfill by affiliateOrderId — return null so backfill skips.
      .mockResolvedValueOnce(null)
      // 2) Auto-refund block: lookup by shopifyOrderName succeeds.
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/200",
        lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      });
    const r = await processFyndWebhook(mkAutoRefundPayload());
    expect(r.ok).toBe(true);
    // 2nd call uses the order name (line 1360).
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(2, expect.anything(), "#1001");
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/200",
      expect.any(Array),
      expect.stringContaining("Auto-refund"),
      expect.any(String),
      expect.objectContaining({ method: "original" }),
    );
  });

  it("uses lineItems from resolved order when local items list is empty", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill skipped
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/200",
        lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 3 }],
      });
    // fetchOrder for the resolved GID returns the same lineItems (avoids
    // wholesale-copy overriding what the resolved order already provided).
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/200",
      lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 3 }],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
    });
    await processFyndWebhook(mkAutoRefundPayload());
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/200",
      [{ id: "gid://shopify/LineItem/9", quantity: 3 }],
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("falls back to fetchOrderByFyndAffiliateId(orderIdForRefund) when name lookup misses; rejection swallowed [line 1363 .catch]", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce(null) // by name → miss
      .mockRejectedValueOnce(new Error("orderIdForRefund boom")) // line 1363 .catch
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/300",
        lineItems: [{ id: "gid://shopify/LineItem/10", quantity: 1 }],
      });
    const r = await processFyndWebhook(mkAutoRefundPayload());
    // 3rd call uses orderIdForRefund (line 1363) which rejects via .catch.
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(3, expect.anything(), "FY-AFFILIATE-XYZ");
    // Auto-refund still recovers via the affiliate fallback (line 1366).
    expect(r.ok).toBe(true);
  });

  it("falls back to fetchOrderByFyndAffiliateId(affiliateOrderId) when name & id lookups both miss [line 1366]", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce(null) // by name
      .mockResolvedValueOnce(null) // by orderIdForRefund
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/400",
        lineItems: [{ id: "gid://shopify/LineItem/11", quantity: 1 }],
      });
    await processFyndWebhook(mkAutoRefundPayload({ affiliate_order_id: "AFF-9" }));
    // 4th call uses affiliateOrderId (line 1366).
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(4, expect.anything(), "AFF-9");
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/400",
      expect.any(Array),
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("affiliate fallback rejection at line 1366 is swallowed via .catch", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce(null) // by name
      .mockResolvedValueOnce(null) // by orderIdForRefund
      .mockRejectedValueOnce(new Error("affiliate lookup failed")); // line 1366 .catch path
    const r = await processFyndWebhook(mkAutoRefundPayload({ affiliate_order_id: "AFF-9" }));
    expect(r.ok).toBe(true);
    // 4th call did happen, but rejection is swallowed.
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(4, expect.anything(), "AFF-9");
  });

  it("uses items from local return case when present (skipping order.lineItems wholesale-copy)", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "gid://shopify/Order/500",
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/77", qty: 4 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkAutoRefundPayload());
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/500",
      [{ id: "gid://shopify/LineItem/77", quantity: 4 }],
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("with GID orderId + empty items, fetches order and copies all lineItems wholesale [line 1405]", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "gid://shopify/Order/600",
      items: [], // no local items → lineItemsForRefund.length === 0
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/600",
      lineItems: [
        { id: "gid://shopify/LineItem/A", quantity: 1, sku: "A", title: "Aaa" },
        { id: "gid://shopify/LineItem/B", quantity: 2, sku: "B", title: "Bbb" },
      ],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
    });
    await processFyndWebhook(mkAutoRefundPayload());
    // Both lineItems passed through wholesale.
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/600",
      [
        { id: "gid://shopify/LineItem/A", quantity: 1 },
        { id: "gid://shopify/LineItem/B", quantity: 2 },
      ],
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("with numeric shopifyOrderId + empty items, also wholesale-copies via fetchOrder", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "123456", items: [] });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "123456",
      lineItems: [{ id: "gid://shopify/LineItem/Z", quantity: 5 }],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
    });
    await processFyndWebhook(mkAutoRefundPayload());
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "123456",
      [{ id: "gid://shopify/LineItem/Z", quantity: 5 }],
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("skips order.lineItems wholesale copy when fetchOrder returns no lineItems", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "gid://shopify/Order/700",
      items: [],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/700",
      lineItems: [],
      fulfillments: [],
      paymentGatewayNames: [],
      displayFinancialStatus: "PAID",
    });
    await processFyndWebhook(mkAutoRefundPayload());
    // lineItemsForRefund stays empty → createRefund not invoked.
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it("skips order resolution branch when shopifyOrderId starts with manual:", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "manual:abc-123",
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/9", qty: 1 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    await processFyndWebhook(mkAutoRefundPayload());
    // Inside the auto-refund block the manual: prefix bypasses lines 1356-1374.
    // The upfront backfill (line 984) DOES still run because shopifyOrderId is
    // not a valid Shopify id, but it returns null so no state changes. We
    // assert that NO call was made with the order name (which is the 1360 path).
    const calledArgs = fetchOrderByFyndAffiliateIdMock.mock.calls.map((c) => c[1]);
    expect(calledArgs).not.toContain("#1001");
  });

  it("when name lookup succeeds and local items exist, does NOT overwrite lineItems with order.lineItems", async () => {
    const rc = mkReturnCase({
      shopifyOrderName: "#1001",
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/L1", qty: 2 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/800",
        lineItems: [{ id: "gid://shopify/LineItem/SHOULD_NOT_USE", quantity: 99 }],
      });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/800",
      lineItems: [{ id: "gid://shopify/LineItem/L1", quantity: 2 }],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
    });
    await processFyndWebhook(mkAutoRefundPayload());
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/800",
      [{ id: "gid://shopify/LineItem/L1", quantity: 2 }],
      expect.any(String),
      expect.any(String),
      expect.any(Object),
    );
  });

  it("auto-refund proceeds when shopifyOrderName lookup rejects (line 1360 .catch path)", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockRejectedValueOnce(new Error("name lookup boom")) // line 1360 .catch
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/900",
        lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      });
    const r = await processFyndWebhook(mkAutoRefundPayload());
    expect(r.ok).toBe(true);
  });

  it("with shopifyOrderName=null, line 1360 ternary picks the null branch (no call by name)", async () => {
    const rc = mkReturnCase({ shopifyOrderName: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce({
        // 2nd real call should be by orderIdForRefund (line 1363) — name path skipped.
        id: "gid://shopify/Order/1000",
        lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      });
    await processFyndWebhook(mkAutoRefundPayload());
    // 2nd call = orderIdForRefund, not the (null) order name.
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(2, expect.anything(), "FY-AFFILIATE-XYZ");
  });

  it("logs auto_refund_processed event when refund succeeds via resolved order", async () => {
    const rc = mkReturnCase({ shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/1100",
        lineItems: [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      });
    await processFyndWebhook(mkAutoRefundPayload());
    const events = prismaMock.returnEvent.create.mock.calls.map((c) => c[0].data.eventType);
    expect(events).toContain("auto_refund_processed");
  });

  // ─── Manual refund completion branch coverage (refund_done) ────────────────

  it("manual refund completion: name lookup rejection triggers .catch fallback then orderIdForRefund (lines 1087/1091)", async () => {
    const rc = mkReturnCase({
      shopifyOrderName: "#1001",
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/X", qty: 1 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockRejectedValueOnce(new Error("name boom")) // line 1087 .catch path
      .mockResolvedValueOnce({     // by orderIdForRefund (line 1091)
        id: "gid://shopify/Order/2000",
        lineItems: [{ id: "gid://shopify/LineItem/X", quantity: 1 }],
      });
    const r = await processFyndWebhook({
      shipment_id: "SHIP-AUTO-1",
      order_id: "FY-AUTO-1",
      affiliate_order_id: "AFF-9",
      refund_status: "refund_done",
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(2, expect.anything(), "#1001");
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(3, expect.anything(), "FY-AFFILIATE-XYZ");
  });

  it("manual refund completion: orderIdForRefund + affiliate_order_id rejections both swallowed (lines 1091/1095)", async () => {
    const rc = mkReturnCase({
      shopifyOrderName: "#1001",
      items: [{ shopifyLineItemId: "gid://shopify/LineItem/X", qty: 1 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // backfill
      .mockResolvedValueOnce(null) // by name
      .mockRejectedValueOnce(new Error("orderId boom")) // line 1091 .catch
      .mockRejectedValueOnce(new Error("affiliate boom")); // line 1095 .catch
    const r = await processFyndWebhook({
      shipment_id: "SHIP-AUTO-1",
      order_id: "FY-AUTO-1",
      affiliate_order_id: "AFF-9",
      refund_status: "refund_done",
    } as FyndWebhookPayload);
    // All lookups failed but orderIdForRefund remained non-null, so refund
    // proceeds via createRefund using the original (non-GID) id.
    expect(r.ok).toBe(true);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenNthCalledWith(4, expect.anything(), "AFF-9");
  });

  it("manual order with customerEmailNorm: notification rejection is swallowed by .catch (line 1062)", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "manual:abc-123",
      customerEmailNorm: "jane@example.com",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValue(null);
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await processFyndWebhook({
      shipment_id: "SHIP-AUTO-1",
      order_id: "FY-AUTO-1",
      refund_status: "refund_done",
    } as FyndWebhookPayload);
    // Allow microtasks to flush so the rejected .catch handler executes.
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.ok).toBe(true);
    expect(sendRefundNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "jane@example.com" }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Manual refund notification failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("unwrapFyndWebhookPayload: promotes nested shipment.{order,meta,affiliate_details,bags} fields (lines 483-504)", () => {
    // Top-level `shipment` object triggers the inner.shipment fallback block
    // at line 472, which then exercises the order/affiliate_details/meta/bags
    // promotion branches at 483-504.
    // Use `data` envelope so `shipment` survives at top-level of inner
    // (the `shipment` envelope branch would delete it; this routes through
    // the `data` envelope branch which doesn't touch inner.shipment).
    const raw = JSON.stringify({
      data: { kind: "envelope" },
      shipment: {
        order: {
          affiliate_order_id: "A-ORDER-1",
          fynd_order_id: "FY-O-1",
          order_id: "ORDER-X",
        },
        affiliate_details: { affiliate_order_id: "AFF-D-1" },
        meta: { affiliate_order_id: "META-1", order_id: "META-O-1", shipment_id: "META-S-1" },
        bags: [
          {
            affiliate_bag_details: {
              affiliate_order_id: "BAG-AO-1",
              affiliate_meta: { shop_domain: "shop.myshopify.com" },
            },
          },
        ],
      },
    });
    const result = unwrapFyndWebhookPayload(raw);
    expect(result.payload).toBeTruthy();
    const p = result.payload as Record<string, unknown>;
    // First-write-wins across the promotion branches; we just assert that
    // some affiliate_order_id and order_id were promoted into the inner.
    expect(p.affiliate_order_id).toBeTruthy();
    expect(p.order_id).toBeTruthy();
  });

  it("manual refund completion: with empty items, copies all order.lineItems wholesale (line 1154)", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "gid://shopify/Order/2200",
      items: [], // empty → triggers fetchOrder fallback at line 1126
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/2200",
      lineItems: [
        { id: "gid://shopify/LineItem/P", quantity: 7 },
        { id: "gid://shopify/LineItem/Q", quantity: 3 },
      ],
      fulfillments: [{ location: { id: "gid://shopify/Location/1" } }],
      paymentGatewayNames: ["shopify_payments"],
      displayFinancialStatus: "PAID",
    });
    const r = await processFyndWebhook({
      shipment_id: "SHIP-AUTO-1",
      order_id: "FY-AUTO-1",
      refund_status: "refund_done",
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
    // The else-branch at line 1154 wholesale-copies order.lineItems → both should appear.
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/2200",
      [
        { id: "gid://shopify/LineItem/P", quantity: 7 },
        { id: "gid://shopify/LineItem/Q", quantity: 3 },
      ],
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
  });
});
