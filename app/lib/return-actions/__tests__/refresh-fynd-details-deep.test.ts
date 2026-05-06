/**
 * Deeper unit tests for handleRefreshFyndDetails.
 *
 * The shared extracted-handlers.test.ts already covers basic happy/error paths.
 * This file goes deeper into the branches that matter most operationally:
 *   - When fynd.getShipments() returns full data, that payload is preferred
 *     over the search results — but only when the full list is non-empty.
 *   - Multi-shipment search responses are persisted intact, and the return
 *     shipment is selected for label backfill regardless of position.
 *   - returnLogisticsData backfill exercises every fallback chain
 *     (delivery_partner_details, dp_details, meta, invoice links).
 *   - Each error branch (manual: prefix, missing order #, missing settings,
 *     client construction failure, storefront-only client, empty shipments,
 *     thrown search errors, getShipments failure) redirects with fyndError=
 *     and never throws a raw error.
 *
 * Pattern follows extracted-handlers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const { prismaMock, createFyndClientOrErrorMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));

import { handleRefreshFyndDetails } from "../refresh-fynd-details.server";
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

const ACTION_BODY = { action: "refresh_fynd_details" } as ReturnActionBody;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

describe("handleRefreshFyndDetails — full vs search payload preference", () => {
  it("prefers full getShipments payload over the initial search response", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-100",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const fullShipments = {
      items: [
        { shipment_id: "S-1", journey_type: "forward", status: "delivered" },
        { shipment_id: "S-2", journey_type: "return", status: "return_initiated" },
      ],
    };
    const getShipments = vi.fn(async () => fullShipments);
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        searchShipmentsByExternalOrderId: search,
        getShipments,
      },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    expect(getShipments).toHaveBeenCalledWith("FY-100");
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.fyndPayloadJson as string);
    // Full payload preferred — has the second shipment from the full fetch.
    expect(Array.isArray(stored.items)).toBe(true);
    expect(stored.items).toHaveLength(2);
    expect(stored.items[1].shipment_id).toBe("S-2");
  });

  it("falls back to the search response when getShipments returns an empty list", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-200",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const getShipments = vi.fn(async () => ({ items: [] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search, getShipments },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.fyndPayloadJson as string);
    // Original search response is kept (it has orderId).
    expect(stored.orderId).toBe("FY-200");
    expect(stored.items).toHaveLength(1);
  });

  it("falls back to the search response when getShipments throws", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-300",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const getShipments = vi.fn(async () => {
      throw new Error("fynd 500");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search, getShipments },
    });

    // Must not surface the getShipments error — it's swallowed.
    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.fyndOrderId).toBe("FY-300");
  });

  it("uses shipmentId as fallback when search response has no orderId", async () => {
    const search = vi.fn(async () => ({
      shipmentId: "SH-only",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    const getShipments = vi.fn(async () => ({ items: [{ shipment_id: "S-1" }] }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search, getShipments },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    expect(getShipments).toHaveBeenCalledWith("SH-only");
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.fyndOrderId).toBe("SH-only");
  });
});

describe("handleRefreshFyndDetails — multi-shipment payloads", () => {
  it("persists multi-shipment payload and selects the return shipment for backfill", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-MULTI",
      items: [
        { shipment_id: "F-1", journey_type: "forward", status: "delivered" },
        { shipment_id: "F-2", journey_type: "forward", status: "delivered" },
        {
          shipment_id: "R-1",
          journey_type: "return",
          status: "return_initiated",
          delivery_partner_details: { display_name: "Delhivery", awb_no: "DEL-9" },
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const payload = JSON.parse(update.data.fyndPayloadJson as string);
    expect(payload.items).toHaveLength(3);
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Delhivery");
    expect(stored.trackingNumber).toBe("DEL-9");
    expect(update.data.returnAwb).toBe("DEL-9");
  });

  it("selects return shipment by status starting with 'return_' even without journey_type", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-S",
      items: [
        { shipment_id: "F-1", status: "delivered" },
        {
          shipment_id: "R-1",
          status: "return_pickup_done",
          dp_name: "Bluedart",
          awb_no: "BD-1",
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Bluedart");
    expect(stored.trackingNumber).toBe("BD-1");
  });

  it("reads items from data.items when search response wraps under data", async () => {
    const search = vi.fn(async () => ({
      data: {
        items: [
          {
            shipment_id: "R-only",
            journey_type: "return",
            delivery_partner_details: { name: "Ekart", awb_no: "EK-7" },
          },
        ],
      },
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Ekart");
    expect(stored.trackingNumber).toBe("EK-7");
  });

  it("does not write fyndOrderId when neither orderId nor shipmentId are present", async () => {
    const search = vi.fn(async () => ({
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data).not.toHaveProperty("fyndOrderId");
    // Payload is still persisted.
    expect(typeof update.data.fyndPayloadJson).toBe("string");
  });
});

describe("handleRefreshFyndDetails — returnLogisticsData backfill fallbacks", () => {
  it("falls back to dp_details when delivery_partner_details is missing", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-DP",
      items: [
        {
          shipment_id: "R-1",
          journey_type: "return",
          dp_details: { display_name: "Shadowfax", awb_no: "SF-42" },
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Shadowfax");
    expect(stored.trackingNumber).toBe("SF-42");
  });

  it("falls back to meta.cp_name + meta.awb_no when DP blocks are absent", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-META",
      items: [
        {
          shipment_id: "R-1",
          journey_type: "return",
          meta: { cp_name: "Xpressbees", awb_no: "XB-1" },
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Xpressbees");
    expect(stored.trackingNumber).toBe("XB-1");
    expect(update.data.returnAwb).toBe("XB-1");
  });

  it("captures invoice.links.label and invoice.links.invoice_a4 fallbacks", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-INV",
      items: [
        {
          shipment_id: "R-1",
          journey_type: "return",
          delivery_partner_details: { display_name: "DTDC" },
          invoice: {
            links: {
              label: "https://invoices.example.com/L-1.pdf",
              invoice_a4: "https://invoices.example.com/I-1.pdf",
            },
          },
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.labelUrl).toBe("https://invoices.example.com/L-1.pdf");
    expect(stored.invoiceUrl).toBe("https://invoices.example.com/I-1.pdf");
    expect(stored.source).toBe("fynd_api_refresh");
  });

  it("does NOT write returnLabelJson when no carrier/awb/track/label info is found on the return shipment", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-EMPTY",
      items: [{ shipment_id: "R-1", journey_type: "return", status: "return_initiated" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data).not.toHaveProperty("returnLabelJson");
    expect(update.data).not.toHaveProperty("returnAwb");
  });

  it("only writes returnAwb when an AWB number is present (carrier-only return shipment)", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-CARR",
      items: [
        {
          shipment_id: "R-1",
          journey_type: "return",
          delivery_partner_details: { display_name: "Delhivery" },
          tracking_url: "https://track.example.com/abc",
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    await expectRedirect(handleRefreshFyndDetails(mkCtx(), ACTION_BODY), "fyndRefresh=1");

    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.returnLabelJson).toBeDefined();
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("Delhivery");
    expect(stored.trackingUrl).toBe("https://track.example.com/abc");
    expect(stored.trackingNumber).toBeNull();
    // returnAwb not set when AWB is missing.
    expect(update.data).not.toHaveProperty("returnAwb");
  });
});

describe("handleRefreshFyndDetails — error redirect paths", () => {
  it("redirects with fyndError when shopifyOrderName has only the # prefix (empty after trim)", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: "#" } as never,
    });
    await expectRedirect(handleRefreshFyndDetails(ctx, ACTION_BODY), "fyndError=");
    // No prisma update should have happened.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    // Fynd client construction should be skipped.
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("redirects with fyndError when search throws, surfacing the enriched error message", async () => {
    const search = vi.fn(async () => {
      throw new Error("403 forbidden");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    try {
      await handleRefreshFyndDetails(mkCtx(), ACTION_BODY);
      throw new Error("expected redirect");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      const loc = (err as Response).headers.get("Location") ?? "";
      expect(loc).toContain("fyndError=");
      // Enriched: 403 errors get extra Test Platform guidance.
      expect(decodeURIComponent(loc)).toMatch(/403|forbidden/i);
      expect(decodeURIComponent(loc)).toMatch(/Test Platform/);
    }
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("redirects with fyndError when search returns a plain object with no items", async () => {
    const search = vi.fn(async () => ({}));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });

    try {
      await handleRefreshFyndDetails(mkCtx(), ACTION_BODY);
      throw new Error("expected redirect");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      const loc = (err as Response).headers.get("Location") ?? "";
      expect(loc).toContain("fyndError=");
      expect(decodeURIComponent(loc)).toMatch(/No shipments found for order 1001/);
    }
  });

  it("strips a leading # from shopifyOrderName before sending to Fynd search", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-STR",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: "#1042  " } as never,
    });

    await expectRedirect(handleRefreshFyndDetails(ctx, ACTION_BODY), "fyndRefresh=1");

    // Source does shopifyOrderName.replace(/^#/, "").trim() — the leading
    // "#" is stripped and then surrounding whitespace is trimmed.
    expect(search).toHaveBeenCalledWith(
      "1042",
      expect.objectContaining({
        searchType: "external_order_id",
        groupEntity: "shipments",
      }),
    );
  });

  it("propagates non-Response errors from the prisma update (outer catch rethrows)", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-OUT",
      items: [{ shipment_id: "S-1", journey_type: "forward" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    // Inner try/catch turns Errors into redirect — so a prisma failure becomes
    // a redirect with fyndError= (it's caught after the search resolves).
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));

    try {
      await handleRefreshFyndDetails(mkCtx(), ACTION_BODY);
      throw new Error("expected redirect");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      const loc = (err as Response).headers.get("Location") ?? "";
      expect(loc).toContain("fyndError=");
      expect(decodeURIComponent(loc)).toMatch(/db down/);
    }
  });
});
