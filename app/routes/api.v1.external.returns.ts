import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { parsePagination, buildMeta, apiSuccess, apiError, sanitizeReturnSummary } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Rate limit
  const rl = checkRateLimit(request, "external.returns.list");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // Auth
  const auth = await authenticateApiKey(request, "read_returns");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const { page, pageSize, skip } = parsePagination(url);

  // Build filters
  const where: Record<string, unknown> = { shopId: auth.shopId };

  const status = url.searchParams.get("status");
  if (status) where.status = status;

  const createdAfter = url.searchParams.get("createdAfter");
  if (createdAfter) {
    const d = new Date(createdAfter);
    if (!isNaN(d.getTime())) where.createdAt = { ...(where.createdAt as object || {}), gte: d };
  }

  const createdBefore = url.searchParams.get("createdBefore");
  if (createdBefore) {
    const d = new Date(createdBefore);
    if (!isNaN(d.getTime())) where.createdAt = { ...(where.createdAt as object || {}), lte: d };
  }

  const orderName = url.searchParams.get("orderName");
  if (orderName) where.shopifyOrderName = { contains: orderName, mode: "insensitive" };

  const customerEmail = url.searchParams.get("customerEmail");
  if (customerEmail) where.customerEmailNorm = { contains: customerEmail.toLowerCase() };

  try {
    const [returns, totalCount] = await Promise.all([
      prisma.returnCase.findMany({
        where: where as any,
        include: { items: true },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      prisma.returnCase.count({ where: where as any }),
    ]);

    const data = returns.map((r) => sanitizeReturnSummary(r as unknown as Record<string, unknown>));
    const meta = buildMeta(page, pageSize, totalCount);

    return apiSuccess(data, meta);
  } catch (err) {
    console.error("[external.returns.list]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch returns");
  }
};
