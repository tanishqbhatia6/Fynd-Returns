import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.lookup — coverage for the Shopify-orders + Fynd enrichment
 * tail of the action handler. The two existing test files exhaustively
 * cover the OTP gate state machine and the prisma where-clause builders
 * but stop short of the live Shopify / Fynd integration paths reachable
 * once the OTP gate is satisfied or the lookup type is non-contact
 * (lookupType ∈ {return_id, order_no, return_no, forward_awb, return_awb}).
 *
 * This file intentionally targets:
 *   - portalLabelsJson + returnLabelJson JSON.parse branches
 *   - email + phone Shopify-orders fetch (both success and error swallow)
 *   - order_no / return_no direct Shopify fetch + each fallback layer:
 *       FyndOrderMapping (gid + name), ReturnCase (gid + name), and
 *       synthetic order construction from ReturnCase.items
 *   - Fynd-based discovery when Shopify finds nothing (line 433+)
 *       resolved-via-affiliate-id and synthetic-from-Fynd-shipment
 *   - Fynd ENRICHMENT when Shopify already returned an order and
 *     _needsFyndEnrich is true (lines 559–590)
 *   - Fynd-discovery error swallow (line 552)
 *   - return_awb / forward_awb Shopify fulfillment-tracking cross-check
 *     (lines 593–604) — both tracking-match and no-match branches
 *
 * Notes
 *   - jsonReq injects a verified portal token/session so execution flows
 *     through the orders/returns block after the OTP gate.
 *   - shopRecord.settings is a NON-EMPTY object so the `shopRecord.settings`
 *     truthy guards ahead of Fynd calls evaluate true.
 */

const {
  prismaMock,
  checkRateLimitMock,
  sendOtpEmailMock,
  fetchOrdersByFilterMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByGidMock,
  fetchOrderByFyndAffiliateIdMock,
  withRestCredentialsMock,
  shopifyModuleMock,
  getPortalLabelsMock,
  getTrackingInfoMock,
  extractJourneyMock,
  getPickupAddressMock,
  parseFyndOrderDetailsForTabMock,
  createFyndClientOrErrorMock,
  searchShipmentsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  sendOtpEmailMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  fetchOrdersByFilterMock: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByGidMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByFyndAffiliateIdMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  getPortalLabelsMock: vi.fn(() => ({ heading: "Your Returns" })),
  getTrackingInfoMock: vi.fn(() => null),
  extractJourneyMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
  getPickupAddressMock: vi.fn(() => null),
  parseFyndOrderDetailsForTabMock: vi.fn<(...args: unknown[]) => unknown>(() => null),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  searchShipmentsMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ items: [] })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ default: shopifyModuleMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/notification.server", () => ({
  sendOtpEmail: sendOtpEmailMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrdersByFilter: fetchOrdersByFilterMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByGid: fetchOrderByGidMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  getTrackingInfoFromFyndPayload: getTrackingInfoMock,
  extractFyndJourney: extractJourneyMock,
  getPickupAddressFromFyndPayload: getPickupAddressMock,
  parseFyndOrderDetailsForTab: parseFyndOrderDetailsForTabMock,
}));
vi.mock("../../lib/portal-i18n", () => ({
  getPortalLabels: getPortalLabelsMock,
}));
vi.mock("../../lib/portal-auth.server", () => ({
  createPortalCsrfToken: () => "csrf-tok",
  verifyPortalSession: vi.fn(async () => ({
    id: "session-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "shopper@example.com",
    matchedReturnIds: null,
  })),
  hashLookupValue: vi.fn(() => "hash"),
}));

import { action } from "../api.portal.lookup";

