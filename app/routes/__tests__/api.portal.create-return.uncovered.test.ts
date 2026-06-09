import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.portal.create-return — supplemental coverage tests targeting branches
 * still uncovered by the primary + coverage suites:
 *
 *   • Notification failure swallowed (.catch on sendNewReturnNotification)
 *   • Fynd retry scheduler triggered when createReturnOnFynd throws
 *   • Structured exchange variant payload — invalid + successful validation
 *   • Auto-approve when customer-return-count fetch throws
 *   • $transaction rollback for non-QUANTITY_EXCEEDED errors (re-throw path)
 *   • Per-bag, sku-shipment, and order-level line-item cap rejections
 *   • Manual-mode item summary (`it.notes ?? "Manual return"`) and validation
 *   • Fynd status gate (status not delivered → 400)
 *   • Multi-shipment fyndShipmentId branch + green-return event creation
 *
 * Existing test files in this directory must NOT be modified.
 */

const {
  prismaMock,
  shopifyModuleMock,
  checkRateLimitMock,
  verifyPortalCsrfMock,
  withRestCredentialsMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateIdMock,
  parseJsonArrayMock,
  evaluateAutoApproveRulesMock,
  parseAutoApproveRulesMock,
  createReturnOnFyndMock,
  createFyndClientOrErrorMock,
  sendNewReturnNotificationMock,
  checkReturnEligibilityMock,
  buildReturnRequestIdMock,
  parseReturnIdConfigMock,
  formatReturnRequestIdMock,
  nextReturnIdCounterMock,
  normalizeSourceChannelMock,
  scheduleRetryMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  shopifyModuleMock: {
    unauthenticated: {
      admin: vi.fn(),
    },
  },
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  verifyPortalCsrfMock: vi.fn(() => true),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  parseJsonArrayMock: vi.fn((s: string | null, fallback: unknown[]) =>
    s ? JSON.parse(s) : fallback,
  ),
  evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
  parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => [] as unknown[]),
  createReturnOnFyndMock: vi.fn(),
  createFyndClientOrErrorMock: vi.fn(),
  sendNewReturnNotificationMock: vi.fn().mockResolvedValue(undefined),
  checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => { eligible: boolean; reason?: string }>(
    () => ({ eligible: true }),
  ),
  buildReturnRequestIdMock: vi.fn(() => "R-1001"),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "id" })),
  formatReturnRequestIdMock: vi.fn((x: string) => `R-${x}`),
  nextReturnIdCounterMock: vi.fn().mockResolvedValue(1),
  normalizeSourceChannelMock: vi.fn((x: string) => x),
  scheduleRetryMock: vi.fn().mockResolvedValue(undefined),
}));

Object.assign(prismaMock, createPrismaMock());
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
  findFirst: vi.fn().mockResolvedValue(null),
};
(prismaMock as unknown as Record<string, unknown>).fyndWebhookLog = {
  findFirst: vi.fn().mockResolvedValue(null),
};

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
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalCsrfToken: verifyPortalCsrfMock,
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
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  withRestCredentials: withRestCredentialsMock,
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendNewReturnNotification: sendNewReturnNotificationMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: evaluateAutoApproveRulesMock,
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: formatReturnRequestIdMock,
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: nextReturnIdCounterMock,
}));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: scheduleRetryMock,
}));

import { action } from "../api.portal.create-return";

const origEnv = { ...process.env };

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/create-return", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function happyShop(overrideSettings: Record<string, unknown> = {}) {
  return {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: {
      id: "settings-1",
      blocklistEnabled: false,
      returnWindowDays: 30,
      returnOffersEnabled: false,
      autoApproveEnabled: false,
      autoApproveRulesJson: null,
      greenReturnsEnabled: false,
      ...overrideSettings,
    },
  };
}

