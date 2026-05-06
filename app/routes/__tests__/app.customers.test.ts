/**
 * Loader tests for app.customers.tsx — the customer listing/search page. Covers
 * the happy path with no query, the search query branch (which triggers rate
 * limiting + audit logging via dynamic imports), pagination, sort variants,
 * the empty result case, and rate-limit rejection (429).
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
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
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

function mkReq(qs = "") {
  return new Request(`https://app.example/app/customers${qs}`);
}

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
  securityLoggerMock.info.mockReset();
  appLoggerMock.warn.mockReset();
});

describe("app.customers.tsx loader", () => {
  it("happy path: returns empty customers list when DB has no return cases", async () => {
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data).toMatchObject({
      customers: [],
      query: "",
      sortBy: "count",
      page: 1,
      totalPages: 1,
      totalCustomers: 0,
      totalReturns: 0,
      totalRefunded: 0,
      serialReturners: 0,
    });
  });

  it("does NOT call rate-limit when no search query is present", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(securityLoggerMock.info).not.toHaveBeenCalled();
  });

  it("calls rate-limit + audit log when search query is present", async () => {
    await loader({
      request: mkReq("?q=alice"),
      params: {},
      context: {},
    } as never);
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.any(Object), "admin.customers.search");
    expect(securityLoggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "admin.customer_search",
        shopId: "shop-1",
        shopDomain: "store.myshopify.com",
        adminEmail: "admin@example.com",
        queryLength: 5,
        page: 1,
        sortBy: "count",
      }),
      "Admin customer search",
    );
  });

  it("throws 429 Response when rate limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterMs: 30_000 });
    await expect(
      loader({ request: mkReq("?q=enumeration"), params: {}, context: {} } as never),
    ).rejects.toMatchObject({ status: 429 });
    // Audit log should not run because we threw before reaching it
    expect(securityLoggerMock.info).not.toHaveBeenCalled();
  });

  it("applies search OR filter (email, phone, name, order name) when query present", async () => {
    await loader({ request: mkReq("?q=bob"), params: {}, context: {} } as never);
    // The second prisma.returnCase.groupBy call is the paginated one with the search filter
    const groupByCalls = prismaMock.returnCase.groupBy.mock.calls;
    expect(groupByCalls.length).toBeGreaterThanOrEqual(2);
    // Find the call(s) that includes the OR clause
    const filteredCall = groupByCalls.find((c) => (c[0] as { where: { OR?: unknown } }).where.OR);
    expect(filteredCall).toBeTruthy();
    const where = (filteredCall![0] as { where: { OR: Array<Record<string, unknown>> } }).where;
    expect(where.OR).toHaveLength(4);
    expect(where.OR[0]).toMatchObject({
      customerEmailNorm: { contains: "bob", mode: "insensitive" },
    });
  });

  it("paginates correctly with skip/take when ?page=3 supplied", async () => {
    await loader({ request: mkReq("?page=3"), params: {}, context: {} } as never);
    // First paginated groupBy call (with skip/take)
    const paginated = prismaMock.returnCase.groupBy.mock.calls.find(
      (c) => (c[0] as { skip?: number }).skip !== undefined,
    );
    expect(paginated).toBeTruthy();
    expect(paginated![0]).toMatchObject({ skip: 100, take: 50 });
  });

  it("clamps invalid page values (e.g. ?page=0) to page 1", async () => {
    const data = await loader({ request: mkReq("?page=0"), params: {}, context: {} } as never);
    expect(data.page).toBe(1);
  });

  it("uses _max.createdAt desc orderBy when sort=recent", async () => {
    await loader({ request: mkReq("?sort=recent"), params: {}, context: {} } as never);
    const paginated = prismaMock.returnCase.groupBy.mock.calls.find(
      (c) => (c[0] as { skip?: number }).skip !== undefined,
    );
    expect((paginated![0] as { orderBy: unknown }).orderBy).toEqual({
      _max: { createdAt: "desc" },
    });
  });

  it("uses _count.id desc orderBy by default (sort=count)", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    const paginated = prismaMock.returnCase.groupBy.mock.calls.find(
      (c) => (c[0] as { skip?: number }).skip !== undefined,
    );
    expect((paginated![0] as { orderBy: unknown }).orderBy).toEqual({ _count: { id: "desc" } });
  });

  it("aggregates customers + computes serialReturners (>=3 returns) and totalCustomers", async () => {
    // First groupBy is the global one (all groups, used for totalCustomers + serialReturners)
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([
        { customerEmailNorm: "a@x.com", _count: { id: 5 } },
        { customerEmailNorm: "b@x.com", _count: { id: 2 } },
        { customerEmailNorm: "c@x.com", _count: { id: 4 } },
      ])
      .mockResolvedValueOnce([]) // paginated groupBy
      .mockResolvedValueOnce([]); // filteredGroupStats
    prismaMock.returnCase.count.mockResolvedValueOnce(11);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalCustomers).toBe(3);
    expect(data.serialReturners).toBe(2); // a (5) and c (4) >= 3
    expect(data.totalReturns).toBe(11);
  });

  it("computes totalRefunded by summing refundJson amounts", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { refundJson: JSON.stringify({ amount: "12.50", currency: "USD" }) },
      { refundJson: JSON.stringify({ amount: "7.25", currency: "USD" }) },
      { refundJson: "not-json" }, // should be skipped, not throw
      { refundJson: JSON.stringify({}) }, // amount missing
    ]);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalRefunded).toBeCloseTo(19.75, 2);
  });

  it("builds enriched customer summaries from grouped return cases", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "alice@example.com", _count: { id: 2 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2);
    prismaMock.returnCase.findMany
      .mockResolvedValueOnce([]) // refundedForTotal
      .mockResolvedValueOnce([
        {
          id: "rc-1",
          returnRequestNo: "RR-001",
          shopifyOrderName: "#1001",
          shopifyOrderId: "gid://1",
          customerEmailNorm: "alice@example.com",
          customerPhoneNorm: "+15555550100",
          customerName: "Alice",
          customerCity: "NYC",
          customerCountry: "US",
          status: "completed",
          refundJson: JSON.stringify({ amount: "20.00", currency: "USD" }),
          refundStatus: "refunded",
          resolutionType: "refund",
          isGreenReturn: false,
          bonusCreditAmount: null,
          discountCodeValue: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          items: [{ title: "Shirt", qty: 1, price: "20.00" }],
        },
        {
          id: "rc-2",
          returnRequestNo: "RR-002",
          shopifyOrderName: "#1002",
          shopifyOrderId: "gid://2",
          customerEmailNorm: "alice@example.com",
          customerPhoneNorm: null,
          customerName: null,
          customerCity: null,
          customerCountry: null,
          status: "pending",
          refundJson: null,
          refundStatus: null,
          resolutionType: "exchange",
          isGreenReturn: true,
          bonusCreditAmount: null,
          discountCodeValue: null,
          createdAt: new Date("2026-02-01T00:00:00Z"),
          items: [{ title: "Pants", qty: 2, price: "30.00" }],
        },
      ]);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.customers).toHaveLength(1);
    const cust = data.customers[0];
    expect(cust.email).toBe("alice@example.com");
    expect(cust.name).toBe("Alice");
    expect(cust.phone).toBe("+15555550100");
    expect(cust.returnCount).toBe(2);
    expect(cust.totalRefundAmount).toBe(20);
    expect(cust.totalItemCount).toBe(3);
    expect(cust.statusBreakdown).toEqual({ completed: 1, pending: 1 });
    expect(cust.resolutionBreakdown).toEqual({ refund: 1, exchange: 1 });
    expect(cust.returns).toHaveLength(2);
  });

  it("enriches with Shopify refund data when fetchOrdersForCustomer returns rows", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "bob@example.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "bob@example.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "bob@example.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-x",
        returnRequestNo: null,
        shopifyOrderName: "#2001",
        shopifyOrderId: "gid://x",
        customerEmailNorm: "bob@example.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "completed",
        refundJson: null,
        refundStatus: "refunded",
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: null,
        createdAt: new Date("2026-03-01T00:00:00Z"),
        items: [{ title: "Hat", qty: 1, price: "15.00" }],
      },
    ]);
    fetchOrdersForCustomerMock.mockResolvedValueOnce([
      {
        orderName: "#2001",
        totalRefundedAmount: 42,
        refundCurrency: "EUR",
        totalOrderAmount: 100,
        customerName: "Bob",
        customerPhone: "+33000",
        customerCity: "Paris",
        customerCountry: "FR",
        lifetimeOrderCount: 8,
        lifetimeSpent: 800,
      },
    ]);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(fetchOrdersForCustomerMock).toHaveBeenCalledWith(
      expect.any(Object),
      "bob@example.com",
      25,
    );
    const cust = data.customers[0];
    expect(cust.totalRefundAmount).toBe(42);
    expect(cust.totalOrderValue).toBe(100);
    expect(cust.currency).toBe("EUR");
    expect(cust.name).toBe("Bob");
    expect(cust.lifetimeOrderCount).toBe(8);
    expect(cust.lifetimeSpent).toBe(800);
  });

  it("computes totalPages using filtered customer count and CUSTOMERS_PAGE_SIZE=50", async () => {
    // 75 filtered customers => totalPages = ceil(75/50) = 2
    const filtered = Array.from({ length: 75 }, (_, i) => ({
      customerEmailNorm: `c${i}@x.com`,
      _count: 1,
    }));
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce(filtered) // global
      .mockResolvedValueOnce([]) // paginated (page-1 empty for simplicity)
      .mockResolvedValueOnce(filtered); // filteredGroupStats

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalFilteredCustomers).toBe(75);
    expect(data.totalPages).toBe(2);
  });

  it("falls back to shop.settings.shopCurrency when customers have no currency", async () => {
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.shopCurrency).toBe("USD");
    expect(data.shopLocale).toBe("en");
    expect(data.shopTimezone).toBe("UTC");
  });

  it("falls back to discountCodeValue when refundJson is missing (line 312)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "x@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "x@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "x@x.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-disc",
        returnRequestNo: null,
        shopifyOrderName: "#9001",
        shopifyOrderId: null,
        customerEmailNorm: "x@x.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "pending",
        refundJson: null,
        refundStatus: null,
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: "5.50", // exercise line 312
        createdAt: new Date("2026-01-01T00:00:00Z"),
        items: [],
      },
    ]);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.customers[0].totalRefundAmount).toBe(5.5);
  });

  it("falls back to bonusCreditAmount when refundJson + discount missing (line 315)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "y@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "y@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "y@x.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-bonus",
        returnRequestNo: null,
        shopifyOrderName: "#9002",
        shopifyOrderId: null,
        customerEmailNorm: "y@x.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "pending",
        refundJson: null,
        refundStatus: null,
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: "8.75", // exercise line 315
        discountCodeValue: null,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        items: [],
      },
    ]);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.customers[0].totalRefundAmount).toBe(8.75);
  });

  it("estimates refund from line items when status=refunded with no recorded amount (lines 324-329)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "z@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "z@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "z@x.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-est",
        returnRequestNo: null,
        shopifyOrderName: "#9003",
        shopifyOrderId: null,
        customerEmailNorm: "z@x.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "completed", // triggers isRefunded
        refundJson: null,
        refundStatus: "refunded",
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: null,
        createdAt: new Date("2026-01-03T00:00:00Z"),
        items: [
          { title: "X", qty: 2, price: "10.00" }, // 20
          { title: "Y", qty: 1, price: "5.50" }, // 5.5
          { title: "Z", qty: 1, price: null }, // skipped
        ],
      },
    ]);

    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.customers[0].totalRefundAmount).toBeCloseTo(25.5, 2);
    expect(data.customers[0].totalRefundAmountIsEstimate).toBe(true);
  });

  it("sorts customers by amount when sort=amount (line 436)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([
        { customerEmailNorm: "small@x.com", _count: { id: 1 } },
        { customerEmailNorm: "big@x.com", _count: { id: 1 } },
      ])
      .mockResolvedValueOnce([
        { customerEmailNorm: "small@x.com", _count: { id: 1 } },
        { customerEmailNorm: "big@x.com", _count: { id: 1 } },
      ])
      .mockResolvedValueOnce([
        { customerEmailNorm: "small@x.com", _count: { id: 1 } },
        { customerEmailNorm: "big@x.com", _count: { id: 1 } },
      ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-small",
        returnRequestNo: null,
        shopifyOrderName: "#1",
        shopifyOrderId: null,
        customerEmailNorm: "small@x.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "completed",
        refundJson: JSON.stringify({ amount: "5.00", currency: "USD" }),
        refundStatus: "refunded",
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        items: [],
      },
      {
        id: "rc-big",
        returnRequestNo: null,
        shopifyOrderName: "#2",
        shopifyOrderId: null,
        customerEmailNorm: "big@x.com",
        customerPhoneNorm: null,
        customerName: null,
        customerCity: null,
        customerCountry: null,
        status: "completed",
        refundJson: JSON.stringify({ amount: "999.00", currency: "USD" }),
        refundStatus: "refunded",
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: null,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        items: [],
      },
    ]);

    const data = await loader({ request: mkReq("?sort=amount"), params: {}, context: {} } as never);
    expect(data.customers).toHaveLength(2);
    // big should come first since amount sort places higher refundAmount first
    expect(data.customers[0].email).toBe("big@x.com");
    expect(data.customers[1].email).toBe("small@x.com");
  });

  it("logs backfill failures via appLogger.warn (lines 416-418)", async () => {
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ customerEmailNorm: "bf@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "bf@x.com", _count: { id: 1 } }])
      .mockResolvedValueOnce([{ customerEmailNorm: "bf@x.com", _count: { id: 1 } }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "rc-bf",
        returnRequestNo: null,
        shopifyOrderName: "#5000",
        shopifyOrderId: null,
        customerEmailNorm: "bf@x.com",
        customerPhoneNorm: null, // missing — triggers backfill
        customerName: null, // missing — triggers backfill
        customerCity: null,
        customerCountry: null,
        status: "pending",
        refundJson: null,
        refundStatus: null,
        resolutionType: "refund",
        isGreenReturn: false,
        bonusCreditAmount: null,
        discountCodeValue: null,
        createdAt: new Date("2026-01-04T00:00:00Z"),
        items: [],
      },
    ]);
    // fetchOrdersForCustomer returns customer info — triggers backfillUpdates push
    fetchOrdersForCustomerMock.mockResolvedValueOnce([
      {
        orderName: "#5000",
        totalRefundedAmount: 0,
        refundCurrency: "USD",
        totalOrderAmount: 50,
        customerName: "Backfill Bob",
        customerPhone: "+1-555-9999",
        customerCity: "Austin",
        customerCountry: "US",
        lifetimeOrderCount: 1,
        lifetimeSpent: 50,
      },
    ]);
    // Force the update to reject so backfill failure path runs
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("constraint failure"));

    await loader({ request: mkReq(), params: {}, context: {} } as never);
    // Allow microtasks to flush so the fire-and-forget logger fires
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        module: "customers.backfill",
        shopId: "shop-1",
        attempted: 1,
        failed: 1,
        firstError: expect.stringContaining("constraint failure"),
      }),
      "Customer-data backfill had partial failures",
    );
  });
});
