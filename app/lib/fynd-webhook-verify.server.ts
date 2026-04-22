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

/** Generate a fresh 64-hex-char webhook secret (32 bytes of entropy). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