function happyBody(extra: Record<string, unknown> = {}) {
  return {
    shop: "store",
    shopifyOrderName: "1001",
    orderId: "gid://shopify/Order/1",
    customerEmail: "shopper@example.com",
    items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1, reasonCode: "size" }],
    lineItemsWithPrice: [
      {
        id: "gid://shopify/LineItem/100",
        title: "Tee",
        price: "25.00",
        quantity: 1,
        productTags: ["sale"],
        sku: "TEE-1",
      },
    ],
    orderCreatedAt: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  process.env = { ...origEnv, PORTAL_CSRF_REQUIRED: "false" };
  resetPrismaMock(prismaMock);
  const fynd = (
    prismaMock as unknown as Record<
      string,
      { upsert: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> }
    >
  ).fyndOrderMapping;
  fynd.upsert.mockReset().mockResolvedValue({});
  fynd.findFirst.mockReset().mockResolvedValue(null);
  const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
    .fyndWebhookLog;
  wlog.findFirst.mockReset().mockResolvedValue(null);
  shopifyModuleMock.unauthenticated.admin.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  verifyPortalCsrfMock.mockReset().mockReturnValue(true);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderMock.mockReset().mockResolvedValue({
    id: "gid://shopify/Order/1",
    email: "shopper@example.com",
    displayFulfillmentStatus: "FULFILLED",
    displayFinancialStatus: "PAID",
    sourceName: "web",
    affiliateOrderId: null,
    lineItems: [],
  });
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchOrderByFyndAffiliateIdMock.mockReset().mockResolvedValue(null);
  parseJsonArrayMock
    .mockReset()
    .mockImplementation((s: string | null, fallback: unknown[]) => (s ? JSON.parse(s) : fallback));
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  createReturnOnFyndMock
    .mockReset()
    .mockResolvedValue({ success: true, fyndReturnId: "fr-1", fyndShipmentId: "fs-1" });
  createFyndClientOrErrorMock
    .mockReset()
    .mockResolvedValue({ ok: false, error: "Fynd not configured" });
  sendNewReturnNotificationMock.mockReset().mockResolvedValue(undefined);
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-1001");
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "id" });
  formatReturnRequestIdMock.mockReset().mockImplementation((x: string) => `R-${x}`);
  nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
  normalizeSourceChannelMock.mockReset().mockImplementation((x: string) => x);
  scheduleRetryMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...origEnv };
});

// ────────────────────────── Notification failure swallowed ──────────────────────────

