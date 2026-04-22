import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError, sanitizeSettings, checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rl = checkRateLimit(request, "external.settings");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "read_settings");
  if (!auth.ok) return auth.response;

  const perKey = await checkPerKeyRateLimit(request, "external.settings", auth.keyId ?? "anon");
  if (perKey) return perKey;

  try {
    const settings = await prisma.shopSettings.findUnique({
      where: { shopId: auth.shopId },
    });

    if (!settings) return apiError(404, "NOT_FOUND", "Shop settings not found");

    return apiSuccess(sanitizeSettings(settings as unknown as Record<string, unknown>));
  } catch (err) {
    console.error("[external.settings]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch settings");
  }
};
