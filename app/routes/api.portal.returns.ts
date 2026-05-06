import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { getPortalLabels } from "../lib/portal-i18n";
import { extractFyndJourney } from "../lib/fynd-payload.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  const auth = request.headers.get("Authorization");
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return withCors(Response.json({ error: "Invalid token" }, { status: 401 }), request);
  }

  const session = await prisma.lookupSession.findUnique({
    where: { id: payload.sessionId as string },
  });
  if (!session?.verifiedAt) {
    return withCors(Response.json({ error: "Session not verified" }, { status: 401 }), request);
  }
  if (session.expiresAt < new Date()) {
    return withCors(
      Response.json(
        { error: "Session expired. Please look up your return again." },
        { status: 401 },
      ),
      request,
    );
  }

  let returnIds: string[] = [];
  try {
    returnIds = JSON.parse(session.matchedReturnIds || "[]");
  } catch {
    // ignore
  }

  const returns = returnIds.length
    ? await prisma.returnCase.findMany({
        where: { id: { in: returnIds }, shopId: payload.shopId as string },
        include: {
          items: true,
          events: { orderBy: { happenedAt: "desc" }, take: 10 },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const shopSettings = await prisma.shopSettings.findUnique({
    where: { shopId: payload.shopId as string },
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
    let returnLabelInfo: {
      carrier?: string | null;
      trackingNumber?: string | null;
      labelUrl?: string | null;
      qrCodeUrl?: string | null;
    } | null = null;
    try {
      if (r.returnLabelJson) returnLabelInfo = JSON.parse(r.returnLabelJson);
    } catch {
      /* ignore */
    }

    const isApprovedOrCompleted = ["approved", "completed"].includes(r.status.toLowerCase());

    // Extract Fynd journey for portal tracking display
    const returnJourney = isApprovedOrCompleted
      ? extractFyndJourney((r as { fyndPayloadJson?: string | null }).fyndPayloadJson, "return")
      : null;

    return {
      ...r,
      // Expose public-safe fields explicitly (fyndPayloadJson stripped out)
      fyndPayloadJson: undefined,
      notesForCustomer: r.notesForCustomer ?? null,
      returnAwb: r.returnAwb ?? null,
      forwardAwb: r.forwardAwb ?? null,
      fyndReturnNo: r.fyndReturnNo ?? null,
      fyndCurrentStatus: (r as { fyndCurrentStatus?: string | null }).fyndCurrentStatus ?? null,
      returnJourney,
      returnLabel: isApprovedOrCompleted ? returnLabelInfo : null,
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
