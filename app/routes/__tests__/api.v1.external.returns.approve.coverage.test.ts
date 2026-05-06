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
  rateLimitResponse: vi.fn((retryAfterMs: number) =>
    Response.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests" } },
      { status: 429, headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
    ),
  ),
}));

vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return {
    ...actual,
    checkPerKeyRateLimit: vi.fn().mockResolvedValue(null),
  };
});

vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: vi.fn(),
}));

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { checkRateLimit } from "../../lib/rate-limit.server";
import { checkPerKeyRateLimit } from "../../lib/external-api-helpers.server";
import { dispatchWebhookEvent } from "../../lib/webhook-dispatch.server";
import { action } from "../api.v1.external.returns.$id.approve";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;
const mockDispatch = dispatchWebhookEvent as ReturnType<typeof vi.fn>;
const mockCheckRateLimit = checkRateLimit as ReturnType<typeof vi.fn>;
const mockPerKey = checkPerKeyRateLimit as ReturnType<typeof vi.fn>;

function makeRequest(method = "POST", body?: Record<string, unknown> | string) {
  const init: RequestInit = {
    method,
    headers: {
      "X-API-Key": "rpm_testkey123",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("http://localhost/api/v1/external/returns/ret-1/approve", init);
}

const baseArgs = (req: Request, id: string | undefined = "ret-1") => ({
  request: req,
  params: { id },
  context: {} as any,
  unstable_pattern: "/api/v1/external/returns/:id/approve",
});

describe("approve route — extra coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 100, retryAfterMs: 0 });
    mockPerKey.mockResolvedValue(null);
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("short-circuits without calling update/dispatch when status is 'rejected' (terminal)", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue({
      id: "ret-1",
      shopId: "shop-1",
      status: "rejected",
      adminNotes: null,
    });

    const response = await action(baseArgs(makeRequest()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(body.error.message).toContain("rejected");
    expect(mockPrisma.returnCase.update).not.toHaveBeenCalled();
    expect(mockPrisma.returnEvent.create).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("short-circuits when status is 'completed' (case-insensitive: COMPLETED)", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue({
      id: "ret-1",
      shopId: "shop-1",
      status: "COMPLETED",
      adminNotes: null,
    });

    const response = await action(baseArgs(makeRequest()));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(mockPrisma.returnCase.update).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("short-circuits on cancelled status without side effects", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue({
      id: "ret-1",
      shopId: "shop-1",
      status: "cancelled",
      adminNotes: null,
    });

    const response = await action(baseArgs(makeRequest()));

    expect(response.status).toBe(400);
    expect(mockPrisma.returnEvent.create).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("dispatches webhook fire-and-forget — does not await; returns success even if dispatch throws sync", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-007",
      shopifyOrderName: "#1007",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});
    // Synchronous throw — fire-and-forget should still allow success path because
    // dispatch is called as a side effect; if route awaited it the catch would run.
    // We assert response is 200 either way (fire-and-forget pattern).
    mockDispatch.mockImplementation(() => {
      // simulate async work that the route does NOT await
      return Promise.reject(new Error("webhook delivery failed"));
    });

    const response = await action(baseArgs(makeRequest("POST", { note: "ok" })));

    expect(response.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "shop-1",
      "return.approved",
      expect.objectContaining({
        returnId: "ret-1",
        returnRequestNo: "RPM-007",
        status: "approved",
        shopifyOrderName: "#1007",
      }),
    );
  });

  it("dispatches webhook payload using updated row's returnRequestNo / shopifyOrderName", async () => {
    const original = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-OLD",
      shopifyOrderName: "#OLD",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(original);
    mockPrisma.returnCase.update.mockResolvedValue({
      ...original,
      status: "approved",
      returnRequestNo: "RPM-NEW",
      shopifyOrderName: "#NEW",
    });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    await action(baseArgs(makeRequest()));

    expect(mockDispatch).toHaveBeenCalledWith(
      "shop-1",
      "return.approved",
      expect.objectContaining({
        returnRequestNo: "RPM-NEW",
        shopifyOrderName: "#NEW",
      }),
    );
  });

  it("creates ReturnEvent with payload containing apiKeyId and note", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    await action(baseArgs(makeRequest("POST", { note: "Manager approved" })));

    expect(mockPrisma.returnEvent.create).toHaveBeenCalledTimes(1);
    const call = mockPrisma.returnEvent.create.mock.calls[0][0];
    expect(call.data.returnCaseId).toBe("ret-1");
    expect(call.data.source).toBe("external_api");
    expect(call.data.eventType).toBe("approved");
    const parsed = JSON.parse(call.data.payloadJson);
    expect(parsed.apiKeyId).toBe("key-1");
    expect(parsed.note).toBe("Manager approved");
  });

  it("creates ReturnEvent even when no note/body provided (note undefined in payload)", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    // Send request with no body at all
    const req = new Request("http://localhost/api/v1/external/returns/ret-1/approve", {
      method: "POST",
      headers: { "X-API-Key": "rpm_testkey123" },
    });

    const response = await action(baseArgs(req));

    expect(response.status).toBe(200);
    expect(mockPrisma.returnEvent.create).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(mockPrisma.returnEvent.create.mock.calls[0][0].data.payloadJson);
    expect(parsed.apiKeyId).toBe("key-1");
    expect(parsed.note).toBeUndefined();
  });

  it("validates resolutionType — rejects unknown values without creating event/dispatch", async () => {
    mockPrisma.returnCase.findFirst.mockResolvedValue({
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    });

    const response = await action(baseArgs(makeRequest("POST", { resolutionType: "magic-beans" })));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("resolutionType");
    expect(mockPrisma.returnCase.update).not.toHaveBeenCalled();
    expect(mockPrisma.returnEvent.create).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("accepts a valid resolutionType (store_credit) and persists it on update", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    const response = await action(
      baseArgs(makeRequest("POST", { resolutionType: "store_credit" })),
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({ status: "approved", resolutionType: "store_credit" }),
    });
  });

  it("appends note to existing adminNotes via newline join", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: "Previous note",
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    await action(baseArgs(makeRequest("POST", { note: "Approved by ops" })));

    expect(mockPrisma.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({
        adminNotes: "Previous note\nApproved by ops",
      }),
    });
  });

  it("returns 400 BAD_REQUEST when params.id is missing", async () => {
    // Bypass the default-param substitution by overriding params directly.
    const response = await action({
      request: makeRequest(),
      params: { id: undefined },
      context: {} as any,
      unstable_pattern: "/api/v1/external/returns/:id/approve",
    } as never);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(mockPrisma.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("returns 500 INTERNAL_ERROR and skips dispatch when prisma.update throws", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockRejectedValue(new Error("db boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await action(baseArgs(makeRequest("POST", { note: "x" })));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockPrisma.returnEvent.create).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("tolerates malformed JSON body and still approves", async () => {
    const pendingReturn = {
      id: "ret-1",
      shopId: "shop-1",
      status: "pending",
      adminNotes: null,
      returnRequestNo: "RPM-001",
      shopifyOrderName: "#1001",
    };
    mockPrisma.returnCase.findFirst.mockResolvedValue(pendingReturn);
    mockPrisma.returnCase.update.mockResolvedValue({ ...pendingReturn, status: "approved" });
    mockPrisma.returnEvent.create.mockResolvedValue({});

    const req = new Request("http://localhost/api/v1/external/returns/ret-1/approve", {
      method: "POST",
      headers: { "X-API-Key": "rpm_testkey123", "Content-Type": "application/json" },
      body: "{ not json",
    });

    const response = await action(baseArgs(req));

    expect(response.status).toBe(200);
    expect(mockPrisma.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: { status: "approved" },
    });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});