describe("notification failure (.catch swallowed)", () => {
  it("returns 200 even when sendNewReturnNotification rejects", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = {
      id: "rc-notif-fail-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
      returnRequestNo: "R-1001",
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    sendNewReturnNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // allow microtasks for the .catch handler to run
    await new Promise((r) => setImmediate(r));
    expect(sendNewReturnNotificationMock).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ────────────────────────── Fynd retry scheduler on sync failure ──────────────────────────

describe("fynd retry on createReturnOnFynd throw", () => {
  it("schedules retry when createReturnOnFynd rejects", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-retry-1", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
    email: "shopper@example.com",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      affiliateOrderId: "AFF-RETRY",
      lineItems: [],
    });
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("Fynd 503 unreachable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(scheduleRetryMock).toHaveBeenCalledWith("rc-retry-1", "Fynd 503 unreachable");
    warnSpy.mockRestore();
  });

  it("non-fatal when scheduleRetry itself throws (catch swallowed)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-retry-2", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));
    scheduleRetryMock.mockRejectedValueOnce(new Error("retry table missing"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});

// ────────────────────────── Structured exchange variants ──────────────────────────

describe("structured exchange variant payload", () => {
  it("400 when exchange variant fetch returns non-ok status", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    // First session lookup is for shopAccessToken (any non-empty shape).
    // Second session lookup is the offline session for variant validation.
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accessToken: "tok" })
      .mockResolvedValueOnce({ accessToken: "offline-tok" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangePreference: "Larger size",
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              productId: "gid://shopify/Product/9",
              variantId: "gid://shopify/ProductVariant/99",
              variantTitle: "Size L",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no longer available/i);
    expect(Array.isArray(body.details)).toBe(true);
    fetchSpy.mockRestore();
  });

  it("400 when variantId is not in product's variants list", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accessToken: "tok" })
      .mockResolvedValueOnce({ accessToken: "offline-tok" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ product: { variants: [{ id: 12345 }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              productId: "gid://shopify/Product/9",
              variantId: "gid://shopify/ProductVariant/99",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    fetchSpy.mockRestore();
  });

  it("400 when variant fetch throws (caught and reported)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accessToken: "tok" })
      .mockResolvedValueOnce({ accessToken: "offline-tok" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network!"));
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              productId: "gid://shopify/Product/9",
              variantId: "gid://shopify/ProductVariant/99",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    fetchSpy.mockRestore();
  });

  it("creates return with structured variants persisted to event payload (replacement)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      accessToken: "tok",
    });
    // resolutionType=replacement → exchangeVariants array is NOT consumed (only "exchange" branch).
    // This still exercises the replacement codepath for exchangePreference text-only.
    const createdRc = { id: "rc-rep-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "replacement",
          exchangePreference: "Send same item again",
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.resolutionType).toBe("replacement");
    expect(callArg?.data?.exchangePreference).toMatch(/Send same item/);
  });

  it("falls back to trusting picker when no offline session exists", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accessToken: "tok" })
      .mockResolvedValueOnce(null); // no offline session
    const createdRc = {
      id: "rc-ex-fallback",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              productId: "gid://shopify/Product/9",
              variantId: "gid://shopify/ProductVariant/99",
              variantTitle: "Size L",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.exchangePreference).toMatch(/Size L/);
  });

  it("creates exchange when variant validation passes", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    (prismaMock.session.findFirst as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ accessToken: "tok" })
      .mockResolvedValueOnce({ accessToken: "offline-tok" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ product: { variants: [{ id: "99" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const createdRc = { id: "rc-ex-ok", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangeVariants: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              productId: "gid://shopify/Product/9",
              variantId: "gid://shopify/ProductVariant/99",
              variantTitle: "Size XL",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // Confirm the event payload includes exchangeVariants
    const eventCall = (prismaMock.returnEvent.create as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0];
    const payload = JSON.parse(eventCall?.data?.payloadJson ?? "{}");
    expect(payload.exchangeVariants).toBeDefined();
    expect(payload.exchangeVariants[0].variantId).toBe("gid://shopify/ProductVariant/99");
    fetchSpy.mockRestore();
  });
});

// ────────────────────────── Auto-approve customer-count fetch failure ──────────────────────────

describe("auto-approve email customer-count fetch failure", () => {
  it("propagates rejection from returnCase.count to outer catch (500 safe)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"if":"customerReturnCount<3","then":"approve"}]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([
      { if: "customerReturnCount<3", then: "approve" },
    ]);
    (prismaMock.returnCase.count as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("DB unavailable"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    // outer catch: generic safe message
    expect(body.error).toMatch(/Something went wrong/i);
    errSpy.mockRestore();
  });
});

// ────────────────────────── $transaction rollback path ──────────────────────────

describe("$transaction non-quantity error rethrow", () => {
  it("re-throws non-QUANTITY_EXCEEDED tx errors → 500 generic", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Make $transaction reject with a generic error
    (prismaMock.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("p2002 unique constraint"),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Something went wrong/i);
    errSpy.mockRestore();
  });

  it("converts QUANTITY_EXCEEDED tx error to 400 customer-friendly message", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    (prismaMock.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("QUANTITY_EXCEEDED:Cool Tee"),
    );
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Cool Tee/);
    expect(body.error).toMatch(/exceeds available/i);
  });
});

// ────────────────────────── Item cap edge: bag, sku-shipment, line-item ──────────────────────────

