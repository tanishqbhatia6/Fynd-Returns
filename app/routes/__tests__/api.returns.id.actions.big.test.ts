import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Heavyweight action types for api.returns.$id.actions.ts:
 * reject, approve, retry_fynd_sync, approve_cancellation, decline_cancellation.
 *
 * Each has meaningful business logic that is worth exercising beyond the
 * dispatcher tests in api.returns.id.actions.test.ts. Tests verify
 * happy-path DB writes, notification fire-and-forget, terminal-state
 * guards, and the Shopify-close-before-cancel ordering invariant.
 */

const {
  prismaMock,
  authenticateMock,
  closeShopifyReturnMock,
  withRestCredentialsMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createShopifyReturnMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  sendApprovalNotificationMock,
  sendRejectionNotificationMock,
  sendCancellationNotificationMock,
  sendCancellationDeclinedNotificationMock,
  refundLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true })),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchOrderMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  createShopifyReturnMock: vi.fn(async () => ({ success: true, shopifyReturnId: "gid://shopify/Return/1" })),
  createFyndClientOrErrorMock: vi.fn(),
  createReturnOnFyndMock: vi.fn(),
  sendApprovalNotificationMock: vi.fn(async () => undefined),
  sendRejectionNotificationMock: vi.fn(async () => undefined),
  sendCancellationNotificationMock: vi.fn(async () => undefined),
  sendCancellationDeclinedNotificationMock: vi.fn(async () => undefined),
  refundLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));

vi.mock("../../lib/shopify-admin.server", () => ({
  createRefund: vi.fn(),
  createShopifyReturn: createShopifyReturnMock,
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
  fetchOrder: fetchOrderMock,
  fetchOrderByGid: vi.fn(),
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: vi.fn(),
  fetchOrderLineItemsOnly: vi.fn(),
  fetchOrderLineItemsByName: vi.fn(),
  withRestCredentials: withRestCredentialsMock,
}));

vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../lib/notification.server", () => ({
  sendRejectionNotification: sendRejectionNotificationMock,
  sendApprovalNotification: sendApprovalNotificationMock,
  sendRefundNotification: vi.fn(),
  sendCustomerNoteNotification: vi.fn(),
  sendCancellationNotification: sendCancellationNotificationMock,
  sendCancellationDeclinedNotification: sendCancellationDeclinedNotificationMock,
}));
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: vi.fn(),
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractShippingDetailsFromFyndPayload: vi.fn(() => ({})),
  isLikelyFyndId: vi.fn(() => false),
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: vi.fn(),
}));
vi.mock("../../lib/observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, cb: (span: unknown) => Promise<T>) =>
    cb({ setAttribute: () => {}, setAttributes: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
  setSpanAttributes: vi.fn(),
}));
vi.mock("../../lib/observability/logger.server", () => ({
  refundLogger: refundLoggerMock,
}));
vi.mock("../../lib/observability/metrics.server", () => ({
  returnActionCounter: { add: vi.fn() },
  returnActionDuration: { record: vi.fn() },
  refundCounter: { add: vi.fn() },
  refundAmountHistogram: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
  returnsApprovedCounter: { add: vi.fn() },
  returnsRejectedCounter: { add: vi.fn() },
  returnsCompletedCounter: { add: vi.fn() },
  appErrorCounter: { add: vi.fn() },
}));
vi.mock("../../lib/observability/audit.server", () => ({
  auditReturnAction: vi.fn(),
}));
vi.mock("../../lib/observability/slo.server", () => ({
  annotateSLO: vi.fn(),
}));
vi.mock("../../lib/observability/request-context.server", () => ({
  setRequestContext: vi.fn(),
}));

import { action } from "../api.returns.$id.actions";