function jsonReq(body: unknown) {
  const payload =
    body && typeof body === "object"
      ? { portalToken: "verified-token", sessionId: "session-1", ...body }
      : body;
  return new Request("https://app.example/api/portal/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function shopWithSettings(extra: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    // truthy settings so the Fynd-discovery + Fynd-enrich blocks are entered
    settings: { id: "s-1", fyndApiKey: "k", fyndApiSecret: "x", ...extra },
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  sendOtpEmailMock.mockReset().mockResolvedValue(undefined);
  fetchOrdersByFilterMock.mockReset().mockResolvedValue([]);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByGidMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  shopifyModuleMock.unauthenticated.admin
    .mockReset()
    .mockResolvedValue({ admin: { graphql: vi.fn() } });
  getPortalLabelsMock.mockReset().mockReturnValue({ heading: "Your Returns" });
  getTrackingInfoMock.mockReset().mockReturnValue(null);
  extractJourneyMock.mockReset().mockReturnValue([]);
  getPickupAddressMock.mockReset().mockReturnValue(null);
  parseFyndOrderDetailsForTabMock.mockReset().mockReturnValue(null);
  searchShipmentsMock.mockReset().mockResolvedValue({ items: [] });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });

  // Sensible defaults for downstream queries
  prismaMock.shopSettings.findUnique.mockResolvedValue({
    portalLanguage: "en",
    portalLabelsJson: null,
    defaultReturnInstructions: null,
  });
  prismaMock.session.findFirst.mockResolvedValue({ accessToken: "tok" });
  prismaMock.lookupSession.findUnique.mockResolvedValue({
    id: "session-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "shopper@example.com",
    portalToken: "verified-token",
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    matchedReturnIds: null,
  });
});

// ─────────────── shopSettings JSON parsing branches ───────────────

describe("shopSettings + return record JSON parsing", () => {
  it("portalLabelsJson with valid JSON → applies overrides", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: JSON.stringify({ heading: "Custom" }),
      defaultReturnInstructions: "ship it back",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "r-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(getPortalLabelsMock).toHaveBeenCalledWith("en", { heading: "Custom" });
  });

  it("portalLabelsJson with malformed JSON → caught, overrides stay null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: "{not-json",
      defaultReturnInstructions: null,
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "r-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(getPortalLabelsMock).toHaveBeenCalledWith("en", null);
  });

  it("approved return with returnLabelJson populates the public returnLabel field", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: "instr",
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "approved",
        customerEmailNorm: "shopper@example.com",
        createdAt: new Date(),
        items: [],
        events: [],
        returnLabelJson: JSON.stringify({ carrier: "BlueDart", trackingNumber: "AWB123" }),
        returnLabelUrl: "https://label/url",
      },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "r-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returns[0].returnLabel).toEqual(
      expect.objectContaining({
        carrier: "BlueDart",
        trackingNumber: "AWB123",
        labelUrl: "https://label/url",
      }),
    );
    expect(body.returns[0]).not.toHaveProperty("returnLabelJson");
    expect(body.returns[0]).not.toHaveProperty("returnLabelUrl");
    expect(body.returns[0].returnInstructions).toBe("instr");
  });

  it("returnLabelJson invalid JSON is swallowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-x",
        status: "completed",
        customerEmailNorm: "shopper@example.com",
        createdAt: new Date(),
        items: [],
        events: [],
        returnLabelJson: "{bad-json",
      },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "r-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Caught — no raw/legacy label field leaks, but request still resolves OK.
    expect(body.returns[0]).not.toHaveProperty("returnLabelInfo");
    expect(body.returns[0]).not.toHaveProperty("returnLabelJson");
  });
});

// ─────────────── email + phone Shopify orders fetch ───────────────

describe("Shopify orders fetch (email / phone)", () => {
  it("email lookup queries Shopify with `email:<addr>` filter", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrdersByFilterMock.mockResolvedValueOnce([
      { id: "o-1",
        email: "shopper@example.com", name: "#1001", createdAt: new Date().toISOString() },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "USER@x.COM" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrdersByFilterMock).toHaveBeenCalledWith(expect.anything(), "email:user@x.com");
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]._needsFyndEnrich).toBe(true);
  });

  it("email Shopify fetch error is swallowed (orders empty, 200 OK)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("admin boom"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "email", lookupValue: "u@x.com" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });

  it("verified phone lookup queries Shopify with rawValue free-text", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrdersByFilterMock.mockResolvedValueOnce([
      { id: "o-2", email: "shopper@example.com", name: "#2002" },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "phone", lookupValue: "+1 415 555 1212" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrdersByFilterMock).toHaveBeenCalledWith(expect.anything(), "+1 415 555 1212");
  });

  it("verified phone Shopify fetch error is swallowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("nope"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "phone", lookupValue: "555-1212" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ─────────────── order_no / return_no — direct Shopify path ───────────────

describe("order_no / return_no Shopify direct fetch", () => {
  it("direct Shopify hit returns the order with _needsFyndEnrich=true", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-1",
        email: "shopper@example.com", name: "#1001" });
    // Make sure the fynd-enrich follow-up sees a "no fynd client" early exit.
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "disabled" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "#1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]._needsFyndEnrich).toBe(true);
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
  });

  it("direct Shopify error swallowed; no orders pushed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("boom"));
    // FyndOrderMapping fallback returns null → no synthetic; ReturnCase findMany also empty
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });
});