describe("item cap edge — preCheck rejections", () => {
  it("400 when bag-level cap exceeded (Fynd shipment + bag)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Existing return-item with same shipment+bag at full capacity
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        shopifyLineItemId: "gid://shopify/LineItem/100",
        fyndShipmentId: "S1",
        fyndBagId: "B1",
        sku: "TEE-1",
        qty: 1,
      },
    ]);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              qty: 1,
              reasonCode: "size",
              fyndShipmentId: "S1",
              fyndBagId: "B1",
              fyndQuantityAvailable: 1,
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already in an active return for shipment/i);
  });

  it("400 when the same Fynd bag is reused under a different return shipment id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // This mirrors Fynd after return creation: the original bag id is stable,
    // but Fynd emits a new return shipment id. The app must block by bag id.
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        shopifyLineItemId: "gid://shopify/LineItem/100",
        fyndShipmentId: "FORWARD-SHIP-1",
        fyndBagId: "BAG-1",
        sku: "TEE-1",
        qty: 1,
      },
    ]);
    const res = await action({
      request: jsonReq(
        happyBody({
          orderId: "FYNDSHOPIFYX14405",
          shopifyOrderName: "#FYNDSHOPIFYX14405",
          items: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              qty: 1,
              reasonCode: "size",
              fyndShipmentId: "RETURN-SHIP-2",
              fyndBagId: "BAG-1",
              fyndQuantityAvailable: 1,
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already in an active return for shipment/i);
    expect(prismaMock.returnItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          returnCase: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                shopifyOrderName: expect.objectContaining({
                  equals: "#FYNDSHOPIFYX14405",
                }),
              }),
              expect.objectContaining({
                fyndOrderId: expect.objectContaining({ equals: "FYNDSHOPIFYX14405" }),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("400 when sku-shipment fallback cap exceeded (no bagId)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { shopifyLineItemId: null, fyndShipmentId: "S1", fyndBagId: null, sku: "TEE-1", qty: 1 },
    ]);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              qty: 1,
              reasonCode: "size",
              fyndShipmentId: "S1", // no bagId → SKU fallback path
            },
          ],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: "25.00",
              quantity: 1,
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already in an active return/i);
  });

  it("400 when order-level line-item cap exceeded (alreadyReturned + qty > originalQty)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        shopifyLineItemId: "gid://shopify/LineItem/100",
        fyndShipmentId: null,
        fyndBagId: null,
        sku: "TEE-1",
        qty: 2,
      },
    ]);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1, reasonCode: "size" }],
          lineItemsWithPrice: [
            { id: "gid://shopify/LineItem/100", title: "Tee", price: "25.00", quantity: 2 },
          ],
          lineItemEstimates: [{ lineItemId: "gid://shopify/LineItem/100", quantity: 2 }],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds available/i);
  });
});

// ────────────────────────── Manual mode flows ──────────────────────────

describe("manual mode", () => {
  it("403 when manual mode has no verified customer contact", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        manual: true,
        manualItemDescription: "Broken zipper on jacket",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Verified customer|Verify your order contact/i);
  });

  it("400 when manual mode with malformed email", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        manual: true,
        customerEmail: "not-an-email",
        manualItemDescription: "Item description",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid email/i);
  });

  it("400 when manualItemDescription too short", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        manual: true,
        customerEmail: "x@y.com",
        manualItemDescription: "ab",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/at least 3 characters/i);
  });

  it("400 when manualItemDescription too long", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1001",
        manual: true,
        customerEmail: "x@y.com",
        manualItemDescription: "x".repeat(2001),
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too long/i);
  });

  it("400 when manual order is unfulfilled (lookup succeeds)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/2",
      displayFulfillmentStatus: "UNFULFILLED",
      displayFinancialStatus: "PAID",
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1002",
        manual: true,
        customerEmail: "x@y.com",
        manualItemDescription: "Long enough description",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/has not been fulfilled/i);
  });

  it("400 when manual order is already refunded", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/2",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "REFUNDED",
    });
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1002",
        manual: true,
        customerEmail: "x@y.com",
        manualItemDescription: "Item description here",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already been refunded/i);
  });

  it("creates manual return → summary contains item.notes (not lineItemsWithPrice title)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/2",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
    });
    const createdRc = { id: "rc-manual-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1002",
        manual: true,
        customerEmail: "shopper@x.com",
        manualItemDescription: "Damaged box on arrival",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.items[0].title).toBe("Damaged box on arrival");
    expect(body.summary.items[0].qty).toBe(1);
  });

  it("manual mode allowed even when fetchOrderByOrderNumber throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("PCDA blocked"));
    const createdRc = { id: "rc-manual-2", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq({
        shop: "store",
        shopifyOrderName: "1002",
        manual: true,
        customerEmail: "shopper@x.com",
        manualItemDescription: "Item desc here",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────── Fynd status gate ──────────────────────────

describe("fynd status gate", () => {
  it("400 when fynd current status is not delivered and not merchant-allowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMock = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMock.findFirst.mockResolvedValueOnce({
      fyndOrderId: "fynd-001",
      fyndShipmentId: null,
    });
    // Simulate latest webhook log indicating in-transit (not delivered)
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce({ fyndStatus: "bag_in_transit" });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Return cannot be initiated/i);
  });

  it("allows return when fynd current status is delivered", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMock = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMock.findFirst.mockResolvedValueOnce({
      fyndOrderId: "fynd-002",
      fyndShipmentId: null,
    });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce({ fyndStatus: "delivery_done" });
    const createdRc = { id: "rc-fynd-ok", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("allows return when adminOverride=true even if fynd not delivered", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMock = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMock.findFirst.mockResolvedValueOnce({
      fyndOrderId: "fynd-003",
      fyndShipmentId: null,
    });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce({ fyndStatus: "bag_in_transit" });
    const createdRc = { id: "rc-override", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody({ adminOverride: true })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("non-fatal when fynd gate query throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMock = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMock.findFirst.mockRejectedValueOnce(new Error("DB hiccup"));
    const createdRc = { id: "rc-gate-err", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});

// ────────────────────────── Fulfillment server-side gate ──────────────────────────

describe("server-side fulfillment gate", () => {
  it("400 when fetchOrder reports UNFULFILLED order", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
    email: "shopper@example.com",
      displayFulfillmentStatus: "UNFULFILLED",
      displayFinancialStatus: "PAID",
      lineItems: [],
    });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/has not been fulfilled/i);
  });

  it("400 when fetchOrder reports REFUNDED order", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
    email: "shopper@example.com",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "REFUNDED",
      lineItems: [],
    });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already been refunded/i);
  });

  it("non-fatal when fetchOrder throws (warn + proceed)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockRejectedValueOnce(new Error("Shopify 500"));
    const createdRc = {
      id: "rc-fulfill-err",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});