function mkJsonReq(body: unknown) {
  return new Request("https://app.example/api/returns/rc-1/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callAction(req: Request) {
  try {
    return await action({ request: req, params: { id: "rc-1" }, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function mkReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-1",
    shopId: "shop-1",
    status: "pending",
    returnRequestNo: "R-1",
    shopifyOrderName: "#1001",
    shopifyOrderId: "gid://shopify/Order/123",
    customerEmailNorm: "u@example.com",
    customerPhoneNorm: null as string | null,
    customerName: null as string | null,
    customerAddress1: null, customerAddress2: null, customerCity: null,
    customerProvince: null, customerZip: null, customerCountry: null, customerLandmark: null,
    adminNotes: null as string | null,
    rejectionReason: null as string | null,
    currency: "USD",
    refundStatus: null as string | null,
    fyndReturnId: null as string | null,
    fyndReturnNo: null as string | null,
    fyndShipmentId: null as string | null,
    fyndOrderId: null as string | null,
    fyndPayloadJson: null as string | null,
    fyndSyncStatus: null as string | null,
    isGreenReturn: false,
    cancellationRequestedAt: null as Date | null,
    cancellationReason: null as string | null,
    shopifyReturnId: null as string | null,
    createdAt: new Date("2025-01-01"),
    items: [],
    ...overrides,
  };
}

const defaultShop = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: {
    fyndApiType: "platform",
    fyndConsolidateReturns: false,
    fyndCredentials: "encrypted",
  } as Record<string, unknown>,
};

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok", email: "admin@x.com" },
    admin: { graphql: vi.fn() },
  });
  closeShopifyReturnMock.mockReset().mockResolvedValue({ ok: true });
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  createShopifyReturnMock.mockReset().mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/1" });
  createFyndClientOrErrorMock.mockReset();
  createReturnOnFyndMock.mockReset();
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
  sendRejectionNotificationMock.mockReset().mockResolvedValue(undefined);
  sendCancellationNotificationMock.mockReset().mockResolvedValue(undefined);
  sendCancellationDeclinedNotificationMock.mockReset().mockResolvedValue(undefined);
  Object.values(refundLoggerMock).forEach((fn) => (fn as { mockClear?: () => void }).mockClear?.());
});

// ────────────── reject ──────────────

describe('action: "reject"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue(defaultShop);
  });

  it("400 when return already in terminal state", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved" }));
    const res = await callAction(mkJsonReq({ action: "reject", rejectionReason: "dup" }));
    expect(res.status).toBe(400);
  });

  it("400 when rejectionReason empty", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(mkJsonReq({ action: "reject" }));
    expect(res.status).toBe(400);
  });

  it("400 when rejectionReason > 500 chars", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(mkJsonReq({ action: "reject", rejectionReason: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });

  it("happy path: updates status + calls Shopify decline + notifies customer", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    await callAction(mkJsonReq({ action: "reject", rejectionReason: "duplicate" }));
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "rejected", rejectionReason: "duplicate" }),
    }));
    expect(closeShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ action: "decline", declineReason: "duplicate" }),
    );
    expect(sendRejectionNotificationMock).toHaveBeenCalled();
  });

  it("swallows notification failure without failing the action", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    sendRejectionNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    const res = await callAction(mkJsonReq({ action: "reject", rejectionReason: "dup" }));
    expect(res.status).toBe(302);
    expect(refundLoggerMock.warn).toHaveBeenCalled();
  });

  it("skips notification when customer has no email", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ customerEmailNorm: null }));
    await callAction(mkJsonReq({ action: "reject", rejectionReason: "dup" }));
    expect(sendRejectionNotificationMock).not.toHaveBeenCalled();
  });
});

// ────────────── approve (consolidation + green) ──────────────

describe('action: "approve"', () => {
  it("400 when already in terminal state", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "completed" }));
    const res = await callAction(mkJsonReq({ action: "approve" }));
    expect(res.status).toBe(400);
  });

  it("consolidation mode: marks pending_consolidation + creates Shopify Return", async () => {
    const shopWithConsolidation = {
      ...defaultShop,
      settings: { ...defaultShop.settings, fyndConsolidateReturns: true },
    };
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithConsolidation);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      items: [{ shopifyLineItemId: "li-1", qty: 2, reasonCode: "size", notes: null, sku: null }],
    }));
    const res = await callAction(mkJsonReq({ action: "approve", resolutionType: "exchange" }));
    expect(res.status).toBe(302);
    // The URL should include consolidationQueued=1
    expect(res.headers.get("Location")).toContain("consolidationQueued=1");
    // Should have written fyndSyncStatus: pending_consolidation
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "approved",
        resolutionType: "exchange",
        fyndSyncStatus: "pending_consolidation",
      }),
    }));
    expect(createShopifyReturnMock).toHaveBeenCalled();
    expect(sendApprovalNotificationMock).toHaveBeenCalled();
  });

  it("consolidation mode + invalid resolutionType falls back to 'refund'", async () => {
    const shopWithConsolidation = {
      ...defaultShop,
      settings: { ...defaultShop.settings, fyndConsolidateReturns: true },
    };
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithConsolidation);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    await callAction(mkJsonReq({ action: "approve", resolutionType: "unknown_thing" }));
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ resolutionType: "refund" }),
    }));
  });

  it("consolidation mode: skips Shopify Return create for manual: orders", async () => {
    const shopWithConsolidation = {
      ...defaultShop,
      settings: { ...defaultShop.settings, fyndConsolidateReturns: true },
    };
    prismaMock.shop.findUnique.mockResolvedValueOnce(shopWithConsolidation);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ shopifyOrderId: "manual:abc" }));
    await callAction(mkJsonReq({ action: "approve" }));
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });
});

// ────────────── retry_fynd_sync ──────────────