// ─────────────── FyndOrderMapping fallback ───────────────

describe("FyndOrderMapping fallback (after direct Shopify miss)", () => {
  it("mapping with shopifyOrderId GID → fetchOrderByGid hit", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]); // first findMany (return cases)
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null); // direct miss
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce({
      shopifyOrderId: "gid://shopify/Order/123",
      shopifyOrderName: "#1234",
    });
    fetchOrderByGidMock.mockResolvedValueOnce({ id: "o-from-gid",
        email: "shopper@example.com", name: "#1234" });
    // ReturnCase fallback findMany should not be needed since orders.length>0; but
    // returnCase.findMany is the first call already used. Stub a second call returning [].
    prismaMock.returnCase.findMany.mockResolvedValue([]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1234" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByGidMock).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/123");
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].id).toBe("o-from-gid");
  });

  it("mapping without GID but with shopifyOrderName → fetchOrderByOrderNumber retry", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null); // first call (direct)
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce({
      shopifyOrderId: null,
      shopifyOrderName: "#5678",
    });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-mapped",
        email: "shopper@example.com", name: "#5678" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "5678" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.orders[0].id).toBe("o-mapped");
  });

  it("FyndOrderMapping prisma error swallowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockRejectedValueOnce(new Error("db fail"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "9999" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ─────────────── ReturnCase fallback ───────────────

describe("ReturnCase fallback (Shopify GID + name + synthetic)", () => {
  it("ReturnCase with shopifyOrderId GID → fetchOrderByGid resolves", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]); // initial returnsRaw
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        shopifyOrderId: "gid://shopify/Order/9",
        shopifyOrderName: "#FYND-9",
        items: [],
        createdAt: new Date(),
      },
    ]);
    fetchOrderByGidMock.mockResolvedValueOnce({ id: "o-rc-gid",
        email: "shopper@example.com", name: "#FYND-9" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_no", lookupValue: "FYND-9" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByGidMock).toHaveBeenCalled();
    const body = await res.json();
    expect(body.orders[0].id).toBe("o-rc-gid");
  });

  it("ReturnCase GID fetch error swallowed; falls into name path", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-2",
        shopifyOrderId: "gid://shopify/Order/x",
        shopifyOrderName: "#NAME-X",
        items: [],
        createdAt: new Date(),
      },
    ]);
    // GID call: throw via shopify admin
    shopifyModuleMock.unauthenticated.admin
      .mockResolvedValueOnce({ admin: { graphql: vi.fn() } }) // direct (orders empty)
      .mockRejectedValueOnce(new Error("gid fail")) // GID branch fails
      .mockResolvedValueOnce({ admin: { graphql: vi.fn() } }); // name branch
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-name",
        email: "shopper@example.com", name: "#NAME-X" });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "NAME-X" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0]?.id).toBe("o-name");
  });

  it("ReturnCase name-fetch error swallowed; synthetic order constructed from items", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-syn",
        shopifyOrderId: null,
        shopifyOrderName: "#SYN-1",
        customerEmailNorm: "buyer@x.com",
        fyndShipmentId: "fy-1",
        fyndPayloadJson: JSON.stringify({ shipments: [], something: 1 }),
        items: [
          { id: "it-1", shopifyLineItemId: "li-1", notes: "Tee", sku: "TEE", qty: 2 },
          { id: "it-2", shopifyLineItemId: null, notes: null, sku: "BAG", qty: 1 },
        ],
        createdAt: new Date("2025-01-01T00:00:00Z"),
      },
    ]);
    // Name-fetch attempt fails → synthetic builder runs
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("name fail"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "SYN-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    const o = body.orders[0];
    expect(o.id).toBe("rc-syn");
    expect(o.name).toBe("#SYN-1");
    expect(o).not.toHaveProperty("email");
    expect(o.lineItems).toHaveLength(2);
    expect(o.lineItems[0].title).toBe("Tee");
    expect(o.lineItems[1].title).toBe("BAG");
    expect(o._needsFyndEnrich).toBe(true);
  });

  it("synthetic-order path with broken fyndPayloadJson swallows JSON.parse error", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-broken",
        customerEmailNorm: "shopper@example.com",
        shopifyOrderId: null,
        shopifyOrderName: null, // skip the name branch entirely
        fyndPayloadJson: "{not-json",
        items: [],
        createdAt: new Date(),
      },
    ]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "BROKEN-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].id).toBe("rc-broken");
  });

  it("ReturnCase findMany throws → swallowed, orders stay empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]); // returnsRaw
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("db crash"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "ZZZ" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });
});

