import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.returns.$id.actions route — dispatch + simple action types.
 *
 * The action handler is a 2,300-line multiplexer with ~14 action types.
 * This test covers:
 *  - method/ID/JSON validation
 *  - auth path (session resolution)
 *  - formData + JSON body parsing
 *  - The "simple" action types with low cyclomatic complexity:
 *    update_status, add_note, save_notes_for_customer, update_label,
 *    update_instructions, edit_details, cancel_order validation paths,
 *    unknown-action fallback
 *
 * The heavyweight action types (approve, process_refund, process_exchange,
 * approve/decline_cancellation) have their own business-logic-heavy tests
 * in separate files so this one stays focused on routing + basics.
 */

const {
  prismaMock,
  authenticateMock,
  closeShopifyReturnMock,
  withRestCredentialsMock,
  fetchOrderByOrderNumberMock,
  sendCustomerNoteNotificationMock,
  dispatchWebhookEventMock,
  setRequestContextMock,
  refundLoggerMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  fetchOrderByOrderNumberMock: vi.fn(),
  sendCustomerNoteNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  dispatchWebhookEventMock: vi.fn(),
  setRequestContextMock: vi.fn(),
  refundLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));

vi.mock("../../lib/shopify-admin.server", () => ({
  createRefund: vi.fn(),
  createShopifyReturn: vi.fn(),
  closeShopifyReturnBestEffort: closeShopifyReturnMock,
  fetchOrder: vi.fn(),
  fetchOrderByGid: vi.fn(),
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: vi.fn(),
  fetchOrderLineItemsOnly: vi.fn(),
  fetchOrderLineItemsByName: vi.fn(),
  withRestCredentials: withRestCredentialsMock,
}));

vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: vi.fn(),
}));
vi.mock("../../lib/notification.server", () => ({
  sendRejectionNotification: vi.fn(),
  sendApprovalNotification: vi.fn(),
  sendRefundNotification: vi.fn(),
  sendCustomerNoteNotification: sendCustomerNoteNotificationMock,
  sendCancellationNotification: vi.fn(),
  sendCancellationDeclinedNotification: vi.fn(),
}));
vi.mock("../../lib/webhook-dispatch.server", () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractShippingDetailsFromFyndPayload: vi.fn(() => ({})),
  isLikelyFyndId: vi.fn(() => false),
}));
vi.mock("../../lib/fynd-retry.server", () => ({
  scheduleRetry: vi.fn(),
}));

// Tracing helpers: execute the callback directly
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
  setRequestContext: setRequestContextMock,
}));

import { action } from "../api.returns.$id.actions";

function mkJsonReq(body: unknown, method: string = "POST") {
  const init: RequestInit = { method };
  // GET/HEAD can't have a body; skip it so Request() doesn't throw.
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/returns/rc-1/actions", init);
}

function mkFormReq(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
}

async function callAction(req: Request, id: string | null = "rc-1") {
  const params = id === null ? {} : { id };
  try {
    return await action({ request: req, params, context: {} } as never);
  } catch (thrown) {
    // The action throws a Response for redirects. Return it so tests can inspect.
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
    adminNotes: null as string | null,
    notesForCustomer: null as string | null,
    returnLabelUrl: null as string | null,
    returnLabelJson: null as string | null,
    currency: "USD",
    refundStatus: null as string | null,
    cancellationRequestedAt: null as Date | null,
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok", email: "admin@x.com" },
    admin: { graphql: vi.fn() },
  });
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  fetchOrderByOrderNumberMock.mockReset();
  sendCustomerNoteNotificationMock.mockReset().mockResolvedValue(undefined);
  dispatchWebhookEventMock.mockClear();
  setRequestContextMock.mockClear();
  Object.values(refundLoggerMock).forEach((fn) => (fn as { mockClear?: () => void }).mockClear?.());
});

// ────────────── Dispatcher / guards ──────────────

describe("method + id + body guards", () => {
  it("405 on non-POST method", async () => {
    const res = await callAction(mkJsonReq({ action: "add_note" }, "GET"));
    expect(res.status).toBe(405);
  });

  it("400 when id param missing", async () => {
    const res = await callAction(mkJsonReq({ action: "add_note" }), null);
    expect(res.status).toBe(400);
  });

  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await callAction(mkJsonReq({ action: "add_note" }));
    expect(res.status).toBe(404);
  });

  it("404 when return case not found for shop", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await callAction(mkJsonReq({ action: "add_note" }));
    expect(res.status).toBe(404);
  });

  it("400 when JSON body is malformed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{broken",
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
  });

  it("400 when action is unknown", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(mkJsonReq({ action: "nuke_database" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown action/);
  });

  it("parses action from multipart/form body (without JSON)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(mkFormReq({ action: "add_note", note: "from form" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminNotes: "from form" }),
      }),
    );
  });

  it("parses action from form with JSON field (json override)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(
      mkFormReq({ json: JSON.stringify({ action: "add_note", note: "from json field" }) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminNotes: "from json field" }),
      }),
    );
  });
});

// ────────────── update_status ──────────────

