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
  checkReturnEligibilityMock: vi.fn(() => ({ eligible: true })),
  normalizeSourceChannelMock: vi.fn((s: string | null) => s),
  evaluateAutoApproveRulesMock: vi.fn(() => "approve"),
  parseAutoApproveRulesMock: vi.fn(() => []),
  buildReturnRequestIdMock: vi.fn(() => "R-123"),
  nextReturnIdCounterMock: vi.fn(async () => 1),
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
    shopifyOrderName: "#1001",
    items: [{ lineItemId: "gid://shopify/LineItem/1", qty: 1 }],
    customerEmail: "u@x.com",
    adminOverride: false,
    resolutionType: "refund",
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  shopifyModuleMock.unauthenticated.admin.mockReset().mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  normalizeSourceChannelMock.mockReset().mockImplementation((s: string | null) => s);
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-123");
  nextReturnIdCounterMock.mockReset().mockResolvedValue(1);
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "random" });
  fetchOrderByFyndAffiliateIdMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
});

describe("validation", () => {
  it("405 on non-POST", async () => {
    const res = await action({ request: jsonReq({}, "GET"), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });

  it("400 when shopifyOrderName missing", async () => {
    const res = await action({ request: jsonReq({ items: [{ lineItemId: "x", qty: 1 }] }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });

  it("400 when items missing or empty", async () => {
    const res1 = await action({ request: jsonReq({ shopifyOrderName: "1001" }), params: {}, context: {} } as never);
    expect(res1.status).toBe(400);
    const res2 = await action({ request: jsonReq({ shopifyOrderName: "1001", items: [] }), params: {}, context: {} } as never);
    expect(res2.status).toBe(400);
  });

  it("400 on invalid resolutionType", async () => {
    const res = await action({
      request: jsonReq({ shopifyOrderName: "1001", items: [{ lineItemId: "x", qty: 1 }], resolutionType: "bogus" }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("400 on non-positive qty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    const res = await action({
      request: jsonReq(happyBody({ items: [{ lineItemId: "x", qty: 0 }] })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when return qty exceeds ordered qty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    const res = await action({
      request: jsonReq(happyBody({
        items: [{ lineItemId: "li-1", qty: 5 }],
        lineItemsWithPrice: [{ id: "li-1", price: "10", quantity: 2 }],
      })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds the ordered quantity/);
  });
});

describe("blocklist (when not adminOverride)", () => {
  it("403 when customer email is blocklisted", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1", settings: { id: "s-1", blocklistEnabled: true },
    });
    prismaMock.blocklistEntry.findFirst.mockResolvedValueOnce({ id: "b-1", type: "email", value: "u@x.com" });
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(403);
  });

  it("skips blocklist + eligibility checks when adminOverride=true", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", settings: { id: "s-1", blocklistEnabled: true } });
    prismaMock.blocklistEntry.findFirst.mockResolvedValue({ id: "b-1" });
    // Happy-path needs successful transaction
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
      }
      return arg;
    });
    prismaMock.returnCase.create.mockResolvedValueOnce({
      id: "rc-new", items: [], createdAt: new Date(),
      status: "pending", shopifyOrderName: "#1001", resolutionType: "refund",
      createdByChannel: "admin", createdByStaff: null, crmTicketId: null,
    });
    const res = await action({
      request: jsonReq(happyBody({ adminOverride: true })),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.blocklistEntry.findFirst).not.toHaveBeenCalled();
    expect(checkReturnEligibilityMock).not.toHaveBeenCalled();
  });

  it("400 when eligibility check fails", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    checkReturnEligibilityMock.mockReturnValueOnce({ eligible: false, reason: "outside return window" });
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/outside return window/);
  });
});

describe("auto-approve flow", () => {
  beforeEach(() => {
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
      return arg;
    });
    prismaMock.returnCase.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "rc-new", items: [], createdAt: new Date(), ...data,
    }));
    prismaMock.returnCase.update.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ ...where, ...data }));
  });

  it("uses 'pending' status when autoApprove disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1", autoApproveEnabled: false } });
    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("pending");
  });

  it("uses 'approved' status when autoApprove on + no rules", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true, autoApproveRulesJson: null },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("approved");
  });

  it("uses 'initiated' when rules return 'manual_review'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "rule-1" }]);
    evaluateAutoApproveRulesMock.mockReturnValueOnce("manual_review");
    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("initiated");
  });
});

describe("orderId resolution", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", settings: { id: "s-1" } });
    prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
      return arg;
    });
    prismaMock.returnCase.create.mockResolvedValue({ id: "rc-new", items: [], createdAt: new Date() });
  });

  it("keeps gid://-prefixed orderId unchanged", async () => {
    await action({ request: jsonReq(happyBody({ orderId: "gid://shopify/Order/999" })), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.shopifyOrderId).toBe("gid://shopify/Order/999");
  });

  it("resolves non-GID orderId via fetchOrderByFyndAffiliateId", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce({ id: "gid://shopify/Order/777" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    await action({ request: jsonReq(happyBody({ orderId: "FYND-XYZ" })), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.shopifyOrderId).toBe("gid://shopify/Order/777");
  });

  it("falls back to fetchOrderByOrderNumber when Fynd lookup fails", async () => {
    fetchOrderByFyndAffiliateIdMock.mockResolvedValueOnce(null);
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/555" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    await action({ request: jsonReq(happyBody({ orderId: "1001" })), params: {}, context: {} } as never);
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.shopifyOrderId).toBe("gid://shopify/Order/555");
  });
});

describe("error paths", () => {
  it("500 on transaction failure", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: { id: "s-1" } });
    prismaMock.$transaction.mockRejectedValueOnce(new Error("db"));
    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
  });
});
