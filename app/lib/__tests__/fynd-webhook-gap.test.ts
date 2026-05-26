import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Coverage-gap tests for fynd-webhook.server.ts. These exercise branches
 * NOT touched by the existing test files (handlers/api/unwrap/verify):
 *
 *  - extractShopDomain via meta.shop_domain / meta.channel_domain
 *  - detectJourneyType: rto_ prefix, _journey_type, meta.journey_type,
 *    out_for_pickup-style return statuses
 *  - unwrapFyndWebhookPayload: shipment_status flatten, firstShipment
 *    promotion (id/order_id/affiliate_order_id/external_order_id/
 *    channel_order_id/dp_details/tracking_url + nested order),
 *    inner.meta promotion, affiliate_details company_affiliate_tag,
 *    inner.shipment fallback (full block lines 472-523), nested status
 *    object handling, eventType string fallback
 *  - processFyndWebhook: strategy 8 shipment fallback, customer
 *    address backfill (city/country/address1/province/zip), existing
 *    returnLabelJson merge, fynd_refund_status seenStatus, manual:
 *    refund close logEvent, fetchOrderByFyndAffiliateId via orderId/
 *    affiliateOrderId fallback, line item resolution by SKU/title
 *    inside auto-refund, COD store_credit override in auto-refund,
 *    auto-refund close + notification, status advance to approved/completed
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
    returnItem: {
      findFirst: vi.fn().mockResolvedValue(null),
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

import {
  processFyndWebhook,
  unwrapFyndWebhookPayload,
  type FyndWebhookPayload,
} from "../fynd-webhook.server";

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
  prismaMock.returnCase.findFirst.mockResolvedValue(null);
  prismaMock.returnCase.findMany.mockResolvedValue([]);
  prismaMock.returnCase.update.mockResolvedValue({});
  prismaMock.returnCase.updateMany.mockResolvedValue({});
  prismaMock.returnEvent.create.mockResolvedValue({});
  prismaMock.returnEvent.findMany.mockResolvedValue([]);
  prismaMock.returnItem.findFirst.mockResolvedValue(null);
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

// ───────────────────────────────────────────────────────────────────────────
// unwrapFyndWebhookPayload — branch coverage
// ───────────────────────────────────────────────────────────────────────────

describe("unwrapFyndWebhookPayload — gap coverage", () => {
  it("flattens shipment_status nested fields when present", () => {
    const raw = JSON.stringify({
      shipment_status: {
        shipment_id: "SS-SHIP",
        status: "return_bag_picked",
        order_id: "SS-ORDER",
        affiliate_order_id: "SS-AFF",
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.shipment_id).toBe("SS-SHIP");
    expect(payload.status).toBe("return_bag_picked");
    expect(payload.order_id).toBe("SS-ORDER");
    expect(payload.affiliate_order_id).toBe("SS-AFF");
  });

  it("promotes id/order_id/affiliate_order_id/external_order_id/channel_order_id from firstShipment", () => {
    const raw = JSON.stringify({
      shipments: [
        {
          id: "SHIPMENT-INNER",
          order_id: "ORD-A",
          affiliate_order_id: "AFF-A",
          external_order_id: "EXT-A",
          channel_order_id: "CHN-A",
          dp_details: { display_name: "Carrier-A" },
          tracking_url: "https://t.example/A",
        },
      ],
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.id).toBe("SHIPMENT-INNER");
    expect(payload.order_id).toBe("ORD-A");
    expect(payload.affiliate_order_id).toBe("AFF-A");
    expect(payload.external_order_id).toBe("EXT-A");
    expect(payload.channel_order_id).toBe("CHN-A");
    expect((payload as Record<string, unknown>).dp_details).toBeDefined();
    expect(payload.tracking_url).toBe("https://t.example/A");
  });

  it("promotes fields from firstShipment.order including order_id and fynd_order_id", () => {
    const raw = JSON.stringify({
      shipments: [
        {
          shipment_id: "SHIP-X",
          order: {
            affiliate_order_id: "AFF-NESTED",
            order_id: "FALLBACK-ORDER",
          },
        },
      ],
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.affiliate_order_id).toBe("AFF-NESTED");
    expect(payload.order_id).toBe("FALLBACK-ORDER");
  });

  it("promotes ids from inner.meta when missing top-level", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      meta: {
        order_id: "META-ORDER",
        affiliate_order_id: "META-AFF",
        external_order_id: "META-EXT",
        channel_order_id: "META-CHN",
        shipment_id: "META-SHIP",
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.order_id).toBe("META-ORDER");
    expect(payload.affiliate_order_id).toBe("META-AFF");
    expect(payload.external_order_id).toBe("META-EXT");
    expect(payload.channel_order_id).toBe("META-CHN");
    // shipment_id was already set, top-level wins
    expect(payload.shipment_id).toBe("SH-1");
  });

  it("promotes shipment_id from meta when top-level absent", () => {
    const raw = JSON.stringify({
      order_id: "O1",
      meta: { shipment_id: "META-ONLY-SHIP" },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.shipment_id).toBe("META-ONLY-SHIP");
  });

  it("promotes company_affiliate_tag from affiliate_details", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      affiliate_details: { company_affiliate_tag: "TAG-XYZ" },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect((payload as Record<string, unknown>).company_affiliate_tag).toBe("TAG-XYZ");
  });

  it("handles inner.shipment fallback object (full promotion block)", () => {
    // Send `shipment` as object alongside top-level id so unwrap base falls
    // through (not picked up as envelope because top-level id wins on spread).
    // After envelope unwrap, inner still has `shipment` object that triggers
    // the fallback promotion block on lines 472-523.
    const raw = JSON.stringify({
      data: { foo: "bar" }, // pick `data` envelope so `shipment` stays in inner
      shipment: {
        shipment_id: "SHIP-FALLBACK",
        id: "SHIP-FB-ID",
        order_id: "ORD-FB",
        affiliate_order_id: "AFF-FB",
        external_order_id: "EXT-FB",
        channel_order_id: "CHN-FB",
        order: {
          affiliate_order_id: "ORD-AFF-FB",
          fynd_order_id: "FYND-FB",
          order_id: "DBL-FB",
        },
        affiliate_details: { affiliate_order_id: "ADX-FB" },
        meta: {
          affiliate_order_id: "MAFF-FB",
          order_id: "MORD-FB",
          shipment_id: "MSHIP-FB",
        },
        bags: [
          {
            affiliate_bag_details: {
              affiliate_order_id: "BAG-AFF-FB",
              affiliate_meta: { shop_domain: "fb.myshopify.com" },
            },
          },
        ],
        delivery_partner_details: { awb_no: "FB-AWB", tracking_url: "https://t.example/FB" },
        dp_details: { name: "FB-DP" },
        delivery_address: { name: "Bob" },
        billing_address: { name: "Bob B" },
        status: "return_bag_picked",
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    // Top-level id should be set from inner.shipment fallback path
    expect(payload.shipment_id).toBe("SHIP-FALLBACK");
    // Order/affiliate ids should come from outer-most s.* first wins
    expect(payload.order_id).toBe("ORD-FB");
    expect(payload.affiliate_order_id).toBe("AFF-FB");
    expect(payload.external_order_id).toBe("EXT-FB");
    expect(payload.channel_order_id).toBe("CHN-FB");
    expect(payload.delivery_partner_details).toBeDefined();
    expect(payload.dp_details).toBeDefined();
    expect(payload.delivery_address).toBeDefined();
    expect(payload.billing_address).toBeDefined();
    expect(payload.bags).toBeDefined();
    expect(payload.meta).toBeDefined();
    expect(payload.status).toBe("return_bag_picked");
    expect(payload.affiliate_details).toBeDefined();
    expect(payload.awb_no).toBe("FB-AWB");
    expect(payload.tracking_url).toBe("https://t.example/FB");
    expect(payload._shop_domain).toBe("fb.myshopify.com");
  });

  it("uses inner.shipment.id when shipment_id is missing", () => {
    const raw = JSON.stringify({
      data: { foo: "bar" },
      shipment: {
        id: "INNER-ID-ONLY",
        order_id: "OO-1",
      },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.id).toBe("INNER-ID-ONLY");
  });

  it("extracts string from nested status object", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      status: { status: "return_bag_delivered" },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.status).toBe("return_bag_delivered");
  });

  it("uses status.name when status.status missing", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      status: { name: "delivery_done" },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.status).toBe("delivery_done");
  });

  it("uses status.current_status when others missing", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      status: { current_status: "in_progress" },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.status).toBe("in_progress");
  });

  it("falls back to empty string when nested status object has no readable fields", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      status: { other: { nested: true } },
    });
    const { payload } = unwrapFyndWebhookPayload(raw);
    expect(payload.status).toBe("");
  });

  it("returns eventType from string event field", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      event: "shipment.update",
    });
    const { eventType } = unwrapFyndWebhookPayload(raw);
    expect(eventType).toBe("shipment.update");
  });

  it("returns eventType from event.name when event.type missing", () => {
    const raw = JSON.stringify({
      shipment_id: "SH-1",
      event: { name: "named.event" },
    });
    const { eventType } = unwrapFyndWebhookPayload(raw);
    expect(eventType).toBe("named.event");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// processFyndWebhook — extractShopDomain / detectJourneyType branches
// ───────────────────────────────────────────────────────────────────────────

describe("extractShopDomain branches", () => {
  it("uses meta.shop_domain when _shop_domain absent (ignored path so log preserves enrichment shopDomain)", async () => {
    // Force lookup to miss so the ignored-case log keeps logEnrichment.shopDomain
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "bag_picked",
      meta: { shop_domain: "meta.myshopify.com" },
    } as FyndWebhookPayload);
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shopDomain: "meta.myshopify.com" }),
      }),
    );
  });

  it("uses meta.channel_domain when others absent (ignored path)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "bag_picked",
      meta: { channel_domain: "channel.myshopify.com" },
    } as FyndWebhookPayload);
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ shopDomain: "channel.myshopify.com" }),
      }),
    );
  });

  it("ignores _shop_domain that lacks a dot", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "bag_picked",
      _shop_domain: "no-dot",
    } as FyndWebhookPayload);
    // shopDomain in webhook log will fall back to returnCase.shop.shopDomain
    expect(prismaMock.fyndWebhookLog.create).toHaveBeenCalled();
  });
});

