import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * api.returns.$id.actions route — coverage gaps test file.
 *
 * Targets uncovered code paths in the action handler not exercised
 * by api.returns.id.actions.test.ts or api.returns.id.actions.big.test.ts:
 *
 *  - 405 method-not-allowed for HTTP verbs other than POST (PUT/DELETE/PATCH)
 *  - 400 missing id (params.id absent / undefined)
 *  - formData (non-JSON) body parsing variations:
 *      • application/x-www-form-urlencoded
 *      • formData with malformed JSON in `json` field falling back to action field
 *      • formData with no action and no json field (defaults to "unknown")
 *      • formData address fields propagating into body (edit_details path)
 *  - invalid JSON edge cases (truncated, empty body, wrong shape)
 *  - unknown action types (404 path occurs before unknown — verify reachable + body shape)
 */

const {
  prismaMock,
  authenticateMock,
  closeShopifyReturnMock,
  withRestCredentialsMock,
  refundLoggerMock,
  setRequestContextMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  closeShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
  refundLoggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRequestContextMock: vi.fn(),
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
  fetchOrderByOrderNumber: vi.fn(),
  fetchOrderByFyndAffiliateId: vi.fn(),
  fetchOrderLineItemsOnly: vi.fn(),
  fetchOrderLineItemsByName: vi.fn(),
  withRestCredentials: withRestCredentialsMock,
  fetchVariantInfo: vi.fn(),
  sendDraftOrderInvoice: vi.fn(),
}));

vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
}));
vi.mock("../../lib/fynd-returns.server", () => ({
  createReturnOnFynd: vi.fn(),
}));
vi.mock("../../lib/notification.server", () => ({
  sendRejectionNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendApprovalNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRefundNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCustomerNoteNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCancellationNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCancellationDeclinedNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
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
  setRequestContext: setRequestContextMock,
}));
vi.mock("../../lib/return-action-errors.server", () => ({
  enrichFyndError: vi.fn((e: unknown) => e),
  classifyFyndError: vi.fn(() => "unknown"),
  enrichRefundError: vi.fn((e: unknown) => e),
  isRedirectResponse: vi.fn(() => false),
  extractErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

import { action } from "../api.returns.$id.actions";

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

async function callAction(req: Request, id: string | null = "rc-1") {
  const params = id === null ? {} : { id };
  try {
    return await action({ request: req, params, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function callActionRaw(req: Request, params: Record<string, unknown>) {
  try {
    return await action({ request: req, params, context: {} } as never);
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok", email: "admin@x.com" },
    admin: { graphql: vi.fn() },
  });
  closeShopifyReturnMock.mockReset().mockResolvedValue(undefined);
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
  setRequestContextMock.mockClear();
  Object.values(refundLoggerMock).forEach((fn) => (fn as { mockClear?: () => void }).mockClear?.());
});

// ────────────── 405 method-not-allowed (multiple verbs) ──────────────

describe("405 method not allowed — exhaustive verb coverage", () => {
  it("405 on PUT", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "PUT" });
    const res = await callAction(req);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });

  it("405 on DELETE", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "DELETE" });
    const res = await callAction(req);
    expect(res.status).toBe(405);
  });

  it("405 on PATCH", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "PATCH" });
    const res = await callAction(req);
    expect(res.status).toBe(405);
  });

  it("405 short-circuits before authenticate is ever called", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "GET" });
    await callAction(req);
    expect(authenticateMock).not.toHaveBeenCalled();
  });
});

// ────────────── 400 missing id ──────────────

describe("400 missing id param", () => {
  it("400 when params.id is undefined explicitly", async () => {
    const req = new Request("https://app.example/api/returns//actions", { method: "POST", body: JSON.stringify({ action: "add_note" }), headers: { "Content-Type": "application/json" } });
    const res = await callActionRaw(req, { id: undefined });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Return ID required");
  });

  it("400 missing id short-circuits before authenticate", async () => {
    const req = new Request("https://app.example/api/returns//actions", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    await callAction(req, null);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it("400 missing id returns JSON shape with error key", async () => {
    const req = new Request("https://app.example/api/returns//actions", { method: "POST" });
    const res = await callAction(req, null);
    const body = await res.json();
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("string");
  });
});

// ────────────── formData (non-JSON) body parsing ──────────────

describe("formData body parsing — non-JSON variants", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com", settings: {} });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("parses application/x-www-form-urlencoded body", async () => {
    const params = new URLSearchParams();
    params.set("action", "add_note");
    params.set("note", "urlencoded note");
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    await callAction(req);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ adminNotes: "urlencoded note" }),
    }));
  });

  it("falls back to action field when json field has malformed JSON", async () => {
    const fd = new FormData();
    fd.set("json", "{not-valid-json");
    fd.set("action", "add_note");
    fd.set("note", "fallback note");
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
    await callAction(req);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ adminNotes: "fallback note" }),
    }));
  });

  it("returns 400 unknown when formData has no action and no json fields", async () => {
    const fd = new FormData();
    fd.set("note", "orphan");
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown action/);
  });

  it("propagates formData address fields into edit_details body", async () => {
    const fd = new FormData();
    fd.set("action", "edit_details");
    fd.set("customerAddress1", "100 Main St");
    fd.set("customerCity", "Anytown");
    fd.set("customerZip", "12345");
    fd.set("customerCountry", "US");
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
    await callAction(req);
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.customerAddress1).toBe("100 Main St");
    expect(data.customerCity).toBe("Anytown");
    expect(data.customerZip).toBe("12345");
    expect(data.customerCountry).toBe("US");
  });

  it("formData notesForCustomer field propagates to body", async () => {
    const fd = new FormData();
    fd.set("action", "save_notes_for_customer");
    fd.set("notesForCustomer", "form-supplied note");
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
    await callAction(req);
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { notesForCustomer: "form-supplied note" },
    }));
  });

  it("formData rejectionReason field propagates to reject action", async () => {
    const fd = new FormData();
    fd.set("action", "reject");
    fd.set("rejectionReason", "outside policy window");
    const req = new Request("https://app.example/api/returns/rc-1/actions", { method: "POST", body: fd });
    await callAction(req);
    // reject handler should have been invoked — verify by ensuring an update occurred
    // (handler implementation may vary; minimally confirm we did not 400 with unknown)
    expect(prismaMock.returnCase.update).toHaveBeenCalled();
  });
});

// ────────────── invalid JSON edge cases ──────────────

describe("invalid JSON parsing", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com", settings: {} });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("400 on truncated JSON body with application/json content-type", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"action":"add_no',
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("400 on empty body with application/json content-type", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });

  it("400 on JSON content-type with arbitrary garbage", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json at all",
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
  });

  it("application/json with vendor suffix still triggers JSON parse path (and fails on bad JSON)", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: "{",
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid JSON");
  });
});

// ────────────── unknown action type ──────────────

describe("unknown action type fallback", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com", settings: {} });
    prismaMock.returnCase.findFirst.mockResolvedValue(mkReturnCase());
  });

  it("400 with 'Unknown action' for misspelled action", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "aprrove" }),
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown action/);
  });

  it("400 when action is empty string", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "" }),
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
  });

  it("400 when action key missing entirely from JSON body", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "no action key" }),
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown action/);
  });

  it("update_status without status param falls through to unknown action", async () => {
    const req = new Request("https://app.example/api/returns/rc-1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_status" }),
    });
    const res = await callAction(req);
    expect(res.status).toBe(400);
  });
});
