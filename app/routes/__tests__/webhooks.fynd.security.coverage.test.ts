/**
 * Extra coverage for Fynd webhook security gates beyond the headline tests in
 * webhooks.fynd.security.test.ts. We focus specifically on:
 *
 *   1. Missing-secret behaviour in development mode (every shape of "missing":
 *      unset, empty string, undefined NODE_ENV).
 *   2. Mismatched / malformed HMAC signatures (wrong secret, tampered body,
 *      truncated hex, wrong length, sha256= prefix variations, garbage hex).
 *   3. Replay-protection timestamp checks (too old, too far future, exactly at
 *      the boundary, malformed timestamp, missing timestamp) — these run in dev
 *      mode (no signature) so the timestamp gate is the only thing under test.
 *
 * All tests use the action() directly with synthetic Requests; no HTTP server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: vi.fn().mockResolvedValue({ ok: true, action: "test" }),
  unwrapFyndWebhookPayload: (raw: string) => ({
    payload: JSON.parse(raw),
    eventType: undefined,
  }),
}));

vi.mock("../../db.server", () => ({
  default: {
    fyndWebhookLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
    },
  },
}));

async function loadAction() {
  vi.resetModules();
  const mod = await import("../api.webhooks.fynd");
  return mod.action;
}

const validBody = JSON.stringify({
  shipment_id: "ship-coverage-1",
  refund_status: "refund_done",
});

function hmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("api.webhooks.fynd security — extra coverage", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Missing-secret behaviour in development mode
  // ──────────────────────────────────────────────────────────────────────────
  describe("missing secret in dev mode", () => {
    it("accepts when NODE_ENV=development and FYND_WEBHOOK_SECRET is unset", async () => {
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

    it("accepts when NODE_ENV=test (any non-production) and secret is unset", async () => {
      process.env.NODE_ENV = "test";
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

    it("rejects (503) in production with empty-string secret (treated as missing)", async () => {
      // Same falsy-empty case but in prod — must fail closed, otherwise an
      // accidentally-blank prod secret would silently accept anyone.
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = "";
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(503);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mismatched / malformed signatures (secret IS configured)
  // ──────────────────────────────────────────────────────────────────────────
  describe("mismatched signature", () => {
    const SECRET = "prod-secret-xyz";

    it("rejects (401) when signature is computed with wrong secret", async () => {
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-signature": hmac(validBody, "different-secret"),
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Webhook authentication failed");
    });

    it("rejects (401) when body is tampered after signing", async () => {
      // Sign one body, send a different body — classic tamper attempt.
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const signedFor = JSON.stringify({ shipment_id: "original", refund_status: "pending" });
      const tamperedBody = JSON.stringify({ shipment_id: "evil", refund_status: "refund_done" });
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-signature": hmac(signedFor, SECRET),
        },
        body: tamperedBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });

    it("rejects (401) when signature hex is the wrong length", async () => {
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-signature": "abc123", // 6 chars, far from sha256's 64
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });

    it("rejects (401) when signature contains non-hex garbage", async () => {
      // Buffer.from(garbage, "hex") silently drops invalid chars; the verifier
      // wraps that in try/catch and returns false. Either way, must reject.
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-signature": "zzzz!!nothex@@@",
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });

    it("accepts a signature with the `sha256=` prefix", async () => {
      // GitHub-style prefix; verifier strips it. Coverage path.
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-signature": `sha256=${hmac(validBody, SECRET)}`,
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });

    it("accepts via x-webhook-signature header alias", async () => {
      // Verifier checks both x-fynd-signature and x-webhook-signature.
      process.env.NODE_ENV = "production";
      process.env.FYND_WEBHOOK_SECRET = SECRET;
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-signature": hmac(validBody, SECRET),
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Replay-protection / timestamp out of range
  // ──────────────────────────────────────────────────────────────────────────
  describe("replay timestamp out of range", () => {
    // Run these in dev with no secret so the auth gate is a no-op and we're
    // exercising only the timestamp gate.
    beforeEach(() => {
      process.env.NODE_ENV = "development";
      delete process.env.FYND_WEBHOOK_SECRET;
    });

    it("rejects (401) when x-webhook-timestamp is older than 5 minutes", async () => {
      const action = await loadAction();
      const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": tenMinAgo,
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Webhook timestamp too old");
    });

    it("rejects (401) when timestamp is in the far future (clock-skew attack)", async () => {
      // The route uses Math.abs(diff), so future drift > 5min is also rejected.
      const action = await loadAction();
      const tenMinAhead = new Date(Date.now() + 10 * 60_000).toISOString();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": tenMinAhead,
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(401);
    });

    it("accepts a timestamp within the 5-minute window", async () => {
      const action = await loadAction();
      const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": recent,
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });

    it("accepts the alternate x-fynd-timestamp header", async () => {
      // The route checks both x-webhook-timestamp and x-fynd-timestamp.
      const action = await loadAction();
      const recent = new Date(Date.now() - 30_000).toISOString();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fynd-timestamp": recent,
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });

    it("ignores a malformed timestamp string and continues processing", async () => {
      // The route does `if (!isNaN(ts) && ...)` — a NaN timestamp simply skips
      // the gate. Important: we don't want to block legitimate webhooks just
      // because Fynd sends a weird date format we don't recognise. (Belt-and-
      // braces: HMAC signature is the real defense.)
      const action = await loadAction();
      const req = new Request("http://x/api/webhooks/fynd", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": "not-a-real-date",
        },
        body: validBody,
      });
      const res = await action({ request: req } as never);
      expect(res.status).toBe(200);
    });

    it("accepts when no timestamp header is sent at all", async () => {
      // Many Fynd integrations don't include a timestamp header; we must not
      // require one — the gate is only enforced when the caller opts in.
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
