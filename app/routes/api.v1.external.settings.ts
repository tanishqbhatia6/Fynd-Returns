import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import {
  apiSuccess,
  apiError,
  sanitizeSettings,
  checkPerKeyRateLimit,
} from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { externalApiLogger } from "../lib/observability/logger.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rl = await checkRateLimit(request, "external.settings");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "read_settings");
  if (!auth.ok) return auth.response;

  // defensive: auth.keyId always set after auth.ok guard above; "anon" fallback unreachable
  /* v8 ignore start */
  const perKey = await checkPerKeyRateLimit(request, "external.settings", auth.keyId ?? "anon");
  /* v8 ignore stop */
  if (perKey) return perKey;

  try {
    const settings = await prisma.shopSettings.findUnique({
      where: { shopId: auth.shopId },
    });

    if (!settings) return apiError(404, "NOT_FOUND", "Shop settings not found");

    return apiSuccess(sanitizeSettings(settings as unknown as Record<string, unknown>));
  } catch (err) {
    externalApiLogger.error(
      { endpoint: "external.settings", shopId: auth.shopId, keyId: auth.keyId, err },
      "External settings fetch failed",
    );
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch settings");
  }
};