// ────────────────────────── Multi-shipment + green return event ──────────────────────────

describe("multi-shipment fyndShipmentId + green return event", () => {
  it("uses first shipmentId when items span multiple shipments", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = {
      id: "rc-multi-ship",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(
        happyBody({
          items: [
            {
              lineItemId: "gid://shopify/LineItem/100",
              qty: 1,
              fyndShipmentId: "S-A",
              fyndBagId: "B-A",
            },
            {
              lineItemId: "gid://shopify/LineItem/100",
              qty: 1,
              fyndShipmentId: "S-B",
              fyndBagId: "B-B",
            },
          ],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: "25.00",
              quantity: 5,
              productTags: [],
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.fyndShipmentId).toBe("S-A");
  });

  it("creates green_return_qualified event when item below threshold", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        greenReturnsEnabled: true,
        greenReturnsThreshold: "100",
        greenReturnsProductTags: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-green-evt", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    const eventCalls = (prismaMock.returnEvent.create as ReturnType<typeof vi.fn>).mock.calls;
    // One event for the case + one green-return event
    expect(eventCalls.length).toBeGreaterThanOrEqual(2);
    const greenCall = eventCalls.find((c) => c?.[0]?.data?.eventType === "green_return_qualified");
    expect(greenCall).toBeDefined();
  });

  it("handles invalid greenReturnsProductTags JSON gracefully", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        greenReturnsEnabled: true,
        greenReturnsThreshold: "10",
        greenReturnsProductTags: "{not-json",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-bad-tags", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────── Customer media + currency edge ──────────────────────────

describe("customer media + currency edge", () => {
  it("accepts valid base64 image and persists customerMediaJson", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-media-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(
        happyBody({
          customerMedia: [
            { name: "x.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/4AAQ" },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.customerMediaJson).toBeTruthy();
  });

  it("filters out media exceeding max size", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-media-big", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    // Build a >5MB base64 string.
    const huge = "data:image/jpeg;base64," + "A".repeat(8 * 1024 * 1024);
    await action({
      request: jsonReq(
        happyBody({
          customerMedia: [{ name: "huge.jpg", mimeType: "image/jpeg", dataUrl: huge }],
        }),
      ),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.customerMediaJson).toBeNull();
  });

  it("normalises and stores uppercase currencyCode", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const createdRc = { id: "rc-currency", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    await action({
      request: jsonReq(happyBody({ currency: "inr" })),
      params: {},
      context: {},
    } as never);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg?.data?.currency).toBe("INR");
  });
});

// ────────────────────────── orderId resolution (non-GID FYND id) ──────────────────────────

describe("orderId resolution (non-GID)", () => {
  it("resolves Fynd-style orderId via fetchOrderByFyndAffiliateId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/9999",
      lineItems: [],
      sourceName: "fynd",
    });
    const createdRc = {
      id: "rc-fynd-resolve-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody({ orderId: "FYNDSHOPIFYX14126" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalled();
  });

  it("non-fatal when fetchOrderByFyndAffiliateId throws — falls back to FyndOrderMapping", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByFyndAffiliateIdMock.mockRejectedValueOnce(new Error("Shopify down"));
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockResolvedValueOnce({ shopifyOrderId: "gid://shopify/Order/8888" });
    const createdRc = { id: "rc-fyndmap-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody({ orderId: "FYNDSHOPIFYX14127" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });

  it("last-resort path: resolves still-unresolved FYND-prefixed id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // First call returns null (no resolution); FyndOrderMapping returns null too;
    // last-resort call resolves to a GID.
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null) // first attempt
      .mockResolvedValueOnce({ id: "gid://shopify/Order/7777", lineItems: [] }); // last-resort
    const createdRc = {
      id: "rc-lastresort-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody({ orderId: "FYNDSHOPIFYX14128" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(fetchOrderByFyndAffiliateIdMock).toHaveBeenCalledTimes(2);
  });

  it("last-resort path swallows error and proceeds", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByFyndAffiliateIdMock
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("upstream timeout"));
    const createdRc = {
      id: "rc-lastresort-fail",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody({ orderId: "FYNDABC14129" })),
      params: {},
      context: {},
    } as never);
    // Without a Shopify GID we'll fall through; mocks stub fetchOrder so subsequent
    // checks use the default mock and return 200 (auto-mode allowed).
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });

  it("FyndOrderMapping query throws → swallowed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null);
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockRejectedValueOnce(new Error("DB outage"));
    const createdRc = { id: "rc-mapfail-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody({ orderId: "FYND14130" })),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────── lineItem ID resolution (Fynd bag ID → Shopify GID) ──────────────────────────

describe("line-item ID resolution path", () => {
  it("resolves non-GID lineItemId by SKU match and creates return", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
    email: "shopper@example.com",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      sourceName: "web",
      affiliateOrderId: null,
      lineItems: [{ id: "gid://shopify/LineItem/9001", title: "Tee", sku: "TEE-1" }],
    });
    const createdRc = {
      id: "rc-resolveLI-1",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "fynd-bag-3777852", qty: 1, reasonCode: "size" }],
          lineItemsWithPrice: [
            { id: "fynd-bag-3777852", title: "Tee", price: "25.00", quantity: 1, sku: "TEE-1" },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    // returnItem creation must reference the resolved Shopify GID
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = callArg?.data?.items?.create ?? [];
    expect(items[0]?.shopifyLineItemId).toBe("gid://shopify/LineItem/9001");
    expect(items[0]?.sku).toBe("TEE-1");
  });

  it("resolves by single-line-item fallback when no SKU/title match", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockResolvedValue({
      id: "gid://shopify/Order/1",
    email: "shopper@example.com",
      displayFulfillmentStatus: "FULFILLED",
      displayFinancialStatus: "PAID",
      affiliateOrderId: null,
      lineItems: [{ id: "gid://shopify/LineItem/9002", title: "Whatever", sku: "OTHER" }],
    });
    const createdRc = { id: "rc-singleLI", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "fynd-bag-X", qty: 1 }],
          lineItemsWithPrice: [
            { id: "fynd-bag-X", title: "Different", price: "25.00", quantity: 1 },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const callArg = (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const items = callArg?.data?.items?.create ?? [];
    expect(items[0]?.shopifyLineItemId).toBe("gid://shopify/LineItem/9002");
  });

  it("non-fatal when line-item resolution throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    fetchOrderMock.mockRejectedValueOnce(new Error("Order fetch broken"));
    const createdRc = {
      id: "rc-resolveErr",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "fynd-bag-Z", qty: 1 }],
          lineItemsWithPrice: [{ id: "fynd-bag-Z", title: "X", price: "10.00", quantity: 1 }],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});

// ────────────────────────── Fynd status gate — sources 2 + 3 ──────────────────────────

describe("fynd status gate — additional source paths", () => {
  it("falls back to existing returnCase.fyndCurrentStatus (source 2)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockResolvedValueOnce({ fyndOrderId: "fynd-src2", fyndShipmentId: null });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce(null); // source 1 empty
    (prismaMock.returnCase.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fyndCurrentStatus: "bag_in_transit",
    });
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Bag In Transit|Return cannot be initiated/i);
  });

  it("falls back to shipment webhook log (source 3)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockResolvedValueOnce({ fyndOrderId: "fynd-src3", fyndShipmentId: "S-3" });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    // First call (affiliateOrderId) → null; second (shipmentId) → in_transit
    wlog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ fyndStatus: "out_for_delivery" });
    (prismaMock.returnCase.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("merchant-allowed status passes the gate even when not in default-delivered set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        allowedFyndStatusesForReturn: '["bag_in_transit"]',
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockResolvedValueOnce({ fyndOrderId: "fynd-allow", fyndShipmentId: null });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce({ fyndStatus: "bag_in_transit" });
    const createdRc = { id: "rc-allow-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("invalid allowedFyndStatusesForReturn JSON is silently ignored", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        allowedFyndStatusesForReturn: "{not-json",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    const fyndMap = (
      prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>
    ).fyndOrderMapping;
    fyndMap.findFirst.mockResolvedValueOnce({ fyndOrderId: "fynd-bad", fyndShipmentId: null });
    const wlog = (prismaMock as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>)
      .fyndWebhookLog;
    wlog.findFirst.mockResolvedValueOnce({ fyndStatus: "delivery_done" });
    const createdRc = { id: "rc-badjson-1", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────── Sequential return-id counter ──────────────────────────

describe("sequential return-id counter", () => {
  it("invokes nextReturnIdCounter when bodyMode=sequential", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "sequential" });
    nextReturnIdCounterMock.mockResolvedValueOnce(42);
    const createdRc = { id: "rc-seq", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(nextReturnIdCounterMock).toHaveBeenCalledWith("settings-1");
  });

  it("invokes nextReturnIdCounter when bodyMode=date_sequential", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "date_sequential" });
    nextReturnIdCounterMock.mockResolvedValueOnce(7);
    const createdRc = { id: "rc-datseq", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(nextReturnIdCounterMock).toHaveBeenCalled();
  });
});

