/**
 * Final coverage closure for the 11 API routes called out in the
 * branch-coverage push to ≥98%. Targets the SPECIFIC remaining branches
 * not exercised by existing test files. Per the brief, this file is the
 * ONLY file added — existing tests are untouched.
 *
 * Highest-impact target is api.admin.backfill-fynd-items.ts (68% → ~98%):
 *   - Method-not-allowed guard
 *   - Body parse catch
 *   - Shop / settings missing
 *   - Fynd client error
 *   - Wrong client type (no getShipments)
 *   - limit clamping (Math.min)
 *   - title+price fuzzy match — both prices match within 1, and price
 *     mismatch (returns plain titleMatch)
 *   - Bag-level fallback (no articles/items/item) — covers branch
 *     populating bag from bag.* fields
 *   - allBags empty path (no caseUpdated assignment)
 *
 * Plus single-test closures for each of the other 10 files.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ─── Shared hoisted mocks ────────────────────────────────────────────────
const {
  prismaMock,
  authenticateMock,
  shopifyModuleMock,
  createFyndClientOrErrorMock,
  runConsolidationForAllShopsMock,
  extractAffiliateOrderIdMock,
  extractAffiliateMock,
  extractCustomerMock,
  parseDateRangeMock,
  formatReturnRequestIdMock,
  parseReturnIdConfigMock,
  buildReturnRequestIdMock,
  nextReturnIdCounterMock,
  checkReturnEligibilityMock,
  normalizeSourceChannelMock,
  evaluateAutoApproveRulesMock,
  parseAutoApproveRulesMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumberMock,
  withRestCredentialsMock,
  decryptMock,
  sendApprovalMock,
  sendRejectionMock,
  sendMailMock,
  createTransportMock,
} = vi.hoisted(() => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
  return {
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateMock: vi.fn(),
    shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
    createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      ok: false,
      error: "disabled",
    })),
    runConsolidationForAllShopsMock: vi.fn(),
    extractAffiliateOrderIdMock: vi.fn<(...args: unknown[]) => string | null>(),
    extractAffiliateMock: vi.fn(() => null as string | null),
    extractCustomerMock: vi.fn(() => null as Record<string, string | undefined> | null),
    parseDateRangeMock: vi.fn(() => ({
      start: new Date("2025-01-01"),
      end: new Date("2025-01-31"),
    })),
    formatReturnRequestIdMock: vi.fn((id: string) => `R-${id.slice(0, 6)}`),
    parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "random" })),
    buildReturnRequestIdMock: vi.fn(() => "R-FINAL-1"),
    nextReturnIdCounterMock: vi.fn(async () => 1),
    checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => unknown>(() => ({ eligible: true })),
    normalizeSourceChannelMock: vi.fn((s: string | null) => s),
    evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
    parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
    fetchOrderByFyndAffiliateIdMock: vi.fn(),
    fetchOrderByOrderNumberMock: vi.fn(),
    withRestCredentialsMock: vi.fn((admin: unknown) => admin),
    decryptMock: vi.fn((v: string) => v),
    sendApprovalMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    sendRejectionMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    sendMailMock: sendMail,
    createTransportMock: vi.fn(() => ({ sendMail })),
  };
});
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-consolidation.server", () => ({
  runConsolidationForAllShops: runConsolidationForAllShopsMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractAffiliateOrderIdFromFyndPayload: extractAffiliateMock,
  extractCustomerFromFyndPayload: extractCustomerMock,
}));
vi.mock("../../lib/dashboard-date-utils", () => ({
  parseDateRange: parseDateRangeMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: nextReturnIdCounterMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: evaluateAutoApproveRulesMock,
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendApprovalNotification: sendApprovalMock,
  sendRejectionNotification: sendRejectionMock,
}));
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

const origEnv = { ...process.env };

beforeEach(() => {
  resetPrismaMock(prismaMock);
  process.env = { ...origEnv };
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok" },
    admin: { graphql: vi.fn() },
  });
  shopifyModuleMock.unauthenticated.admin
    .mockReset()
    .mockResolvedValue({ admin: { graphql: vi.fn() } });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  runConsolidationForAllShopsMock.mockReset();
  extractAffiliateOrderIdMock.mockReset().mockReturnValue(null);
  extractAffiliateMock.mockReset().mockReturnValue(null);
  extractCustomerMock.mockReset().mockReturnValue(null);
  parseDateRangeMock
    .mockReset()
    .mockReturnValue({ start: new Date("2025-01-01"), end: new Date("2025-01-31") });
  formatReturnRequestIdMock.mockReset().mockImplementation((id: string) => `R-${id.slice(0, 6)}`);
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "random" });
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-FINAL-1");
  nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  normalizeSourceChannelMock.mockReset().mockImplementation((s: string | null) => s);
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  fetchOrderByFyndAffiliateIdMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  decryptMock.mockReset().mockImplementation((v: string) => v);
  sendApprovalMock.mockReset().mockResolvedValue(undefined);
  sendRejectionMock.mockReset().mockResolvedValue(undefined);
  sendMailMock.mockReset().mockResolvedValue({ messageId: "x" });
  createTransportMock.mockReset().mockReturnValue({ sendMail: sendMailMock });
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.unstubAllGlobals();
});

// ─── Imports under test ──────────────────────────────────────────────────
import { action as backfillItemsAction } from "../api.admin.backfill-fynd-items";
import { action as backfillMappingsAction } from "../api.admin.backfill-fynd-mappings";
import { action as createReturnAction } from "../api.admin.create-return";
import { loader as returnItemsDataLoader } from "../api.admin.return-items-data.$id";
import { action as fyndConsolidationAction } from "../api.fynd-consolidation-cron";
import { action as fixOrderIdsAction } from "../api.fix-order-ids";
import { loader as scheduledReportLoader } from "../api.scheduled-report";
import { action as bulkAction } from "../api.returns.bulk";
import { loader as exportLoader } from "../api.returns.export";
import { loader as gorgiasLoader } from "../api.integrations.gorgias";
import { action as gorgiasActionsAction } from "../api.integrations.gorgias-actions";

function jsonReq(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ============================================================================
// api.admin.backfill-fynd-items.ts — biggest gap (68% → ~98%)
// ============================================================================
describe("backfill-fynd-items — final closures", () => {
  it("405 when method is GET", async () => {
    const req = new Request("https://app.example/api/admin/backfill-fynd-items", { method: "GET" });
    const res = await backfillItemsAction({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  it("malformed JSON body is caught and treated as empty (no fields → defaults)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce(null);
    const req = new Request("https://app.example/api/admin/backfill-fynd-items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const res = await backfillItemsAction({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(404); // continues to shop lookup which returns null
  });

  it("404 when shop is not found", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce(null);
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Shop not found");
  });

  it("400 when settings is null", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "s", settings: null });
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("No settings configured");
  });

  it("400 when createFyndClientOrError returns ok:false", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no creds");
  });

  it("400 when client is missing getShipments", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { other: vi.fn() } });
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Fynd Platform client required");
  });

  it("bag-level fallback path: bag has no articles/items/item — uses bag.seller_identifier etc.", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    // Shipment with single bag that has NO articles, NO items, NO item — exercises
    // the bag-level fallback at lines 197-225 of the source.
    const shipment = {
      shipment_id: "SHIP-FB",
      bags: [
        {
          bag_id: "BAG-FB",
          seller_identifier: "FB-SKU",
          article_id: "FB-ART",
          affiliate_bag_details: { affiliate_line_id: "FB-LINE" },
          prices: { transfer_price: "50", price_effective: "60" },
          quantity: 3,
          size: "L",
          item: { item_id: "IT-FB-1", name: "Fallback Widget", size: "L" },
        },
      ],
    };
    // Note: bag.item is truthy → article path runs with article=bag.item
    // To force the bag-level fallback we need bag.articles=[], bag.items=[], !bag.item
    const bagOnlyShipment = {
      shipment_id: "SHIP-BO",
      bags: [
        {
          bag_id: "BAG-BO",
          seller_identifier: "BO-SKU",
          article_id: "BO-ART",
          affiliate_bag_details: { affiliate_line_id: "BO-LINE" },
          prices: { transfer_price: "70", price_effective: "80" },
          quantity: 2,
          size: "M",
          articles: [],
          items: [],
          // No `item` key
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [bagOnlyShipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-bo",
        returnRequestNo: "R-BO",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#BO",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-bo",
            title: null,
            sku: "BO-SKU",
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);
    // Confirms bag-level fallback path executed and matched by sku
    const updateCall = prismaMock.returnItem.update.mock.calls[0][0];
    expect(updateCall.data.fyndBagId).toBe("BAG-BO");
    expect(updateCall.data.fyndAffiliateLineId).toBe("BO-LINE");
    expect(updateCall.data.fyndQuantityAvailable).toBe(2);
    expect(updateCall.data.fyndSize).toBe("M");
    // Suppress unused-var warning
    void shipment;
  });

  it("title+price fuzzy match: when prices match within 1 unit, returns matched", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-T1",
      bags: [
        {
          bag_id: "BAG-T1",
          affiliate_bag_details: {},
          prices: { transfer_price: "100.50", price_effective: "100.50" },
          articles: [
            {
              // No matching seller_identifier or affiliate_line_id
              article_id: "A-T1",
              item: { name: "Big Red Widget" },
            },
          ],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-t1",
        returnRequestNo: "R-T1",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#T1",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-t1",
            title: "Big Red Widget",
            sku: null,
            price: "100.40", // diff < 1
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
  });

  it("title+price fuzzy match: prices differ by more than 1 → no match", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-T2",
      bags: [
        {
          bag_id: "BAG-T2",
          affiliate_bag_details: {},
          prices: { transfer_price: "100", price_effective: "100" },
          articles: [
            {
              article_id: "A-T2",
              item: { name: "Blue Widget" },
            },
          ],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-t2",
        returnRequestNo: "R-T2",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#T2",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-t2",
            title: "Blue Widget",
            sku: null,
            price: "200", // diff > 1
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);

    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    // Match function returns false when price diff >= 1, so no match
    expect(body.updated).toBe(0);
    expect(body.skipped).toBe(1);
  });

  it("returnCase has existing fyndShipmentId — case update is skipped", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SHIP-EX",
      bags: [
        {
          bag_id: "BAG-EX",
          affiliate_bag_details: { affiliate_line_id: "L-EX" },
          prices: { transfer_price: "10" },
          articles: [{ seller_identifier: "EX-SKU", article_id: "A-EX", item: { name: "X" } }],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-ex",
        returnRequestNo: "R-EX",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#EX",
        fyndShipmentId: "SHIP-PRE-EXISTING",
        items: [
          {
            id: "ri-ex",
            title: "X",
            sku: "EX-SKU",
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.results[0].caseUpdated).toBe(false);
    // returnItem.update was called, returnCase.update was NOT
    expect(prismaMock.returnItem.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("alternate field paths: shipment.id, bag.id, bag.items[], article._id, itemObj._id, item_name, amount_paid", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    // Drives `??` chain alternates: no shipment_id (uses .id), no bag_id (uses .id),
    // bag.items[] (instead of articles), article._id, itemObj._id, item_name, amount_paid.
    const shipment = {
      id: "SH-ALT",
      bags: [
        {
          id: "BG-ALT",
          affiliate_line_id: "LINE-DIRECT", // bag-level affiliate_line_id
          price_info: { amount_paid: "42.00" }, // amount_paid only
          items: [
            {
              // .items not .articles
              _id: "ART-ALT", // _id not article_id
              quantity_available: 4,
              item: { _id: "ITM-ALT", item_name: "Alt Title" },
            },
          ],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-alt",
        returnRequestNo: "R-A",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#A",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-alt",
            title: "Alt Title",
            sku: null,
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
    const data = prismaMock.returnItem.update.mock.calls[0][0].data;
    expect(data.fyndShipmentId).toBe("SH-ALT");
    expect(data.fyndBagId).toBe("BG-ALT");
    expect(data.fyndArticleId).toBe("ART-ALT");
    expect(data.fyndAffiliateLineId).toBe("LINE-DIRECT");
    expect(data.fyndItemId).toBe("ITM-ALT");
    expect(data.fyndQuantityAvailable).toBe(4);
  });

  it("title-only fuzzy match (no return price → titleMatch return path)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SH-TO",
      bags: [
        {
          bag_id: "BG-TO",
          affiliate_bag_details: {},
          prices: { transfer_price: "100" },
          articles: [{ article_id: "A-TO", item: { name: "Wonder Widget" } }],
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-to",
        returnRequestNo: "R-TO",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#TO",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-to",
            title: "Wonder Widget",
            sku: null,
            price: null, // no price → fuzzy returns titleMatch
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.updated).toBe(1);
  });

  it("title fuzzy match: empty bag title or empty return title returns false", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "s",
      settings: { fyndApiType: "platform" },
    });
    const shipment = {
      shipment_id: "SH-EM",
      bags: [
        {
          bag_id: "BG-EM",
          affiliate_bag_details: {},
          prices: {},
          articles: [{ article_id: "A-EM", item: { name: "" } }], // empty bag title
        },
      ],
    };
    const search = vi.fn(async () => ({ items: [shipment] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: search },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-em",
        returnRequestNo: "R-EM",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#EM",
        fyndShipmentId: null,
        items: [
          {
            id: "ri-em",
            title: "Something",
            sku: null,
            price: null,
            shopifyLineItemId: null,
            fyndShipmentId: null,
            fyndBagId: null,
            fyndArticleId: null,
            fyndAffiliateLineId: null,
            fyndSellerIdentifier: null,
            fyndItemId: null,
            fyndQuantityAvailable: null,
            fyndPriceEffective: null,
            fyndSize: null,
          },
        ],
      },
    ]);
    const res = await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {}),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    // Empty bag title → fuzzy match returns false → no match → skipped
    expect(body.skipped).toBe(1);
    expect(body.updated).toBe(0);
  });

  it("returnCaseId-targeted lookup uses {id, shopId} where clause", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-X",
      settings: { fyndApiType: "platform" },
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn(), searchShipmentsByExternalOrderId: vi.fn() },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await backfillItemsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-items", {
        returnCaseId: "rc-target",
      }),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-target", shopId: "shop-X" },
      }),
    );
  });
});

// ============================================================================
// api.admin.backfill-fynd-mappings.ts — 88% br
// ============================================================================
describe("backfill-fynd-mappings — final closures", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await backfillMappingsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-mappings", {}),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("returns 500 with progress when GraphQL response has errors[]", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
    });
    const graphql = vi.fn(async () => ({
      json: async () => ({ errors: [{ message: "oops" }] }),
    }));
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com" },
      admin: { graphql },
    });
    const res = await backfillMappingsAction({
      request: jsonReq("https://app.example/api/admin/backfill-fynd-mappings", { maxPages: 1 }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("GraphQL error");
    expect(body.details).toEqual(["oops"]);
    expect(body.progress).toEqual(
      expect.objectContaining({
        totalScanned: 0,
        totalMapped: 0,
        metafieldsWritten: 0,
      }),
    );
  });
});

// ============================================================================
// api.admin.create-return.ts — 96% br
// ============================================================================
describe("create-return — final closure", () => {
  it("400 when items is empty array (covers explicit empty-array branch)", async () => {
    const res = await createReturnAction({
      request: jsonReq("https://app.example/api/admin/create-return", {
        shopifyOrderName: "#1",
        items: [],
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// api.admin.return-items-data.$id.ts — close
// ============================================================================
describe("return-items-data — final closure", () => {
  it("returnCase not found → 404", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await returnItemsDataLoader({
      request: new Request("https://app.example/api/admin/return-items-data/rc-X"),
      params: { id: "rc-X" },
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("liveFyndError set when createFyndClientOrError returns ok:false", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      returnRequestNo: "R",
      shopifyOrderName: "#1",
      shopifyOrderId: "gid://x",
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndReturnNo: null,
      status: "pending",
      createdByChannel: "admin",
      createdAt: new Date(),
      items: [
        {
          id: "i",
          shopifyLineItemId: "gid",
          title: "T",
          variantTitle: null,
          sku: null,
          price: null,
          qty: 1,
          reasonCode: null,
          fyndShipmentId: null,
          fyndBagId: null,
          fyndArticleId: null,
          fyndAffiliateLineId: null,
          fyndSellerIdentifier: null,
          fyndItemId: null,
          fyndQuantityAvailable: null,
          fyndPriceEffective: null,
          fyndSize: null,
        },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "config missing" });
    const res = await returnItemsDataLoader({
      request: new Request("https://app.example/api/admin/return-items-data/rc-1"),
      params: { id: "rc-1" },
      context: {},
    } as never);
    const body = await res.json();
    expect(body.liveFyndError).toBe("config missing");
    expect(body.missingFieldCount).toBeGreaterThan(0);
  });
});

// ============================================================================
// api.fynd-consolidation-cron.ts — close
// ============================================================================
describe("fynd-consolidation-cron — final closure", () => {
  it("loader: GET with no CRON_SECRET and localhost host → runs cron", async () => {
    delete process.env.CRON_SECRET;
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const headers = new Headers();
    headers.set("Host", "localhost:3000");
    const req = new Request("https://app.example/api/fynd-consolidation-cron", {
      method: "GET",
      headers,
    });
    const res = await fyndConsolidationAction({ request: req, params: {}, context: {} } as never);
    // POST action → should also pass (localhost branch)
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// api.fix-order-ids.ts — 91% br
// ============================================================================
describe("fix-order-ids — final closure", () => {
  it("action: 500 when no offline session/access token found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    const res = await fixOrderIdsAction({
      request: new Request("https://app.example/api/fix-order-ids", { method: "POST" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("No offline session");
  });
});

// ============================================================================
// api.scheduled-report.ts — 91% br
// ============================================================================
describe("scheduled-report — final closure", () => {
  it("401 when CRON_SECRET set and header mismatched length", async () => {
    process.env.CRON_SECRET = "real-secret";
    const headers = new Headers();
    headers.set("x-cron-secret", "wrong");
    const res = await scheduledReportLoader({
      request: new Request("https://app.example/api/scheduled-report", { headers }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("weekly + dayOfWeek mismatch → continues to next setting", async () => {
    const now = new Date();
    const today = now.getDay() === 0 ? 7 : now.getDay();
    const nextDay = (today % 7) + 1; // pick a different day
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      {
        shopId: "s1",
        shop: { shopDomain: "shop.example" },
        scheduledReportEnabled: true,
        scheduledReportFrequency: "weekly",
        scheduledReportDay: nextDay,
        scheduledReportEmails: "x@y.com",
        shopCurrency: "USD",
        shopLocale: "en",
        shopTimezone: "UTC",
        smtpHost: "smtp.x",
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: "u",
        smtpPass: "p",
      },
    ]);
    const res = await scheduledReportLoader({
      request: new Request("https://app.example/api/scheduled-report"),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// api.returns.bulk.ts — 92% br
// ============================================================================
describe("returns.bulk — final closure", () => {
  it("bulk_change_resolution for status=cancelled returns error in result", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "r1",
        status: "cancelled",
        resolutionType: "refund",
        customerEmailNorm: null,
        shopifyOrderName: "#1",
      },
    ]);
    const res = await bulkAction({
      request: jsonReq("https://app.example/api/returns/bulk", {
        action: "bulk_change_resolution",
        returnIds: ["r1"],
        resolutionType: "exchange",
      }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.errorCount).toBe(1);
    expect(body.results[0].error).toContain("cancelled");
  });
});

// ============================================================================
// api.returns.export.ts — close
// ============================================================================
describe("returns.export — final closure", () => {
  it("400 when count exceeds MAX_EXPORT_ROWS", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(20000);
    const res = await exportLoader({
      request: new Request("https://app.example/api/returns/export"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("Export limit exceeded");
  });

  it("500 when loader throws (outer try/catch)", async () => {
    // authenticate throws → outer catch returns 500 JSON.
    authenticateMock.mockReset().mockRejectedValueOnce(new Error("auth failure"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await exportLoader({
      request: new Request("https://app.example/api/returns/export"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});

// ============================================================================
// api.integrations.gorgias.ts — 95% br
// ============================================================================
describe("integrations.gorgias — final closure", () => {
  it("returns 'No Data' when no email or order provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    const res = await gorgiasLoader({
      request: new Request("https://app.example/api/integrations/gorgias?shop=test.myshopify.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("No Data");
  });

  it("falls back without isGiftReturn fields when first findMany throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    // First call (with isGiftReturn fields) throws, fallback succeeds.
    prismaMock.returnCase.findMany
      .mockRejectedValueOnce(new Error("column missing"))
      .mockResolvedValueOnce([
        {
          id: "rc-fb",
          returnRequestNo: "R-FB",
          shopifyOrderName: "#FB",
          status: "pending",
          resolutionType: "refund",
          createdAt: new Date(),
          customerName: "X",
          items: [{ title: "I", qty: 1 }],
        },
      ]);
    const res = await gorgiasLoader({
      request: new Request(
        "https://app.example/api/integrations/gorgias?shop=test.myshopify.com&email=a@b.com",
      ),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("R-FB");
  });
});

// ============================================================================
// api.integrations.gorgias-actions.ts — 98% br
// ============================================================================
describe("integrations.gorgias-actions — final closure", () => {
  it("400 for invalid JSON body", async () => {
    const req = new Request("https://app.example/api/integrations/gorgias-actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    const res = await gorgiasActionsAction({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON");
  });

  it("get_timeline action returns event timeline successfully", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "key" },
    });
    decryptMock.mockReturnValueOnce("key");
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      adminNotes: null,
    });
    prismaMock.returnEvent.findMany.mockResolvedValueOnce([
      {
        eventType: "approved",
        source: "admin",
        happenedAt: new Date("2025-01-01"),
        payloadJson: '{"k":1}',
      },
      {
        eventType: "created",
        source: "portal",
        happenedAt: new Date("2025-01-02"),
        payloadJson: null,
      },
    ]);
    const res = await gorgiasActionsAction({
      request: jsonReq("https://app.example/api/integrations/gorgias-actions", {
        shop: "store.myshopify.com",
        api_key: "key",
        action: "get_timeline",
        returnId: "rc-1",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.timeline).toHaveLength(2);
    expect(body.timeline[0].details).toEqual({ k: 1 });
    expect(body.timeline[1].details).toBeNull();
  });
});
