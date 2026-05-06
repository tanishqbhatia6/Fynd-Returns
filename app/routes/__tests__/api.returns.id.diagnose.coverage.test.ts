/**
 * Extended coverage tests for /app/routes/api.returns.$id.diagnose.ts
 *
 * Focus areas:
 *  - Diagnostic strategies: shipment id derivation (fyndShipmentId, fyndOrderId
 *    when looksLikeShipmentId, fyndReturnId fallback, none).
 *  - Fast-path payload composition: products array, default fallback when
 *    items lack SKUs/lineItemIds, manual line items filtered out.
 *  - Shopify order fetch error categorization (Error vs non-Error throw,
 *    manual: order id skipped, fetchOrder vs fetchOrderByOrderNumber).
 *  - Live Fynd API trace: client construction failure, multi-step trace,
 *    per-step error capture.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  createFyndClientOrErrorMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/fynd.server", () => ({ createFyndClientOrError: createFyndClientOrErrorMock }));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
}));

import { loader } from "../api.returns.$id.diagnose";

function mkReq() {
  return new Request("https://app.example/api/returns/rc-1/diagnose");
}

/** Minimal ReturnCase row with all required scalar fields. */
function makeReturnCase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rc-1",
    returnRequestNo: "R-1",
    shopifyOrderId: null as string | null,
    shopifyOrderName: "#1001",
    shopifyReturnId: null,
    status: "pending",
    refundStatus: null,
    resolutionType: "refund",
    fyndOrderId: null as string | null,
    fyndReturnId: null as string | null,
    fyndReturnNo: null,
    fyndShipmentId: null as string | null,
    fyndCurrentStatus: null,
    forwardAwb: null,
    returnAwb: null,
    customerName: null,
    customerEmailNorm: null,
    customerPhoneNorm: null,
    customerCity: null,
    customerAddress1: null,
    customerZip: null,
    createdByChannel: "portal",
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

function makeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "it-1",
    shopifyLineItemId: "gid://shopify/LineItem/1",
    title: "Item",
    sku: "SKU-1",
    qty: 1,
    price: "10",
    reasonCode: "defective",
    fyndShipmentId: null,
    fyndBagId: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  fetchOrderMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
});