// ────────────────────────── tx SKU fallback merge ──────────────────────────

describe("tx SKU fallback merge", () => {
  it("merges SKU-matched existing items into alreadyReturned map (in-tx)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });

    // OUTER preCheck (line ~598): no existing items.
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // outer pre-check (lineItem/bag)
      .mockResolvedValueOnce([]) // inner tx by lineItemId
      .mockResolvedValueOnce([
        // inner tx by SKU
        { sku: "TEE-1", qty: 1, shopifyLineItemId: "gid://shopify/LineItem/100" },
      ]);
    const createdRc = { id: "rc-skufb", status: "initiated", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1 }],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: "25.00",
              quantity: 5,
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("non-fatal when tx SKU fallback query throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("sku query failed"));
    const createdRc = {
      id: "rc-skufb-fail",
      status: "initiated",
      createdAt: new Date(),
      items: [],
    };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1 }],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: "25.00",
              quantity: 5,
              sku: "TEE-1",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("400 when tx-level QUANTITY_EXCEEDED triggers", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(happyShop());
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    // Outer pre-check OK (qty 1, original 5), but inner tx finds 5 already returned → exceeds.
    (prismaMock.returnItem.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // outer
      .mockResolvedValueOnce([
        // inner by lineItemId
        { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 5 },
      ]);
    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "gid://shopify/LineItem/100", qty: 1 }],
          lineItemsWithPrice: [
            {
              id: "gid://shopify/LineItem/100",
              title: "Tee",
              price: "25.00",
              quantity: 5,
              sku: "TEE-1",
            },
          ],
          lineItemEstimates: [{ lineItemId: "gid://shopify/LineItem/100", quantity: 5 }],
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds available/i);
  });
});

// ────────────────────────── Fynd sync — return case missing ──────────────────────────

describe("fynd sync — return case missing after creation", () => {
  it("warns and skips when re-fetched returnCase is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(
      happyShop({
        autoApproveEnabled: true,
        autoApproveRulesJson: "[]",
      }),
    );
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const createdRc = { id: "rc-missing", status: "approved", createdAt: new Date(), items: [] };
    (prismaMock.returnCase.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdRc);
    (prismaMock.returnCase.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    createFyndClientOrErrorMock.mockResolvedValue({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await action({
      request: jsonReq(happyBody()),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(scheduleRetryMock).toHaveBeenCalledWith(
      "rc-missing",
      "Return case not found after creation",
    );
    warnSpy.mockRestore();
  });
});
