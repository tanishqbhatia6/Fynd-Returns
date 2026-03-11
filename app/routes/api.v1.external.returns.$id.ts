import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError, sanitizeReturnDetail } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const rl = checkRateLimit(request, "external.returns.detail");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "read_returns");
  if (!auth.ok) return auth.response;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Return ID is required");

  try {
    const returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: auth.shopId },
      include: { items: true, events: { orderBy: { happenedAt: "asc" } } },
    });

    if (!returnCase) return apiError(404, "NOT_FOUND", `Return with ID ${id} not found`);

    return apiSuccess(sanitizeReturnDetail(returnCase as unknown as Record<string, unknown> & { items: unknown[]; events: unknown[] }));
  } catch (err) {
    console.error("[external.returns.detail]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch return details");
  }
};
