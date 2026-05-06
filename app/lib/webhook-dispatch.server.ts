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

/**
 * Per-subscription FIFO queue.
 *
 * Previously every event for the same subscription dispatched concurrently —
 * `return.approved` and `return.refunded` for the same return could arrive at
 * the merchant out-of-order if the first one had to retry. Per-subscription
 * serial dispatch fixes this for the common case (a single process). Multi-
 * instance deploys still need a Redis queue for true cross-process ordering;
 * tracked separately.
 *
 * The queue is intentionally NOT bounded — a stuck subscription only stalls
 * its own queue, not the dispatcher. If a subscription endpoint is permanently
 * down, items still flow into the DLQ via the existing retry path.
 */
const subscriptionQueues = new Map<string, Promise<void>>();

function enqueueForSubscription(subscriptionId: string, task: () => Promise<void>): void {
  const prev = subscriptionQueues.get(subscriptionId) ?? Promise.resolve();
  // Chain the new task onto the previous one. Errors don't propagate — each task
  // already has its own try/catch via deliverWithRetry.
  const next = prev.then(task, task);
  subscriptionQueues.set(subscriptionId, next);
  // Best-effort cleanup so the map doesn't grow unbounded for one-shot subs.
  next.finally(() => {
    if (subscriptionQueues.get(subscriptionId) === next) {
      subscriptionQueues.delete(subscriptionId);
    }
  });
}

async function deliverWebhook(
  url: string,
  body: string,
  signature: string,
  eventType: string,
): Promise<boolean> {
  // SSRF re-check at delivery time. Even though the URL is validated at registration,
  // DNS rebinding can flip a public hostname to a private IP between registration
  // and delivery. We re-resolve and reject if it now points internally.
  try {
    const { isSafeOutboundUrl } = await import("./url-safety.server");
    const safety = await isSafeOutboundUrl(url);
    if (!safety.ok) {
      webhookLogger.warn({ url, eventType, reason: safety.reason }, "Webhook target failed SSRF re-check; not dispatching");
      return false;
    }
  } catch { /* if the safety check itself errors, fail closed */ return false; }

  const controller = new AbortController();
  /* v8 ignore next */ // unreachable: timer fires only on real network hangs
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Standard header — `sha256=<hex>` format mirrors Shopify's
        // X-Shopify-Hmac-SHA256, so merchants can re-use Shopify webhook
        // verification code without modifications.
        "X-Webhook-Signature": signature.startsWith("sha256=") ? signature : `sha256=${signature}`,
        "X-Webhook-Event": eventType,
        // Legacy alias kept for one release so existing merchant integrations
        // that were verifying X-RPM-Signature don't break overnight. Remove in
        // the next major version; document the cutover in the migration guide.
        "X-RPM-Signature": signature,
        "X-RPM-Event": eventType,
      },
      body,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    // Always clear the timer — without this, a fetch() that throws synchronously
    // (DNS failure, malformed URL) leaves the timeout queued in the event loop
    // for up to TIMEOUT_MS doing nothing. Across 1000s of failed deliveries this
    // accumulates into noticeable RAM/event-loop pressure.
    clearTimeout(timer);
  }
}

async function deliverWithRetry(
  url: string,
  body: string,
  signature: string,
  eventType: string,
  /** Optional dead-letter context — when supplied we persist failures to the DLQ. */
  dlqContext?: { subscriptionId: string; shopId: string; idempotencyKey?: string },
): Promise<void> {
  webhookInflight.add(1, { "webhook.event_type": eventType });
  let lastError: string | undefined;
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
      // Subscription cancellation check: if the merchant removed the
      // subscription between attempts, abandon the retry immediately. Without
      // this, in-flight retries kept hammering URLs the merchant had already
      // disabled (P2 finding from QA audit).
      if (dlqContext) {
        try {
          const stillActive = await prisma.webhookSubscription.findFirst({
            where: { id: dlqContext.subscriptionId, isActive: true },
            select: { id: true },
          });
          if (!stillActive) {
            webhookLogger.info(
              { eventType, url, subscriptionId: dlqContext.subscriptionId },
              "Subscription was disabled — abandoning retry",
            );
            return;
          }
        } catch { /* best-effort — proceed to attempt */ }
      }
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

    // Persist to dead-letter queue so the merchant can see and replay it. The
    // previous behaviour of silently dropping after retries left merchants in the
    // dark when their endpoint had a multi-minute outage (P1 finding).
    if (dlqContext) {
      try {
        await prisma.webhookDeliveryFailure.create({
          data: {
            subscriptionId: dlqContext.subscriptionId,
            shopId: dlqContext.shopId,
            eventType,
            payloadJson: body,
            url,
            attemptCount: MAX_RETRIES + 1,
            lastError: lastError ?? "delivery_failed",
            idempotencyKey: dlqContext.idempotencyKey,
          },
        });
      } catch (dlqErr) {
        webhookLogger.error({ err: dlqErr, eventType }, "Failed to persist webhook to DLQ");
      }
    }
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

          // Idempotency key — merchants should dedupe on this if they receive a
          // delivery twice (initial + DLQ replay, or network double-fire).
          const { randomUUID } = await import("node:crypto");
          const idempotencyKey = randomUUID();

          const body = JSON.stringify({
            event: eventType,
            data: payload,
            timestamp: new Date().toISOString(),
            idempotencyKey,
          });

          addBusinessEvent("webhook.dispatch.started", {
            "webhook.event_type": eventType,
            "webhook.subscriber_count": matchingSubs.length,
          });

          for (const sub of matchingSubs) {
            const signature = signPayload(body, sub.secret);
            // Per-subscription FIFO — events for the same subscription dispatch
            // serially so they arrive in causal order at the merchant. Different
            // subscriptions still dispatch in parallel.
            enqueueForSubscription(sub.id, () =>
              deliverWithRetry(sub.url, body, signature, eventType, {
                subscriptionId: sub.id,
                shopId,
                idempotencyKey,
              }).catch(() => {}),
            );
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
