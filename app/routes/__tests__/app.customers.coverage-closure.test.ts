/**
 * Coverage closure for app.customers.tsx loader. Targets:
 *   - line 200          empty-email continue branch in the grouping loop
 *   - lines 214-217     "group already exists" branch — fills missing fields
 *                       (phone / name / city / country) from a later record
 *   - line 438          customers.sort comparator body for sort=recent
 *   - line 440          customers.sort comparator body for the default (count)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  findOrCreateShopMock,
  fetchOrdersForCustomerMock,
  checkRateLimitMock,
  securityLoggerMock,
  appLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  fetchOrdersForCustomerMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  securityLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  appLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: findOrCreateShopMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrdersForCustomer: fetchOrdersForCustomerMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
}));
vi.mock("../../lib/observability/logger.server", () => ({
  securityLogger: securityLoggerMock,
  appLogger: appLoggerMock,
}));

import { loader } from "../app.customers";

const SHOP = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: { id: "s-1", shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC" },
};

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: {
      shop: "store.myshopify.com",
      onlineAccessInfo: { associated_user: { email: "admin@example.com" } },
    },
    admin: { graphql: vi.fn() },
  });
  findOrCreateShopMock.mockReset().mockResolvedValue(SHOP);
  fetchOrdersForCustomerMock.mockReset().mockResolvedValue([]);
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true });
});

function mkReq(qs = "") {
  return new Request(`https://app.example/app/customers${qs}`);
}

function rc(overrides: Record<string, unknown>) {
  return {
    id: "rc-x",
    returnRequestNo: null,
    shopifyOrderName: "#1",
    shopifyOrderId: null,
    customerEmailNorm: "x@x.com",
    customerPhoneNorm: null,
    customerName: null,
    customerCity: null,
    customerCountry: null,
    status: "completed",
    refundJson: null,
    refundStatus: null,
    resolutionType: "refund",
    isGreenReturn: false,
    bonusCreditAmount: null,
    discountCodeValue: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    items: [],
    ...overrides,
  };
}

describe("app.customers loader — coverage closure", () => {
  it("skips records whose email is empty/whitespace (line 200)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "good@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "good@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "good@x.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      // First record has empty email — line 200 `continue`s past it.
      rc({ id: "rc-empty", customerEmailNorm: "", shopifyOrderName: "#blank" }),
      rc({
        id: "rc-good",
        customerEmailNorm: "good@x.com",
        shopifyOrderName: "#1001",
      }),
    ]);
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.customers).toHaveLength(1);
    expect(data.customers[0].email).toBe("good@x.com");
  });

  it("backfills missing fields from a later record for an existing group (lines 214-217)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      // First record creates the group with all-null contact fields.
      rc({
        id: "rc-1",
        customerEmailNorm: "alice@example.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
      }),
      // Second record has all four fields — exercises lines 214-217 branches.
      rc({
        id: "rc-2",
        customerEmailNorm: "alice@example.com",
        customerPhoneNorm: "+15551234567",
        customerName: "Alice",
        customerCity: "Brooklyn",
        customerCountry: "US",
      }),
    ]);
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.customers).toHaveLength(1);
    const c = data.customers[0];
    expect(c.phone).toBe("+15551234567");
    expect(c.name).toBe("Alice");
    expect(c.city).toBe("Brooklyn");
    expect(c.country).toBe("US");
  });

  it("sorts customers by recent date (line 438) and by count by default (line 440)", async () => {
    // Two customers with distinct dates and counts → comparator runs.
    const groupA = { customerEmailNorm: "a@x.com", _count: { id: 1 } };
    const groupB = { customerEmailNorm: "b@x.com", _count: { id: 3 } };

    // ── First call: sort=recent (line 438) ──────────────────────────────
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([groupA, groupB])
      .mockResolvedValueOnce([groupA, groupB])
      .mockResolvedValueOnce([groupA, groupB]);
    prismaMock.returnCase.count.mockResolvedValueOnce(4);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      rc({
        id: "ra",
        customerEmailNorm: "a@x.com",
        createdAt: new Date("2026-04-01T00:00:00Z"),
      }),
      rc({
        id: "rb",
        customerEmailNorm: "b@x.com",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);
    const recent = await loader({
      request: mkReq("?sort=recent"),
      params: {},
      context: {},
    } as never);
    // a (Apr) should be sorted before b (Jan).
    expect(recent.customers[0].email).toBe("a@x.com");
    expect(recent.customers[1].email).toBe("b@x.com");

    // ── Second call: default sort=count (line 440) ──────────────────────
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([groupA, groupB])
      .mockResolvedValueOnce([groupA, groupB])
      .mockResolvedValueOnce([groupA, groupB]);
    prismaMock.returnCase.count.mockResolvedValueOnce(4);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      rc({ id: "ra", customerEmailNorm: "a@x.com" }),
      // b has 3 returns vs a's 1 — comparator should rank b first.
      rc({ id: "rb1", customerEmailNorm: "b@x.com" }),
      rc({ id: "rb2", customerEmailNorm: "b@x.com" }),
      rc({ id: "rb3", customerEmailNorm: "b@x.com" }),
    ]);
    const byCount = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(byCount.customers[0].email).toBe("b@x.com");
    expect(byCount.customers[1].email).toBe("a@x.com");
  });
});
