/**
 * Shared verification + processing helpers for Fynd webhook receivers.
 *
 * Two routes use these:
 *  - app/routes/api.webhooks.fynd.ts          (legacy, global FYND_WEBHOOK_SECRET)
 *  - app/routes/api.webhooks.fynd.$shopId.ts  (per-shop secret, preferred)
 *
 * Keeping the verification + idempotency + error-log code in one place ensures
 * the two endpoints stay consistent and any future tightening (e.g. timestamp
 * skew window) lands in both.
 */
import crypto from "crypto";

// Hard cap on body size — see api.webhooks.fynd.ts header for rationale.
export const MAX_WEBHOOK_BYTES = 1_048_576;

/** Read body with an upfront content-length check. Returns null + a Response on
 *  413 so callers can `return body ?? response`. */
export async function readBoundedBody(request: Request): Promise<{ body: string } | { rejected: Response }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      return { rejected: Response.json({ error: "Webhook payload too large" }, { status: 413 }) };
    }
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
    return { rejected: Response.json({ error: "Webhook payload too large" }, { status: 413 }) };
  }
  return { body };
}

/**
 * Verify HMAC-SHA256 signature in the X-Fynd-Signature / X-Webhook-Signature
 * header against the raw body. Returns true if the signature matches.
 *
 * Accepts both `<hex>` and `sha256=<hex>` formats so Fynd can use either
 * convention without breaking us.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const sigClean = signatureHeader.replace(/^sha256=/, "").trim();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const sigBuf = Buffer.from(sigClean, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison. Uses timingSafeEqual on UTF-8 byte buffers.
 *
 * Safe to call with user-supplied strings of any length: we pad the shorter
 * one to the longer one's length so timingSafeEqual doesn't throw, then OR
 * the length-mismatch flag in at the end. The total runtime depends only on
 * the maximum input length, not on which input is correct.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length);
  // Pad both to same length so timingSafeEqual can run without throwing.
  // The length mismatch is folded back into the final result.
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const equal = crypto.timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}

/**
 * Resolve the candidate webhook secret(s) the caller presented, in priority
 * order. Fynd Commerce's webhook config supports two relevant fields:
 *   - "Custom Headers" — arbitrary key/value pairs the merchant types in
 *   - "Authentication > Secret" — a secret string Fynd attaches to outbound
 *     webhooks (sent as the Authorization header value)
 *
 * To stay compatible with both fields without requiring the merchant to
 * understand the difference, we accept the secret in any of:
 *   - X-Shop-Secret      (recommended Custom Header — explicit + non-overloaded)
 *   - X-Webhook-Secret   (alias)
 *   - X-Fynd-Secret      (alias for forward-compat with future Fynd standards)
 *   - Authorization      (with optional `Bearer ` prefix — what Fynd's
 *                         Authentication field most likely sends)
 *
 * Returns every present candidate so the caller can timing-safe compare
 * against the stored secret.
 */
export function extractSecretCandidates(request: Request): string[] {
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && v.trim().length > 0) out.push(v.trim());
  };
  push(request.headers.get("x-shop-secret"));
  push(request.headers.get("x-webhook-secret"));
  push(request.headers.get("x-fynd-secret"));
  // Authorization: support both `Bearer <token>` and bare `<token>` forms.
  const auth = request.headers.get("authorization");
  if (auth) {
    const stripped = auth.replace(/^Bearer\s+/i, "").trim();
    if (stripped.length > 0) out.push(stripped);
    // Also push the raw value in case the secret itself starts with "Bearer ".
    if (stripped !== auth.trim()) out.push(auth.trim());
  }
  return out;
}

/**
 * Single entry point that decides whether a webhook request is authentic.
 *
 * Tries the simple shared-secret path first (Fynd Commerce compatible),
 * falls back to HMAC signature verification (legacy + custom integrations
 * that prefer signatures). Returns a structured result so the caller can
 * log the specific failure reason without leaking it to the response.
 */
export type WebhookAuthResult =
  | { ok: true; method: "shared_secret" | "hmac" }
  | { ok: false; reason: string };

export function authenticateWebhook(
  request: Request,
  rawBody: string,
  storedSecret: string,
): WebhookAuthResult {
  // 1. Shared-secret in headers (Fynd Commerce + curl + most other clients).
  const candidates = extractSecretCandidates(request);
  for (const candidate of candidates) {
    if (timingSafeEqualString(candidate, storedSecret)) {
      return { ok: true, method: "shared_secret" };
    }
  }

  // 2. HMAC signature fallback. We keep this so anyone who built against the
  //    previous signature-based design (or a Fynd integration that chooses to
  //    sign) keeps working without re-onboarding.
  const sigHeader =
    request.headers.get("x-fynd-signature") ??
    request.headers.get("x-webhook-signature");
  if (sigHeader && verifyWebhookSignature(rawBody, sigHeader, storedSecret)) {
    return { ok: true, method: "hmac" };
  }

  if (candidates.length === 0 && !sigHeader) {
    return { ok: false, reason: "no auth header present" };
  }
  return { ok: false, reason: "secret/signature mismatch" };
}

/** Generate a fresh 64-hex-char webhook secret (32 bytes of entropy). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
