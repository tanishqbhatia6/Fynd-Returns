import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for api.portal.cancel-return:
 *   - line 263: fallback Response when returnCase.status is not terminal,
 *     not in AUTO_CANCEL_STATUSES, and not "approved" — e.g. "needs_review".
 */

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
  sendCancellationNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
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

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/cancel-return", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalTokenMock.mockReset().mockReturnValue({ sessionId: "sess-1", shopId: "shop-1" });
  verifyPortalCsrfTokenMock.mockReset().mockReturnValue(true);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 5, retryAfterMs: 0 });
  parsePortalConfigMock.mockReset().mockReturnValue({ allowReturnCancellation: true });
});

describe("api.portal.cancel-return — fallback status branch (line 263)", () => {
  it("returns 400 when returnCase.status is not terminal/auto-cancel/approved", async () => {
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      id: "sess-1",
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      matchedReturnIds: JSON.stringify(["rc-1"]),
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    // status not in any handled bucket — exercises the fallback at line 263
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      status: "needs_review",
      items: [],
    });

    const res = await action({
      request: jsonReq({ shop: "store", returnCaseId: "rc-1" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("needs_review");
  });
});
