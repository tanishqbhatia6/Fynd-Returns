import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so we can re-use the same fns inside vi.mock factories
const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  rateLimitResponseMock,
  checkPerKeyRateLimitMock,
  dispatchWebhookEventMock,
  createAdminClientMock,
  closeShopifyReturnBestEffortMock,
} = vi.hoisted(() => ({
  prismaMock: {
    returnCase: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    returnEvent: {
      create: vi.fn(),
    },
    session: {
      findFirst: vi.fn(),
    },
  },
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 100, retryAfterMs: 0 })),
  rateLimitResponseMock: vi.fn(() => Response.json({ error: "rate-limited" }, { status: 429 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  dispatchWebhookEventMock: vi.fn(),
  createAdminClientMock: vi.fn(() => ({ admin: true })),
  closeShopifyReturnBestEffortMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: authenticateApiKeyMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  createAdminClient: createAdminClientMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
}));

import { action } from "../api.v1.external.returns.$id.reject";

const ACTION_CONTEXT = {
  context: {} as any,
  unstable_pattern: "/api/v1/external/returns/:id/reject",
} as const;

function makeRequest(opts: {
  method?: string;
  body?: unknown;
  rawBody?: string;
} = {}) {
  const method = opts.method ?? "POST";
  const init: RequestInit = {
    method,
    headers: {
      "X-API-Key": "rpm_testkey",
      "Content-Type": "application/json",
    },
  };
  if (opts.rawBody !== undefined) {
    init.body = opts.rawBody;
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }
  return new Request("http://localhost/api/v1/external/returns/ret-1/reject", init);
}

function pendingReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "ret-1",
    shopId: "shop-1",
    status: "pending",
    adminNotes: null,
    returnRequestNo: "RPM-100",
    shopifyOrderName: "#1100",
    ...overrides,
  };
}

describe("api.v1.external.returns.$id.reject — extra coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateApiKeyMock.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
    checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 100, retryAfterMs: 0 });
    checkPerKeyRateLimitMock.mockResolvedValue(null);
    prismaMock.session.findFirst.mockResolvedValue(null);
    prismaMock.returnCase.findFirst.mockReset();
    prismaMock.returnCase.update.mockReset();
    prismaMock.returnEvent.create.mockReset();
    prismaMock.returnEvent.create.mockResolvedValue({});
  });

  it("rejects non-POST method with 405", async () => {
    const response = await action({
      request: new Request("http://localhost/api/v1/external/returns/ret-1/reject", {
        method: "GET",
      }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });
    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 400 BAD_REQUEST when params.id is missing", async () => {
    const response = await action({
      request: makeRequest({ body: { rejectionReason: "no" } }),
      params: {},
      ...ACTION_CONTEXT,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Return ID is required");
  });

  it("treats whitespace-only rejectionReason as missing (validation)", async () => {
    const response = await action({
      request: makeRequest({ body: { rejectionReason: "   \t\n" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("rejectionReason is required");
    // Should never have hit the DB
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("treats invalid JSON body as missing rejectionReason (400)", async () => {
    const response = await action({
      request: makeRequest({ rawBody: "{ not json" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("rejectionReason is required");
  });

  it("accepts a 500-character rejectionReason at the boundary", async () => {
    const reason = "x".repeat(500);
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
      rejectionReason: reason,
    });

    const response = await action({
      request: makeRequest({ body: { rejectionReason: reason } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({ status: "rejected", rejectionReason: reason }),
    });
  });

  it.each([
    ["approved"],
    ["rejected"],
    ["completed"],
    ["cancelled"],
  ])("blocks rejection when return is in terminal status %s (INVALID_STATE)", async (status) => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase({ status }));

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "trying to reject" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(body.error.message).toContain(`already ${status}`);
    // Should not have updated or dispatched
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(dispatchWebhookEventMock).not.toHaveBeenCalled();
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
  });

  it("treats terminal-status check as case-insensitive (APPROVED is blocked)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase({ status: "APPROVED" }));

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "case test" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_STATE");
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("trims rejectionReason before persisting", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
      rejectionReason: "Damaged",
    });

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "   Damaged   " } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({ rejectionReason: "Damaged" }),
    });
  });

  it("appends note to existing adminNotes when provided", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(
      pendingReturnCase({ adminNotes: "previous note" }),
    );
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
    });

    const response = await action({
      request: makeRequest({
        body: { rejectionReason: "Damaged", note: "added context" },
      }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: expect.objectContaining({
        adminNotes: "previous note\nadded context",
      }),
    });
  });

  it("calls Shopify decline (closeShopifyReturnBestEffort) when an offline session exists", async () => {
    const returnCase = pendingReturnCase();
    prismaMock.returnCase.findFirst.mockResolvedValue(returnCase);
    prismaMock.returnCase.update.mockResolvedValue({
      ...returnCase,
      status: "rejected",
      rejectionReason: "Damaged item",
    });
    prismaMock.session.findFirst.mockResolvedValue({
      shop: "test.myshopify.com",
      isOnline: false,
      accessToken: "shpat_token",
      expires: new Date(),
    });

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "  Damaged item  " } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(createAdminClientMock).toHaveBeenCalledWith("test.myshopify.com", "shpat_token");
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalledTimes(1);
    const [adminArg, returnCaseArg, optsArg] = closeShopifyReturnBestEffortMock.mock.calls[0] as unknown as [unknown, unknown, { action: string; declineReason: string; logEvent: unknown }];
    expect(adminArg).toEqual({ admin: true });
    expect(returnCaseArg).toEqual(returnCase);
    expect(optsArg.action).toBe("decline");
    // Decline reason should be the trimmed reason
    expect(optsArg.declineReason).toBe("Damaged item");
    expect(typeof optsArg.logEvent).toBe("function");
  });

  it("skips Shopify decline when no offline session is found", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
    });
    prismaMock.session.findFirst.mockResolvedValue(null);

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "no session" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
    // Webhook still dispatched
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.rejected",
      expect.objectContaining({ returnId: "ret-1", status: "rejected" }),
    );
  });

  it("skips Shopify decline when session row exists but accessToken is missing", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
    });
    prismaMock.session.findFirst.mockResolvedValue({
      shop: "test.myshopify.com",
      isOnline: false,
      accessToken: null,
      expires: new Date(),
    });

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "no token" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
  });

  it("returns 500 when prisma.update throws", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockRejectedValue(new Error("db boom"));

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await action({
      request: makeRequest({ body: { rejectionReason: "Damaged" } }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(dispatchWebhookEventMock).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
