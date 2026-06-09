import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  verifyPortalSessionMock,
  verifyPortalCsrfTokenMock,
  checkRateLimitMock,
  parsePortalConfigMock,
  sendCancellationNotificationMock,
  dispatchWebhookEventMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  verifyPortalSessionMock: vi.fn(),
  verifyPortalCsrfTokenMock: vi.fn(() => true),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  parsePortalConfigMock: vi.fn(() => ({ allowReturnCancellation: true })),
  sendCancellationNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  dispatchWebhookEventMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalSession: verifyPortalSessionMock,
  verifyPortalCsrfToken: verifyPortalCsrfTokenMock,
}));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/portal-config.server", () => ({
  parsePortalConfig: parsePortalConfigMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendCancellationNotification: sendCancellationNotificationMock,
}));
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}));

import { loader, action } from "../api.portal.cancel-return";

function jsonReq(body: unknown, opts: { method?: string; auth?: string } = {}) {
  const method = opts.method ?? "POST";
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.auth) headers.Authorization = opts.auth;
    init.headers = headers;
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/portal/cancel-return", init);
}

function validSession() {
  return {
    id: "sess-1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "u@x.com",
    matchedReturnIds: JSON.stringify(["rc-1"]),
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalSessionMock.mockReset().mockResolvedValue(validSession());
  verifyPortalCsrfTokenMock.mockReset().mockReturnValue(true);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  parsePortalConfigMock.mockReset().mockReturnValue({ allowReturnCancellation: true });
  sendCancellationNotificationMock.mockReset().mockResolvedValue(undefined);
  dispatchWebhookEventMock.mockClear();
});

describe("loader", () => {
  it("204 on OPTIONS preflight", async () => {
    const res = await loader({
      request: new Request("https://a/x", { method: "OPTIONS" }),
      params: {},
      context: {},
    } as never);
    expect(res?.status).toBe(204);
  });
  it("null for other methods", async () => {
    const res = await loader({
      request: new Request("https://a/x"),
      params: {},
      context: {},
    } as never);
    expect(res).toBe(null);
  });
});

describe("action guards", () => {
  it("405 on non-POST", async () => {
    const res = await action({
      request: jsonReq({}, { method: "GET" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(405);
  });
  it("429 rate-limit", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: jsonReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });
  it("400 when shop or returnCaseId missing", async () => {
    const res = await action({ request: jsonReq({ shop: "x" }), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });
  it("401 when no Authorization header", async () => {
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
  it("401 on invalid token", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer bad" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
  it("401 when session unverified", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
  it("401 when session expired", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
  it("404 when returnCaseId not in session's matchedReturnIds", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({
      ...validSession(),
      matchedReturnIds: JSON.stringify(["other"]),
    });
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });
  it("tolerates invalid matchedReturnIds JSON (resolves to 404)", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({
      ...validSession(),
      matchedReturnIds: "{broken",
    });
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });
  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "missing", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });
  it("403 on cross-shop token replay", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({ ...validSession(), shopId: "shop-1" });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-2",
      shopDomain: "other.myshopify.com",
    });
    const res = await action({
      request: jsonReq({ shop: "other", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });
  it("403 when portal config disables cancellation", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    parsePortalConfigMock.mockReturnValueOnce({ allowReturnCancellation: false });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(403);
  });
  it("404 when return case not found for shop", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });
  it("400 when return is in terminal status", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "completed",
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });
});

describe("Flow A: auto-cancel for non-approved statuses", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("cancels 'pending' immediately + notifies + dispatches webhook", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "pending",
      customerEmailNorm: "u@x.com",
      customerPhoneNorm: null,
      returnRequestNo: "R-1",
      shopifyOrderName: "#1001",
      items: [],
    });
    const res = await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", reason: "changed mind" },
        { auth: "Bearer t" },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flow).toBe("auto_cancelled");
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          cancellationRequestedBy: "portal",
          cancellationReason: "changed mind",
        }),
      }),
    );
    await new Promise((r) => setImmediate(r));
    expect(sendCancellationNotificationMock).toHaveBeenCalled();
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.cancelled",
      expect.any(Object),
    );
  });

  it("skips notification when customer has no email", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "initiated",
      customerEmailNorm: null,
      returnRequestNo: "R-1",
      items: [],
    });
    await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(sendCancellationNotificationMock).not.toHaveBeenCalled();
  });

  it("cancels 'processing' status", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "processing",
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe("Flow B: cancellation request for approved returns", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("409 when refund already completed", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "approved",
      refundStatus: "refunded",
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been refunded/);
  });

  it("409 when refund is in progress", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "approved",
      refundStatus: "in_progress",
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(409);
  });

  it("400 when cancellation already pending", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "approved",
      refundStatus: null,
      cancellationRequestedAt: new Date(),
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
  });

  it("success: records cancellation request, clears prior declined state", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "approved",
      refundStatus: null,
      items: [],
    });
    const res = await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", reason: "wrong size" },
        { auth: "Bearer t" },
      ),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flow).toBe("cancellation_requested");
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cancellationRequestedBy: "portal",
          cancellationReason: "wrong size",
          cancellationDeclinedAt: null,
          cancellationDeclinedBy: null,
        }),
      }),
    );
  });
});

describe("error path", () => {
  it("500 on unexpected prisma error", async () => {
    verifyPortalSessionMock.mockRejectedValueOnce(new Error("db gone"));
    const res = await action({
      request: jsonReq({ shop: "x", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
  });
});
