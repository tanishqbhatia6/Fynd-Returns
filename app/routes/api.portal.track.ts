/**
 * Unauthenticated portal track endpoint.
 * GET /api/portal/track?shop=&returnRequestNo=&email=  (OR phone=)
 *
 * Returns public-safe fields only: status, refundStatus, fyndReturnNo, returnAwb,
 * createdAt, notesForCustomer, returnJourney.
 *
 * Email or phone required to prevent enumeration (lightweight verification).
 * Rate-limited.
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { extractFyndJourney } from "../lib/fynd-payload.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }

  const rl = await checkRateLimit(request, "portal.track");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const returnRequestNo = (url.searchParams.get("returnRequestNo") ?? "").trim();
  const emailParam = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const phoneParam = (url.searchParams.get("phone") ?? "").trim().replace(/[^\d+]/g, "");

  if (!shopParam) {
    return withCors(Response.json({ error: "shop is required" }, { status: 400 }), request);
  }
  if (!returnRequestNo) {
    return withCors(Response.json({ error: "returnRequestNo is required" }, { status: 400 }), request);
  }
  if (!emailParam && !phoneParam) {
    return withCors(Response.json({ error: "email or phone is required" }, { status: 400 }), request);
  }

  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;
  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  const rc = await prisma.returnCase.findFirst({
    where: {
      shopId: shopRecord.id,
      returnRequestNo: { equals: returnRequestNo, mode: "insensitive" },
    },
  });

  if (!rc) {
    return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
  }

  // Verify caller knows email or phone (anti-enumeration)
  const emailMatch = emailParam && rc.customerEmailNorm && rc.customerEmailNorm === emailParam;
  const phoneMatch = phoneParam && rc.customerPhoneNorm && rc.customerPhoneNorm.replace(/[^\d+]/g, "") === phoneParam;
  if (!emailMatch && !phoneMatch) {
    return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
  }

  const isApprovedOrCompleted = ["approved", "completed"].includes(rc.status.toLowerCase());
  const returnJourney = isApprovedOrCompleted
    ? extractFyndJourney((rc as { fyndPayloadJson?: string | null }).fyndPayloadJson, "return")
    : null;

  return withCors(Response.json({
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
  }), request);
};
