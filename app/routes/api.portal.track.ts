/**
 * Verified portal track endpoint.
 * GET /api/portal/track?shop=&returnRequestNo=&portalToken=&sessionId=
 *
 * Returns public-safe fields only: status, refundStatus, fyndReturnNo, returnAwb,
 * createdAt, notesForCustomer, returnJourney.
 *
 * A verified portal session is required. Email/phone matching is not strong enough
 * for sensitive return status lookups.
 * Rate-limited.
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { extractFyndJourney } from "../lib/fynd-payload.server";
import { buildFyndJourneyFilterForReturn } from "../lib/fynd-return-scope.server";
import { verifyPortalSession } from "../lib/portal-auth.server";

function parseMatchedReturnIds(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }

  const rl = await checkRateLimit(request, "portal.track");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const returnRequestNo = (url.searchParams.get("returnRequestNo") ?? "").trim();
  const portalToken = url.searchParams.get("portalToken");
  const sessionId = url.searchParams.get("sessionId");

  if (!shopParam) {
    return withCors(Response.json({ error: "shop is required" }, { status: 400 }), request);
  }
  if (!returnRequestNo) {
    return withCors(
      Response.json({ error: "returnRequestNo is required" }, { status: 400 }),
      request,
    );
  }

  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;
  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  const verifiedSession = await verifyPortalSession(prisma, {
    portalToken,
    sessionId,
    shopId: shopRecord.id,
  });
  if (!verifiedSession) {
    return withCors(
      Response.json({ error: "Verified customer session is required" }, { status: 401 }),
      request,
    );
  }

  const rc = await prisma.returnCase.findFirst({
    where: {
      shopId: shopRecord.id,
      returnRequestNo: { equals: returnRequestNo, mode: "insensitive" },
    },
    select: {
      id: true,
      returnRequestNo: true,
      status: true,
      refundStatus: true,
      resolutionType: true,
      fyndReturnId: true,
      fyndReturnNo: true,
      fyndShipmentId: true,
      fyndPayloadJson: true,
      returnAwb: true,
      notesForCustomer: true,
      createdAt: true,
      updatedAt: true,
      items: {
        select: {
          fyndBagId: true,
          fyndShipmentId: true,
        },
      },
    },
  });

  if (!rc) {
    return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
  }

  const matchedReturnIds = parseMatchedReturnIds(verifiedSession.matchedReturnIds);
  if (!matchedReturnIds.includes(rc.id)) {
    return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
  }

  const shouldShowReturnJourney = ["approved", "processing", "in progress", "completed"].includes(
    rc.status.toLowerCase(),
  );
  const journeyFilter = buildFyndJourneyFilterForReturn(rc);
  const returnJourney = shouldShowReturnJourney
    ? journeyFilter
      ? extractFyndJourney(
          (rc as { fyndPayloadJson?: string | null }).fyndPayloadJson,
          "return",
          journeyFilter,
        )
      : []
    : null;

  return withCors(
    Response.json({
      returnRequestNo: rc.returnRequestNo,
      status: rc.status,
      refundStatus: rc.refundStatus ?? null,
      resolutionType: rc.resolutionType,
      fyndReturnNo: rc.fyndReturnNo ?? null,
      returnAwb: rc.returnAwb ?? null,
      notesForCustomer: rc.notesForCustomer ?? null,
      createdAt: rc.createdAt,
      updatedAt: rc.updatedAt,
      returnJourney: returnJourney ?? [],
    }),
    request,
  );
};
