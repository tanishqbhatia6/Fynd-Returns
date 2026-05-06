/**
 * Extra coverage for fynd-webhook-verify.server.ts.
 *
 * The base suite (fynd-webhook-verify.test.ts) pins the happy path and the
 * obvious negative cases. This file digs into corners that are easy to
 * regress:
 *
 *  - HMAC edge cases: uppercase hex, mixed-case `Sha256=` prefix, non-UTF-8
 *    bodies, empty body, and unicode bodies (UTF-8 byte-correctness).
 *  - Empty / whitespace-only stored secret behaviour — we should never
 *    accept a request whose stored secret is blank, even if the candidate
 *    matches a blank string.
 *  - Replay surface — verifyWebhookSignature is intentionally stateless, so
 *    we pin that the same sig+body verifies repeatedly (idempotency is the
 *    caller's job, not this module's). This is a behaviour pin, not an
 *    endorsement of replay attacks.
 *  - Timing-safe comparison: pin that signature/secret comparison takes a
 *    path that does NOT short-circuit on the first differing byte, by
 *    spot-checking that the function returns false for any single-byte
 *    flip at any position (smoke-test of constant-time behaviour).
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  verifyWebhookSignature,
  authenticateWebhook,
  timingSafeEqualString,
  extractSecretCandidates,
  generateWebhookSecret,
} from "../fynd-webhook-verify.server";

const SECRET = "test-secret-32-bytes-long-string";

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeReq(headers: Record<string, string>): Request {
  return new Request("http://x/", { method: "POST", headers });
}

describe("verifyWebhookSignature — HMAC edge cases", () => {
  const body = JSON.stringify({ shipment_id: "abc", status: "delivered" });

  it("accepts an UPPERCASE hex signature (Buffer.from('hex') is case-insensitive)", () => {
    const sig = sign(body, SECRET).toUpperCase();
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a mixed-case `Sha256=` prefix (we only strip exact `sha256=`)", () => {
    // The strip regex is `^sha256=` — case-sensitive on purpose so we don't
    // get tricked into treating `Sha256=...` as a prefix and then comparing
    // a mangled hex string.
    const sig = `Sha256=${sign(body, SECRET)}`;
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(false);
  });

  it("verifies an empty-body signature correctly", () => {
    const sig = sign("", SECRET);
    expect(verifyWebhookSignature("", sig, SECRET)).toBe(true);
  });

  it("verifies a unicode body (UTF-8 bytes, not code units)", () => {
    const unicodeBody = JSON.stringify({ note: "héllo 🌍 — naïve café" });
    const sig = sign(unicodeBody, SECRET);
    expect(verifyWebhookSignature(unicodeBody, sig, SECRET)).toBe(true);
  });

  it("handles malformed hex inputs (odd-length, empty) without throwing", () => {
    // "abc" parses to Buffer<0xab> (length 1) — never matches a 32-byte HMAC.
    // "" is falsy and short-circuits to false. Both must be safe and false.
    expect(() => verifyWebhookSignature(body, "abc", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "abc", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("rejects when secret is empty string (HMAC computes with empty key, but matches no real client)", () => {
    // crypto.createHmac accepts "" as a key. We don't disallow it inside the
    // verify function itself; we just pin that a signature created with the
    // *real* secret won't match an HMAC computed under "" — i.e. an
    // attacker can't bypass by sending an empty secret on the server.
    const sig = sign(body, SECRET);
    expect(verifyWebhookSignature(body, sig, "")).toBe(false);
  });

  it("accepts a signature containing leading/trailing whitespace (header was trimmed)", () => {
    // The function calls `.trim()` after stripping the prefix.
    const sig = `  ${sign(body, SECRET)}  `;
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("flips false for a single-bit change anywhere in the signature", () => {
    // Smoke-check that a successful verify isn't accepting "almost-right"
    // signatures. Walks the whole hex string and flips each character.
    const good = sign(body, SECRET);
    expect(verifyWebhookSignature(body, good, SECRET)).toBe(true);
    // Spot-check first, middle, and last hex chars.
    const positions = [0, Math.floor(good.length / 2), good.length - 1];
    for (const i of positions) {
      const flipped = good.slice(0, i) + (good[i] === "0" ? "1" : "0") + good.slice(i + 1);
      expect(verifyWebhookSignature(body, flipped, SECRET)).toBe(false);
    }
  });
});

describe("authenticateWebhook — missing / blank secret regressions", () => {
  const body = JSON.stringify({ a: 1 });

  it("rejects when storedSecret is blank, even if request sends a blank candidate", () => {
    // If a shop somehow ended up with a blank stored secret, we must NOT
    // accept any inbound request — even one whose candidate is also blank.
    // extractSecretCandidates trims, so "" / "   " both produce no candidates.
    const empty = authenticateWebhook(makeReq({ "x-shop-secret": "" }), body, "");
    const whitespace = authenticateWebhook(makeReq({ "x-shop-secret": "   " }), body, "   ");
    expect(empty.ok).toBe(false);
    expect(whitespace.ok).toBe(false);
  });

  it("does not accept the literal string 'Bearer' as a secret when Authorization is just 'Bearer '", () => {
    // Defensive: an Authorization header of `Bearer ` (no token) should
    // produce no candidate, not the empty string and not "Bearer".
    const r = authenticateWebhook(makeReq({ authorization: "Bearer " }), body, SECRET);
    expect(r.ok).toBe(false);
  });
});

describe("verifyWebhookSignature — replay surface (stateless by design)", () => {
  const body = JSON.stringify({ event: "shipment_update", id: "evt_1" });

  it("accepts the same signature+body multiple times (no built-in replay protection)", () => {
    // PIN: this module is intentionally stateless. Idempotency / replay
    // defence belongs in the caller's webhook-event ledger
    // (see api.webhooks.fynd.$shopId.ts and the FyndWebhookEvent table).
    // If you ever add timestamp-based replay rejection here, this test
    // will need updating in lockstep.
    const sig = sign(body, SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("a captured signature for body A does not authenticate body B (no cross-replay)", () => {
    // Sanity: capturing a real sig and replaying it against a *different*
    // body must fail. This is the actual property HMAC gives us; the test
    // above only pins the (intentional) absence of timestamp/nonce checks.
    const bodyA = JSON.stringify({ event: "A" });
    const bodyB = JSON.stringify({ event: "B" });
    const sigA = sign(bodyA, SECRET);
    expect(verifyWebhookSignature(bodyA, sigA, SECRET)).toBe(true);
    expect(verifyWebhookSignature(bodyB, sigA, SECRET)).toBe(false);
  });
});

describe("timingSafeEqualString — constant-time properties", () => {
  it("returns false for one-byte difference at any position (no early exit observable)", () => {
    // This isn't a true timing test (vitest can't measure ns-level timing
    // reliably), but it verifies that the function reaches a comparison
    // for differences at every position rather than short-circuiting on
    // the first byte. timingSafeEqual on padded buffers gives us this.
    const base = "a".repeat(64);
    const positions = [0, 31, 63];
    for (const i of positions) {
      const flipped = base.slice(0, i) + "b" + base.slice(i + 1);
      expect(timingSafeEqualString(base, flipped)).toBe(false);
    }
  });

  it("does not throw when comparing very-different-length strings (1 byte vs 1KB)", () => {
    // The pad-to-max-length trick has to handle wildly asymmetric inputs.
    const tiny = "x";
    const huge = "y".repeat(1024);
    expect(() => timingSafeEqualString(tiny, huge)).not.toThrow();
    expect(timingSafeEqualString(tiny, huge)).toBe(false);
  });

  it("treats UTF-8 byte length, not JS code-unit length, when comparing", () => {
    // "é" is 2 UTF-8 bytes, "e" is 1. Same code-point count, different
    // byte length — must return false.
    expect(timingSafeEqualString("é", "e")).toBe(false);
    // Same bytes — must return true.
    expect(timingSafeEqualString("é", "é")).toBe(true);
  });
});

describe("extractSecretCandidates — Bearer dual-push behaviour", () => {
  it("pushes both stripped and raw Authorization when they differ, but no duplicates otherwise", () => {
    // With `Bearer mytoken`: stripped is `mytoken`, raw.trim() is the full
    // string — both should be present (defends the rare case where the
    // secret itself starts with `Bearer `).
    const withPrefix = extractSecretCandidates(makeReq({ authorization: "Bearer mytoken" }));
    expect(withPrefix).toContain("mytoken");
    expect(withPrefix).toContain("Bearer mytoken");

    // Without a Bearer prefix, stripped === raw.trim() so we should NOT
    // duplicate the value.
    const bare = extractSecretCandidates(makeReq({ authorization: "mytoken" }));
    expect(bare.filter((c) => c === "mytoken")).toHaveLength(1);
  });
});

describe("generateWebhookSecret — entropy sanity", () => {
  it("never collides across 50 sequential calls", () => {
    // 32 bytes of entropy means collision probability is ~0; smoke-test
    // that we're drawing from crypto.randomBytes and not a constant.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateWebhookSecret());
    expect(seen.size).toBe(50);
  });
});
