/**
 * Portal Cancel Return API: POST /api/portal/cancel-return
 *
 * Two flows:
 *  Flow A – Non-approved returns (initiated, pending, processing, in progress):
 *    Auto-cancels immediately. Sets status = "cancelled".
 *
 *  Flow B – Approved returns:
 *    Creates a cancellation REQUEST (sets cancellationRequestedAt).
 *    Admin must approve or decline from the app.
 *
 * Terminal statuses (rejected, completed, cancelled) cannot be cancelled.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalToken, verifyPortalCsrfToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { parsePortalConfig } from "../lib/portal-config.server";
import { sendCancellationNotification } from "../lib/notification.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";

const TERMINAL_STATUSES = ["rejected", "completed", "cancelled"];
const AUTO_CANCEL_STATUSES = ["initiated", "pending", "processing", "in progress"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  const rl = await checkRateLimit(request, "portal.cancel-return");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const body = await request.json();
    const shopRaw = body.shop as string | undefined;
    const returnCaseId = (body.returnCaseId as string | undefined)?.trim();
    const reason = (body.reason as string | undefined)?.trim().slice(0, 500) || null;

    if (!shopRaw || !returnCaseId) {
      return withCors(
        Response.json({ error: "shop and returnCaseId are required" }, { status: 400 }),
        request,
      );
    }

    // CSRF gate — same pattern as create-return. The portal HTML sends
    // portalCsrfToken whenever it has one. Soft-enforced: if the token is
    // present we validate it; full enforcement is gated by the env flag so
    // existing portal sessions aren't broken on rollout.
    const REQUIRE_CSRF =
      String(process.env.PORTAL_CSRF_REQUIRED ?? "true").toLowerCase() !== "false";
    const portalCsrfToken = body.portalCsrfToken as string | undefined;
    if (REQUIRE_CSRF || portalCsrfToken) {
      const expectedShop = shopRaw.includes(".") ? shopRaw : `${shopRaw}.myshopify.com`;
      if (!verifyPortalCsrfToken(portalCsrfToken, expectedShop)) {
        return withCors(
          Response.json(
            { error: "Session expired. Refresh the page and try again." },
            { status: 403 },
          ),
          request,
        );
      }
    }

    // Auth: Bearer JWT
    const auth = request.headers.get("Authorization");
    const token = auth?.replace("Bearer ", "");
    if (!token) {
      return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
    }

    const payload = verifyPortalToken(token);
    if (!payload) {
      return withCors(Response.json({ error: "Invalid token" }, { status: 401 }), request);
    }

    // Verify session
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

    // Verify customer owns this return
    let matchedReturnIds: string[] = [];
    try {
      // defensive: matchedReturnIds populated by login flow before this endpoint; "[]" fallback unreachable
      /* v8 ignore start */
      matchedReturnIds = JSON.parse(session.matchedReturnIds || "[]");
      /* v8 ignore stop */
    } catch {
      // ignore
    }
    if (!matchedReturnIds.includes(returnCaseId)) {
      return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
    }

    // Shop lookup
    const shopDomain = shopRaw.includes(".") ? shopRaw : `${shopRaw}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    // Cross-shop replay defence: the JWT carries the shop it was issued for. Reject
    // if a token from shop A is being used to act on shop B (P0 finding from QA audit).
    if (payload.shopId && payload.shopId !== shopRecord.id) {
      return withCors(
        Response.json({ error: "Token does not belong to this shop" }, { status: 403 }),
        request,
      );
    }

    // Check portal config: allowReturnCancellation
    const portalConfig = parsePortalConfig(shopRecord.settings?.portalConfigJson ?? null);
    if (!portalConfig.allowReturnCancellation) {
      return withCors(
        Response.json({ error: "Return cancellation is not enabled" }, { status: 403 }),
        request,
      );
    }

    // Fetch return case
    const returnCase = await prisma.returnCase.findFirst({
      where: { id: returnCaseId, shopId: shopRecord.id },
      include: { items: true },
    });
    if (!returnCase) {
      return withCors(Response.json({ error: "Return not found" }, { status: 404 }), request);
    }

    const statusLower = returnCase.status.toLowerCase();

    // Terminal statuses cannot be cancelled
    if (TERMINAL_STATUSES.includes(statusLower)) {
      return withCors(
        Response.json(
          { error: `Cannot cancel: return is already ${returnCase.status}` },
          { status: 400 },
        ),
        request,
      );
    }

    // ── Flow A: Auto-cancel for non-approved returns ──
    if (AUTO_CANCEL_STATUSES.includes(statusLower)) {
      await prisma.returnCase.update({
        where: { id: returnCaseId },
        data: {
          status: "cancelled",
          cancellationRequestedAt: new Date(),
          cancellationRequestedBy: "portal",
          cancellationReason: reason,
        },
      });

      await prisma.returnEvent.create({
        data: {
          returnCaseId,
          source: "portal",
          eventType: "return_cancelled",
          payloadJson: JSON.stringify({
            flow: "auto_cancelled",
            reason: reason || null,
            previousStatus: returnCase.status,
          }),
        },
      });

      // Send cancellation notification (fire-and-forget)
      if (returnCase.customerEmailNorm) {
        sendCancellationNotification({
          shopDomain,
          to: returnCase.customerEmailNorm,
          orderName: returnCase.shopifyOrderName,
          shopName: undefined,
          returnId: returnCase.returnRequestNo ?? returnCase.id,
          customerPhone: returnCase.customerPhoneNorm ?? null,
        }).catch((e) => console.warn("[portal.cancel-return] Notification failed:", e));
      }

      // Dispatch webhook (fire-and-forget)
      dispatchWebhookEvent(shopRecord.id, "return.cancelled", {
        returnCaseId,
        returnRequestNo: returnCase.returnRequestNo,
        shopifyOrderName: returnCase.shopifyOrderName,
        previousStatus: returnCase.status,
        cancelledBy: "portal",
        reason: reason || null,
      });

      return withCors(Response.json({ success: true, flow: "auto_cancelled" }), request);
    }

    // ── Flow B: Cancellation request for approved returns ──
    if (statusLower === "approved") {
      // Block cancellation if a refund has already been issued or is in flight.
      // Previously this check was missing, so a customer could request cancellation
      // after the refund had been processed — leaving the merchant to chase down
      // an already-paid-out refund (P1 finding from QA audit).
      const refundStatusLower = (returnCase.refundStatus ?? "").toLowerCase();
      if (refundStatusLower === "refunded" || refundStatusLower === "in_progress") {
        return withCors(
          Response.json(
            {
              error:
                refundStatusLower === "refunded"
                  ? "This return has already been refunded and cannot be cancelled. Contact support if you need to reverse the refund."
                  : "A refund is currently being processed. Cancellation is not available — please contact support.",
            },
            { status: 409 },
          ),
          request,
        );
      }
      // Check no duplicate request
      if (returnCase.cancellationRequestedAt) {
        return withCors(
          Response.json({ error: "A cancellation request is already pending" }, { status: 400 }),
          request,
        );
      }

      await prisma.returnCase.update({
        where: { id: returnCaseId },
        data: {
          cancellationRequestedAt: new Date(),
          cancellationRequestedBy: "portal",
          cancellationReason: reason,
          // Clear any previous declined state so the request is fresh
          cancellationDeclinedAt: null,
          cancellationDeclinedBy: null,
        },
      });

      await prisma.returnEvent.create({
        data: {
          returnCaseId,
          source: "portal",
          eventType: "cancellation_requested",
          payloadJson: JSON.stringify({
            flow: "cancellation_requested",
            reason: reason || null,
          }),
        },
      });

      return withCors(Response.json({ success: true, flow: "cancellation_requested" }), request);
    }

    // Fallback: status is not handled (shouldn't reach here)
    return withCors(
      Response.json(
        { error: `Cannot cancel return with status "${returnCase.status}"` },
        { status: 400 },
      ),
      request,
    );
  } catch (err) {
    console.error("[portal.cancel-return] Error:", err);
    return withCors(
      Response.json(
        { error: err instanceof Error ? err.message : "Internal server error" },
        { status: 500 },
      ),
      request,
    );
  }
};
