/**
 * Tests for webhooks.orders.updated.tsx — guarded webhook pattern.
 *
 * Each must:
 *   - re-throw HMAC 401 Responses (Shopify expects them)
 *   - swallow other authenticate-time errors so we return 200
 *   - return 200 on missing payload / shop not found edge cases
 *   - take the fast-path bail-out for boring edits (no DB hit)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateWebhookMock,
  shopifyModuleMock,
  extractAffiliateOrderIdMock,
  normalizeSourceChannelMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  extractAffiliateOrderIdMock: vi.fn(),
  normalizeSourceChannelMock: vi.fn(() => null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  extractAffiliateOrderId: extractAffiliateOrderIdMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));

import { action } from "../webhooks.orders.updated";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  extractAffiliateOrderIdMock.mockReset();
  normalizeSourceChannelMock.mockReset().mockReturnValue(null);
});

describe("webhooks.orders.updated", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(
      action({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBe(resp401);
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    authenticateWebhookMock.mockRejectedValueOnce(new Error("auth network down"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 on missing payload", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: null,
    });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("fast-path: returns 200 with no DB hit when nothing meaningful changed", async () => {
    // No fynd id, no cancellation, no source channel — handler should bail
    // before touching the DB.
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#1001",
        note_attributes: [],
        financial_status: "paid",
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.findUnique).not.toHaveBeenCalled();
  });

  it("returns 200 on shop not found, no upsert / no cancel", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "missing.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/Order/1",
        name: "#1001",
        note_attributes: [{ name: "fynd_order_id", value: "F-1" }],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce("F-1");
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.fyndOrderMapping.upsert).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors during processing and still returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        name: "#1001",
        cancelled_at: "2026-01-01T00:00:00Z",
        note_attributes: [],
      },
    });
    extractAffiliateOrderIdMock.mockReturnValueOnce(null);
    normalizeSourceChannelMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db blew up"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
