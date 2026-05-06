/**
 * Extra coverage tests for app/routes/api.v1.external.returns.$id.refund.ts.
 *
 * Sibling file `api.external.returns.refund.test.ts` already covers the
 * primary happy path + auth/rate-limit gates. This file fills in the
 * gaps the coverage report flags:
 *
 *  - per-key (per-API-key) rate limit branch
 *  - JSON parse failure (silent fallback to defaults)
 *  - explicit refundMethod overrides settings/default
 *  - refundMethod whitelist (each invalid value rejected)
 *  - locationId override / settings fallback
 *  - line-item shape passed to createRefund
 *  - refundCurrency falls back to returnCase.currency on webhook
 *  - dispatchWebhookEvent fired even when closeShopifyReturnBestEffort logEvent throws
 *  - case-insensitive `status` check (Approved, APPROVED)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
  dispatchWebhookEventMock,
  createRefundMock,
  createAdminClientMock,
  closeShopifyReturnMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  dispatchWebhookEventMock: vi.fn(),
  createRefundMock: vi.fn(),
  createAdminClientMock: vi.fn(() => ({ adminClient: true })),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
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
  createRefund: createRefundMock,
  createAdminClient: createAdminClientMock,
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
}));

import { action } from "../api.v1.external.returns.$id.refund";

function mkReq(method = "POST", body?: unknown, raw?: string) {
  const init: RequestInit = { method };
  if (raw !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = raw;
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://app.example/api/v1/external/returns/rc-1/refund", init);
}

function approvedReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "approved",
    refundStatus: null,
    returnRequestNo: "R-1",
    shopifyOrderId: "gid://shopify/Order/123",
    currency: "USD",
    items: [
      { shopifyLineItemId: "li-1", qty: 2 },
      { shopifyLineItemId: "li-2", qty: 1 },
    ],
    ...overrides,
  };
}

function happyAuth() {
  authenticateApiKeyMock.mockResolvedValueOnce({
    ok: true,
    keyId: "k-1",
    shopId: "shop-1",
    shopDomain: "s.myshopify.com",
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  dispatchWebhookEventMock.mockClear();
  createRefundMock.mockReset();
  createAdminClientMock.mockClear();
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
});

describe("api.v1.external.returns.$id.refund — extra coverage", () => {
  // ─── Input validation ───────────────────────────────────────────

  it("returns the per-key 429 response when checkPerKeyRateLimit returns one", async () => {
    happyAuth();
    checkPerKeyRateLimitMock.mockResolvedValueOnce(
      Response.json({ error: { code: "TOO_MANY" } }, { status: 429 }),
    );
    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(429);
    // Auth must have run before per-key check (per-key uses keyId from auth).
    expect(authenticateApiKeyMock).toHaveBeenCalled();
    // Should short-circuit before touching DB.
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to defaults when body is invalid JSON (no 400 from parse)", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r1",
      refundAmount: "10.00",
      refundCurrency: "USD",
    });
    const res = await action({
      request: mkReq("POST", undefined, "not-json{"),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // No method in body, no setting → "original" default
    expect(body.data.refundDetails.method).toBe("original");
  });

  it.each([["bogus"], ["partial"], ["cash"], ["DISCOUNT_CODE"], [""]])(
    "rejects invalid refundMethod %s with 400 BAD_REQUEST",
    async (method) => {
      happyAuth();
      const res = await action({
        request: mkReq("POST", { refundMethod: method }),
        params: { id: "rc-1" },
        context: {},
      } as never);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toMatch(/Invalid refundMethod/);
      // Validation failure must short-circuit before DB.
      expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each([["original"], ["store_credit"], ["both"]])(
    "accepts whitelisted refundMethod %s and forwards it to createRefund",
    async (method) => {
      happyAuth();
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
      prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
      prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
      createRefundMock.mockResolvedValueOnce({
        success: true,
        refundId: "r-x",
        refundAmount: "1.00",
        refundCurrency: "USD",
      });

      const res = await action({
        request: mkReq("POST", { refundMethod: method }),
        params: { id: "rc-1" },
        context: {},
      } as never);
      expect(res.status).toBe(200);
      expect(createRefundMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        undefined,
        null,
        expect.objectContaining({ method }),
      );
    },
  );

  it("body refundMethod overrides shopSettings.refundPaymentMethod", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "store_credit",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "5.00",
      refundCurrency: "USD",
    });

    const res = await action({
      request: mkReq("POST", { refundMethod: "both" }),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.refundDetails.method).toBe("both");
  });

  it("body locationId overrides shopSettings.refundLocationId", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "original",
      refundLocationId: "loc-from-settings",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "1.00",
      refundCurrency: "USD",
    });

    const res = await action({
      request: mkReq("POST", { locationId: "loc-from-body" }),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      "loc-from-body",
      expect.anything(),
    );
  });

  it("uses shopSettings.refundLocationId when body omits locationId", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "original",
      refundLocationId: "loc-from-settings",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "1.00",
      refundCurrency: "USD",
    });

    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      "loc-from-settings",
      expect.anything(),
    );
  });

  // ─── Refund execution ───────────────────────────────────────────

  it("forwards lineItems built from returnCase.items (id + quantity)", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "1.00",
      refundCurrency: "USD",
    });

    await action({
      request: mkReq("POST", { note: "hi" }),
      params: { id: "rc-1" },
      context: {},
    } as never);
    expect(createRefundMock).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/Order/123",
      [
        { id: "li-1", quantity: 2 },
        { id: "li-2", quantity: 1 },
      ],
      "hi",
      null,
      expect.anything(),
    );
  });

  it("uses the most recent offline session (orderBy expires desc)", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "freshest-token" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "1.00",
      refundCurrency: "USD",
    });

    await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(prismaMock.session.findFirst).toHaveBeenCalledWith({
      where: { shop: "s.myshopify.com", isOnline: false },
      orderBy: { expires: "desc" },
    });
    expect(createAdminClientMock).toHaveBeenCalledWith("s.myshopify.com", "freshest-token");
  });

  it.each([["Approved"], ["APPROVED"]])(
    "treats status %s as approved (case-insensitive)",
    async (status) => {
      happyAuth();
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn({ status }));
      prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
      prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
      createRefundMock.mockResolvedValueOnce({
        success: true,
        refundId: "r",
        refundAmount: "1.00",
        refundCurrency: "USD",
      });

      const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
      expect(res.status).toBe(200);
    },
  );

  // ─── dispatchWebhookEvent fire ──────────────────────────────────

  it("fires dispatchWebhookEvent with returnCase.currency when result.refundCurrency is missing", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn({ currency: "EUR" }));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "20.00",
      // refundCurrency intentionally omitted
    });

    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.refunded",
      expect.objectContaining({
        returnId: "rc-1",
        returnRequestNo: "R-1",
        method: "original",
        amount: "20.00",
        currency: "EUR",
      }),
    );
    const body = await res.json();
    expect(body.data.refundDetails.currency).toBe("EUR");
  });

  it("still fires dispatchWebhookEvent when closeShopifyReturnBestEffort logEvent path errors", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "9.99",
      refundCurrency: "USD",
    });

    // Simulate close handler invoking logEvent with a failing prisma create.
    closeShopifyReturnMock.mockImplementationOnce(async (..._args: unknown[]) => {
      const opts = _args[2] as { logEvent?: (e: unknown) => Promise<void> } | undefined;
      // The route swallows logEvent failures with `.catch(() => {})`.
      prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("transient"));
      await opts?.logEvent?.({ eventType: "shopify_return_closed", payloadJson: "{}" });
      return undefined;
    });

    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.refunded",
      expect.objectContaining({ returnId: "rc-1", amount: "9.99" }),
    );
  });

  it("does not fire dispatchWebhookEvent when createRefund fails", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ refundPaymentMethod: "original" });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({ success: false, error: "gateway down" });

    const res = await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(400);
    expect(dispatchWebhookEventMock).not.toHaveBeenCalled();
    expect(closeShopifyReturnMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("emits a return.refunded event row with method + apiKeyId in payloadJson", async () => {
    happyAuth();
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(approvedReturn());
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      refundPaymentMethod: "store_credit",
    });
    prismaMock.session.findFirst.mockResolvedValueOnce({ accessToken: "tok" });
    createRefundMock.mockResolvedValueOnce({
      success: true,
      refundId: "r",
      refundAmount: "3.00",
      refundCurrency: "USD",
    });

    await action({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);

    const refundedCall = prismaMock.returnEvent.create.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { data?: { eventType?: string } })?.data?.eventType === "refunded",
    );
    expect(refundedCall).toBeTruthy();
    const data = (refundedCall as unknown as [{ data: { source: string; payloadJson: string } }])[0]
      .data;
    expect(data.source).toBe("external_api");
    expect(JSON.parse(data.payloadJson)).toEqual({ method: "store_credit", apiKeyId: "k-1" });
  });
});
