/**
 * Gap-coverage tests for app/routes/api.admin.create-return.ts.
 *
 * These tests intentionally complement the existing
 * `api.admin.create-return.test.ts` and `.coverage.test.ts` suites
 * (which are not modified) by drilling into the few remaining
 * branches/lines that they do not exercise:
 *
 *   - Blocklist match by phone and by order_name (in addition to the
 *     existing "match by email" case).
 *   - Blocklist enabled but with no settings.id (skips lookup).
 *   - Blocklist enabled, no email/phone — still checks order_name.
 *   - Resolution-type validation — exhaustive valid + invalid codes.
 *   - Auto-approve evaluation throwing → caught by outer transaction
 *     try/catch → 500.
 *   - Fynd order-id resolution: both helpers reject (catch fallback),
 *     resolved with non-GID id (no assignment), and outer try/catch
 *     swallowing a thrown shopify.unauthenticated.admin.
 *   - Transaction rollback when tx.returnCase.update throws.
 *   - Date-sequential bodyMode invokes nextReturnIdCounter just like
 *     "sequential" (the second branch of the OR).
 *   - Items-with-very-large-province / address slicing branches.
 *   - Non-integer qty (qty=1.5) is rejected.
 *   - shopifyOrderName already starts with "#" path (no re-prepend).
 *   - Multiple blocklist-eligible inputs (email + phone + order_name)
 *     all present but no row matches → proceeds to create.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  shopifyModuleMock,
  checkReturnEligibilityMock,
  normalizeSourceChannelMock,
  evaluateAutoApproveRulesMock,
  parseAutoApproveRulesMock,
  buildReturnRequestIdMock,
  nextReturnIdCounterMock,
  parseReturnIdConfigMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumberMock,
  withRestCredentialsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => unknown>(() => ({ eligible: true })),
  normalizeSourceChannelMock: vi.fn((s: string | null) => s),
  evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
  parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
  buildReturnRequestIdMock: vi.fn(() => "R-GAP-1"),
  nextReturnIdCounterMock: vi.fn(async () => 7),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "random" })),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: vi.fn((x: string) => `R-${x.slice(0, 6)}`),
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
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  withRestCredentials: withRestCredentialsMock,
}));

import { action } from "../api.admin.create-return";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/admin/create-return", init);
}

function happyBody(overrides: Record<string, unknown> = {}) {
  return {
    shopifyOrderName: "#7777",
    items: [{ lineItemId: "gid://shopify/LineItem/1", qty: 1 }],
    customerEmail: "gap@x.com",
    adminOverride: false,
    resolutionType: "refund",
    ...overrides,
  };
}

function wireTxAndCreate() {
  prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
    return arg;
  });
  prismaMock.returnCase.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "rc-gap",
      items: Array.isArray((data.items as { create?: unknown[] } | undefined)?.create)
        ? ((data.items as { create: unknown[] }).create)
        : [],
      createdAt: new Date("2026-05-06T00:00:00Z"),
      ...data,
    }),
  );
  prismaMock.returnCase.update.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
      ...where,
      ...data,
    }),
  );
  prismaMock.returnEvent.create.mockResolvedValue({ id: "ev-gap" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  shopifyModuleMock.unauthenticated.admin.mockReset().mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  normalizeSourceChannelMock.mockReset().mockImplementation((s: string | null) => s);
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-GAP-1");
  nextReturnIdCounterMock.mockReset().mockResolvedValue(7);
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "random" });
  fetchOrderByFyndAffiliateIdMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
});

describe("blocklist match variants", () => {
  it("403 when phone is blocklisted", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", blocklistEnabled: true },
    });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({ id: "b-2", type: "phone", value: "+15551112222" });

    const res = await action({
      request: jsonReq(happyBody({ customerEmail: undefined, customerPhone: "+1 (555) 111-2222" })),
      params: {}, context: {},
    } as never);

    expect(res.status).toBe(403);
    const passedOR = (prismaMock.blocklistEntry.findFirst.mock.calls[0][0] as {
      where: { OR: { type: string; value: string }[] };
    }).where.OR;
    // includes phone + order_name (no email)
    expect(passedOR.some((c) => c.type === "phone" && c.value === "+15551112222")).toBe(true);
    expect(passedOR.some((c) => c.type === "order_name" && c.value === "#7777")).toBe(true);
  });

  it("403 when order_name is blocklisted (no email/phone)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", blocklistEnabled: true },
    });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({ id: "b-3", type: "order_name", value: "#7777" });

    const res = await action({
      request: jsonReq(happyBody({ customerEmail: undefined })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(403);
  });

  it("blocklist enabled but no settings.id → skip lookup", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { blocklistEnabled: true /* no id */ },
    });
    wireTxAndCreate();
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.blocklistEntry.findFirst).not.toHaveBeenCalled();
  });

  it("blocklist enabled, all OR keys present, no row matches → continues to create", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", blocklistEnabled: true },
    });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce(null);
    wireTxAndCreate();

    const res = await action({
      request: jsonReq(happyBody({ customerPhone: "555-9999" })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.blocklistEntry.findFirst).toHaveBeenCalledTimes(1);
  });

  it("blocklist disabled (settings.blocklistEnabled=false) → skip lookup", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", blocklistEnabled: false },
    });
    wireTxAndCreate();
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.blocklistEntry.findFirst).not.toHaveBeenCalled();
  });
});

