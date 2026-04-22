/**
 * Tests for the per-shop webhook verification helpers.
 *
 * Pins:
 *  - Signature verification accepts both `<hex>` and `sha256=<hex>` formats
 *  - Mismatched secret rejected
 *  - Missing header rejected
 *  - Length-mismatched signature rejected (no buffer-overrun)
 *  - generateWebhookSecret produces 64-hex-char strings unique per call
 *  - readBoundedBody enforces the 1MB cap
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyWebhookSignature,
  generateWebhookSecret,
  readBoundedBody,
  MAX_WEBHOOK_BYTES,
} from "../fynd-webhook-verify.server";

const SECRET = "test-secret-32-bytes-long-string";
const ALT_SECRET = "different-secret-also-32-byteslongx";

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ shipment_id: "abc", status: "refund_done" });

  it("accepts a correct signature in raw hex format", () => {
    const sig = sign(body, SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("accepts a correct signature with `sha256=` prefix", () => {
    const sig = `sha256=${sign(body, SECRET)}`;
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a signature signed with a different secret", () => {
    const sig = sign(body, ALT_SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects when header is null/undefined", () => {
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects malformed (non-hex) signature without throwing", () => {
    expect(() => verifyWebhookSignature(body, "not-hex!!", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "not-hex!!", SECRET)).toBe(false);
  });

  it("rejects a length-mismatched signature (timing-safe compare guard)", () => {
    expect(verifyWebhookSignature(body, "deadbeef", SECRET)).toBe(false);
  });

  it("rejects when the body has been tampered with (one byte different)", () => {
    const sig = sign(body, SECRET);
    expect(verifyWebhookSignature(body + "x", sig, SECRET)).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("returns 64 hex characters (32 bytes of entropy)", () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on each call", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
  });
});

describe("readBoundedBody", () => {
  it("accepts a normal-sized body", async () => {
    const req = new Request("http://x/", { method: "POST", body: '{"ok":true}' });
    const result = await readBoundedBody(req);
    expect("body" in result).toBe(true);
    if ("body" in result) expect(result.body).toBe('{"ok":true}');
  });

  it("rejects (413) when content-length exceeds 1MB", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
      body: "{}",
    });
    const result = await readBoundedBody(req);
    expect("rejected" in result).toBe(true);
    if ("rejected" in result) expect(result.rejected.status).toBe(413);
  });

  it("rejects (413) when actual body exceeds 1MB even without content-length", async () => {
    const huge = JSON.stringify({ data: "x".repeat(MAX_WEBHOOK_BYTES + 100) });
    const req = new Request("http://x/", { method: "POST", body: huge });
    const result = await readBoundedBody(req);
    expect("rejected" in result).toBe(true);
    if ("rejected" in result) expect(result.rejected.status).toBe(413);
  });
});