describe('action: "retry_fynd_sync"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue(defaultShop);
  });

  it("400 when return not yet approved", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "pending" }));
    const res = await callAction(mkJsonReq({ action: "retry_fynd_sync" }));
    expect(res.status).toBe(400);
  });

  it("short-circuits (redirect) when already synced with no retry-eligible state", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", fyndReturnId: "FR-1", fyndSyncStatus: "synced",
    }));
    const res = await callAction(mkJsonReq({ action: "retry_fynd_sync" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("already_synced");
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("redirects with error when Fynd client creation fails", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved" }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "bad creds" });
    const res = await callAction(mkJsonReq({ action: "retry_fynd_sync" }));
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toMatch(/bad creds/);
  });

  it("redirects with error when client lacks Platform API", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved" }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: { /* no getShipments */ } });
    const res = await callAction(mkJsonReq({ action: "retry_fynd_sync" }));
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toMatch(/Platform API/);
  });

  it("updates to failed + emits event when createReturnOnFynd crashes", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved" }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("network down"));

    const res = await callAction(mkJsonReq({ action: "retry_fynd_sync" }));
    expect(res.status).toBe(302);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fyndSyncStatus: "failed" }),
    }));
  });
});

// ────────────── approve_cancellation ──────────────

describe('action: "approve_cancellation"', () => {
  it("400 when status not 'approved'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "pending", cancellationRequestedAt: new Date() }));
    const res = await callAction(mkJsonReq({ action: "approve_cancellation" }));
    expect(res.status).toBe(400);
  });

  it("400 when no cancellation request pending", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved", cancellationRequestedAt: null }));
    const res = await callAction(mkJsonReq({ action: "approve_cancellation" }));
    expect(res.status).toBe(400);
  });

  it("502 with local state intact when Shopify close fails (invariant: close-before-cancel)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", cancellationRequestedAt: new Date(),
    }));
    closeShopifyReturnMock.mockResolvedValueOnce({ ok: false, error: "still fulfilled" });

    const res = await callAction(mkJsonReq({ action: "approve_cancellation" }));
    expect(res.status).toBe(502);
    // Critical invariant: returnCase.update with status=cancelled must NOT have been called
    const updateCallsWithCancelled = prismaMock.returnCase.update.mock.calls.filter(
      (c) => c[0]?.data?.status === "cancelled",
    );
    expect(updateCallsWithCancelled.length).toBe(0);
  });

  it("happy path: closes on Shopify, marks cancelled, sends customer notification", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", cancellationRequestedAt: new Date(),
    }));

    const res = await callAction(mkJsonReq({ action: "approve_cancellation" }));
    expect(res.status).toBe(302);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "cancelled" },
    }));
    // Customer notification is fire-and-forget — give it a tick
    await new Promise((r) => setImmediate(r));
    expect(sendCancellationNotificationMock).toHaveBeenCalled();
  });

  it("best-effort Fynd cancel: continues even if Fynd cancel throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", cancellationRequestedAt: new Date(),
      fyndReturnId: "FR-1", fyndShipmentId: "SH-1",
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        updateShipmentStatus: vi.fn().mockRejectedValueOnce(new Error("fynd down")),
      },
    });

    const res = await callAction(mkJsonReq({ action: "approve_cancellation" }));
    // Still redirects (local cancel succeeded)
    expect(res.status).toBe(302);
    expect(refundLoggerMock.warn).toHaveBeenCalled();
  });
});

// ────────────── decline_cancellation ──────────────

describe('action: "decline_cancellation"', () => {
  it("400 when no pending cancellation to decline", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({ status: "approved", cancellationRequestedAt: null }));
    const res = await callAction(mkJsonReq({ action: "decline_cancellation" }));
    expect(res.status).toBe(400);
  });

  it("happy path: clears cancellationRequestedAt + records declined timestamp", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", cancellationRequestedAt: new Date(),
    }));

    const res = await callAction(mkJsonReq({ action: "decline_cancellation" }));
    expect(res.status).toBe(302);
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.cancellationRequestedAt).toBe(null);
    expect(data.cancellationDeclinedAt).toBeInstanceOf(Date);
    expect(data.cancellationDeclinedBy).toBe("admin@x.com");

    await new Promise((r) => setImmediate(r));
    expect(sendCancellationDeclinedNotificationMock).toHaveBeenCalled();
  });

  it("skips notification when customer has no email", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(defaultShop);
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase({
      status: "approved", cancellationRequestedAt: new Date(), customerEmailNorm: null,
    }));
    await callAction(mkJsonReq({ action: "decline_cancellation" }));
    await new Promise((r) => setImmediate(r));
    expect(sendCancellationDeclinedNotificationMock).not.toHaveBeenCalled();
  });
});
