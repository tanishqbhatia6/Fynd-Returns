import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalSession } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { getPortalLabels } from "../lib/portal-i18n";
import { extractFyndJourney } from "../lib/fynd-payload.server";
import { buildFyndJourneyFilterForReturn } from "../lib/fynd-return-scope.server";

function parseMatchedReturnIds(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseReturnLabel(raw: string | null | undefined) {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      carrier: typeof parsed.carrier === "string" ? parsed.carrier : null,
      trackingNumber: typeof parsed.trackingNumber === "string" ? parsed.trackingNumber : null,
      labelUrl: typeof parsed.labelUrl === "string" ? parsed.labelUrl : null,
      qrCodeUrl: typeof parsed.qrCodeUrl === "string" ? parsed.qrCodeUrl : null,
    };
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }

  const rateLimit = await checkRateLimit(request, "portal.returns");
  if (!rateLimit.allowed) {
    return withCors(rateLimitResponse(rateLimit.retryAfterMs), request);
  }

  const auth = request.headers.get("Authorization");
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const session = await verifyPortalSession(prisma, { portalToken: token });
  if (!session) {
    return withCors(Response.json({ error: "Invalid token" }, { status: 401 }), request);
  }

  const returnIds = parseMatchedReturnIds(session.matchedReturnIds);

  const returns = returnIds.length
    ? await prisma.returnCase.findMany({
        where: { id: { in: returnIds }, shopId: session.shopId },
        select: {
          id: true,
          returnRequestNo: true,
          shopifyOrderName: true,
          status: true,
          refundStatus: true,
          resolutionType: true,
          createdAt: true,
          updatedAt: true,
          notesForCustomer: true,
          returnAwb: true,
          forwardAwb: true,
          fyndReturnId: true,
          fyndReturnNo: true,
          fyndShipmentId: true,
          fyndCurrentStatus: true,
          fyndPayloadJson: true,
          returnLabelJson: true,
          cancellationRequestedAt: true,
          cancellationDeclinedAt: true,
          items: {
            select: {
              id: true,
              title: true,
              variantTitle: true,
              sku: true,
              qty: true,
              reasonCode: true,
              imageUrl: true,
              fyndBagId: true,
              fyndShipmentId: true,
            },
          },
          events: {
            orderBy: { happenedAt: "desc" },
            take: 10,
            select: {
              id: true,
              eventType: true,
              happenedAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const shopSettings = await prisma.shopSettings.findUnique({
    where: { shopId: session.shopId },
  });

  const portalLanguage = shopSettings?.portalLanguage ?? "en";
  let portalLabelOverrides: Record<string, string> = {};
  try {
    if (shopSettings?.portalLabelsJson)
      portalLabelOverrides = JSON.parse(shopSettings.portalLabelsJson);
  } catch {
    /* ignore */
  }
  const labels = getPortalLabels(portalLanguage, portalLabelOverrides);

  const defaultReturnInstructions = shopSettings?.defaultReturnInstructions ?? null;

  const enrichedReturns = returns.map((r) => {
    const isApprovedOrCompleted = ["approved", "completed"].includes(r.status.toLowerCase());
    const journeyFilter = buildFyndJourneyFilterForReturn(r);

    // Extract Fynd journey for portal tracking display
    const returnJourney = isApprovedOrCompleted
      ? journeyFilter
        ? extractFyndJourney(
            (r as { fyndPayloadJson?: string | null }).fyndPayloadJson,
            "return",
            journeyFilter,
          )
        : extractFyndJourney((r as { fyndPayloadJson?: string | null }).fyndPayloadJson, "return")
      : null;

    return {
      id: r.id,
      returnRequestNo: r.returnRequestNo ?? null,
      returnRequestId: r.returnRequestNo ?? r.id,
      shopifyOrderName: r.shopifyOrderName ?? null,
      status: r.status,
      refundStatus: r.refundStatus ?? null,
      resolutionType: r.resolutionType ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      items: r.items.map((item) => ({
        id: item.id,
        title: item.title ?? null,
        variantTitle: item.variantTitle ?? null,
        sku: item.sku ?? null,
        qty: item.qty,
        reasonCode: item.reasonCode ?? null,
        imageUrl: item.imageUrl ?? null,
      })),
      events: r.events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        happenedAt: event.happenedAt,
      })),
      notesForCustomer: r.notesForCustomer ?? null,
      returnAwb: r.returnAwb ?? null,
      forwardAwb: r.forwardAwb ?? null,
      fyndReturnNo: r.fyndReturnNo ?? null,
      fyndCurrentStatus: (r as { fyndCurrentStatus?: string | null }).fyndCurrentStatus ?? null,
      returnJourney,
      returnLabel: isApprovedOrCompleted ? parseReturnLabel(r.returnLabelJson) : null,
      returnInstructions: isApprovedOrCompleted ? defaultReturnInstructions : null,
      cancellationRequestedAt: r.cancellationRequestedAt ?? null,
      cancellationDeclinedAt: r.cancellationDeclinedAt ?? null,
    };
  });

  return withCors(
    Response.json({
      returns: enrichedReturns,
      labels,
      language: portalLanguage,
    }),
    request,
  );
};
