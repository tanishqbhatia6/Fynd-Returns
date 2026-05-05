/**
 * Extended coverage for /api/portal/cancel-return.
 *
 * The base test file (`api.portal.cancel-return.test.ts`) covers the happy
 * paths and primary guards. This file fills in the gaps that were flagged
 * during the QA audit:
 *
 *  - Auto-cancel paths for *every* non-approved status in
 *    AUTO_CANCEL_STATUSES, plus event payload + previousStatus assertions.
 *  - Approved-flow request creation: verifies the
 *    "cancellation_requested" return event is written with the right
 *    payload (this was previously only smoke-tested).
 *  - CSRF gate matrix:
 *      * Soft mode (`PORTAL_CSRF_REQUIRED=false`) allows missing tokens.
 *      * Soft mode still validates a token if one is supplied
 *        (the new portalCsrfToken support).
 *      * Hard mode (default) rejects missing/invalid tokens.
 *      * The expected shop passed to verifyPortalCsrfToken is normalised
 *        with `.myshopify.com` when the caller sends the bare handle.
 *  - Already-pending duplicate request: confirms no DB writes happen
 *    when the case already has cancellationRequestedAt set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  verifyPortalTokenMock,
  verifyPortalCsrfTokenMock,
  checkRateLimitMock,
  parsePortalConfigMock,
  sendCancellationNotificationMock,
  dispatchWebhookEventMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  verifyPortalTokenMock: vi.fn(),
  verifyPortalCsrfTokenMock: vi.fn(() => true),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 5, retryAfterMs: 0 })),
  parsePortalConfigMock: vi.fn(() => ({ allowReturnCancellation: true })),
  sendCancellationNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  dispatchWebhookEventMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalToken: verifyPortalTokenMock,
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

import { action } from "../api.portal.cancel-return";

function jsonReq(body: unknown, opts: { auth?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth) headers.Authorization = opts.auth;
  return new Request("https://app.example/api/portal/cancel-return", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function validSession() {
  return {
    id: "sess-1",
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    matchedReturnIds: JSON.stringify(["rc-1"]),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalTokenMock.mockReset().mockReturnValue({ sessionId: "sess-1", shopId: "shop-1" });
  verifyPortalCsrfTokenMock.mockReset().mockReturnValue(true);
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  parsePortalConfigMock.mockReset().mockReturnValue({ allowReturnCancellation: true });
  sendCancellationNotificationMock.mockReset().mockResolvedValue(undefined);
  dispatchWebhookEventMock.mockClear();
  prismaMock.lookupSession.findUnique.mockResolvedValue(validSession());
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com", settings: {} });
});

afterEach(() => {
  // Restore env vars that individual tests may have flipped.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    process.env[k] = v;
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Flow A — auto-cancel for non-approved statuses
// ────────────────────────────────────────────────────────────────────────────
describe("Flow A: auto-cancel non-approved statuses (extended)", () => {
  for (const status of ["initiated", "pending", "processing", "in progress"]) {
    it(`auto-cancels '${status}' and writes return_cancelled event with previousStatus`, async () => {
      prismaMock.returnCase.findFirst.mockResolvedValueOnce({
        id: "rc-1",
        status,
        refundStatus: null,
        customerEmailNorm: null,
        returnRequestNo: "R-99",
        shopifyOrderName: "#9001",
        items: [],
      });

      const res = await action({
        request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
        params: {},
        context: {},
      } as never);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ success: true, flow: "auto_cancelled" });

      // returnCase.update sets status=cancelled
      expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rc-1" },
          data: expect.objectContaining({
            status: "cancelled",
            cancellationRequestedBy: "portal",
          }),
        }),
      );

      // returnEvent.create captures previous status in payload
      expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            returnCaseId: "rc-1",
            source: "portal",
            eventType: "return_cancelled",
          }),
        }),
      );
      const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
      const payload = JSON.parse(eventCall.data.payloadJson);
      expect(payload.flow).toBe("auto_cancelled");
      expect(payload.previousStatus).toBe(status);
    });
  }

  it("trims and caps the reason at 500 chars before persisting", async () => {
    const longReason = " ".repeat(5) + "x".repeat(800);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null, items: [],
    });
    await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1", reason: longReason }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
    expect(updateCall.data.cancellationReason.length).toBeLessThanOrEqual(500);
    // First non-space char preserved (trim happened)
    expect(updateCall.data.cancellationReason.startsWith("x")).toBe(true);
  });

  it("auto-cancel still returns 200 even when notification rejects (fire-and-forget)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null,
      customerEmailNorm: "u@x.com", items: [],
    });
    sendCancellationNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    // Let the rejection settle so vitest doesn't flag an unhandled rejection.
    await new Promise((r) => setImmediate(r));
  });

  it("dispatches return.cancelled webhook with previousStatus + portal source", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "in progress", refundStatus: null,
      customerEmailNorm: null, returnRequestNo: "R-7",
      shopifyOrderName: "#7", items: [],
    });
    await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1", reason: "test" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.cancelled",
      expect.objectContaining({
        returnCaseId: "rc-1",
        cancelledBy: "portal",
        previousStatus: "in progress",
        reason: "test",
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Flow B — request creation for approved (cancellation_requested event)
// ────────────────────────────────────────────────────────────────────────────
describe("Flow B: approved-status request creation (extended)", () => {
  it("writes a cancellation_requested return event with reason in payload", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "approved", refundStatus: null, items: [],
    });
    const res = await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", reason: "ordered wrong color" },
        { auth: "Bearer t" },
      ),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);

    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          returnCaseId: "rc-1",
          source: "portal",
          eventType: "cancellation_requested",
        }),
      }),
    );
    const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
    const payload = JSON.parse(eventCall.data.payloadJson);
    expect(payload).toEqual({ flow: "cancellation_requested", reason: "ordered wrong color" });

    // Status MUST stay 'approved' — only cancellationRequestedAt is set.
    const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
    expect(updateCall.data.status).toBeUndefined();
    expect(updateCall.data.cancellationRequestedAt).toBeInstanceOf(Date);
    expect(updateCall.data.cancellationDeclinedAt).toBeNull();
    expect(updateCall.data.cancellationDeclinedBy).toBeNull();
  });

  it("approved flow does NOT dispatch webhook or send notification", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "approved", refundStatus: null,
      customerEmailNorm: "u@x.com", items: [],
    });
    await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    await new Promise((r) => setImmediate(r));
    expect(dispatchWebhookEventMock).not.toHaveBeenCalled();
    expect(sendCancellationNotificationMock).not.toHaveBeenCalled();
  });

  it("payload.reason is null when caller omits reason", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "approved", refundStatus: null, items: [],
    });
    await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
    const payload = JSON.parse(eventCall.data.payloadJson);
    expect(payload.reason).toBeNull();
  });

  it("400 when cancellation_requested already pending — does NOT touch returnCase or returnEvent", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "approved",
      refundStatus: null,
      cancellationRequestedAt: new Date("2026-01-01"),
      items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already pending/i);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// CSRF gate (soft mode + portalCsrfToken)
// ────────────────────────────────────────────────────────────────────────────
describe("CSRF gate", () => {
  it("hard mode (default): rejects missing portalCsrfToken with 403", async () => {
    delete process.env.PORTAL_CSRF_REQUIRED; // default => required
    verifyPortalCsrfTokenMock.mockReturnValueOnce(false);
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Session expired/);
    // Should never have got to DB calls.
    expect(prismaMock.lookupSession.findUnique).not.toHaveBeenCalled();
  });

  it("hard mode: accepts a valid portalCsrfToken and proceeds", async () => {
    delete process.env.PORTAL_CSRF_REQUIRED;
    verifyPortalCsrfTokenMock.mockReturnValueOnce(true);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null, items: [],
    });
    const res = await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", portalCsrfToken: "good" },
        { auth: "Bearer t" },
      ),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(verifyPortalCsrfTokenMock).toHaveBeenCalledWith("good", "store.myshopify.com");
  });

  it("soft mode (PORTAL_CSRF_REQUIRED=false) without token: skips CSRF check entirely", async () => {
    process.env.PORTAL_CSRF_REQUIRED = "false";
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null, items: [],
    });
    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }, { auth: "Bearer t" }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(verifyPortalCsrfTokenMock).not.toHaveBeenCalled();
  });

  it("soft mode WITH portalCsrfToken: still validates the supplied token and rejects bad ones", async () => {
    // This is the new portalCsrfToken behaviour — even in soft rollout
    // mode, if the client sends a token we honour it.
    process.env.PORTAL_CSRF_REQUIRED = "false";
    verifyPortalCsrfTokenMock.mockReturnValueOnce(false);
    const res = await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", portalCsrfToken: "stale" },
        { auth: "Bearer t" },
      ),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(403);
    expect(verifyPortalCsrfTokenMock).toHaveBeenCalledWith("stale", "store.myshopify.com");
  });

  it("normalises bare shop handle to *.myshopify.com when verifying CSRF", async () => {
    delete process.env.PORTAL_CSRF_REQUIRED;
    verifyPortalCsrfTokenMock.mockReturnValueOnce(true);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null, items: [],
    });
    await action({
      request: jsonReq(
        { shop: "store", returnCaseId: "rc-1", portalCsrfToken: "tok" },
        { auth: "Bearer t" },
      ),
      params: {}, context: {},
    } as never);
    expect(verifyPortalCsrfTokenMock).toHaveBeenCalledWith("tok", "store.myshopify.com");
  });

  it("passes through full domain unchanged when shop already contains a dot", async () => {
    delete process.env.PORTAL_CSRF_REQUIRED;
    verifyPortalCsrfTokenMock.mockReturnValueOnce(true);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1", status: "pending", refundStatus: null, items: [],
    });
    await action({
      request: jsonReq(
        { shop: "store.myshopify.com", returnCaseId: "rc-1", portalCsrfToken: "tok" },
        { auth: "Bearer t" },
      ),
      params: {}, context: {},
    } as never);
    expect(verifyPortalCsrfTokenMock).toHaveBeenCalledWith("tok", "store.myshopify.com");
  });
});