describe("detectJourneyType branches", () => {
  it("detects rto journey via rto_ prefix", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "rto_initiated",
      delivery_partner_details: { display_name: "Carrier", awb_no: "AWB-1" },
    } as FyndWebhookPayload);
    // For rto journey, AWB should go to forwardAwb (not return)
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-1")).toBe(true);
  });

  it("detects journey via _journey_type=return", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "weird_unknown_status",
      _journey_type: "RETURN",
      delivery_partner_details: { display_name: "Carrier", awb_no: "AWB-2" },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.returnAwb === "AWB-2")).toBe(true);
  });

  it("detects journey via _journey_type=rto", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "weird_unknown_status",
      _journey_type: "rto",
      delivery_partner_details: { awb_no: "AWB-3" },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-3")).toBe(true);
  });

  it("detects journey via _journey_type=forward", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "weird_unknown_status",
      _journey_type: "forward",
      delivery_partner_details: { awb_no: "AWB-4" },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-4")).toBe(true);
  });

  it("detects journey via meta.journey_type=return", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "weird_unknown_status",
      meta: { journey_type: "return" },
      delivery_partner_details: { awb_no: "AWB-5" },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.returnAwb === "AWB-5")).toBe(true);
  });

  it("detects journey via meta.journey_type=rto and forward", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "weird_unknown_status",
      meta: { journey_type: "rto" },
      delivery_partner_details: { awb_no: "AWB-6" },
    } as FyndWebhookPayload);

    const rc2 = mkReturnCase({ id: "rc-2" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc2);
    await processFyndWebhook({
      shipment_id: "SHIP-2",
      refund_status: "weird_unknown_status",
      meta: { journey_type: "forward" },
      delivery_partner_details: { awb_no: "AWB-7" },
    } as FyndWebhookPayload);

    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-6")).toBe(true);
    expect(updateDatas.some((d) => d.forwardAwb === "AWB-7")).toBe(true);
  });

  it("detects return journey via out_for_pickup status", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "out_for_pickup",
      delivery_partner_details: { awb_no: "AWB-OFP" },
    } as FyndWebhookPayload);
    const updateDatas = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    expect(updateDatas.some((d) => d.returnAwb === "AWB-OFP")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// processFyndWebhook — backfill + lookup branches
// ───────────────────────────────────────────────────────────────────────────

describe("processFyndWebhook — gap branches", () => {
  it("matches return webhooks by app return marker before order-level fallbacks", async () => {
    const rc = mkReturnCase({ id: "rc-marker", shopifyOrderName: "#1001" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);

    const r = await processFyndWebhook({
      shipment_id: "RETURN-SHIP-1",
      affiliate_order_id: "FYNDSHOPIFYX14403",
      status: "return_bag_picked",
      meta: { activity_comment: "rc-marker" },
    } as FyndWebhookPayload);

    expect(r).toMatchObject({ ok: true, returnCaseId: "rc-marker" });
    expect(prismaMock.returnCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([expect.objectContaining({ id: "rc-marker" })]),
        }),
      }),
    );
  });

  it("matches return webhooks by Fynd bag id so same-order partial returns do not steal status", async () => {
    const rc = mkReturnCase({ id: "rc-second", shopifyOrderName: "#1001" });
    prismaMock.returnItem.findFirst.mockResolvedValueOnce({
      id: "ri-second",
      fyndBagId: "BAG-2",
      returnCase: rc,
    });

    const r = await processFyndWebhook({
      shipment_id: "RETURN-SHIP-2",
      affiliate_order_id: "FYNDSHOPIFYX14403",
      status: "return_accepted",
      bags: [{ bag_id: "BAG-2" }],
    } as FyndWebhookPayload);

    expect(r).toMatchObject({ ok: true, returnCaseId: "rc-second" });
    expect(prismaMock.returnItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fyndBagId: { in: ["BAG-2"] } }),
      }),
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-second" },
        data: expect.objectContaining({ fyndPayloadJson: expect.any(String) }),
      }),
    );
  });

  it("ignores bag-scoped return webhooks when bags do not belong to an app return", async () => {
    const r = await processFyndWebhook({
      shipment_id: "RETURN-SHIP-OLD",
      affiliate_order_id: "FYNDSHOPIFYX14403",
      status: "return_bag_picked",
      bags: [{ bag_id: "BAG-OLD" }],
    } as FyndWebhookPayload);

    expect(r).toEqual({ ok: true, action: "ignored", returnCaseId: undefined });
    expect(prismaMock.returnItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fyndBagId: { in: ["BAG-OLD"] } }),
      }),
    );
    const returnCaseLookups = prismaMock.returnCase.findFirst.mock.calls.map((c) => c[0]);
    expect(returnCaseLookups).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({ shopifyOrderName: expect.anything() }),
        }),
      ]),
    );
  });

  it("ignores unscoped return webhooks instead of matching by Shopify order", async () => {
    const r = await processFyndWebhook({
      shipment_id: "RETURN-SHIP-UNKNOWN",
      affiliate_order_id: "FYNDSHOPIFYX14403",
      status: "return_bag_picked",
    } as FyndWebhookPayload);

    expect(r).toEqual({ ok: true, action: "ignored", returnCaseId: undefined });
    const returnCaseLookups = prismaMock.returnCase.findFirst.mock.calls.map((c) => c[0]);
    expect(returnCaseLookups).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: expect.objectContaining({ fyndOrderId: expect.anything() }),
        }),
      ]),
    );
  });

  it("backfills fyndOrderId from affiliateOrderId when no orderId", async () => {
    const rc = mkReturnCase({ fyndOrderId: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      affiliate_order_id: "AFF-NEW",
      refund_status: "bag_picked",
    } as FyndWebhookPayload);
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(updates.some((u) => u.includes('"fyndOrderId":"AFF-NEW"'))).toBe(true);
  });

  it("backfills customer city/country/address1/province/zip when missing", async () => {
    const rc = mkReturnCase({ customerName: null, customerEmailNorm: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      order_id: "FY-1",
      refund_status: "bag_picked",
      delivery_address: {
        name: "Alice",
        email: "a@e.com",
        phone: "+99",
        city: "Mumbai",
        country: "India",
        address1: "21 Marine Drive",
        state: "MH",
        pincode: "400001",
      },
    } as FyndWebhookPayload);
    const updates = prismaMock.returnCase.update.mock.calls.map(
      (c) => (c[0] as { data?: Record<string, unknown> }).data ?? {},
    );
    const u = updates.find(
      (d) =>
        d.customerCity === "Mumbai" &&
        d.customerCountry === "India" &&
        d.customerAddress1 === "21 Marine Drive" &&
        d.customerProvince === "MH" &&
        d.customerZip === "400001",
    );
    expect(u).toBeDefined();
  });

  it("merges existing returnLabelJson with new fields", async () => {
    const rc = mkReturnCase({
      returnLabelJson: JSON.stringify({ existingField: "keep-me", carrier: "Old" }),
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "return_dp_assigned",
      delivery_partner_details: {
        display_name: "NewCarrier",
        awb_no: "NEW-AWB",
        tracking_url: "https://t/new",
      },
      invoice: {
        label_url: "https://l/new",
        invoice_url: "https://i/new",
      },
    } as FyndWebhookPayload);
    const updateData = prismaMock.returnCase.update.mock.calls
      .map((c) => (c[0] as { data?: Record<string, unknown> }).data ?? {})
      .find((d) => typeof d.returnLabelJson === "string") as
      | { returnLabelJson?: string }
      | undefined;
    const labelJson = JSON.parse(updateData!.returnLabelJson!) as Record<string, unknown>;
    expect(labelJson.existingField).toBe("keep-me");
    expect(labelJson.carrier).toBe("NewCarrier");
    expect(labelJson.trackingNumber).toBe("NEW-AWB");
    expect(labelJson.labelUrl).toBe("https://l/new");
    expect(labelJson.invoiceUrl).toBe("https://i/new");
  });

  it("recovers when existing returnLabelJson is invalid JSON", async () => {
    const rc = mkReturnCase({ returnLabelJson: "{not-json" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    const r = await processFyndWebhook({
      shipment_id: "SHIP-1",
      refund_status: "return_dp_assigned",
      delivery_partner_details: { display_name: "C", awb_no: "AWB" },
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
  });

  it("dedupes against fynd_refund_status from existing event payloads", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      { payloadJson: JSON.stringify({ fynd_refund_status: "bag_packed" }) },
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
      const data = (c[0] as { data?: { eventType?: string } }).data;
      return data?.eventType === "status_backfill";
    });
    // bag_packed is already in seenStatuses via fynd_refund_status, so only
    // bag_picked should be created.
    expect(backfillEvents.length).toBe(1);
  });

  it("logs payload keys when no identifiers present in payload", async () => {
    const r = await processFyndWebhook({
      refund_status: "refund_done",
      meta: { foo: "bar" },
    } as FyndWebhookPayload);
    expect(r).toMatchObject({ ok: true, action: "ignored" });
    const logCalls = prismaMock.fyndWebhookLog.create.mock.calls;
    const errMsg = (logCalls[0]?.[0] as { data?: { error?: string } })?.data?.error ?? "";
    expect(errMsg).toContain("refund_status");
  });

  it("skips empty oid in strategy 6 direct shopifyOrderName loop", async () => {
    // Strategy 6 strips '#' — when the resulting clean string is empty
    // (oid was just "#"), the inner branch should skip it. The webhook
    // still succeeds via no-match → ignored.
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    const r = await processFyndWebhook({
      affiliate_order_id: "#",
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
  });

  it("matches via shop-scoped fyndShipmentId when affiliateOrderId absent (strategy 8)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "x.myshopify.com",
    });
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockImplementation(async (args: unknown) => {
      const a = args as { where?: { shopId?: string; fyndShipmentId?: string } };
      if (a.where?.shopId === "shop-1" && a.where?.fyndShipmentId === "SHIP-1") return rc;
      return null;
    });
    const r = await processFyndWebhook({
      shipment_id: "SHIP-1",
      _shop_domain: "x.myshopify.com",
      refund_status: "bag_picked",
    } as FyndWebhookPayload);
    expect(r.ok).toBe(true);
  });

  it("backfills shopifyOrderName from Shopify lookup when missing", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "store-1001", shopifyOrderName: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/777",
      name: "#1001-from-shopify",
      lineItems: [{ id: "gid://shopify/LineItem/L", quantity: 1 }],
    });
    await processFyndWebhook(
      mkPayload({ refund_status: "refund_done", affiliate_order_id: "STORE-1001" }),
    );
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(updates.some((u) => u.includes('"shopifyOrderName":"#1001-from-shopify"'))).toBe(true);
  });

  it("logs event via closeShopifyReturnBestEffort logEvent callback (manual refund branch)", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "manual:abc" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    closeShopifyReturnBestEffortMock.mockImplementationOnce(
      async (_admin, _rc, opts: { logEvent: (e: { eventType: string }) => Promise<void> }) => {
        await opts.logEvent({ eventType: "shopify_return_closed" });
      },
    );
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "shopify_return_closed" }),
      }),
    );
  });

  it("does NOT send notification on manual-refund branch when customer email missing", async () => {
    const rc = mkReturnCase({ shopifyOrderId: "manual:abc", customerEmailNorm: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "refunded" }));
    expect(sendRefundNotificationMock).not.toHaveBeenCalled();
  });

  it("logs event via closeShopifyReturnBestEffort callback in already-refunded branch", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    createRefundMock.mockResolvedValueOnce({
      success: false,
      error: "Order has been refunded for this amount already",
    });
    let captured: { eventType: string } | null = null;
    closeShopifyReturnBestEffortMock.mockImplementation(
      async (
        _admin: unknown,
        _rc: unknown,
        opts: { logEvent: (e: { eventType: string }) => Promise<void> },
      ) => {
        await opts.logEvent({ eventType: "close_already_refunded" });
        captured = { eventType: "close_already_refunded" };
      },
    );
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalled();
    expect(captured).not.toBeNull();
  });

  it("logs event via closeShopifyReturnBestEffort callback after successful refund", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    let captured: { eventType: string } | null = null;
    closeShopifyReturnBestEffortMock.mockImplementation(
      async (
        _admin: unknown,
        _rc: unknown,
        opts: { logEvent: (e: { eventType: string }) => Promise<void> },
      ) => {
        await opts.logEvent({ eventType: "close_after_success" });
        captured = { eventType: "close_after_success" };
      },
    );
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
    expect(captured).not.toBeNull();
  });

  it("resolves orderIdForRefund using fetchOrderByFyndAffiliateId when shopifyOrderId is non-GID and shopifyOrderName lookup fails", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "store-9999",
      shopifyOrderName: "#9999",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // attempt 1 with shopifyOrderName
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/RESOLVED",
        lineItems: [{ id: "gid://shopify/LineItem/X", quantity: 3 }],
      }); // attempt 2 with shopifyOrderId
    const r = await processFyndWebhook(
      mkPayload({ refund_status: "refund_done", affiliate_order_id: "AFF-RESOLVE" }),
    );
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  it("resolves orderIdForRefund via affiliateOrderId fallback when others miss and uses lineItems from lookup", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "store-9999",
      shopifyOrderName: "#9999",
      items: [], // empty so it falls through to lookup-derived line items
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/AFF-RES",
        lineItems: [
          { id: "gid://shopify/LineItem/L1", quantity: 2 },
          { id: "gid://shopify/LineItem/L2", quantity: 1 },
        ],
      });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/AFF-RES",
      lineItems: [
        { id: "gid://shopify/LineItem/L1", quantity: 2 },
        { id: "gid://shopify/LineItem/L2", quantity: 1 },
      ],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    const r = await processFyndWebhook(
      mkPayload({ refund_status: "refund_done", affiliate_order_id: "ZZZ-AFF" }),
    );
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  it("falls through to all order.lineItems when SKU/title resolution finds no matches", async () => {
    // Items have non-GID IDs but neither sku nor title — resolver finds zero
    // matches, so it falls back to mapping all order.lineItems.
    const rc = mkReturnCase({
      items: [{ shopifyLineItemId: "fynd-bag-zzz", qty: 1 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/F1", quantity: 7, sku: "S1", title: "Title1" }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [{ id: "gid://shopify/LineItem/F1", quantity: 7 }],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("handles GID-prefixed line items in resolver (push-through branch)", async () => {
    const rc = mkReturnCase({
      items: [
        { shopifyLineItemId: "gid://shopify/LineItem/keep", qty: 4 },
        { shopifyLineItemId: "fynd-bag", qty: 2, sku: "WIDGET" },
      ],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/match", quantity: 99, sku: "WIDGET", title: "T" }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([
        { id: "gid://shopify/LineItem/keep", quantity: 4 },
        { id: "gid://shopify/LineItem/match", quantity: 2 },
      ]),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("advances ReturnCase.status to 'approved' on return_initiated", async () => {
    const rc = mkReturnCase({ status: "pending" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "return_initiated" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const advanced = updates.some(
      (u) => (u as { data?: { status?: string } }).data?.status === "approved",
    );
    expect(advanced).toBe(true);
  });

  it("advances ReturnCase.status to 'completed' on return_completed", async () => {
    const rc = mkReturnCase({ status: "in progress" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    await processFyndWebhook(mkPayload({ refund_status: "return_completed" }));
    const updates = prismaMock.returnCase.update.mock.calls.map((c) => c[0]);
    const advanced = updates.some(
      (u) => (u as { data?: { status?: string } }).data?.status === "completed",
    );
    expect(advanced).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// processFyndWebhook — auto-refund branch coverage
// ───────────────────────────────────────────────────────────────────────────

describe("processFyndWebhook — auto-refund gap coverage", () => {
  const baseSettings = {
    autoRefundEnabled: true,
    refundLocationId: null,
    refundPaymentMethod: "original",
    refundStoreCreditPct: 100,
    allowedFyndStatusesForRefund: null,
  };

  it("auto-refund: resolves order via shopifyOrderName fetchOrderByFyndAffiliateId fallback", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "store-name-only",
      shopifyOrderName: "#1001",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/AUTO-RESOLVED",
      lineItems: [{ id: "gid://shopify/LineItem/L", quantity: 5 }],
    });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/AUTO-RESOLVED",
      lineItems: [{ id: "gid://shopify/LineItem/L", quantity: 5 }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  it("auto-refund: resolves via shopifyOrderId fallback when shopifyOrderName lookup misses", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "store-id-only",
      shopifyOrderName: "#1001",
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // shopifyOrderName attempt
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/IDFALL",
        lineItems: [{ id: "gid://shopify/LineItem/IDL", quantity: 7 }],
      });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/IDFALL",
      lineItems: [{ id: "gid://shopify/LineItem/IDL", quantity: 7 }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  it("auto-refund: resolves via affiliateOrderId fallback when others miss", async () => {
    const rc = mkReturnCase({
      shopifyOrderId: "store-aff-only",
      shopifyOrderName: "#1001",
      items: [],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "gid://shopify/Order/AFFFALL",
        lineItems: [{ id: "gid://shopify/LineItem/AFL", quantity: 9 }],
      });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/AFFFALL",
      lineItems: [{ id: "gid://shopify/LineItem/AFL", quantity: 9 }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    const r = await processFyndWebhook(
      mkPayload({ refund_status: "credit_note_generated", affiliate_order_id: "AUTO-AFF" }),
    );
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });

  it("auto-refund: resolves non-GID line items via SKU match", async () => {
    const rc = mkReturnCase({
      items: [{ shopifyLineItemId: "fynd-bag", qty: 2, sku: "WIDGET-AUTO" }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [
        { id: "gid://shopify/LineItem/MATCH", quantity: 5, sku: "WIDGET-AUTO", title: "T" },
      ],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [{ id: "gid://shopify/LineItem/MATCH", quantity: 2 }],
      expect.stringContaining("Auto-refund"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("auto-refund: falls back to all order.lineItems when SKU/title resolution finds none", async () => {
    const rc = mkReturnCase({
      items: [{ shopifyLineItemId: "fynd-bag", qty: 1 }],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/A", quantity: 4, sku: "Z", title: "T" }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).toHaveBeenCalled();
  });

  it("auto-refund: GID line item passes through resolver unchanged alongside non-GID", async () => {
    const rc = mkReturnCase({
      items: [
        { shopifyLineItemId: "gid://shopify/LineItem/keep-auto", qty: 3 },
        { shopifyLineItemId: "fynd-2", qty: 1, sku: "MATCH-AUTO" },
      ],
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [
        { id: "gid://shopify/LineItem/auto-match", quantity: 99, sku: "MATCH-AUTO", title: "T" },
      ],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.arrayContaining([
        { id: "gid://shopify/LineItem/keep-auto", quantity: 3 },
        { id: "gid://shopify/LineItem/auto-match", quantity: 1 },
      ]),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("auto-refund: applies COD store_credit override when payment is COD", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue({
      ...baseSettings,
      refundPaymentMethod: "original",
    });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/1", quantity: 1 }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["Cash on Delivery"],
      displayFinancialStatus: "PENDING",
    });
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining("Auto-refund"),
      expect.anything(),
      expect.objectContaining({ method: "store_credit" }),
    );
  });

  it("auto-refund: closeShopifyReturnBestEffort logEvent fires returnEvent.create", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    closeShopifyReturnBestEffortMock.mockImplementationOnce(
      async (_admin, _rc, opts: { logEvent: (e: { eventType: string }) => Promise<void> }) => {
        await opts.logEvent({ eventType: "auto_refund_close_done" });
      },
    );
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "auto_refund_close_done" }),
      }),
    );
  });

  it("auto-refund: skips notification when customerEmailNorm missing", async () => {
    const rc = mkReturnCase({ customerEmailNorm: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(sendRefundNotificationMock).not.toHaveBeenCalled();
  });

  it("auto-refund: survives notification rejection", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValue(baseSettings);
    sendRefundNotificationMock.mockRejectedValueOnce(new Error("SMTP fail"));
    const r = await processFyndWebhook(mkPayload({ refund_status: "credit_note_generated" }));
    expect(r).toMatchObject({ ok: true, action: "refund_completed" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// processFyndWebhook — strategy 1 backfill branch
// ───────────────────────────────────────────────────────────────────────────

describe("processFyndWebhook — fetchOrder error tolerance", () => {
  it("survives fetchOrder errors during refund flow (location fetch)", async () => {
    const rc = mkReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(rc);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundLocationId: null,
      refundPaymentMethod: "original",
      refundStoreCreditPct: 100,
    });
    fetchOrderMock.mockRejectedValueOnce(new Error("network")).mockResolvedValue({
      id: "gid://shopify/Order/100",
      lineItems: [{ id: "gid://shopify/LineItem/1", quantity: 1 }],
      fulfillments: [{ location: { id: "loc-1" } }],
      paymentGatewayNames: ["shopify_payments"],
    });
    const r = await processFyndWebhook(mkPayload({ refund_status: "refund_done" }));
    expect(r.ok).toBe(true);
  });
});
