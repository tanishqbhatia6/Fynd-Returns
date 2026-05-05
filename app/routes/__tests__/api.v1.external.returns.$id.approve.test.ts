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

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { dispatchWebhookEvent } from "../../lib/webhook-dispatch.server";
import { action } from "../api.v1.external.returns.$id.approve";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;
const mockDispatch = dispatchWebhookEvent as ReturnType<typeof vi.fn>;

function makeRequest(method = "POST", body?: Record<string, unknown>) {
  const init: RequestInit = {
    method,
    headers: {
      "X-API-Key": "rpm_testkey123",
      "Content-Type": "application/json",
    },
  };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/v1/external/returns/ret-1/approve", init);
}

describe("POST /api/v1/external/returns/:id/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("returns 405 for non-POST method", async () => {
    const response = await action({
      request: makeRequest("PUT"),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 401 for invalid API key", async () => {
    const unauthorizedResponse = Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
      { status: 401 },
    );
    mockAuth.mockResolvedValue({ ok: false, response: unauthorizedResponse });

    const response = await action({
      request: makeRequest(),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for non-existent return", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue(null);

    const response = await action({
      request: makeRequest(),
      params: { id: "non-existent" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 INVALID_STATE for already-approved return", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue({
      id: "ret-1",
      shopId: "shop-1",
      status: "approved",
      adminNotes: null,
    });

    const response = await action({
      request: makeRequest(),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(body.error.message).toContain("already approved");
  });

  it("successfully approves a pending return", async () => {
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
      status: "approved",
    });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    const response = await action({
      request: makeRequest("POST", { note: "Looks good" }),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.id).toBe("ret-1");
    expect(body.data.status).toBe("approved");
    expect(body.data.message).toBe("Return approved successfully");

    // Verify update was called
    expect(mockPrisma.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({ status: "approved" }),
    });

    // Verify webhook dispatch
    expect(mockDispatch).toHaveBeenCalledWith("shop-1", "return.approved", expect.objectContaining({
      returnId: "ret-1",
      status: "approved",
    }));
  });

  it("creates a ReturnEvent with source external_api", async () => {
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
      status: "approved",
    });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    await action({
      request: makeRequest("POST", { note: "Auto-approved" }),
      params: { id: "ret-1" },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    });

    expect(mockPrisma.returnEvent.create).toHaveBeenCalledWith({
      data: {
        returnCaseId: "ret-1",
        source: "external_api",
        eventType: "approved",
        payloadJson: expect.stringContaining('"apiKeyId":"key-1"'),
      },
    });
  });
});