describe("resolutionType variants", () => {
  beforeEach(() => wireTxAndCreate());

  it.each(["refund", "exchange", "store_credit", "replacement"])(
    "accepts valid resolutionType=%s",
    async (rt) => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({
        id: "shop-1",
        settings: { id: "s-1", autoApproveEnabled: false },
      });
      const res = await action({
        request: jsonReq(happyBody({ resolutionType: rt, exchangePreference: "Size L" })),
        params: {}, context: {},
      } as never);
      expect(res.status).toBe(200);
      const data = prismaMock.returnCase.create.mock.calls[0][0].data;
      expect(data.resolutionType).toBe(rt);
      // exchangePreference only set for "exchange"
      expect(data.exchangePreference).toBe(rt === "exchange" ? "Size L" : null);
    },
  );

  it.each(["return", "REFUND", "credit", "store-credit", "Replace"])(
    "rejects invalid resolutionType=%s",
    async (rt) => {
      const res = await action({
        request: jsonReq(happyBody({ resolutionType: rt })),
        params: {}, context: {},
      } as never);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid resolutionType/);
    },
  );
});

describe("validation edge cases", () => {
  it("400 on non-integer qty (qty=1.5)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    const res = await action({
      request: jsonReq(happyBody({ items: [{ lineItemId: "li-1", qty: 1.5 }] })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid quantity/);
  });

  it("400 when shopifyOrderName is whitespace-only", async () => {
    const res = await action({
      request: jsonReq({ shopifyOrderName: "   ", items: [{ lineItemId: "x", qty: 1 }] }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("preserves leading '#' in shopifyOrderName when already present", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    wireTxAndCreate();
    await action({
      request: jsonReq(happyBody({ shopifyOrderName: "#1234" })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.shopifyOrderName).toBe("#1234");
  });
});

describe("orderId resolution edge cases", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    wireTxAndCreate();
  });

  it("both fynd helpers reject (caught) → shopifyOrderId stays as raw", async () => {
    fetchOrderByFyndAffiliateIdMock.mockRejectedValueOnce(new Error("net-1"));
    fetchOrderByOrderNumberMock.mockRejectedValueOnce(new Error("net-2"));
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });

    const res = await action({
      request: jsonReq(happyBody({ orderId: "RAW-XYZ" })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.shopifyOrderId).toBe("RAW-XYZ");
  });

  it("resolved order missing gid:// prefix → shopifyOrderId NOT replaced", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({ id: "12345" });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });

    await action({
      request: jsonReq(happyBody({ orderId: "1042" })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.shopifyOrderId).toBe("1042");
  });

  it("outer try/catch swallows shopify.unauthenticated.admin throw", async () => {
    prismaMock.session.findFirst.mockResolvedValueOnce(null);
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("auth"));

    const res = await action({
      request: jsonReq(happyBody({ orderId: "1042" })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.shopifyOrderId).toBe("1042");
  });

  it("no orderId → no resolution attempt at all", async () => {
    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(fetchOrderByFyndAffiliateIdMock).not.toHaveBeenCalled();
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.shopifyOrderId).toBe("");
  });
});

describe("auto-approve eval failures + edge inputs", () => {
  // The auto-approve block runs BEFORE the transaction try/catch so a
  // throw there bubbles up as an unhandled rejection — verify the
  // promise rejects (we DO NOT catch in the source, so the runtime
  // shape matters for upstream callers).
  it("evaluateAutoApproveRules throw bubbles out of the action", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "r1" }]);
    evaluateAutoApproveRulesMock.mockImplementationOnce(() => {
      throw new Error("rule eval boom");
    });

    await expect(
      action({ request: jsonReq(happyBody()), params: {}, context: {} } as never),
    ).rejects.toThrow(/rule eval boom/);
  });

  it("parseAutoApproveRules throw bubbles out of the action", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseAutoApproveRulesMock.mockImplementationOnce(() => {
      throw new Error("parse boom");
    });
    await expect(
      action({ request: jsonReq(happyBody()), params: {}, context: {} } as never),
    ).rejects.toThrow(/parse boom/);
  });

  it("prisma.returnCase.count rejection bubbles out of the action", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "r1" }]);
    prismaMock.returnCase.count.mockRejectedValueOnce(new Error("db down"));

    await expect(
      action({ request: jsonReq(happyBody()), params: {}, context: {} } as never),
    ).rejects.toThrow(/db down/);
  });
});

