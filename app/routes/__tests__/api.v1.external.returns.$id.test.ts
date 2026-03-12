import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../../db.server", () => {
  const mockPrisma = {
    returnCase: {
      findFirst: vi.fn(),
    },
  };
  return { default: mockPrisma };
});

vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 100, retryAfterMs: 0 }),
  rateLimitResponse: vi.fn(),
}));

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { loader } from "../api.v1.external.returns.$id";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function makeRequest() {
  return new Request("http://localhost/api/v1/external/returns/ret-1", {
    method: "GET",
    headers: { "X-API-Key": "rpm_testkey123" },
  });
}

describe("GET /api/v1/external/returns/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("returns 401 for invalid API key", async () => {
    const unauthorizedResponse = Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
      { status: 401 },
    );
    mockAuth.mockResolvedValue({ ok: false, response: unauthorizedResponse });

    const response = await loader({
      request: makeRequest(),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id",
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for non-existent return", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue(null);

    const response = await loader({
      request: makeRequest(),
      params: { id: "non-existent" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns full return detail with items and events", async () => {
    const now = new Date();
    const fakeReturn = {
      id: "ret-1",
      returnRequestNo: "RPM-001",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      shopifyReturnId: null,
      status: "approved",
      refundStatus: null,
      resolutionType: "refund",
      customerName: "Alice",
      customerEmailNorm: "alice@test.com",
      customerPhoneNorm: "+1234567890",
      customerCity: "New York",
      customerCountry: "US",
      currency: "USD",
      rejectionReason: null,
      adminNotes: null,
      notesForCustomer: null,
      isGreenReturn: false,
      fyndReturnId: null,
      fyndReturnNo: null,
      fyndCurrentStatus: null,
      returnAwb: null,
      forwardAwb: null,
      createdAt: now,
      updatedAt: now,
      items: [
        {
          id: "item-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          title: "Blue T-Shirt",
          variantTitle: "Medium",
          sku: "BTS-M-001",
          price: "29.99",
          qty: 1,
          reasonCode: "wrong_size",
          condition: "unused",
          notes: null,
        },
      ],
      events: [
        {
          id: "evt-1",
          source: "admin",
          eventType: "approved",
          happenedAt: now,
        },
      ],
    };

    mockPrisma.returnCase.findFirst.mockResolvedValue(fakeReturn);

    const response = await loader({
      request: makeRequest(),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data.id).toBe("ret-1");
    expect(body.data.returnRequestNo).toBe("RPM-001");
    expect(body.data.status).toBe("approved");
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].title).toBe("Blue T-Shirt");
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0].eventType).toBe("approved");
    expect(body.errors).toEqual([]);
  });

  it("returns 400 when return ID is missing", async () => {
    const response = await loader({
      request: makeRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Return ID is required");
  });
});
