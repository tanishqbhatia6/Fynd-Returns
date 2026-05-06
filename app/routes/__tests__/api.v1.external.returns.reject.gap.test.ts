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

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/v1/external/returns/ret-1/reject", {
    method: "POST",
    headers: {
      "X-API-Key": "rpm_testkey",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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

describe("api.v1.external.returns.$id.reject — gap coverage (logEvent callback)", () => {
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
    prismaMock.returnCase.findFirst.mockReset();
    prismaMock.returnCase.update.mockReset();
    prismaMock.returnEvent.create.mockReset();
    prismaMock.returnEvent.create.mockResolvedValue({});
    prismaMock.session.findFirst.mockReset();
  });

  it("invokes logEvent callback which writes a returnEvent (line 79) when closeShopifyReturnBestEffort calls it", async () => {
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

    // When closeShopifyReturnBestEffort is invoked, call the supplied logEvent
    // callback to exercise line 79 (prisma.returnEvent.create inside the cb).
    closeShopifyReturnBestEffortMock.mockImplementationOnce(
      async (_admin: unknown, _rc: unknown, opts: any) => {
        await opts.logEvent({
          eventType: "shopify_decline_attempt",
          payloadJson: JSON.stringify({ ok: true }),
        });
        return undefined;
      },
    );

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged item" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalledTimes(1);
    // The logEvent callback must have invoked prisma.returnEvent.create with
    // the spread evt data plus the route-level fields.
    const createCalls = prismaMock.returnEvent.create.mock.calls;
    // First call is the route-level "rejected" event; second is from logEvent.
    expect(createCalls.length).toBeGreaterThanOrEqual(2);
    const logEventCall = createCalls[createCalls.length - 1][0];
    expect(logEventCall).toEqual({
      data: expect.objectContaining({
        returnCaseId: "ret-1",
        source: "external_api",
        eventType: "shopify_decline_attempt",
        payloadJson: JSON.stringify({ ok: true }),
      }),
    });
  });

  it("returns 429 when global rate limit blocks the request", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(429);
    expect(rateLimitResponseMock).toHaveBeenCalledWith(1000);
    expect(authenticateApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns per-key rate-limit response when checkPerKeyRateLimit yields one", async () => {
    const perKeyResp = Response.json({ error: "per-key-limit" }, { status: 429 });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(perKeyResp);

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response).toBe(perKeyResp);
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to 'anon' for per-key rate-limit when auth.keyId is missing", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: undefined,
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(pendingReturnCase());
    prismaMock.returnCase.update.mockResolvedValue({
      ...pendingReturnCase(),
      status: "rejected",
    });
    prismaMock.session.findFirst.mockResolvedValue(null);

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response.status).toBe(200);
    expect(checkPerKeyRateLimitMock).toHaveBeenCalledWith(
      expect.any(Request),
      "external.returns.reject",
      "anon",
    );
  });

  it("returns auth.response when authenticateApiKey fails (auth.ok === false)", async () => {
    const authResp = Response.json({ error: "unauthorized" }, { status: 401 });
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: false, response: authResp });

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    expect(response).toBe(authResp);
    expect(checkPerKeyRateLimitMock).not.toHaveBeenCalled();
  });

  it("logEvent swallows prisma.returnEvent.create rejections (.catch on line 79)", async () => {
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

    // First create() call (route-level "rejected" event) must succeed; the
    // second call (from logEvent) should reject so we exercise the .catch.
    prismaMock.returnEvent.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("event log boom"));

    closeShopifyReturnBestEffortMock.mockImplementationOnce(
      async (_admin: unknown, _rc: unknown, opts: any) => {
        // Should not throw — .catch(() => {}) on line 79 swallows it.
        await opts.logEvent({
          eventType: "shopify_decline_failed",
          payloadJson: JSON.stringify({ error: "x" }),
        });
        return undefined;
      },
    );

    const response = await action({
      request: makeRequest({ rejectionReason: "Damaged item" }),
      params: { id: "ret-1" },
      ...ACTION_CONTEXT,
    });

    // Action completes successfully — webhook still dispatched.
    expect(response.status).toBe(200);
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.rejected",
      expect.objectContaining({ returnId: "ret-1", status: "rejected" }),
    );
  });
});