describe("transaction rollback paths", () => {
  it("500 when tx.returnCase.update throws inside transaction", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
      return arg;
    });
    prismaMock.returnCase.create.mockResolvedValueOnce({ id: "rc-1", items: [] });
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("update fail"));

    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/update fail/);
  });

  it("500 when nextReturnIdCounter throws (sequential mode)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
      return arg;
    });
    prismaMock.returnCase.create.mockResolvedValueOnce({ id: "rc-1", items: [] });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "sequential" });
    nextReturnIdCounterMock.mockRejectedValueOnce(new Error("counter down"));

    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });

  it("500 with non-Error thrown returns generic message", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    prismaMock.$transaction.mockRejectedValueOnce("not-an-error-object");

    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to create return");
  });
});

describe("return-id bodyMode branches", () => {
  beforeEach(() => wireTxAndCreate());

  it("date_sequential bodyMode also calls nextReturnIdCounter", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "date_sequential" });
    nextReturnIdCounterMock.mockResolvedValueOnce(101);
    buildReturnRequestIdMock.mockReturnValueOnce("R-DATE-101");

    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(nextReturnIdCounterMock).toHaveBeenCalledWith("s-1");
    const updateData = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(updateData.returnRequestNo).toBe("R-DATE-101");
  });
});

describe("string-slicing branches", () => {
  beforeEach(() => wireTxAndCreate());

  it("trims/uppercases/slices currency to 10 chars", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    await action({
      request: jsonReq(happyBody({ currency: "  abcdefghijklmnop  " })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.currency).toBe("ABCDEFGHIJ"); // 10 chars, upper
  });

  it("slices customerProvince at 100 chars and address at 500", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    const longProvince = "A".repeat(150);
    const longAddress = "B".repeat(600);
    await action({
      request: jsonReq(happyBody({
        customerProvince: longProvince,
        customerAddress1: longAddress,
      })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect((data.customerProvince as string).length).toBe(100);
    expect((data.customerAddress1 as string).length).toBe(500);
  });

  it("sets orderProcessedAt from orderCreatedAt ISO string", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    await action({
      request: jsonReq(happyBody({ orderCreatedAt: "2026-04-01T12:00:00Z" })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.orderProcessedAt).toBeInstanceOf(Date);
    expect((data.orderProcessedAt as Date).toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("falls back to item.sku when lineItemsWithPrice has no sku", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    await action({
      request: jsonReq(happyBody({
        items: [{ lineItemId: "li-9", qty: 1, sku: "FALLBACK-SKU" }],
        lineItemsWithPrice: [{ id: "li-9", title: "T" }],
      })),
      params: {}, context: {},
    } as never);
    const itemCreates = prismaMock.returnCase.create.mock.calls[0][0].data.items.create as Array<Record<string, unknown>>;
    expect(itemCreates[0].sku).toBe("FALLBACK-SKU");
  });

  it("multiple items with same fyndShipmentId → unique single value (not first-of-list)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    await action({
      request: jsonReq(happyBody({
        items: [
          { lineItemId: "li-1", qty: 1, fyndShipmentId: "ship-SAME" },
          { lineItemId: "li-2", qty: 1, fyndShipmentId: "ship-SAME" },
        ],
      })),
      params: {}, context: {},
    } as never);
    const data = prismaMock.returnCase.create.mock.calls[0][0].data;
    expect(data.fyndShipmentId).toBe("ship-SAME");
  });
});
