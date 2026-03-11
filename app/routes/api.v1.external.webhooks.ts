import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import crypto from "crypto";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiCreated, apiError } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { WEBHOOK_EVENTS } from "../lib/api-docs-data";
import prisma from "../db.server";

// GET — List webhook subscriptions
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rl = checkRateLimit(request, "external.webhooks");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "manage_webhooks");
  if (!auth.ok) return auth.response;

  try {
    const subs = await prisma.webhookSubscription.findMany({
      where: { shopId: auth.shopId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    const data = subs.map((s) => ({
      id: s.id,
      url: s.url,
      events: JSON.parse(s.events),
      isActive: s.isActive,
      createdAt: s.createdAt,
    }));

    return apiSuccess(data);
  } catch (err) {
    console.error("[external.webhooks.list]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch webhook subscriptions");
  }
};

// POST — Register a new webhook subscription
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST to register, DELETE to remove");
  }

  const rl = checkRateLimit(request, "external.webhooks");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "manage_webhooks");
  if (!auth.ok) return auth.response;

  let body: { url?: string; events?: string[] } = {};
  try { body = await request.json(); } catch {
    return apiError(400, "BAD_REQUEST", "Invalid JSON body");
  }

  // Validate URL
  if (!body.url || typeof body.url !== "string") {
    return apiError(400, "BAD_REQUEST", "url is required");
  }
  try {
    const u = new URL(body.url);
    if (u.protocol !== "https:") {
      return apiError(400, "BAD_REQUEST", "Webhook URL must use HTTPS");
    }
  } catch {
    return apiError(400, "BAD_REQUEST", "Invalid webhook URL");
  }

  // Validate events
  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    return apiError(400, "BAD_REQUEST", "events must be a non-empty array");
  }
  const validEvents = WEBHOOK_EVENTS as readonly string[];
  const invalidEvents = body.events.filter((e) => !validEvents.includes(e));
  if (invalidEvents.length > 0) {
    return apiError(400, "BAD_REQUEST", `Invalid events: ${invalidEvents.join(", ")}. Valid: ${validEvents.join(", ")}`);
  }

  try {
    // Check for duplicate URL
    const existing = await prisma.webhookSubscription.findFirst({
      where: { shopId: auth.shopId, url: body.url, isActive: true },
    });
    if (existing) {
      return apiError(400, "BAD_REQUEST", "A webhook subscription already exists for this URL");
    }

    const secret = "whsec_" + crypto.randomBytes(32).toString("hex");

    const sub = await prisma.webhookSubscription.create({
      data: {
        shopId: auth.shopId,
        url: body.url,
        events: JSON.stringify(body.events),
        secret,
      },
    });

    return apiCreated({
      id: sub.id,
      url: sub.url,
      events: body.events,
      secret, // Shown once
      isActive: true,
      createdAt: sub.createdAt,
    });
  } catch (err) {
    console.error("[external.webhooks.register]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to register webhook");
  }
};
