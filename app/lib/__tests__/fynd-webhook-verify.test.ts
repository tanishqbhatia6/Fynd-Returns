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
 *  - Shared-secret header auth (Fynd Commerce path) accepts the secret in
 *    every documented header position and rejects on mismatch / missing
 *  - HMAC fallback continues to work alongside shared-secret auth
 *  - timingSafeEqualString handles unequal lengths without throwing
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyWebhookSignature,
  generateWebhookSecret,
  readBoundedBody,
  MAX_WEBHOOK_BYTES,
  authenticateWebhook,
  extractSecretCandidates,
  timingSafeEqualString,
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

describe("timingSafeEqualString", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualString(SECRET, SECRET)).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(timingSafeEqualString("abcdef", "abcdeg")).toBe(false);
  });

  it("returns false for strings of different lengths without throwing", () => {
    expect(() => timingSafeEqualString("short", "longer-string")).not.toThrow();
    expect(timingSafeEqualString("short", "longer-string")).toBe(false);
  });

  it("returns false when one side is empty", () => {
    expect(timingSafeEqualString("", "x")).toBe(false);
    expect(timingSafeEqualString("x", "")).toBe(false);
  });

  it("returns true for both empty (degenerate but defined)", () => {
    expect(timingSafeEqualString("", "")).toBe(true);
  });
});

describe("extractSecretCandidates", () => {
  function reqWithHeader(name: string, value: string) {
    return new Request("http://x/", { method: "POST", headers: { [name]: value } });
  }

  it.each([
    ["x-shop-secret", "tok-shop"],
    ["x-webhook-secret", "tok-wh"],
    ["x-fynd-secret", "tok-fynd"],
  ])("extracts the secret from %s", (header, value) => {
    const cands = extractSecretCandidates(reqWithHeader(header, value));
    expect(cands).toContain(value);
  });

  it("strips a single Bearer prefix from Authorization", () => {
    const cands = extractSecretCandidates(reqWithHeader("authorization", "Bearer abcdef"));
    expect(cands).toContain("abcdef");
  });

  it("also accepts a bare Authorization value (no Bearer prefix)", () => {
    const cands = extractSecretCandidates(reqWithHeader("authorization", "abcdef"));
    expect(cands).toContain("abcdef");
  });

  it("returns empty array when no auth headers are present", () => {
    const req = new Request("http://x/", { method: "POST" });
    expect(extractSecretCandidates(req)).toEqual([]);
  });

  it("trims whitespace from header values", () => {
    const cands = extractSecretCandidates(reqWithHeader("x-shop-secret", "  padded  "));
    expect(cands).toContain("padded");
  });

  it("ignores empty/whitespace-only header values", () => {
    const cands = extractSecretCandidates(reqWithHeader("x-shop-secret", "   "));
    expect(cands).toEqual([]);
  });
});

describe("authenticateWebhook (shared-secret + HMAC fallback)", () => {
  const body = JSON.stringify({ shipment_id: "abc", refund_status: "refund_done" });

  function makeReq(headers: Record<string, string>) {
    return new Request("http://x/", { method: "POST", headers });
  }

  it("accepts the secret in X-Shop-Secret (Custom Header path)", () => {
    const r = authenticateWebhook(makeReq({ "x-shop-secret": SECRET }), body, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("shared_secret");
  });

  it("accepts the secret in X-Webhook-Secret", () => {
    const r = authenticateWebhook(makeReq({ "x-webhook-secret": SECRET }), body, SECRET);
    expect(r.ok).toBe(true);
  });

  it("accepts the secret in X-Fynd-Secret", () => {
    const r = authenticateWebhook(makeReq({ "x-fynd-secret": SECRET }), body, SECRET);
    expect(r.ok).toBe(true);
  });

  it("accepts the secret in Authorization with Bearer prefix", () => {
    const r = authenticateWebhook(makeReq({ authorization: `Bearer ${SECRET}` }), body, SECRET);
    expect(r.ok).toBe(true);
  });

  it("accepts the secret in Authorization without Bearer prefix", () => {
    const r = authenticateWebhook(makeReq({ authorization: SECRET }), body, SECRET);
    expect(r.ok).toBe(true);
  });

  it("falls back to HMAC signature when no shared-secret header is present", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    const r = authenticateWebhook(makeReq({ "x-fynd-signature": sig }), body, SECRET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("hmac");
  });

  it("rejects when no auth header at all is present (specific reason)", () => {
    const r = authenticateWebhook(makeReq({}), body, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no auth header/i);
  });

  it("rejects when shared-secret header value does not match", () => {
    const r = authenticateWebhook(makeReq({ "x-shop-secret": "wrong-token" }), body, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mismatch/i);
  });

  it("rejects when HMAC signature is wrong", () => {
    const wrongSig = crypto.createHmac("sha256", "different-secret").update(body).digest("hex");
    const r = authenticateWebhook(makeReq({ "x-fynd-signature": wrongSig }), body, SECRET);
    expect(r.ok).toBe(false);
  });

  it("rejects when body is tampered (HMAC path)", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    const r = authenticateWebhook(makeReq({ "x-fynd-signature": sig }), body + "X", SECRET);
    expect(r.ok).toBe(false);
  });

  it("does NOT leak which shared-secret position was tried (constant reason)", () => {
    // Same reason whether we got the wrong value in X-Shop-Secret or in
    // Authorization — don't help an attacker enumerate which header you check.
    const a = authenticateWebhook(makeReq({ "x-shop-secret": "bad" }), body, SECRET);
    const b = authenticateWebhook(makeReq({ authorization: "Bearer bad" }), body, SECRET);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok && !b.ok) expect(a.reason).toBe(b.reason);
  });

  it("when both shared-secret AND HMAC are present, either correct one wins", () => {
    // Realistic scenario: a merchant's clients sometimes layer auth — if the
    // shared secret is right but the HMAC is wrong, the request is still
    // authentic (and vice versa). Don't require both.
    const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    const r1 = authenticateWebhook(
      makeReq({ "x-shop-secret": SECRET, "x-fynd-signature": "garbage" }),
      body,
      SECRET,
    );
    expect(r1.ok).toBe(true);

    const r2 = authenticateWebhook(
      makeReq({ "x-shop-secret": "wrong", "x-fynd-signature": sig }),
      body,
      SECRET,
    );
    expect(r2.ok).toBe(true);
  });

  it("rejects empty string secret in any header", () => {
    const r = authenticateWebhook(makeReq({ "x-shop-secret": "" }), body, SECRET);
    expect(r.ok).toBe(false);
  });

  it("is case-insensitive on header NAMES (HTTP standard) but case-sensitive on VALUES", () => {
    // Headers names are case-insensitive per RFC 7230 — fetch's Headers
    // normalises them, so we check the normalised access path works.
    const upper = new Request("http://x/", {
      method: "POST",
      headers: { "X-SHOP-SECRET": SECRET },
    });
    const r = authenticateWebhook(upper, body, SECRET);
    expect(r.ok).toBe(true);

    // Values are case-sensitive — mismatched casing should fail.
    const wrongCase = authenticateWebhook(
      makeReq({ "x-shop-secret": SECRET.toUpperCase() }),
      body,
      SECRET,
    );
    expect(wrongCase.ok).toBe(false);
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
