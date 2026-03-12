/**
 * Outbound webhook dispatch for external integrations.
 * Sends signed POST requests to registered webhook URLs.
 * HMAC-SHA256 signature in X-RPM-Signature header.
 * Fire-and-forget with 3 retry attempts (exponential backoff).
 *
 * Instrumented with OpenTelemetry spans, structured logging, and metrics.
 */
import crypto from "crypto";
import prisma from "../db.server";
import { webhookLogger } from "./observability/logger.server";
import { withSpan, addBusinessEvent } from "./observability/tracing.server";
import {
  webhookDispatchCounter,
  webhookDeliveryAttempts,
  webhookRetriesExhausted,
  webhookInflight,
} from "./observability/metrics.server";

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
  webhookInflight.add(1, { "webhook.event_type": eventType });
  try {
    // Initial attempt
    const ok = await deliverWebhook(url, body, signature, eventType);
    webhookDeliveryAttempts.add(1, {
      "webhook.event_type": eventType,
      "webhook.attempt": 1,
      "webhook.outcome": ok ? "success" : "failure",
    });
    if (ok) {
      webhookDispatchCounter.add(1, {
        "webhook.event_type": eventType,
        "webhook.outcome": "success",
      });
      return;
    }

    // Retry loop
    for (let i = 0; i < MAX_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[i]));
      const retryOk = await deliverWebhook(url, body, signature, eventType);
      webhookDeliveryAttempts.add(1, {
        "webhook.event_type": eventType,
        "webhook.attempt": i + 2,
        "webhook.outcome": retryOk ? "success" : "failure",
      });
      if (retryOk) {
        webhookDispatchCounter.add(1, {
          "webhook.event_type": eventType,
          "webhook.outcome": "success",
        });
        return;
      }
    }

    // All retries exhausted
    webhookRetriesExhausted.add(1, { "webhook.event_type": eventType });
    webhookDispatchCounter.add(1, {
      "webhook.event_type": eventType,
      "webhook.outcome": "failure",
    });
    webhookLogger.warn(
      { eventType, url, attempts: MAX_RETRIES + 1 },
      "Webhook delivery failed after all retry attempts",
    );
  } finally {
    webhookInflight.add(-1, { "webhook.event_type": eventType });
  }
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
      await withSpan(
        "webhook.dispatch",
        { "webhook.event_type": eventType },
        async (span) => {
          const subscriptions = await prisma.webhookSubscription.findMany({
            where: { shopId, isActive: true },
          });

          const matchingSubs = subscriptions.filter((sub) => {
            let events: string[] = [];
            try { events = JSON.parse(sub.events); } catch { /* empty */ }
            return events.includes(eventType);
          });

          span.setAttribute("webhook.subscriber_count", matchingSubs.length);

          webhookLogger.info(
            { eventType, shopId, subscriberCount: matchingSubs.length },
            "Dispatching webhook event",
          );

          if (matchingSubs.length === 0) return;

          const body = JSON.stringify({
            event: eventType,
            data: payload,
            timestamp: new Date().toISOString(),
          });

          addBusinessEvent("webhook.dispatch.started", {
            "webhook.event_type": eventType,
            "webhook.subscriber_count": matchingSubs.length,
          });

          for (const sub of matchingSubs) {
            const signature = signPayload(body, sub.secret);
            // Each delivery runs independently
            deliverWithRetry(sub.url, body, signature, eventType).catch(() => {});
          }
        },
      );
    } catch (err) {
      webhookLogger.error(
        { err, eventType, shopId },
        "Error dispatching webhook event",
      );
    }
  })();
}
