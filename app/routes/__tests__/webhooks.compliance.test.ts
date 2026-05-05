/**
 * Tests for the 3 compliance/utility webhook handlers that were missing the
 * try-catch around `authenticate.webhook`:
 *   - webhooks.draft-orders.create.tsx
 *   - webhooks.shop.redact.tsx
 *   - webhooks.customers.data_request.tsx
 *
 * Each must:
 *   - re-throw HMAC 401 Responses (Shopify expects them)
 *   - swallow other authenticate-time errors so we don't trigger Shopify's
 *     retry storm against the topic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock, extractAffiliateOrderIdMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  extractAffiliateOrderIdMock: vi.fn(() => "FYNDX1"),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));

import { action as draftOrdersCreateAction } from "../webhooks.draft-orders.create";
import { action as shopRedactAction } from "../webhooks.shop.redact";
import { action as customersDataRequestAction } from "../webhooks.customers.data_request";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  extractAffiliateOrderIdMock.mockReset().mockReturnValue("FYNDX1");
});

describe("webhooks.draft-orders.create", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(
      draftOrdersCreateAction({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBe(resp401);
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    authenticateWebhookMock.mockRejectedValueOnce(new Error("DB unavailable during auth"));
    const res = await draftOrdersCreateAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 on missing payload", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: null });
    const res = await draftOrdersCreateAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 when affiliate id missing — no DB write", async () => {
    extractAffiliateOrderIdMock.mockReturnValueOnce(null as unknown as string);
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { id: 42, name: "#D-1", note_attributes: [] },
    });
    const res = await draftOrdersCreateAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 on shop not found, no upsert", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { id: 42, admin_graphql_api_id: "gid://shopify/DraftOrder/42", name: "#D-1", note_attributes: [{ name: "affiliate_order_id", value: "FYNDX1" }] },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await draftOrdersCreateAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.upsert).not.toHaveBeenCalled();
  });
});

describe("webhooks.shop.redact", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(
      shopRedactAction({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBe(resp401);
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    authenticateWebhookMock.mockRejectedValueOnce(new Error("session lookup failed"));
    const res = await shopRedactAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 when shop not found (no-op redact)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: { shop_id: 999 },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await shopRedactAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});

describe("webhooks.customers.data_request", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(
      customersDataRequestAction({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBe(resp401);
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    authenticateWebhookMock.mockRejectedValueOnce(new Error("auth backend down"));
    const res = await customersDataRequestAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("does NOT log raw customer email (PII)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      authenticateWebhookMock.mockResolvedValueOnce({
        shop: "store.myshopify.com",
        payload: { customer: { id: 123, email: "secret@user.com" } },
      });
      prismaMock.shop.findUnique.mockResolvedValueOnce(null);
      await customersDataRequestAction({ request: mkReq(), params: {}, context: {} } as never);

      const allLogs = logSpy.mock.calls.flat().join(" ");
      expect(allLogs).not.toContain("secret@user.com");
      expect(allLogs).toContain("[present]");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("returns 200 even when shop not found", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: { customer: { id: 123 } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await customersDataRequestAction({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
