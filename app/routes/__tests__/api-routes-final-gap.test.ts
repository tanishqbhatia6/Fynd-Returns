/**
 * Final-gap coverage tests for five route files.
 *
 * Targets the last few uncovered statements to push each file toward 100%:
 *  - api.portal.otp.verify.ts        (lines 30, 100, 105)
 *  - api.portal.fynd-enrich.ts       (lines 121, 162, 171-172)
 *  - api.portal.products.ts          (lines 68, 101, 128, 174)
 *  - api.returns.$id.actions.ts      (line 74)
 *  - api.returns.$id.diagnose.ts     (lines 213, 236)
 *
 * No source modifications. All prisma + helper calls are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ─── Hoisted mocks shared by every suite ─────────────────────────────────────
const {
  prismaMock,
  // otp
  createPortalTokenMock,
  verifyPortalSessionMock,
  // shared rate-limit
  checkRateLimitMock,
  // fynd-enrich
  createFyndClientOrErrorMock,
  parseFyndOrderDetailsMock,
  extractFyndJourneyMock,
  getTrackingInfoMock,
  getPickupAddressMock,
  // actions
  authenticateMock,
  closeShopifyReturnMock,
  // diagnose
  diagFetchOrderMock,
  diagFetchOrderByOrderNumberMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createPortalTokenMock: vi.fn(() => "jwt-token"),
  verifyPortalSessionMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  parseFyndOrderDetailsMock: vi.fn(() => ({ orderInfo: { name: "#1001" } })),
  extractFyndJourneyMock: vi.fn(() => [{ status: "x" }]),
  getTrackingInfoMock: vi.fn(() => ({ awb: "AWB-1" })),
  getPickupAddressMock: vi.fn(() => ({ city: "SF" })),
  authenticateMock: vi.fn(),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  diagFetchOrderMock: vi.fn(),
  diagFetchOrderByOrderNumberMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());
// fyndOrderMapping isn't in the default model list — attach manually.
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
};

// db.server is shared by every route under test
vi.mock("../../db.server", () => ({ default: prismaMock }));

// ── otp.verify deps
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) =>
    Response.json({ error: "rate" }, { status: 429, headers: { "Retry-After": String(ms) } }),
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalToken: createPortalTokenMock,
  verifyPortalSession: verifyPortalSessionMock,
}));

// ── fynd-enrich deps
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  parseFyndOrderDetailsForTab: parseFyndOrderDetailsMock,
  extractFyndJourney: extractFyndJourneyMock,
  getTrackingInfoFromFyndPayload: getTrackingInfoMock,
  getPickupAddressFromFyndPayload: getPickupAddressMock,
  extractShippingDetailsFromFyndPayload: vi.fn(() => ({})),
  isLikelyFyndId: vi.fn(() => false),
}));

// ── actions deps
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  createRefund: vi.fn(),
  createShopifyReturn: vi.fn(),
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
  fetchOrder: diagFetchOrderMock,
  fetchOrderByGid: vi.fn(),
  fetchOrderByOrderNumber: diagFetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: vi.fn(),
  fetchOrderLineItemsOnly: vi.fn(),
  fetchOrderLineItemsByName: vi.fn(),
  withRestCredentials: (a: unknown) => a,
  fetchVariantInfo: vi.fn(),
  sendDraftOrderInvoice: vi.fn(),
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: vi.fn(),
}));
vi.mock("../../lib/notification.server", () => ({
  sendRejectionNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  sendApprovalNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRefundNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCustomerNoteNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  sendCancellationNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  sendCancellationDeclinedNotification: vi.fn<(...a: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: vi.fn(),
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: vi.fn(),
}));
vi.mock("../../lib/observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, cb: (span: unknown) => Promise<T>) =>
    cb({ setAttribute: () => {}, setAttributes: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
  setSpanAttributes: vi.fn(),
}));
vi.mock("../../lib/observability/logger.server", () => ({
  refundLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../lib/observability/metrics.server", () => ({
  returnActionCounter: { add: vi.fn() },
  returnActionDuration: { record: vi.fn() },
  refundCounter: { add: vi.fn() },
  refundAmountHistogram: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
  returnsApprovedCounter: { add: vi.fn() },
  returnsRejectedCounter: { add: vi.fn() },
  returnsCompletedCounter: { add: vi.fn() },
  appErrorCounter: { add: vi.fn() },
  portalOtpCounter: { add: vi.fn() },
}));
vi.mock("../../lib/observability/audit.server", () => ({
  auditReturnAction: vi.fn(),
}));
vi.mock("../../lib/observability/slo.server", () => ({
  annotateSLO: vi.fn(),
}));
vi.mock("../../lib/observability/request-context.server", () => ({
  setRequestContext: vi.fn(),
}));
vi.mock("../../lib/return-action-errors.server", () => ({
  enrichFyndError: vi.fn((e: unknown) => e),
  classifyFyndError: vi.fn(() => "unknown"),
  enrichRefundError: vi.fn((e: unknown) => e),
  isRedirectResponse: vi.fn(() => false),
  extractErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

import { action as otpAction, loader as otpLoader } from "../api.portal.otp.verify";
import { action as fyndAction } from "../api.portal.fynd-enrich";
import { loader as productsLoader } from "../api.portal.products";
import { action as returnsActionsAction } from "../api.returns.$id.actions";
import { loader as diagnoseLoader } from "../api.returns.$id.diagnose";

function getMappingUpsertMock() {
  return (prismaMock as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)
    .fyndOrderMapping.upsert;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  const upsert = getMappingUpsertMock();
  upsert.mockReset().mockResolvedValue({});
  createPortalTokenMock.mockClear();
  verifyPortalSessionMock.mockReset().mockResolvedValue({
    id: "lookup-session",
    shopId: "shop-1",
    lookupType: "order_no",
    lookupValueHash: "hash",
    lookupValueNorm: "1001",
    matchedReturnIds: JSON.stringify(["r-1"]),
  });
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  parseFyndOrderDetailsMock.mockReset().mockReturnValue({ orderInfo: { name: "#1001" } });
  extractFyndJourneyMock.mockReset().mockReturnValue([{ status: "x" }]);
  getTrackingInfoMock.mockReset().mockReturnValue({ awb: "AWB-1" });
  getPickupAddressMock.mockReset().mockReturnValue({ city: "SF" });
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok", email: "admin@x.com" },
    admin: { graphql: vi.fn() },
  });
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
  diagFetchOrderMock.mockReset();
  diagFetchOrderByOrderNumberMock.mockReset();
});

// ─────────────────────────────────────────────────────────────────────────────
// api.portal.otp.verify — final gap (lines 30, 100, 105)
// ─────────────────────────────────────────────────────────────────────────────
describe("api.portal.otp.verify — final gap", () => {
  // Line 30 — loader returns null on non-OPTIONS request
  it("loader returns null for a plain GET (non-OPTIONS) request", async () => {
    const res = await otpLoader({
      request: new Request("https://app/x", { method: "GET" }),
      params: {},
      context: {},
    } as never);
    expect(res).toBe(null);
  });

  // Line 100 — SHA-256 path successfully matches a legacy-hashed OTP. This
  // exercises the full try block (Buffer.from + timingSafeEqual) for the
  // legacy branch including the success comparison. The catch is defensive
  // for unreachable buffer length mismatches.
  it("legacy SHA-256 hex hash matches when submitted OTP hashes to the same digest", async () => {
    const crypto = await import("node:crypto");
    const otp = "424242";
    const legacyHash = crypto.createHash("sha256").update(otp).digest("hex");
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: new Date(Date.now() - 1000),
      otpTarget: legacyHash,
      lookupValueHash: "lookup-hash",
      lookupType: "email",
    });
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);

    const res = await otpAction({
      request: new Request("https://app/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s-1", otp }),
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
  });

  // Line 105 — bcrypt.compare throws → caught → isValid = false
  it("bcrypt.compare throwing is caught and counted as a miss", async () => {
    const spy = vi.spyOn(bcrypt, "compare").mockImplementation(() => {
      throw new Error("bcrypt internal failure");
    });
    // bcrypt-shaped (non-hex) hash → bcrypt branch
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "s-1",
      shopId: "shop-1",
      expiresAt: new Date(Date.now() + 60_000),
      attemptsCount: 0,
      otpSentAt: new Date(Date.now() - 1000),
      otpTarget: "$2a$10$abcdefghijklmnopqrstuv",
      lookupValueHash: "h",
      lookupType: "email",
    });
    prismaMock.lookupSession.findMany.mockResolvedValueOnce([]);
    prismaMock.lookupSession.update.mockResolvedValueOnce({ attemptsCount: 1 });

    const res = await otpAction({
      request: new Request("https://app/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s-1", otp: "111" }),
      }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api.portal.fynd-enrich — final gap (lines 121, 162, 171-172)
// ─────────────────────────────────────────────────────────────────────────────
describe("api.portal.fynd-enrich — final gap", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  // Line 121 — upsert update branch carries fyndShipmentId / strategy.
  it("upsert update branch propagates fyndShipmentId + searchStrategy fields", async () => {
    const searchMock = vi.fn().mockResolvedValueOnce({
      items: [{ shipment_id: "SH-UPD", order_id: "O-1", journey_type: "forward" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });

    await fyndAction({
      request: new Request("https://app/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: "store", type: "order", orderName: "1001" }),
      }),
      params: {},
      context: {},
    } as never);
    await new Promise((r) => setImmediate(r));

    const upsert = getMappingUpsertMock();
    expect(upsert).toHaveBeenCalled();
    const payload = upsert.mock.calls[0][0] as {
      update: { fyndOrderId: string; fyndShipmentId: string; searchStrategy: string };
    };
    expect(payload.update.fyndShipmentId).toBe("SH-UPD");
    expect(payload.update.fyndOrderId).toBe("O-1");
    expect(payload.update.searchStrategy).toBe("external_order_id");
  });

  // Line 162 — exact match falls back to s.id when shipment_id is absent.
  it("returns enrichment exact-match uses s.id fallback when shipment_id missing", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [
        { id: "BAG-77", journey_type: "return" }, // matches stored fyndShipmentId via s.id
        { shipment_id: "SH-OTHER", journey_type: "return" },
      ],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "BAG-77", fyndPayloadJson: null },
    ]);

    const res = await fyndAction({
      request: new Request("https://app/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body.returnEnrichments["r-1"]).toBeDefined();
  });

  // Lines 171-172 — liveShipmentId resolves matched.shipmentId (camelCase) when
  // matched.shipment_id is absent.
  it("returns enrichment liveShipmentId falls back to camelCase shipmentId", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      items: [{ shipmentId: "SH-CAMEL", journey_type: "return" }],
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchMock },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "r-1", shopifyOrderName: "#5001", fyndShipmentId: "WHATEVER", fyndPayloadJson: null },
    ]);

    const res = await fyndAction({
      request: new Request("https://app/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: "store", type: "returns", returnIds: ["r-1"] }),
      }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    expect(body.returnEnrichments["r-1"].fyndShipmentId).toBe("SH-CAMEL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api.portal.products — final gap (lines 68, 101, 128, 174)
// ─────────────────────────────────────────────────────────────────────────────
describe("api.portal.products — final gap", () => {
  const origFetch = globalThis.fetch;
  const shopWithExchange = {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: { portalExchangeEnabled: true },
  };

  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue(shopWithExchange);
    prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
    globalThis.fetch = vi.fn();
  });

  // restore original fetch after each test in this describe
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  // Line 68 — shopDomain *with* a dot is used verbatim (no .myshopify.com appended).
  it("uses shopDomain verbatim when query param already contains a dot (line 68 ternary true branch)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ products: [] }),
    }) as typeof fetch;

    await productsLoader({
      request: new Request("https://app/api/portal/products?shop=already.has.dot.com"),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "already.has.dot.com" },
      }),
    );
  });

  // Line 101 — `if (response.ok)` false branch in the productId path returns
  // an empty products[] (no body parsing).
  it("returns products:[] when single-product Shopify fetch responds non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ errors: "boom" }),
    }) as typeof fetch;

    const res = await productsLoader({
      request: new Request("https://app/api/portal/products?shop=store&productId=42"),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  // Line 128 — `if (response.ok)` false branch in the search path
  it("returns products:[] when search Shopify fetch responds non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as typeof fetch;

    const res = await productsLoader({
      request: new Request("https://app/api/portal/products?shop=store"),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.products).toEqual([]);
  });

  // Line 174 — `(p.variants || [])` when variants is undefined.
  it("maps a product with no `variants` field via the empty-array fallback", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        products: [
          {
            id: 1,
            title: "NoVariantsKey",
            handle: "n",
            product_type: "",
            vendor: "",
            images: [],
            // variants intentionally absent — exercises (p.variants || []) fallback
          },
        ],
      }),
    }) as typeof fetch;

    const res = await productsLoader({
      request: new Request("https://app/api/portal/products?shop=store"),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    // Mapped to PortalProduct with variants:[] then dropped by availability filter.
    expect(body.products).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api.returns.$id.actions — final gap (line 74)
// logShopifyReturnEvent helper executes prisma.returnEvent.create(...).catch.
// ─────────────────────────────────────────────────────────────────────────────
describe("api.returns.$id.actions — final gap", () => {
  it("logShopifyReturnEvent helper persists a returnEvent on terminal status update (line 74)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopId: "shop-1",
      status: "pending",
      returnRequestNo: "R-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid://shopify/Order/123",
      customerEmailNorm: "u@example.com",
      adminNotes: null,
      notesForCustomer: null,
      currency: "USD",
      refundStatus: null,
      cancellationRequestedAt: null,
      items: [],
    });

    // closeShopifyReturnBestEffort — invoke the supplied logEvent callback
    // synchronously so the helper at line 74 executes prisma.returnEvent.create.
    closeShopifyReturnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[2] as
        | { logEvent?: (e: { eventType: string; payloadJson: string }) => Promise<void> }
        | undefined;
      if (opts?.logEvent) {
        await opts.logEvent({ eventType: "shopify.return.closed", payloadJson: "{}" });
      }
      return undefined;
    });

    let res: Response;
    try {
      res = await returnsActionsAction({
        request: new Request("https://app/api/returns/rc-1/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update_status", status: "completed", note: "done" }),
        }),
        params: { id: "rc-1" },
        context: {},
      } as never);
    } catch (thrown) {
      if (thrown instanceof Response) res = thrown;
      else throw thrown;
    }

    // Two returnEvent.create calls expected:
    //   1. inside update-status handler (status_updated event)
    //   2. via logShopifyReturnEvent helper (the line we want covered)
    const calls = prismaMock.returnEvent.create.mock.calls as unknown as Array<
      [{ data: { eventType: string; source: string } }]
    >;
    const helperCall = calls.find(
      (c) => c[0]?.data?.source === "admin" && c[0]?.data?.eventType === "shopify.return.closed",
    );
    expect(helperCall).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// api.returns.$id.diagnose — final gap (lines 213, 236)
// ─────────────────────────────────────────────────────────────────────────────
describe("api.returns.$id.diagnose — final gap", () => {
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

  // Line 213 — step 3 (verify shipment_id) catch block: search throws.
  it("captures per-step error in trace when step 3 (shipment_id verify) throws", async () => {
    // Search by external_order_id -> success (no orderId so step 2 skipped).
    // Search by shipment_id -> throws -> hits the line 213 catch.
    const searchMock = vi
      .fn()
      .mockResolvedValueOnce({ items: [] }) // step 1
      .mockRejectedValueOnce(new Error("503 ship lookup")); // step 3
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
        // 15+ digits → looksLikeShipmentId(true) → derivedTargetShipId set
        fyndShipmentId: "111222333444555",
        shopifyOrderName: "", // empty externalOrderId → step 4 skipped
        items: [],
      }),
    );

    const res = await diagnoseLoader({
      request: new Request("https://app/api/returns/rc-1/diagnose"),
      params: { id: "rc-1" },
      context: {},
    } as never);
    const body = await res.json();
    const step3 = body.apiTrace.find((s: { step: string }) => s.step.startsWith("3."));
    expect(step3).toBeDefined();
    expect(step3.error).toBe("503 ship lookup");
    expect(step3.response.status).toBe(0);
  });

  // Line 236 — step 4 (externalOrderId fallback) catch block.
  it("captures per-step error in trace when step 4 (externalOrderId fallback) throws", async () => {
    // Search by external_order_id succeeds with no orderId → step 2 skipped.
    // No derivedTargetShipId → step 3 skipped.
    // externalOrderId set ("1001") → step 4 runs → throws → line 236 catch.
    const searchMock = vi.fn().mockResolvedValueOnce({ items: [] });
    const getShipmentsMock = vi.fn().mockRejectedValue(new Error("404 ext-order"));
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
        fyndShipmentId: null, // no derivedTargetShipId → step 3 skipped
        shopifyOrderName: "#1001",
        items: [],
      }),
    );
    diagFetchOrderByOrderNumberMock.mockResolvedValueOnce(null);

    const res = await diagnoseLoader({
      request: new Request("https://app/api/returns/rc-1/diagnose"),
      params: { id: "rc-1" },
      context: {},
    } as never);
    const body = await res.json();
    const step4 = body.apiTrace.find((s: { step: string }) => s.step.startsWith("4."));
    expect(step4).toBeDefined();
    expect(step4.error).toBe("404 ext-order");
    expect(step4.response.status).toBe(0);
  });
});
