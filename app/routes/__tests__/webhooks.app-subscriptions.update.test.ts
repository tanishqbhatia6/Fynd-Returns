/**
 * Tests for webhooks.app-subscriptions.update.tsx — guarded webhook pattern.
 *
 * Each must:
 *   - re-throw HMAC 401 Responses (Shopify expects them)
 *   - swallow other authenticate-time errors so we return 200
 *   - return 200 on missing payload / shop not found edge cases
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock, shopifyModuleMock, fetchSubscriptionSnapshotMock } =
  vi.hoisted(() => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateWebhookMock: vi.fn(),
    shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
    fetchSubscriptionSnapshotMock: vi.fn(),
  }));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/billing.server", () => ({
  fetchSubscriptionSnapshot: fetchSubscriptionSnapshotMock,
}));

import { action } from "../webhooks.app-subscriptions.update";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
  shopifyModuleMock.unauthenticated.admin.mockReset();
  fetchSubscriptionSnapshotMock.mockReset();
});

describe("webhooks.app-subscriptions.update", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(
      resp401,
    );
  });

  it("swallows non-Response auth errors and returns 200", async () => {
    authenticateWebhookMock.mockRejectedValueOnce(new Error("auth network down"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 on shop not found, no settings update", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "missing.myshopify.com" });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: {} });
    fetchSubscriptionSnapshotMock.mockResolvedValueOnce({ status: "ACTIVE", name: "Pro" });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("returns 200 when shop has no settings row, no settings update", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com" });
    shopifyModuleMock.unauthenticated.admin.mockResolvedValueOnce({ admin: {} });
    fetchSubscriptionSnapshotMock.mockResolvedValueOnce({ status: "ACTIVE", name: "Pro" });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("swallows admin init failure and returns 200", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com" });
    shopifyModuleMock.unauthenticated.admin.mockRejectedValueOnce(new Error("no offline session"));
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
