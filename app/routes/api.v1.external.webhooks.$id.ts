import type { ActionFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError, checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import prisma from "../db.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "DELETE") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use DELETE to remove a webhook subscription");
  }

  const rl = await checkRateLimit(request, "external.webhooks");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "manage_webhooks");
  if (!auth.ok) return auth.response;

  const perKey = await checkPerKeyRateLimit(request, "external.webhooks", auth.keyId ?? "anon");
  if (perKey) return perKey;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Webhook ID is required");

  try {
    const sub = await prisma.webhookSubscription.findFirst({
      where: { id, shopId: auth.shopId },
    });
    if (!sub) return apiError(404, "NOT_FOUND", `Webhook subscription ${id} not found`);

    await prisma.webhookSubscription.update({
      where: { id },
      data: { isActive: false },
    });

    return apiSuccess({
      id,
      message: "Webhook subscription removed",
    });
  } catch (err) {
    console.error("[external.webhooks.delete]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to delete webhook subscription");
  }
};
