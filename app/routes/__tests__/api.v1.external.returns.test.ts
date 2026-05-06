import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../../db.server", () => {
  const mockPrisma = {
    returnCase: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  return { default: mockPrisma };
});

vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, retryAfterMs: 0 }),
  rateLimitResponse: vi.fn(),
}));

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { loader } from "../api.v1.external.returns";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function makeRequest(url = "http://localhost/api/v1/external/returns") {
  return new Request(url, {
    method: "GET",
    headers: { "X-API-Key": "rpm_testkey123" },
  });
}

describe("GET /api/v1/external/returns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("returns 401 when API key is invalid", async () => {
    const unauthorizedResponse = Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
      { status: 401 },
    );
    mockAuth.mockResolvedValue({ ok: false, response: unauthorizedResponse });

    const response = await loader({
      request: makeRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns",
    });
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns paginated list of returns with meta", async () => {
    const now = new Date();
    const fakeReturns = [
      {
        id: "ret-1",
        returnRequestNo: "RPM-001",
        shopifyOrderId: "gid://shopify/Order/1",
        shopifyOrderName: "#1001",
        status: "pending",
        resolutionType: "refund",
        customerName: "Alice",
        customerEmailNorm: "alice@test.com",
        currency: "USD",
        items: [{ id: "item-1" }],
        createdAt: now,
        updatedAt: now,
      },
    ];

    mockPrisma.returnCase.findMany.mockResolvedValue(fakeReturns);
    mockPrisma.returnCase.count.mockResolvedValue(1);

    const response = await loader({
      request: makeRequest("http://localhost/api/v1/external/returns?page=1&pageSize=25"),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("ret-1");
    expect(body.data[0].returnRequestNo).toBe("RPM-001");
    expect(body.data[0].itemCount).toBe(1);

    expect(body.meta).toEqual({
      page: 1,
      pageSize: 25,
      totalCount: 1,
      totalPages: 1,
      hasNextPage: false,
      // Cursor pagination support — null when there are no more rows.
      nextCursor: null,
    });
    expect(body.errors).toEqual([]);
  });

  it("filters by status", async () => {
    mockPrisma.returnCase.findMany.mockResolvedValue([]);
    mockPrisma.returnCase.count.mockResolvedValue(0);

    await loader({
      request: makeRequest("http://localhost/api/v1/external/returns?status=approved"),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns",
    });

    const whereArg = mockPrisma.returnCase.findMany.mock.calls[0][0].where;
    expect(whereArg.status).toBe("approved");
    expect(whereArg.shopId).toBe("shop-1");
  });

  it("filters by orderName", async () => {
    mockPrisma.returnCase.findMany.mockResolvedValue([]);
    mockPrisma.returnCase.count.mockResolvedValue(0);

    await loader({
      request: makeRequest("http://localhost/api/v1/external/returns?orderName=%231001"),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns",
    });

    const whereArg = mockPrisma.returnCase.findMany.mock.calls[0][0].where;
    expect(whereArg.shopifyOrderName).toEqual({
      contains: "#1001",
      mode: "insensitive",
    });
  });

  it("returns empty array when no returns", async () => {
    mockPrisma.returnCase.findMany.mockResolvedValue([]);
    mockPrisma.returnCase.count.mockResolvedValue(0);

    const response = await loader({
      request: makeRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data).toEqual([]);
    expect(body.meta.totalCount).toBe(0);
    expect(body.meta.hasNextPage).toBe(false);
  });
});
