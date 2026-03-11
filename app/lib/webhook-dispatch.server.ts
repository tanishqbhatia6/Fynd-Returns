/**
 * Outbound webhook dispatch for external integrations.
 * Sends signed POST requests to registered webhook URLs.
 * HMAC-SHA256 signature in X-RPM-Signature header.
 * Fire-and-forget with 3 retry attempts (exponential backoff).
 */
import crypto from "crypto";
import prisma from "../db.server";

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2; // 0-indexed: initial + 2 retries = 3 total attempts
const RETRY_DELAYS = [30_000, 120_000]; // 30s, 2min

function signPayload(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function deliverWebhook(
  url: string,
  body: string,
  signature: string,
  eventType: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-RPM-Signature": signature,
        "X-RPM-Event": eventType,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function deliverWithRetry(
  url: string,
  body: string,
  signature: string,
  eventType: string,
): Promise<void> {
  const ok = await deliverWebhook(url, body, signature, eventType);
  if (ok) return;

  for (let i = 0; i < MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
    const retryOk = await deliverWebhook(url, body, signature, eventType);
    if (retryOk) return;
  }
  // All retries exhausted — silently drop (fire-and-forget)
  console.warn(`[webhook-dispatch] Failed to deliver ${eventType} to ${url} after ${MAX_RETRIES + 1} attempts`);
}

/**
 * Dispatch a webhook event to all matching subscriptions for the shop.
 * Non-blocking: returns immediately, deliveries happen in background.
 */
export function dispatchWebhookEvent(
  shopId: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  // Fire-and-forget
  (async () => {
    try {
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: { shopId, isActive: true },
      });

      const body = JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() });

      for (const sub of subscriptions) {
        let events: string[] = [];
        try { events = JSON.parse(sub.events); } catch { /* empty */ }
        if (!events.includes(eventType)) continue;

        const signature = signPayload(body, sub.secret);
        // Each delivery runs independently
        deliverWithRetry(sub.url, body, signature, eventType).catch(() => {});
      }
    } catch (err) {
      console.error("[webhook-dispatch] Error dispatching:", err);
    }
  })();
}
