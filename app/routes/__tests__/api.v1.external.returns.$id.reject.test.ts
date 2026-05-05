import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../../db.server", () => {
  const mockPrisma = {
    returnCase: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    returnEvent: {
      create: vi.fn(),
    },
    // `session` is needed because api.v1.external.returns.$id.reject looks up
    // the offline Shopify session to best-effort decline the return in
    // Shopify after rejecting it locally. Default to null so the best-effort
    // Shopify call is skipped — the actual Shopify flow is covered by the
    // shopify-admin.server integration tests.
    session: {
      findFirst: vi.fn().mockResolvedValue(null),
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

vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>("../../lib/external-api-helpers.server");
  return {
    ...actual,
    // Per-key rate-limit hits the DB in production. In tests we short-circuit
    // to "always allowed" so we're exercising the action logic, not the
    // rate-limit infra (which has its own dedicated test file).
    checkPerKeyRateLimit: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../../lib/shopify-admin.server", () => ({
  createAdminClient: vi.fn(),
  closeShopifyReturnBestEffort: vi.fn().mockResolvedValue(undefined),
}));

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { action } from "../api.v1.external.returns.$id.reject";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function makeRequest(body?: Record<string, unknown>) {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "X-API-Key": "rpm_testkey123",
      "Content-Type": "application/json",
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/v1/external/returns/ret-1/reject", init);
}

describe("POST /api/v1/external/returns/:id/reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("returns 400 when rejectionReason is missing", async () => {
    const response = await action({
      request: makeRequest({}),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/reject",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("rejectionReason is required");
  });

  it("returns 400 when reason exceeds 500 chars", async () => {
    const longReason = "x".repeat(501);

    const response = await action({
      request: makeRequest({ rejectionReason: longReason }),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/reject",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("500 characters or less");
  });

  it("returns 404 for non-existent return", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue(null);

    const response = await action({
      request: makeRequest({ rejectionReason: "Out of window" }),
      params: { id: "non-existent" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/reject",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("successfully rejects a pending return", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };

    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({
      ...pendingReturn,
      status: "rejected",
      rejectionReason: "Out of return window",
    });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    const response = await action({
      request: makeRequest({ rejectionReason: "Out of return window" }),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/reject",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe("ret-1");
    expect(body.data.status).toBe("rejected");
    expect(body.data.message).toBe("Return rejected successfully");

    // Verify prisma update was called with correct data
    expect(mockPrisma.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({
        status: "rejected",
        rejectionReason: "Out of return window",
      }),
    });

    // Verify event created with external_api source
    expect(mockPrisma.returnEvent.create).toHaveBeenCalledWith({
      data: {
        returnCaseId: "ret-1",
        source: "external_api",
        eventType: "rejected",
        payloadJson: expect.stringContaining('"rejectionReason":"Out of return window"'),
      },
    });
  });
});