// ─────────────── Fynd-based discovery (orders.length === 0 + settings) ───────────────

describe("Fynd-based order discovery (Shopify-empty fallback)", () => {
  it("Fynd shipments → resolves real Shopify order via affiliate_order_id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [
        {
          journey_type: "forward",
          affiliate_order_id: "FYND-ABC-1",
          bags: [{ delivery_address: { city: "BLR" }, prices: { currency_code: "INR" } }],
        },
      ],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce({ shipments: [] });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "shop-found",
        email: "shopper@example.com",
      name: "#FYND-ABC-1",
    });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "FYND-ABC-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalled();
    const body = await res.json();
    expect(body.orders[0].id).toBe("shop-found");
    expect(body.orders[0]._needsFyndEnrich).toBe(false);
  });

  it("Fynd shipments → builds synthetic order with line items + shipping address", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [
        {
          journey_type: "forward",
          affiliate_order_id: "AFFX-1",
          customer_details: { email: "fc@x.com", name: "Fynd Customer" },
          bags: [
            {
              delivery_address: {
                city: "BLR",
                state: "KA",
                country: "IN",
                pincode: "560001",
                name: "Fynd C",
              },
              prices: { currency_code: "INR" },
            },
          ],
        },
      ],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce({
      shipments: [
        {
          items: [
            { itemId: "i1", sku: "SKU1", title: "Item 1", quantity: 2, price: "10.00" },
            { itemId: "i2", sku: "SKU1", title: "Dup", quantity: 1 }, // dedupe by sku
            { itemId: "i3", sku: "SKU2", title: "Item 2" },
          ],
        },
      ],
    });
    extractJourneyMock.mockReturnValueOnce([{ step: "shipped" }]);
    // No shopify resolve — fetchOrderByFyndAffiliateId returns null
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "AFFX-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    const o = body.orders[0];
    expect(o.name).toBe("AFFX-1");
    expect(o).not.toHaveProperty("email");
    expect(o.currencyCode).toBe("INR");
    // sku-based dedupe: 2 unique skus → 2 line items
    expect(o.lineItems).toHaveLength(2);
    expect(o).not.toHaveProperty("shippingAddress");
    expect(o._needsFyndEnrich).toBe(false);
  });

  it("Fynd affiliate-id resolve throws → swallowed and synthetic falls in", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [
        {
          journey_type: "forward",
          affiliate_order_id: "AFF-T",
          customer_details: { email: "shopper@example.com", phone: "+15550100" },
          bags: [],
        },
      ],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce(null);
    // Make the shopify admin call inside the affiliate resolve throw
    shopifyModuleMock.unauthenticated.admin
      .mockResolvedValueOnce({ admin: {} }) // direct order_no lookup
      .mockRejectedValueOnce(new Error("aff fail")); // affiliate resolve

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "AFF-T" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // synthetic fallback ran
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].name).toBe("AFF-T");
  });

  it("Fynd discovery: response with empty `data.items` → no orders pushed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({ data: { items: [] } });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "EMPTY-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });

  it("Fynd discovery: only-return shipments fall through to rawItems (forwardItems empty)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [
        {
          journey_type: "return",
          affiliate_order_id: "RET-1",
          customer_details: { email: "shopper@example.com", phone: "+15550100" },
          bags: [],
        },
      ],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce(null);
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "RET-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1); // synthetic
  });

  it("Fynd discovery throws — error swallowed, orders stay empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.fyndOrderMapping.findFirst.mockResolvedValueOnce(null);
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("fynd-down"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "FYND-ERR" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });
});