describe('action: "update_status"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("400 on invalid status value", async () => {
    const res = await callAction(mkJsonReq({ action: "update_status", status: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("updates + redirects on happy path", async () => {
    const res = await callAction(mkJsonReq({ action: "update_status", status: "processing" }));
    expect(res.status).toBe(302);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "processing" }),
      }),
    );
  });

  it("calls closeShopifyReturnBestEffort with 'close' when transitioning to completed", async () => {
    await callAction(mkJsonReq({ action: "update_status", status: "completed" }));
    expect(closeShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "close" }),
    );
  });

  it("calls closeShopifyReturnBestEffort with 'decline' when transitioning to rejected", async () => {
    await callAction(mkJsonReq({ action: "update_status", status: "rejected", note: "dup" }));
    expect(closeShopifyReturnMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "decline", declineReason: "dup" }),
    );
  });

  it("ignores update_status when no status supplied (falls through to unknown)", async () => {
    const res = await callAction(mkJsonReq({ action: "update_status" }));
    expect(res.status).toBe(400);
  });
});

// ────────────── add_note ──────────────

describe('action: "add_note"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("writes adminNotes + emits event", async () => {
    await callAction(mkJsonReq({ action: "add_note", note: "looked reasonable" }));
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { adminNotes: "looked reasonable" },
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "note_added" }),
      }),
    );
  });
});

// ────────────── save_notes_for_customer ──────────────

describe('action: "save_notes_for_customer"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("publishes note + sends email notification when customer has an email", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    await callAction(mkJsonReq({ action: "save_notes_for_customer", notesForCustomer: "Hello!" }));
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { notesForCustomer: "Hello!" },
      }),
    );
    // allow fire-and-forget notification to schedule
    await new Promise((r) => setImmediate(r));
    expect(sendCustomerNoteNotificationMock).toHaveBeenCalled();
  });

  it("skips notification when customer has no email", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ customerEmailNorm: null }),
    );
    await callAction(mkJsonReq({ action: "save_notes_for_customer", notesForCustomer: "Hello!" }));
    await new Promise((r) => setImmediate(r));
    expect(sendCustomerNoteNotificationMock).not.toHaveBeenCalled();
  });
});

// ────────────── update_label ──────────────

describe('action: "update_label"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("stores label JSON and URL", async () => {
    await callAction(
      mkJsonReq({
        action: "update_label",
        carrier: "DHL",
        trackingNumber: "TRK-1",
        labelUrl: "https://labels.example/1.pdf",
        qrCodeUrl: "https://qr.example/1",
      }),
    );
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.returnLabelUrl).toBe("https://labels.example/1.pdf");
    const parsed = JSON.parse(call.data.returnLabelJson);
    expect(parsed.carrier).toBe("DHL");
    expect(parsed.trackingNumber).toBe("TRK-1");
    expect(parsed.qrCodeUrl).toBe("https://qr.example/1");
  });

  it("stores null URL when labelUrl empty", async () => {
    await callAction(mkJsonReq({ action: "update_label", carrier: "UPS" }));
    const call = prismaMock.returnCase.update.mock.calls[0][0];
    expect(call.data.returnLabelUrl).toBe(null);
  });
});

// ────────────── update_instructions ──────────────

describe('action: "update_instructions"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("upserts defaultReturnInstructions on shop settings", async () => {
    await callAction(
      mkJsonReq({ action: "update_instructions", returnInstructions: "Bring receipt" }),
    );
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1" },
        create: expect.objectContaining({ defaultReturnInstructions: "Bring receipt" }),
        update: { defaultReturnInstructions: "Bring receipt" },
      }),
    );
  });
});

// ────────────── edit_details ──────────────

describe('action: "edit_details"', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("writes supplied address fields; clips to size limits", async () => {
    await callAction(
      mkJsonReq({
        action: "edit_details",
        customerAddress1: "   1 Infinite Loop   ",
        customerCity: "C".repeat(200),
        customerZip: "94105",
      }),
    );
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.customerAddress1).toBe("1 Infinite Loop");
    expect(data.customerCity?.length).toBe(100);
    expect(data.customerZip).toBe("94105");
  });
});

// ────────────── cancel_order validation paths ──────────────

describe('action: "cancel_order" — validation', () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
  });

  it("400 on invalid cancel reason", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    const res = await callAction(mkJsonReq({ action: "cancel_order", cancelReason: "because" }));
    expect(res.status).toBe(400);
  });

  it("400 when no valid Shopify order linked (manual: prefix)", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ shopifyOrderId: "manual:abc" }),
    );
    const res = await callAction(mkJsonReq({ action: "cancel_order" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no valid Shopify order/);
  });

  it("400 when numeric order id can't be resolved via fetchOrderByOrderNumber", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(
      mkReturnCase({ shopifyOrderId: "not-gid-or-numeric", shopifyOrderName: "" }),
    );
    fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
    const res = await callAction(mkJsonReq({ action: "cancel_order" }));
    expect(res.status).toBe(400);
  });
});

// ────────────── Session / request-context side-effects ──────────────

describe("session side-effects", () => {
  it("sets request context once after auth succeeds", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {},
    });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(mkReturnCase());
    await callAction(mkJsonReq({ action: "add_note", note: "n" }));
    expect(setRequestContextMock).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ shopDomain: "store.myshopify.com", shopId: "shop-1" }),
    );
  });
});
