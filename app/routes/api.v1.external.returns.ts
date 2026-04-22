import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { parsePagination, buildMeta, apiSuccess, apiError, sanitizeReturnSummary, checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Rate limit
  const rl = checkRateLimit(request, "external.returns.list");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // Auth
  const auth = await authenticateApiKey(request, "read_returns");
  if (!auth.ok) return auth.response;

  // Per-key fairness limit AFTER auth — gives each API key its own quota so
  // multiple keys from the same shop+IP don't share a single bucket (P2 finding).
  // The pre-auth IP limit above still guards against unauthenticated DDoS.
  const perKeyResp = await checkPerKeyRateLimit(request, "external.returns.list", auth.keyId ?? "anon");
  if (perKeyResp) return perKeyResp;

  const url = new URL(request.url);
  const { page, pageSize, skip } = parsePagination(url);

  // Build filters
  const where: Record<string, unknown> = { shopId: auth.shopId };

  // Whitelist enum to prevent operator-style injection (`?status[gt]=foo`) and to
  // reject invalid values up-front rather than silently returning empty results.
  const VALID_STATUSES = new Set(["initiated", "pending", "processing", "in progress", "approved", "rejected", "completed", "cancelled"]);
  const status = url.searchParams.get("status");
  if (status) {
    if (!VALID_STATUSES.has(status)) {
      return apiError(400, "BAD_REQUEST", `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`);
    }
    where.status = status;
  }

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

  // Optional cursor pagination — pass `?cursor=<id>` to anchor the next page on a
  // specific row. This avoids the offset-pagination drift (P1 finding) where new
  // returns inserted between page 1 and page 2 cause page 2 to skip or duplicate
  // rows. Backwards compatible: existing `?page=N` callers keep working.
  const cursor = url.searchParams.get("cursor");

  try {
    if (cursor) {
      const rows = await prisma.returnCase.findMany({
        where: where as any,
        include: { items: true },
        // Stable secondary sort by id so ties on createdAt don't shuffle pages.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        cursor: { id: cursor },
        skip: 1, // skip the cursor row itself
        take: pageSize,
      });
      const nextCursor = rows.length === pageSize ? rows[rows.length - 1].id : null;
      const data = rows.map((r) => sanitizeReturnSummary(r as unknown as Record<string, unknown>));
      return apiSuccess(data, { pageSize, nextCursor });
    }

    const [returns, totalCount] = await Promise.all([
      prisma.returnCase.findMany({
        where: where as any,
        include: { items: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize,
      }),
      prisma.returnCase.count({ where: where as any }),
    ]);

    const data = returns.map((r) => sanitizeReturnSummary(r as unknown as Record<string, unknown>));
    const meta = buildMeta(page, pageSize, totalCount);
    // Surface the next-cursor even on offset responses so clients can migrate
    // gradually without changing their request shape.
    const nextCursor = returns.length === pageSize ? returns[returns.length - 1].id : null;

    return apiSuccess(data, { ...meta, nextCursor });
  } catch (err) {
    console.error("[external.returns.list]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to fetch returns");
  }
};