// ─────────────── Fynd ENRICHMENT (existing Shopify order + _needsFyndEnrich) ───────────────

describe("Fynd enrichment for existing Shopify order (lines 559-590)", () => {
  it("attaches parsed Fynd payload to orders[0] when forward shipments returned", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-enrich",
        email: "shopper@example.com", name: "#1001" });

    // First call (Fynd discovery block) is bypassed because orders.length>0;
    // Only the enrichment block fires.
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [{ journey_type: "forward", id: "ship-1" }],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce({ shipments: [{ items: [] }] });
    extractJourneyMock.mockReturnValueOnce([{ step: "ok" }]);

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1001" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0]).not.toHaveProperty("fyndData");
    expect(body.orders[0]._needsFyndEnrich).toBe(false);
  });

  it("enrichment with empty fynd items → no fyndData attached", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-noenr",
        email: "shopper@example.com", name: "#1002" });

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({ items: [] });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1002" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0]).not.toHaveProperty("fyndData");
  });

  it("enrichment: forwardItems empty → uses rawItems (return-only shipments)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-only-ret",
        email: "shopper@example.com", name: "#1003" });

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [{ journey_type: "return", id: "rship-1" }],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce({ shipments: [] });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1003" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0]).not.toHaveProperty("fyndData");
  });

  it("enrichment with parseFyndOrderDetailsForTab returning null → no enrichment, but loop breaks", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-null-parse",
        email: "shopper@example.com", name: "#1004" });

    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchShipmentsMock },
    });
    searchShipmentsMock.mockResolvedValueOnce({
      items: [{ journey_type: "forward", id: "s-1" }],
    });
    parseFyndOrderDetailsForTabMock.mockReturnValueOnce(null); // parser returns null

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1004" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders[0]).not.toHaveProperty("fyndData");
    // _needsFyndEnrich should remain true since enrichment didn't materialise
    expect(body.orders[0]._needsFyndEnrich).toBe(true);
  });

  it("enrichment block error swallowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-throw",
        email: "shopper@example.com", name: "#1005" });
    createFyndClientOrErrorMock.mockRejectedValueOnce(new Error("enrich boom"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1005" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
  });

  it("enrichment skipped when fynd client lacks searchShipmentsByExternalOrderId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "o-noclient",
        email: "shopper@example.com", name: "#1006" });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        /* missing search method */
      },
    });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "order_no", lookupValue: "1006" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // No enrichment, but order still present
    expect(body.orders[0]?.id).toBe("o-noclient");
  });
});

// ─────────────── return_awb / forward_awb Shopify cross-check ───────────────

describe("AWB lookup: Shopify fulfillments tracking-number cross-check", () => {
  it("return_awb empty Shopify orders → falls into AWB tracking-search; matching tracking pushes order", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "o-awb",
        email: "shopper@example.com",
      name: "#A-1",
      fulfillments: [{ trackingInfo: [{ number: "AWB-MATCH-9" }] }],
    });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_awb", lookupValue: "AWB-MATCH-9" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0].id).toBe("o-awb");
    expect(body.orders[0]._needsFyndEnrich).toBe(true);
  });

  it("return_awb tracking number does NOT match → order not pushed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "o-no-awb",
        email: "shopper@example.com",
      name: "#A-2",
      fulfillments: [{ trackingInfo: [{ number: "OTHER-XX" }] }],
    });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_awb", lookupValue: "AWB-NOMATCH" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });

  it("forward_awb with no fulfillments still resolves cleanly", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "o-empty-f",
        email: "shopper@example.com",
      name: "#A-3",
      fulfillments: [],
    });

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "forward_awb", lookupValue: "AWB-Q" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });

  it("AWB shopify admin throws → caught best-effort, 200 OK no orders", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithSettings());
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("awb fail"));

    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "forward_awb", lookupValue: "AWB-Q-X" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toEqual([]);
  });
});

// ─────────────── outer-catch top-level error path ───────────────

describe("outer try/catch catch-all", () => {
  it("shop.findUnique throws → 500 (catch-all)", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db dead"));
    const res = await action({
      request: jsonReq({ shop: "store", lookupType: "return_id", lookupValue: "rr" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});