describe("api.returns.$id.diagnose — extended coverage", () => {
  // ── Shipment ID derivation strategies ──────────────────────────────────────
  it("derives shipment id from fyndOrderId when it looks like a shipment id (15+ digits)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndOrderId: "123456789012345", // 15 digits → looksLikeShipmentId
        items: [makeItem()],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.derivedTargetShipId).toBe("123456789012345");
    expect(body.analysis.storedFyndOrderId_looksLikeShipmentId).toBe(true);
    expect(body.analysis.wouldUseFastPath).toBe(true);
  });

  it("derives shipment id from fyndReturnId when it looks like a shipment id and no fyndOrderId match", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndOrderId: "FY-NOT-DIGITS",
        fyndReturnId: "987654321098765", // 15-digit
        items: [makeItem()],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.storedFyndOrderId_looksLikeShipmentId).toBe(false);
    expect(body.analysis.storedFyndReturnId_looksLikeShipmentId).toBe(true);
    expect(body.analysis.derivedTargetShipId).toBe("987654321098765");
  });

  it("does NOT derive shipment id when both fynd ids are short non-digit strings", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndOrderId: "FY-ABC",
        fyndReturnId: "RET-XYZ",
        items: [makeItem()],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.derivedTargetShipId).toBeNull();
    expect(body.analysis.wouldUseFastPath).toBe(false);
    expect(body.analysis.fastPathExplanation).toMatch(/SEARCH PATH/);
  });

  it("rejects 14-digit fyndOrderId (boundary — needs 15+)", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndOrderId: "12345678901234", // 14 digits
        items: [makeItem()],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.storedFyndOrderId_looksLikeShipmentId).toBe(false);
    expect(body.analysis.derivedTargetShipId).toBeNull();
  });

  // ── hasItems detection ─────────────────────────────────────────────────────
  it("treats items with shopifyLineItemId='manual' as not eligible for fast path", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndShipmentId: "SH-XYZ",
        items: [makeItem({ shopifyLineItemId: "manual", sku: null })],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.hasReturnItems).toBe(false);
    expect(body.analysis.wouldUseFastPath).toBe(false);
    expect(body.fastPathPayload).toBeNull();
  });

  it("treats items with neither sku nor lineItemId as no items", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndShipmentId: "SH-A",
        items: [makeItem({ sku: null, shopifyLineItemId: null })],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.hasReturnItems).toBe(false);
    expect(body.fastPathPayload).toBeNull();
  });

  // ── Fast-path payload composition ──────────────────────────────────────────
  it("builds fast-path payload with products array preferring sku over lineItemId", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndShipmentId: "SH-PAY",
        items: [
          makeItem({ id: "it-1", sku: "SKU-A", qty: 2, reasonCode: "size" }),
          makeItem({ id: "it-2", sku: null, shopifyLineItemId: "gid://LineItem/2", qty: 3 }),
        ],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    const shipment = body.fastPathPayload.statuses[0].shipments[0];
    expect(shipment.identifier).toBe("SH-PAY");
    expect(shipment.products).toEqual([
      { line_number: 1, quantity: 2, identifier: "SKU-A" },
      { line_number: 2, quantity: 3, identifier: "gid://LineItem/2" },
    ]);
    // reasons mirror products
    expect(shipment.reasons.products).toHaveLength(2);
    expect(shipment.reasons.products[0].data.reason_text).toBe("size");
  });

  it("uses 'Other' reason fallback when first item has no reasonCode", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndShipmentId: "SH-B",
        items: [makeItem({ reasonCode: null })],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.fastPathPayload.statuses[0].shipments[0].reasons.products[0].data.reason_text).toBe(
      "Other",
    );
    expect(body.fastPathPayload.statuses[0].shipments[0].reasons.products[0].data.reason_id).toBe(
      122,
    );
    expect(body.fastPathPayload.statuses[0].status).toBe("return_initiated");
  });

  // ── Shopify order fetch strategies ─────────────────────────────────────────
  it("uses fetchOrder when shopifyOrderId is set and not 'manual:'", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "gid://shopify/Order/999",
        items: [],
      }),
    );
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-XYZ" });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(fetchOrderMock).toHaveBeenCalledTimes(1);
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
    expect(body.analysis.affiliateOrderId).toBe("AFF-XYZ");
  });

  it("skips Shopify lookup entirely when shopifyOrderId starts with 'manual:'", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: "manual:FY-1",
        items: [],
      }),
    );

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(fetchOrderMock).not.toHaveBeenCalled();
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
    expect(body.analysis.affiliateOrderId).toBeNull();
    expect(body.analysis.shopifyOrderFetchError).toBeNull();
  });

  it("categorizes non-Error thrown values from Shopify lookup via String() coercion", async () => {
    prismaMock.shop.findFirst.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderId: null,
        shopifyOrderName: "#2002",
        items: [],
      }),
    );
    // Throw a non-Error value to exercise the String(err) branch
    fetchOrderByOrderNumberMock.mockImplementationOnce(async () => {
      throw "boom-string";
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.analysis.shopifyOrderFetchError).toBe("boom-string");
  });

  // ── Fynd client construction errors ────────────────────────────────────────
  it("captures fyndClientError when createFyndClientOrError throws", async () => {
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("creds invalid"));
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(makeReturnCase({ items: [] }));
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.fyndClientError).toBe("creds invalid");
    expect(body.apiTrace).toEqual([]);
  });

  it("captures fyndClientError when result.ok is false", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "missing token" });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(makeReturnCase({ items: [] }));
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.fyndClientError).toBe("missing token");
  });

  // ── Live Fynd API trace strategy ───────────────────────────────────────────
  it("runs all 4 trace steps when search returns orderId + derivedTargetShipId is present + externalOrderId set", async () => {
    const searchMock = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ shipment_id: "SH-1" }], orderId: "ORDER-NONDIGIT" })
      .mockResolvedValueOnce({ items: [{ shipment_id: "111111111111111" }] }); // step 3
    const getShipmentsMock = vi
      .fn()
      .mockResolvedValueOnce({ order: { id: "ORDER-NONDIGIT" } }) // step 2
      .mockResolvedValueOnce({ order: { id: "ext" } }); // step 4
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: getShipmentsMock },
    });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        fyndShipmentId: "111111111111111",
        shopifyOrderName: "#3003",
        items: [makeItem()],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-3" });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    expect(body.apiTrace.map((s: { step: string }) => s.step)).toEqual([
      "1. Search by external_order_id",
      "2. Get order details (from search orderId)",
      "3. Verify shipment exists (search by shipment_id)",
      "4. Get order details by externalOrderId (fallback path)",
    ]);
    // Step 1 is searched by affiliateOrderId (preferred over external)
    expect(searchMock).toHaveBeenCalledWith(
      "AFF-3",
      expect.objectContaining({ searchType: "external_order_id" }),
    );
  });

  it("skips step 2 when search orderId looks like a shipment id (15+ digits)", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [],
      orderId: "555555555555555", // 15 digits - looksLikeShipmentId
    });
    const getShipmentsMock = vi.fn().mockResolvedValue({ order: { id: "x" } });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: getShipmentsMock },
    });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderName: "#4004",
        items: [],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    // Step 2 (order details from search) should be absent
    const stepLabels = body.apiTrace.map((s: { step: string }) => s.step);
    expect(stepLabels).not.toContain("2. Get order details (from search orderId)");
    // Step 4 (external fallback) should still run because externalOrderId="4004"
    expect(stepLabels).toContain("4. Get order details by externalOrderId (fallback path)");
  });

  it("captures per-step error in trace when step 2 (order details) throws", async () => {
    const searchMock = vi.fn().mockResolvedValue({ items: [], orderId: "ORD-2" });
    const getShipmentsMock = vi.fn().mockRejectedValue(new Error("404 from order-details"));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock, getShipments: getShipmentsMock },
    });
    prismaMock.shop.findFirst.mockResolvedValueOnce({
      id: "shop-1",
      settings: { fyndApiType: "platform" },
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      makeReturnCase({
        shopifyOrderName: "", // empty externalOrderId → step 4 skipped
        items: [],
      }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const body = await res.json();
    const step2 = body.apiTrace.find((s: { step: string }) => s.step.startsWith("2."));
    expect(step2).toBeDefined();
    expect(step2.error).toBe("404 from order-details");
    expect(step2.response.status).toBe(0);
  });
});
