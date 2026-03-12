import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../../db.server", () => {
  const mockPrisma = {
    shopSettings: {
      findUnique: vi.fn(),
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
import { loader } from "../api.v1.external.settings";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function makeRequest() {
  return new Request("http://localhost/api/v1/external/settings", {
    method: "GET",
    headers: { "X-API-Key": "rpm_testkey123" },
  });
}

describe("GET /api/v1/external/settings", () => {
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
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/settings",
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns settings without sensitive fields", async () => {
    const fakeSettings = {
      id: "settings-1",
      shopId: "shop-1",
      returnWindowDays: 30,
      autoApproveEnabled: false,
      autoRefundEnabled: false,
      photoRequired: true,
      refundPaymentMethod: "original",
      returnFeeAmount: "5.00",
      returnFeeCurrency: "USD",
      bonusCreditEnabled: false,
      bonusCreditPct: null,
      greenReturnsEnabled: true,
      portalExchangeEnabled: false,
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
      discountCodeRefundEnabled: false,
      // These sensitive fields should NOT appear in the response
      shopifyAccessToken: "shpat_secret_token",
      fyndApiKey: "fynd_secret_key",
      internalConfig: { secret: true },
    };

    mockPrisma.shopSettings.findUnique.mockResolvedValue(fakeSettings);

    const response = await loader({
      request: makeRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/settings",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    // Verify expected fields are present
    expect(body.data.returnWindowDays).toBe(30);
    expect(body.data.autoApproveEnabled).toBe(false);
    expect(body.data.photoRequired).toBe(true);
    expect(body.data.refundPaymentMethod).toBe("original");
    expect(body.data.returnFeeAmount).toBe("5.00");
    expect(body.data.greenReturnsEnabled).toBe(true);
    expect(body.data.shopCurrency).toBe("USD");
    expect(body.data.shopTimezone).toBe("America/New_York");

    // Verify sensitive fields are NOT present
    expect(body.data.shopifyAccessToken).toBeUndefined();
    expect(body.data.fyndApiKey).toBeUndefined();
    expect(body.data.internalConfig).toBeUndefined();
    expect(body.data.id).toBeUndefined();
    expect(body.data.shopId).toBeUndefined();

    expect(body.errors).toEqual([]);
  });

  it("returns 404 when settings not found", async () => {
    mockPrisma.shopSettings.findUnique.mockResolvedValue(null);

    const response = await loader({
      request: makeRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/settings",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Shop settings not found");
  });
});
