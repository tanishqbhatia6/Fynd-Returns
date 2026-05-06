/**
 * Closure tests for fynd-webhook.server.ts — targets the remaining uncov
 * anonymous fns at lines 1012, 1053, 1209, 1261, 1343, 1348, 1468, 1506.
 *
 * All targets are either:
 *   - `.catch(() => {})` callbacks on fire-and-forget prisma writes, or
 *   - `logEvent: async (evt) => { … prisma.returnEvent.create(…).catch(() => {}) }`
 *     callbacks passed into `closeShopifyReturnBestEffort`.
 *
 * Each test forces the underlying promise to reject so the catch handler
 * fires (or invokes the supplied logEvent callback), and asserts the action
 * still completes successfully (the catch swallowed the error).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
    customerEmailNorm: pick("customerEmailNorm", null),
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
  closeShopifyReturnBestEffortMock.mockResolvedValue(undefined);
  isLikelyFyndIdMock.mockReturnValue(false);
});

describe("fynd-webhook closure — uncov anon fns", () => {
  // ─── Line 1012: idempotent refund_in_progress fyndCurrentStatus update ───
  it("line 1012: swallows rejection in idempotent fyndCurrentStatus update (refund already in_progress)", async () => {
    const rc = mkReturnCase({ refundStatus: "in_progress" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    // First update is the idempotent one at line 1012 — force it to reject.
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("idempotent update boom"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_pending" }));
    expect(r).toMatchObject({ ok: true, action: "refund_in_progress" });
  });

  // ─── Line 1053: manual refund — closeShopifyReturnBestEffort logEvent ───
  it("line 1053: logEvent in manual: refund_done branch swallows returnEvent.create rejection", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "manual:abc", refundStatus: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    // Force the closeShopifyReturnBestEffort mock to invoke the logEvent
    // callback so the inner `.catch(() => {})` arrow at line 1053 fires.
    closeShopifyReturnBestEffortMock.mockImplementationOnce(async (_admin, _rc, opts) => {
      // Make the underlying create reject so the .catch at line 1053 fires.
      prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("evt create boom"));
      await opts?.logEvent?.({ eventType: "shopify_return_closed", payloadJson: "{}" });
      return undefined;
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalled();
  });

  // ─── Line 1209: already-refunded path — closeShopifyReturnBestEffort logEvent ───
  it("line 1209: logEvent in already-refunded branch swallows returnEvent.create rejection", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    createRefundMock.mockResolvedValueOnce({
      success: false,
      error: "Order has already been refunded for this amount",
    });
    closeShopifyReturnBestEffortMock.mockImplementationOnce(async (_admin, _rc, opts) => {
      prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("evt create boom 1209"));
      await opts?.logEvent?.({ eventType: "shopify_return_closed", payloadJson: "{}" });
      return undefined;
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  // ─── Line 1261: refund_done success — closeShopifyReturnBestEffort logEvent ───
  it("line 1261: logEvent in refund_done success branch swallows returnEvent.create rejection", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    closeShopifyReturnBestEffortMock.mockImplementationOnce(async (_admin, _rc, opts) => {
      prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("evt create boom 1261"));
      await opts?.logEvent?.({ eventType: "shopify_return_closed", payloadJson: "{}" });
      return undefined;
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  // ─── Line 1343: malformed allowedFyndStatusesForRefund JSON ───
  it("line 1343: swallows rejection on auto_refund_blocked_by_config_error returnEvent.create", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "return_accepted" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      allowedFyndStatusesForRefund: "{not-json",
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    // The malformed-JSON branch creates an event then catches its rejection.
    // Force the very next returnEvent.create to reject so the catch at line
    // 1343 fires. (Subsequent creates after that resolve normally.)
    prismaMock.returnEvent.create.mockRejectedValueOnce(
      new Error("blocked-by-config-error create boom"),
    );
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toBeDefined();
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  // ─── Line 1348: blocked-by-gate fyndCurrentStatus update ───
  it("line 1348: swallows rejection on fyndCurrentStatus update when blocked by gate", async () => {
    const rc = mkReturnCase({ fyndCurrentStatus: "bag_picked" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      allowedFyndStatusesForRefund: JSON.stringify(["return_accepted"]),
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    // Force the fyndCurrentStatus update inside the autoRefundBlockedByGate
    // branch (line 1348) to reject so its `.catch(() => {})` fires.
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("blocked-gate update boom"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toBeDefined();
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  // ─── Line 1468: auto-refund logEvent ───
  it("line 1468: logEvent in auto-refund branch swallows returnEvent.create rejection", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: true,
      refundLocationId: null,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
      allowedFyndStatusesForRefund: null,
    });
    closeShopifyReturnBestEffortMock.mockImplementationOnce(async (_admin, _rc, opts) => {
      prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("evt create boom 1468"));
      await opts?.logEvent?.({ eventType: "shopify_return_closed", payloadJson: "{}" });
      return undefined;
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  // ─── Line 1506: auto-refund disabled → status update catch ───
  it("line 1506: swallows rejection on fyndCurrentStatus update when autoRefund disabled", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      autoRefundEnabled: false,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    // First update is the line-1506 .catch(() => {}) — force it to reject.
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("autoref-disabled update boom"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toBeDefined();
    expect(createRefundMock).not.toHaveBeenCalled();
  });
});
