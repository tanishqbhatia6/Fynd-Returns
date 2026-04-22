/**
 * Integration tests for the Fynd webhook security gates added in Phase 1A:
 *
 *   1. Production REQUIRES FYND_WEBHOOK_SECRET (P0 — was previously opt-in).
 *   2. Payload size cap returns 413 instead of silently truncating (P1).
 *   3. Valid signature is accepted; invalid signature is rejected.
 *
 * These tests use the route's action() directly with a synthetic Request — no
 * HTTP server needed. Fully hermetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

// Stub the heavy webhook handler so we never reach Prisma — we're only testing
// the auth/signature/size gates here. The handler returns a fixed result.
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: vi.fn().mockResolvedValue({ ok: true, action: "test" }),
  unwrapFyndWebhookPayload: (raw: string) => ({
    payload: JSON.parse(raw),
    eventType: undefined,
  }),
}));

// Stub Prisma so dedup/error-log lookups don't try to hit a real DB.
vi.mock("../../db.server", () => ({
  default: {
    fyndWebhookLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
    },
  },
}));

// We dynamic-import the action AFTER setting NODE_ENV so the production gate
// behaviour is deterministic per test.
async function loadAction() {
  vi.resetModules();
  const mod = await import("../api.webhooks.fynd");
  return mod.action;
}

const validBody = JSON.stringify({
  shipment_id: "abc123",
  refund_status: "refund_done",
});

function signedHeaders(body: string, secret: string) {
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return new Headers({
    "content-type": "application/json",
    "x-fynd-signature": sig,
  });
}

describe("api.webhooks.fynd security", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("production fail-closed when FYND_WEBHOOK_SECRET is missing", () => {
    it("rejects (503) when secret is unset in production", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.FYND_WEBHOOK_SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toMatch(/FYND_WEBHOOK_SECRET/);
    });

    it("accepts when secret is unset in development (convenience for local testing)", async () => {
      process.env.NODE_ENV = "development";
      delete process.env.FYND_WEBHOOK_SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });
  });

  describe("signature verification when secret IS set", () => {
    it("accepts a webhook with a valid signature", async () => {
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = "test-secret-123";
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: signedHeaders(validBody, "test-secret-123"),
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });

    it("rejects (401) when signature header is missing", async () => {
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = "test-secret-123";
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });

    it("rejects (401) when signature does not match", async () => {
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = "test-secret-123";
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: signedHeaders(validBody, "WRONG-SECRET"),
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });
  });

  describe("payload size cap", () => {
    it("rejects (413) when content-length exceeds 1MB", async () => {
      process.env.NODE_ENV = "development"; // bypass signature gate to test size separately
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(2_000_000) },
        body: validBody, // actual body is small; we lie via content-length
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(413);
    });

    it("rejects (413) when actual body exceeds 1MB even if content-length is unset", async () => {
      process.env.NODE_ENV = "development";
      const action = await loadAction();
      // 1.5MB of pseudo-JSON
      const huge = JSON.stringify({ data: "x".repeat(1_500_000) });
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(413);
    });

    it("accepts a normal-sized webhook", async () => {
      process.env.NODE_ENV = "development";
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });
  });
});
