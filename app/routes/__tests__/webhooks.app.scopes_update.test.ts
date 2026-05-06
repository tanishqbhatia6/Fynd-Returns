/**
 * Tests for webhooks.app.scopes_update.tsx — minimal handler that only
 * authenticates the webhook. Source does NOT wrap authenticate in try/catch,
 * so non-Response errors propagate (this is intentional — Shopify retries
 * are acceptable for a no-op handler).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authenticateWebhookMock } = vi.hoisted(() => ({
  authenticateWebhookMock: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

import { action } from "../webhooks.app.scopes_update";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  authenticateWebhookMock.mockReset();
});

describe("webhooks.app.scopes_update", () => {
  it("re-throws HMAC 401 Response from authenticate.webhook", async () => {
    const resp401 = new Response(null, { status: 401 });
    authenticateWebhookMock.mockRejectedValueOnce(resp401);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(
      resp401,
    );
  });

  it("propagates non-Response auth errors (no try/catch in source)", async () => {
    const err = new Error("auth backend down");
    authenticateWebhookMock.mockRejectedValueOnce(err);
    await expect(action({ request: mkReq(), params: {}, context: {} } as never)).rejects.toBe(err);
  });

  it("returns 200 on successful authenticate", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: {} });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 even when payload is missing", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "store.myshopify.com", payload: null });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns 200 even when shop is unknown (handler does not query DB)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({ shop: "missing.myshopify.com", payload: {} });
    const res = await action({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
