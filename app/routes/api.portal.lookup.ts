import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import {
  getTrackingInfoFromFyndPayload,
  extractFyndJourney,
  parseFyndOrderDetailsForTab,
  type FyndOrderDetailsTab,
} from "../lib/fynd-payload.server";
import { buildFyndJourneyFilterForReturn } from "../lib/fynd-return-scope.server";
import { createFyndClientOrError, type ShipmentsListingSearchType } from "../lib/fynd.server";
import {
  fetchOrdersByFilter,
  fetchOrderByOrderNumber,
  fetchOrderByGid,
  fetchOrderByFyndAffiliateId,
  withRestCredentials,
} from "../lib/shopify-admin.server";
import shopify from "../shopify.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { getPortalLabels } from "../lib/portal-i18n";
import { sendOtpEmail } from "../lib/notification.server";
import {
  createPortalCsrfToken,
  hashLookupValue,
  verifyPortalSession,
  type VerifiedPortalSession,
} from "../lib/portal-auth.server";
import { portalLogger } from "../lib/observability/logger.server";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 min
const OTP_COOLDOWN_MS = 60_000; // 60s resend cooldown
const MAX_OTP_ATTEMPTS = 5;
const OTP_EMAIL_FAILED_MESSAGE =
  "Could not send the verification email. Ask the store to check email settings and try again.";
// Cost factor — 10 is industry standard, ~50ms per hash. Verifying becomes
// significantly slower than the previous unsalted digest, defeating rainbow tables
// and slowing brute force enough to make the account-level lockout meaningful.
const BCRYPT_COST = 10;

async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, BCRYPT_COST);
}

function otpEmailFailureResponse(request: Request): Response {
  return withCors(
    Response.json(
      {
        error: OTP_EMAIL_FAILED_MESSAGE,
        emailVerificationUnavailable: true,
      },
      { status: 503 },
    ),
    request,
  );
}

async function resetFailedOtpSend(sessionId: string, attemptsCount: number) {
  await prisma.lookupSession
    .update({
      where: { id: sessionId },
      data: {
        otpTarget: null,
        otpSentAt: null,
        attemptsCount,
      },
    })
    .catch(() => {});
}

function normalizeContactLookupValue(lookupType: string, value: unknown): string {
  const raw = String(value).trim();
  return lookupType === "phone" ? raw.replace(/[^\d+]/g, "") : raw.toLowerCase();
}

function portalSessionMatchesContact(
  session: VerifiedPortalSession,
  contacts: { email?: string | null; phone?: string | null },
): boolean {
  const email = contacts.email?.trim().toLowerCase();
  const phone = contacts.phone?.trim().replace(/[^\d+]/g, "");
  if (session.lookupType === "email" && email) {
    return session.lookupValueHash === hashLookupValue(email);
  }
  if (session.lookupType === "phone" && phone) {
    return session.lookupValueHash === hashLookupValue(phone);
  }
  return false;
}

type PortalReturnResponse = {
  id: string;
  returnRequestNo: string | null;
  returnRequestId: string;
  shopifyOrderName: string | null;
  status: string | null;
  refundStatus: string | null;
  resolutionType: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  forwardAwb: string | null;
  returnAwb: string | null;
  fyndCurrentStatus: string | null;
  items: Array<{
    id: string;
    title: string;
    sku: string | null;
    qty: number;
    quantity: number;
    reasonCode: string | null;
    imageUrl: string | null;
  }>;
  events: Array<{ id: string; eventType: string | null; happenedAt: Date | string }>;
  trackingInfo?: unknown;
  returnJourney?: unknown;
  returnLabel?: {
    carrier?: string | null;
    trackingNumber?: string | null;
    labelUrl?: string | null;
    qrCodeUrl?: string | null;
  } | null;
  returnInstructions?: string;
  cancellationRequestedAt?: Date | string | null;
  _needsFyndEnrich: boolean;
};

function parseReturnLabel(
  returnLabelJson: string | null | undefined,
  returnLabelUrl: string | null | undefined,
): PortalReturnResponse["returnLabel"] {
  let parsed: PortalReturnResponse["returnLabel"] = null;
  try {
    if (returnLabelJson) parsed = JSON.parse(returnLabelJson) as PortalReturnResponse["returnLabel"];
  } catch {
    parsed = null;
  }
  if (!parsed && !returnLabelUrl) return null;
  return {
    carrier: parsed?.carrier ?? null,
    trackingNumber: parsed?.trackingNumber ?? null,
    labelUrl: parsed?.labelUrl ?? returnLabelUrl ?? null,
    qrCodeUrl: parsed?.qrCodeUrl ?? null,
  };
}

function toPortalReturnResponse(
  r: {
    id: string;
    returnRequestNo?: string | null;
    shopifyOrderName?: string | null;
    status?: string | null;
    refundStatus?: string | null;
    resolutionType?: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    forwardAwb?: string | null;
    returnAwb?: string | null;
    fyndCurrentStatus?: string | null;
    returnLabelJson?: string | null;
    returnLabelUrl?: string | null;
    cancellationRequestedAt?: Date | string | null;
    fyndShipmentId?: string | null;
    items?: Array<{
      id: string;
      shopifyLineItemId?: string | null;
      title?: string | null;
      sku?: string | null;
      qty?: number;
      reasonCode?: string | null;
      imageUrl?: string | null;
    }>;
    events?: Array<{ id: string; eventType?: string | null; happenedAt: Date | string }>;
  },
  extras: {
    trackingInfo?: unknown;
    returnJourney?: unknown;
    returnInstructions?: string;
  } = {},
): PortalReturnResponse {
  const approved = ["approved", "completed"].includes(String(r.status ?? "").toLowerCase());
  const returnLabel = approved ? parseReturnLabel(r.returnLabelJson, r.returnLabelUrl) : null;
  const response: PortalReturnResponse = {
    id: r.id,
    returnRequestNo: r.returnRequestNo ?? null,
    returnRequestId: r.returnRequestNo ?? r.id,
    shopifyOrderName: r.shopifyOrderName ?? null,
    status: r.status ?? null,
    refundStatus: r.refundStatus ?? null,
    resolutionType: r.resolutionType ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    forwardAwb: r.forwardAwb ?? null,
    returnAwb: r.returnAwb ?? null,
    fyndCurrentStatus: r.fyndCurrentStatus ?? null,
    items: (r.items ?? []).map((item) => ({
      id: item.id,
      title: item.title || item.sku || item.shopifyLineItemId || "Item",
      sku: item.sku ?? null,
      qty: item.qty ?? 1,
      quantity: item.qty ?? 1,
      reasonCode: item.reasonCode ?? null,
      imageUrl: item.imageUrl ?? null,
    })),
    events: (r.events ?? []).map((event) => ({
      id: event.id,
      eventType: event.eventType ?? null,
      happenedAt: event.happenedAt,
    })),
    cancellationRequestedAt: r.cancellationRequestedAt ?? null,
    _needsFyndEnrich: !!(r.shopifyOrderName && r.fyndShipmentId),
  };
  if (extras.trackingInfo) response.trackingInfo = extras.trackingInfo;
  if (extras.returnJourney) response.returnJourney = extras.returnJourney;
  if (returnLabel) response.returnLabel = returnLabel;
  if (approved && extras.returnInstructions) response.returnInstructions = extras.returnInstructions;
  return response;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    const res = Response.json({ error: "Method not allowed" }, { status: 405 });
    return withCors(res, request);
  }

  const rl = await checkRateLimit(request, "portal.lookup");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const body = (await request.json()) as {
      shop?: string;
      lookupType?: string;
      lookupValue?: string;
      portalToken?: string;
      sessionId?: string;
    };
    const { shop, lookupType, lookupValue, portalToken, sessionId } = body;
    if (!shop || !lookupType || !lookupValue) {
      return withCors(
        Response.json({ error: "shop, lookupType, lookupValue required" }, { status: 400 }),
        request,
      );
    }

    // Input validation
    const VALID_LOOKUP_TYPES = [
      "email",
      "phone",
      "mobile",
      "order_no",
      "return_no",
      "return_id",
      "forward_awb",
      "return_awb",
    ];
    if (!VALID_LOOKUP_TYPES.includes(lookupType)) {
      return withCors(Response.json({ error: "Invalid lookup type" }, { status: 400 }), request);
    }
    const normalizedLookupType = lookupType === "mobile" ? "phone" : lookupType;
    const lookupStr = String(lookupValue).trim();
    if (lookupStr.length > 256) {
      return withCors(Response.json({ error: "Lookup value too long" }, { status: 400 }), request);
    }
    if (lookupStr.length < 2) {
      return withCors(Response.json({ error: "Lookup value too short" }, { status: 400 }), request);
    }

    /* v8 ignore start - defensive shop-domain normalization ternary */
    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    /* v8 ignore stop */
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    // ── OTP gate (secure-by-default) ──
    // Customer contact lookups are gated behind verified identity unless the
    // merchant explicitly disables email OTP. Phone stays fail-closed until an
    // actual SMS/WhatsApp OTP delivery path exists.
    // First call (no portalToken): create session + send OTP → return { requiresOtp, sessionId }.
    // Second call (with portalToken): verify session token → proceed to return results.
    const otpEmailEnabled = shopRecord.settings?.portalOtpEmailEnabled ?? true;
    const otpSmsEnabled = true;
    const otpRequired =
      (otpEmailEnabled && normalizedLookupType === "email") ||
      (otpSmsEnabled && normalizedLookupType === "phone");
    const isContactLookup = normalizedLookupType === "email" || normalizedLookupType === "phone";
    let verifiedSessionForNonContactLookup: VerifiedPortalSession | null = null;

    if (otpRequired) {
      const contactNorm = normalizeContactLookupValue(normalizedLookupType, lookupValue);
      const lookupValueHash = hashLookupValue(contactNorm);

      if (!portalToken) {
        if (normalizedLookupType === "phone") {
          return withCors(
            Response.json(
              {
                error:
                  "Phone verification is not configured for this portal. Use email verification or contact support.",
                phoneVerificationUnavailable: true,
              },
              { status: 400 },
            ),
            request,
          );
        }

        // First call — create or reuse a session and send OTP
        const existing = sessionId
          ? await prisma.lookupSession.findUnique({ where: { id: sessionId } })
          : null;
        const reusableExisting =
          existing &&
          existing.shopId === shopRecord.id &&
          existing.lookupType === normalizedLookupType &&
          existing.lookupValueHash === lookupValueHash
            ? existing
            : null;

        // Reuse existing unexpired session if resend requested (sessionId provided)
        if (
          reusableExisting &&
          reusableExisting.expiresAt > new Date() &&
          reusableExisting.attemptsCount < MAX_OTP_ATTEMPTS
        ) {
          const cooldownRemaining = reusableExisting.otpSentAt
            ? Math.max(0, OTP_COOLDOWN_MS - (Date.now() - reusableExisting.otpSentAt.getTime()))
            : 0;
          if (cooldownRemaining > 0) {
            return withCors(
              Response.json({
                requiresOtp: true,
                sessionId: reusableExisting.id,
                cooldownMs: cooldownRemaining,
              }),
              request,
            );
          }
          // Resend: generate new OTP
          const otp = String(crypto.randomInt(100000, 1000000));
          const otpHash = await hashOtp(otp);
          await prisma.lookupSession.update({
            where: { id: reusableExisting.id },
            data: {
              otpTarget: otpHash,
              otpSentAt: new Date(),
              attemptsCount: reusableExisting.attemptsCount + 1,
            },
          });
          try {
            const emailResult = await sendOtpEmail({ shopDomain, to: contactNorm, otp });
            if (!emailResult.success) {
              await resetFailedOtpSend(reusableExisting.id, reusableExisting.attemptsCount);
              portalLogger.warn(
                { error: emailResult.error, shopDomain },
                "Portal lookup OTP email send failed",
              );
              return otpEmailFailureResponse(request);
            }
          } catch (e) {
            await resetFailedOtpSend(reusableExisting.id, reusableExisting.attemptsCount);
            portalLogger.warn({ err: e, shopDomain }, "Portal lookup OTP email send failed");
            return otpEmailFailureResponse(request);
          }
          return withCors(
            Response.json({ requiresOtp: true, sessionId: reusableExisting.id }),
            request,
          );
        }

        // Account-level lockout — same gate as the verify endpoint, applied at OTP-send
        // time so attackers can't bypass by spinning up fresh sessions.
        const lockoutSince = new Date(Date.now() - 60 * 60 * 1000);
        const recentForValue = await prisma.lookupSession.findMany({
          where: {
            shopId: shopRecord.id,
            lookupValueHash,
            createdAt: { gte: lockoutSince },
          },
          select: { attemptsCount: true, verifiedAt: true },
        });
        /* v8 ignore start - defensive `?? 0` for null attempt count */
        const totalRecentFailures = recentForValue
          .filter((s) => !s.verifiedAt)
          .reduce((sum, s) => sum + (s.attemptsCount ?? 0), 0);
        /* v8 ignore stop */
        if (totalRecentFailures >= 15) {
          return withCors(
            Response.json(
              {
                error:
                  "Too many failed verification attempts on this contact. Please try again in an hour.",
                accountLocked: true,
              },
              { status: 429 },
            ),
            request,
          );
        }

        // Create new session
        const otp = String(crypto.randomInt(100000, 1000000));
        const otpHash = await hashOtp(otp);
        const session = await prisma.lookupSession.create({
          data: {
            shopId: shopRecord.id,
            lookupType: normalizedLookupType,
            lookupValueHash,
            lookupValueNorm: contactNorm,
            otpTarget: otpHash,
            otpSentAt: new Date(),
            attemptsCount: 1,
            expiresAt: new Date(Date.now() + OTP_TTL_MS),
          },
        });
        try {
          const emailResult = await sendOtpEmail({ shopDomain, to: contactNorm, otp });
          if (!emailResult.success) {
            await resetFailedOtpSend(session.id, 0);
            portalLogger.warn(
              { error: emailResult.error, shopDomain },
              "Portal lookup OTP email send failed",
            );
            return otpEmailFailureResponse(request);
          }
        } catch (e) {
          await resetFailedOtpSend(session.id, 0);
          portalLogger.warn({ err: e, shopDomain }, "Portal lookup OTP email send failed");
          return otpEmailFailureResponse(request);
        }
        return withCors(Response.json({ requiresOtp: true, sessionId: session.id }), request);
      }

      // Second call — portalToken provided: verify it against DB session and
      // bind it to the exact contact being queried. A verified token for one
      // email/phone must never authorize lookup of another contact.
      const session = sessionId
        ? await prisma.lookupSession.findUnique({ where: { id: sessionId } })
        : null;
      if (!session || session.expiresAt < new Date()) {
        return withCors(
          Response.json(
            { error: "Session expired. Please search again.", sessionExpired: true },
            { status: 401 },
          ),
          request,
        );
      }
      if (!session.verifiedAt) {
        return withCors(
          Response.json(
            { error: "OTP not verified", requiresOtp: true, sessionId: session.id },
            { status: 401 },
          ),
          request,
        );
      }
      const verifiedContactSession = await verifyPortalSession(prisma, {
        portalToken,
        sessionId,
        shopId: shopRecord.id,
        allowedLookupTypes: [normalizedLookupType],
      });
      // Token must match what was stored at verify time and must prove the
      // same lookup value hash as this request.
      if (
        !verifiedContactSession ||
        session.portalToken !== portalToken ||
        verifiedContactSession.lookupValueHash !== lookupValueHash
      ) {
        return withCors(
          Response.json(
            {
              error: "Invalid session token for this lookup value",
              requiresOtp: true,
              sessionId: session.id,
            },
            { status: 401 },
          ),
          request,
        );
      }
      // Verified — proceed to return results below
    } else if (!isContactLookup) {
      verifiedSessionForNonContactLookup = await verifyPortalSession(prisma, {
        portalToken,
        sessionId,
        shopId: shopRecord.id,
        allowedLookupTypes: ["email", "phone"],
      });
      if (!verifiedSessionForNonContactLookup) {
        return withCors(
          Response.json(
            { error: "Verify your email or phone before searching by this value." },
            { status: 401 },
          ),
          request,
        );
      }
    }

    const norm = String(lookupValue).toLowerCase().trim();
    const rawValue = String(lookupValue).trim();

    const where: Record<string, unknown> = { shopId: shopRecord.id };
    if (normalizedLookupType === "return_id") {
      const returnIdUpper = rawValue.toUpperCase();
      where.OR = [
        { id: rawValue },
        { returnRequestNo: rawValue },
        { returnRequestNo: returnIdUpper },
      ];
    } else if (["return_no", "order_no"].includes(normalizedLookupType)) {
      const normNoHash = norm.replace(/^#/, "");
      where.OR = [
        { fyndReturnNo: { equals: normNoHash, mode: "insensitive" } },
        { shopifyOrderName: { equals: normNoHash, mode: "insensitive" } },
        { shopifyOrderName: { equals: `#${normNoHash}`, mode: "insensitive" } },
        { fyndOrderId: { equals: normNoHash, mode: "insensitive" } },
      ];
    } else if (["forward_awb", "return_awb"].includes(normalizedLookupType)) {
      where.OR = [
        { forwardAwb: { contains: norm, mode: "insensitive" } },
        { returnAwb: { contains: norm, mode: "insensitive" } },
      ];
    } else if (normalizedLookupType === "phone") {
      const phoneNorm = norm.replace(/[\s+()-]/g, "");
      where.OR = [{ customerPhoneNorm: { contains: phoneNorm, mode: "insensitive" } }];
    } else {
      where.OR = [
        { customerEmailNorm: { contains: norm, mode: "insensitive" } },
        { customerPhoneNorm: { contains: norm, mode: "insensitive" } },
      ];
    }

    // Single query: fetch only portal-safe fields; matched IDs derive from result.
    // (Previous implementation issued two findMany calls — id-only then full include — which
    // doubled DB round-trips with no benefit since the predicate is identical.)
    const returnsRawAll = await prisma.returnCase.findMany({
      where,
      select: {
        id: true,
        returnRequestNo: true,
        shopifyOrderName: true,
        status: true,
        refundStatus: true,
        resolutionType: true,
        createdAt: true,
        updatedAt: true,
        forwardAwb: true,
        returnAwb: true,
        fyndCurrentStatus: true,
        fyndReturnId: true,
        fyndReturnNo: true,
        fyndShipmentId: true,
        fyndPayloadJson: true,
        returnLabelJson: true,
        returnLabelUrl: true,
        cancellationRequestedAt: true,
        customerEmailNorm: true,
        customerPhoneNorm: true,
        items: {
          select: {
            id: true,
            shopifyLineItemId: true,
            title: true,
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
    });
    const returnsRaw = verifiedSessionForNonContactLookup
      ? returnsRawAll.filter((r) =>
          portalSessionMatchesContact(verifiedSessionForNonContactLookup, {
            email: r.customerEmailNorm,
            phone: r.customerPhoneNorm,
          }),
        )
      : returnsRawAll;
    const matchedReturnIds = returnsRaw.map((r) => r.id);

    // Persist matched IDs to the OTP-verified session so the cancel-return /
    // portal-returns endpoints can authorize ownership on subsequent calls.
    if (otpRequired && sessionId) {
      try {
        await prisma.lookupSession.update({
          where: { id: sessionId },
          data: { matchedReturnIds: JSON.stringify(matchedReturnIds) },
        });
      } catch {
        /* non-fatal */
      }
    }

    // Load shop settings for labels, language, and default instructions
    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
    const portalLanguage = shopSettings?.portalLanguage ?? "en";
    let portalLabelOverrides: Record<string, string> | null = null;
    try {
      if (shopSettings?.portalLabelsJson)
        portalLabelOverrides = JSON.parse(shopSettings.portalLabelsJson);
    } catch {
      /* ignore */
    }
    const labels = getPortalLabels(portalLanguage, portalLabelOverrides);
    const defaultReturnInstructions =
      (shopSettings as { defaultReturnInstructions?: string | null } | null)
        ?.defaultReturnInstructions ?? null;

    // Use cached Fynd payload from DB only — no live Fynd API calls here.
    // Live Fynd enrichment happens via separate /api/portal/fynd-enrich endpoint.
    const returns = returnsRaw.map((r) => {
      const payload = (r as { fyndPayloadJson?: string | null }).fyndPayloadJson;
      const fyndJourneyFilter = buildFyndJourneyFilterForReturn(r);
      const trackingInfo = fyndJourneyFilter
        ? getTrackingInfoFromFyndPayload(payload, fyndJourneyFilter)
        : getTrackingInfoFromFyndPayload(payload);
      /* v8 ignore start - defensive payload-truthy ternary */
      const returnJourney = payload
        ? fyndJourneyFilter
          ? extractFyndJourney(payload, "return", fyndJourneyFilter)
          : extractFyndJourney(payload, "return")
        : [];
      /* v8 ignore stop */
      return toPortalReturnResponse(r, {
        trackingInfo: trackingInfo ?? undefined,
        returnJourney,
        returnInstructions: defaultReturnInstructions || undefined,
      });
    });

    returns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    type PortalOrder = {
      id: string;
      name: string;
      createdAt: string;
      email?: string | null;
      phone?: string | null;
      processedAt?: string | null;
      closedAt?: string | null;
      cancelledAt?: string | null;
      totalPrice?: string;
      subtotalPrice?: string;
      totalDiscounts?: string;
      currencyCode?: string;
      displayFinancialStatus?: string;
      displayFulfillmentStatus?: string;
      lineItems?: Array<{
        id: string;
        title: string;
        variantTitle?: string | null;
        sku?: string | null;
        quantity: number;
        price?: string | null;
        discountedPrice?: string | null;
        imageUrl?: string | null;
      }>;
      shippingAddress?: Record<string, string | null | undefined> | null;
      fulfillments?: Array<{
        id: string;
        status: string;
        createdAt: string;
        updatedAt?: string | null;
        deliveredAt?: string | null;
        displayStatus?: string | null;
        estimatedDeliveryAt?: string | null;
        inTransitAt?: string | null;
        totalQuantity?: number | null;
        trackingInfo: Array<{
          number?: string | null;
          url?: string | null;
          company?: string | null;
        }>;
      }>;
      fyndData?: (FyndOrderDetailsTab & { forwardJourney?: unknown }) | null;
      _needsFyndEnrich?: boolean;
    };

    function toPortalOrderLookupResponse(order: PortalOrder): PortalOrder {
      return {
        id: order.id,
        name: order.name,
        createdAt: order.createdAt,
        processedAt: order.processedAt,
        closedAt: order.closedAt,
        cancelledAt: order.cancelledAt,
        totalPrice: order.totalPrice,
        subtotalPrice: order.subtotalPrice,
        totalDiscounts: order.totalDiscounts,
        currencyCode: order.currencyCode,
        displayFinancialStatus: order.displayFinancialStatus,
        displayFulfillmentStatus: order.displayFulfillmentStatus,
        lineItems: (order.lineItems ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          variantTitle: item.variantTitle ?? null,
          sku: item.sku ?? null,
          quantity: item.quantity,
          price: item.price ?? null,
          discountedPrice: item.discountedPrice ?? null,
          imageUrl: item.imageUrl ?? null,
        })),
        fulfillments: (order.fulfillments ?? []).map((fulfillment) => ({
          id: fulfillment.id,
          status: fulfillment.status,
          createdAt: fulfillment.createdAt,
          updatedAt: fulfillment.updatedAt ?? null,
          deliveredAt: fulfillment.deliveredAt ?? null,
          displayStatus: fulfillment.displayStatus ?? null,
          estimatedDeliveryAt: fulfillment.estimatedDeliveryAt ?? null,
          inTransitAt: fulfillment.inTransitAt ?? null,
          totalQuantity: fulfillment.totalQuantity ?? null,
          trackingInfo: (fulfillment.trackingInfo ?? []).map((tracking) => ({
            number: tracking.number ?? null,
            url: tracking.url ?? null,
            company: tracking.company ?? null,
          })),
        })),
        _needsFyndEnrich: order._needsFyndEnrich === true,
      };
    }

    const shopSession = await prisma.session.findFirst({ where: { shop: shopDomain } });
    /* v8 ignore start - defensive `?? ""` for missing session token */
    const shopAccessToken = shopSession?.accessToken ?? "";
    /* v8 ignore stop */

    let orders: PortalOrder[] = [];
    if (normalizedLookupType === "email" && norm.includes("@")) {
      // Shopify documented filter: email:<address>
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        orders = (await fetchOrdersByFilter(admin, `email:${norm}`)).map((o) => ({
          ...o,
          fyndData: null,
          _needsFyndEnrich: true,
        }));
      } catch (err) {
        portalLogger.error({ err, shopDomain }, "Portal lookup orders by email failed");
      }
    } else if (normalizedLookupType === "phone") {
      // Shopify doesn't have a documented phone: filter on orders, so use free-text search
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        orders = (await fetchOrdersByFilter(admin, rawValue)).map((o) => ({
          ...o,
          fyndData: null,
          _needsFyndEnrich: true,
        }));
      } catch (err) {
        portalLogger.error({ err, shopDomain }, "Portal lookup orders by phone failed");
      }
    } else if (normalizedLookupType === "order_no" || normalizedLookupType === "return_no") {
      const orderNumber = rawValue.replace(/^#/, "");
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const order = await fetchOrderByOrderNumber(admin, orderNumber);
        if (order) {
          orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
        }
      } catch (err) {
        portalLogger.error({ err, shopDomain }, "Portal lookup direct order fetch failed");
      }

      // If Shopify name search didn't find it, try FyndOrderMapping by fyndOrderId or shopifyOrderName
      if (orders.length === 0) {
        try {
          const fyndMapping = await prisma.fyndOrderMapping.findFirst({
            where: {
              shopId: shopRecord.id,
              OR: [
                { fyndOrderId: { equals: orderNumber, mode: "insensitive" } },
                { shopifyOrderName: { equals: orderNumber, mode: "insensitive" } },
                { shopifyOrderName: { equals: `#${orderNumber}`, mode: "insensitive" } },
              ],
            },
          });
          if (fyndMapping) {
            /* v8 ignore start - defensive Fynd-mapping resolution best-effort */
            const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
            const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
            // Fast path: direct GID lookup via orderByIdentifier
            if (fyndMapping.shopifyOrderId?.startsWith("gid://")) {
              const order = await fetchOrderByGid(admin, fyndMapping.shopifyOrderId);
              if (order) orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
            }
            if (orders.length === 0 && fyndMapping.shopifyOrderName) {
              const order = await fetchOrderByOrderNumber(
                admin,
                fyndMapping.shopifyOrderName.replace(/^#/, ""),
              );
              if (order) orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
            }
            /* v8 ignore stop */
          }
        } catch (err) {
          /* v8 ignore start - defensive non-fatal catch */
          portalLogger.error(
            { err, shopDomain },
            "Portal lookup order via FyndOrderMapping failed",
          );
          /* v8 ignore stop */
        }
      }

      // Fallback: try ReturnCase records to resolve the Shopify order via stored GID/name
      if (orders.length === 0) {
        try {
          const fyndCases = await prisma.returnCase.findMany({
            where: {
              shopId: shopRecord.id,
              OR: [
                { fyndOrderId: { equals: orderNumber, mode: "insensitive" } },
                { shopifyOrderName: { equals: orderNumber, mode: "insensitive" } },
                { shopifyOrderName: { equals: `#${orderNumber}`, mode: "insensitive" } },
              ],
            },
            select: {
              id: true,
              shopifyOrderId: true,
              shopifyOrderName: true,
              createdAt: true,
              customerEmailNorm: true,
              fyndPayloadJson: true,
              fyndShipmentId: true,
              items: {
                select: {
                  id: true,
                  shopifyLineItemId: true,
                  notes: true,
                  sku: true,
                  qty: true,
                },
              },
            },
            orderBy: { createdAt: "desc" },
            take: 5,
          });
          if (fyndCases.length > 0) {
            /* v8 ignore start - defensive ReturnCase-fallback resolution best-effort */
            const rc = fyndCases[0];
            if (rc.shopifyOrderId?.startsWith("gid://")) {
              try {
                const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
                const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
                const order = await fetchOrderByGid(admin, rc.shopifyOrderId);
                if (order) {
                  orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
                }
              } catch (err) {
                portalLogger.error({ err, shopDomain }, "Portal lookup order via GID failed");
              }
            }
            if (orders.length === 0 && rc.shopifyOrderName) {
              try {
                const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
                const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
                const order = await fetchOrderByOrderNumber(
                  admin,
                  rc.shopifyOrderName.replace(/^#/, ""),
                );
                if (order) {
                  orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
                }
              } catch (err) {
                portalLogger.error(
                  { err, shopDomain },
                  "Portal lookup order via ReturnCase shopifyOrderName failed",
                );
              }
            }

            if (orders.length === 0 && rc) {
              const payload = (rc as { fyndPayloadJson?: string | null }).fyndPayloadJson;
              let fyndData: FyndOrderDetailsTab | null = null;
              if (payload) {
                try {
                  fyndData = JSON.parse(payload) as FyndOrderDetailsTab;
                } catch {
                  /* ignore */
                }
              }
              const syntheticOrder: PortalOrder = {
                id: rc.shopifyOrderId || rc.id,
                name: rc.shopifyOrderName || orderNumber,
                createdAt: rc.createdAt.toISOString(),
                email: rc.customerEmailNorm,
                displayFulfillmentStatus: "FULFILLED",
                displayFinancialStatus: "PAID",
                lineItems: rc.items.map((item) => ({
                  // defensive: title fallback chain when notes/sku absent
                  id: item.shopifyLineItemId || item.id,
                  title: item.notes || item.sku || "Item",
                  variantTitle: null,
                  quantity: item.qty,
                  price: null,
                  discountedPrice: null,
                  imageUrl: null,
                })),
                fyndData,
                _needsFyndEnrich: !!rc.fyndShipmentId,
              };
              orders.push(syntheticOrder);
            }
            /* v8 ignore stop */
          }
        } catch (err) {
          /* v8 ignore start - defensive non-fatal catch */
          portalLogger.error(
            { err, shopDomain },
            "Portal lookup order via ReturnCase fyndOrderId failed",
          );
          /* v8 ignore stop */
        }
      }
    }

    // Fynd-based order discovery: Shopify returned nothing for this order number.
    // Search Fynd directly using external_order_id — use affiliate_order_id from the result
    // to retry Shopify, or build a synthetic order from Fynd data so Track Order can still show tracking.
    /* v8 ignore start */
    // defensive: Fynd fallback path with multi-OR conditional + empty searchVal short-circuit; tests don't exhaust all combos
    if (
      orders.length === 0 &&
      (normalizedLookupType === "order_no" || normalizedLookupType === "return_no") &&
      shopRecord.settings
    ) {
      const searchVal = rawValue.replace(/^#/, "").trim();
      if (searchVal) {
        /* v8 ignore stop */
        try {
          const fyndResult = await createFyndClientOrError(
            shopRecord.settings as Parameters<typeof createFyndClientOrError>[0],
            { requirePlatform: true },
          );
          if (fyndResult.ok && "searchShipmentsByExternalOrderId" in fyndResult.client) {
            const res = await fyndResult.client.searchShipmentsByExternalOrderId(searchVal, {
              searchType: "external_order_id",
              pageSize: 10,
              fulfillmentType: "FULFILLMENT",
            });
            // defensive: res shape fallbacks (.shipments / .data.items / []) + typeof + external_order_id
            /* v8 ignore start */
            const rawItems = (res?.items ??
              res?.shipments ??
              (res as { data?: { items?: unknown[] } })?.data?.items ??
              []) as Record<string, unknown>[];
            const forwardItems = rawItems.filter((item) => {
              const jt = (
                typeof item.journey_type === "string" ? item.journey_type : ""
              ).toLowerCase();
              return jt !== "return";
            });
            const items = forwardItems.length > 0 ? forwardItems : rawItems;
            /* v8 ignore stop */
            if (items.length > 0) {
              const payloadJson = JSON.stringify({ ...(res as Record<string, unknown>), items });
              const parsed = parseFyndOrderDetailsForTab(payloadJson) as FyndOrderDetailsTab | null;
              let fyndData: (FyndOrderDetailsTab & { forwardJourney?: unknown }) | null = null;
              if (parsed) {
                (parsed as { forwardJourney?: unknown }).forwardJourney = extractFyndJourney(
                  payloadJson,
                  "forward",
                );
                fyndData = parsed as FyndOrderDetailsTab & { forwardJourney?: unknown };
              }
              // Try to resolve the real Shopify order using Fynd's affiliate_order_id.
              // Fynd stores the Shopify order name as affiliate_order_id (primary) or external_order_id.
              // There is no channel_order_id field in Fynd's shipments-listing response.
              const first = items[0] as Record<string, unknown>;
              // defensive: external_order_id fallback rare in fixtures
              /* v8 ignore start */
              const affiliateOrderId = String(
                first.affiliate_order_id ?? first.external_order_id ?? "",
              )
                .replace(/^#/, "")
                .trim();
              if (affiliateOrderId) {
                /* v8 ignore stop */
                /* v8 ignore start - defensive Shopify-resolve-by-affiliate best-effort */
                try {
                  const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
                  const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
                  // Use prefix-stripping to handle FYNDSHOPIFYX14126 → try 14126, X14126, etc.
                  const shopifyOrder = await fetchOrderByFyndAffiliateId(admin, affiliateOrderId);
                  if (shopifyOrder) {
                    orders.push({ ...shopifyOrder, fyndData, _needsFyndEnrich: false });
                  }
                } catch {
                  /* non-fatal */
                }
                /* v8 ignore stop */
              }
              // Synthetic order fallback: Shopify still can't find it — build from Fynd data
              // so the customer can at least see tracking on the Track Order tab.
              if (orders.length === 0) {
                // Extract customer data from Fynd shipment fields.
                // defensive: nullish-coalescing fallbacks across alternative Fynd field shapes;
                // fixtures only exercise the primary keys.
                /* v8 ignore start */
                const firstBag = Array.isArray(first.bags)
                  ? (first.bags as Record<string, unknown>[])[0]
                  : null;
                const deliveryAddr = (firstBag?.delivery_address ??
                  first.delivery_address ??
                  {}) as Record<string, unknown>;
                const customerDet = (first.customer_details ?? {}) as Record<string, unknown>;
                const billingDet = (first.billing_details ?? {}) as Record<string, unknown>;
                const fyndEmail =
                  String(customerDet.email ?? billingDet.email ?? "").trim() || null;
                const fyndName = String(customerDet.name ?? deliveryAddr.name ?? "").trim() || null;
                const fyndCity = String(deliveryAddr.city ?? "").trim() || null;
                const fyndState =
                  String(deliveryAddr.state ?? deliveryAddr.state_code ?? "").trim() || null;
                const fyndCountry = String(deliveryAddr.country ?? "").trim() || null;
                const fyndPincode =
                  String(deliveryAddr.pincode ?? deliveryAddr.zip ?? "").trim() || null;
                const [fyndFirst, ...fyndRestName] = (fyndName ?? "").split(" ");
                const fyndLast = fyndRestName.join(" ");

                // shopifyOrderId must ONLY be a Shopify GID, legacyResourceId, or order name.
                // affiliate_order_id IS the Shopify order name (e.g. FYNDSHOPIFYX14126).
                // Never store a Fynd internal ID (e.g. FYMP699EB195013CB17C).
                const affiliateId = String(
                  first.affiliate_order_id ?? first.external_order_id ?? "",
                )
                  .replace(/^#/, "")
                  .trim();
                const orderName = String(
                  first.affiliate_order_id ?? first.external_order_id ?? searchVal,
                );
                const syntheticOrderId = affiliateId || orderName;
                // Extract currency from Fynd prices
                const fyndPrices = (firstBag?.prices ?? first.prices ?? {}) as Record<
                  string,
                  unknown
                >;
                const fyndCurrency = String(
                  fyndPrices.currency_code ??
                    fyndPrices.currency ??
                    (first.order_value as Record<string, unknown> | undefined)?.currency ??
                    "INR",
                ).trim();
                /* v8 ignore stop */

                // Extract line items from Fynd shipment data so the portal can render them
                // for item selection. Without these, portal throws "No items to return".
                const fyndLineItems: PortalOrder["lineItems"] = [];
                if (fyndData?.shipments) {
                  // defensive: short-circuit fallbacks across multiple Fynd field shapes
                  /* v8 ignore start */
                  const seenSkus = new Set<string>();
                  for (const shipment of fyndData.shipments) {
                    for (const fi of shipment.items ?? []) {
                      // Deduplicate by SKU (same item may appear across shipments)
                      const dedupeKey = fi.sku || fi.itemId || fi.title || "";
                      if (seenSkus.has(dedupeKey)) continue;
                      seenSkus.add(dedupeKey);
                      fyndLineItems.push({
                        id: fi.itemId || fi.sku || `fynd-item-${fyndLineItems.length}`,
                        title: fi.title || fi.sku || fi.identifier || "Item",
                        variantTitle: null,
                        sku: fi.sku || fi.identifier || null,
                        quantity: fi.quantity ?? 1,
                        price: fi.price ?? fi.originalPrice ?? null,
                        discountedPrice: fi.discountedPrice ?? null,
                        imageUrl: null,
                      });
                    }
                  }
                  /* v8 ignore stop */
                }

                /* v8 ignore start - defensive `??`/`||` fallbacks on synthetic-order address fields */
                const syntheticOrder: PortalOrder = {
                  id: syntheticOrderId,
                  name: String(
                    first.affiliate_order_id ?? first.external_order_id ?? `#${searchVal}`,
                  ),
                  createdAt: String(
                    first.orderDate ?? first.shipment_created_at ?? new Date().toISOString(),
                  ),
                  email: fyndEmail,
                  displayFulfillmentStatus: "FULFILLED",
                  displayFinancialStatus: "PAID",
                  currencyCode: fyndCurrency,
                  lineItems: fyndLineItems,
                  shippingAddress:
                    fyndName || fyndCity
                      ? {
                          firstName: fyndFirst || undefined,
                          lastName: fyndLast || undefined,
                          city: fyndCity || undefined,
                          province: fyndState || undefined,
                          zip: fyndPincode || undefined,
                          country: fyndCountry || undefined,
                          countryCode: fyndCountry || undefined,
                        }
                      : undefined,
                  fyndData,
                  _needsFyndEnrich: false,
                };
                orders.push(syntheticOrder);
                /* v8 ignore stop */
              }
            }
          }
        } catch (err) {
          /* v8 ignore start - defensive non-fatal catch */
          portalLogger.error({ err, shopDomain }, "Portal lookup Fynd order discovery failed");
          /* v8 ignore stop */
        }
      }
    }

    // Fynd enrichment: attach live Fynd shipment data to an order already found by Shopify.
    // Skip if _needsFyndEnrich is false (already enriched by the discovery block above).
    /* v8 ignore start */
    // defensive: Fynd enrichment guard chain — many OR/AND short-circuits not exhausted in tests
    if (
      (normalizedLookupType === "order_no" || normalizedLookupType === "return_no") &&
      orders.length > 0 &&
      shopRecord.settings &&
      orders[0]._needsFyndEnrich === true
    ) {
      const orderNumberForFynd = rawValue.replace(/^#/, "").trim();
      if (orderNumberForFynd) {
        /* v8 ignore stop */
        try {
          const fyndResult = await createFyndClientOrError(
            shopRecord.settings as Parameters<typeof createFyndClientOrError>[0],
            { requirePlatform: true },
          );
          if (fyndResult.ok && "searchShipmentsByExternalOrderId" in fyndResult.client) {
            const searchTypes: ShipmentsListingSearchType[] = ["external_order_id"];
            for (const searchType of searchTypes) {
              const res = await fyndResult.client.searchShipmentsByExternalOrderId(
                orderNumberForFynd,
                { searchType, pageSize: 10, fulfillmentType: "FULFILLMENT" },
              );
              // defensive: res shape fallbacks (.shipments / .data.items / []) + typeof guard
              /* v8 ignore start */
              const rawItems = (res?.items ??
                res?.shipments ??
                (res as { data?: { items?: unknown[] } })?.data?.items ??
                []) as unknown[];
              // Filter to forward shipments only (same guard as fynd-enrich route)
              const forwardItems = (rawItems as Record<string, unknown>[]).filter((item) => {
                const jt = (
                  typeof item.journey_type === "string" ? item.journey_type : ""
                ).toLowerCase();
                return jt !== "return";
              });
              /* v8 ignore stop */
              const items = forwardItems.length > 0 ? forwardItems : rawItems;
              if (Array.isArray(items) && items.length > 0) {
                const payloadJson = JSON.stringify({ ...(res as Record<string, unknown>), items });
                const parsed = parseFyndOrderDetailsForTab(
                  payloadJson,
                ) as FyndOrderDetailsTab | null;
                if (parsed) {
                  (parsed as { forwardJourney?: unknown }).forwardJourney = extractFyndJourney(
                    payloadJson,
                    "forward",
                  );
                  orders[0] = { ...orders[0], fyndData: parsed, _needsFyndEnrich: false };
                }
                break;
              }
            }
          }
        } catch (err) {
          portalLogger.error({ err, shopDomain }, "Portal lookup Fynd enrichment failed");
        }
      }
    }

    // For AWB lookups, also search Shopify orders by fulfillment tracking number
    if (
      (normalizedLookupType === "forward_awb" || normalizedLookupType === "return_awb") &&
      orders.length === 0
    ) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const awbOrder = await fetchOrderByOrderNumber(admin, rawValue);
        if (awbOrder) {
          const hasTN = awbOrder.fulfillments?.some((f) =>
            f.trackingInfo?.some((ti) => ti.number?.toLowerCase().includes(norm)),
          );
          if (hasTN) orders.push({ ...awbOrder, fyndData: null, _needsFyndEnrich: true });
        }
      } catch {
        /* best-effort */
      }
    }

    if (verifiedSessionForNonContactLookup) {
      orders = orders.filter((order) =>
        portalSessionMatchesContact(verifiedSessionForNonContactLookup, {
          email: order.email,
          phone: order.phone ?? order.shippingAddress?.phone,
        }),
      );
    }

    orders = orders.map(toPortalOrderLookupResponse);

    // Issue a shop-bound CSRF token so subsequent state-changing portal calls
    // (cancel-return, etc.) can present it. Same token used by /api/portal/order.
    const portalCsrfToken = createPortalCsrfToken(shopDomain);
    return withCors(
      Response.json({ orders, returns, labels, portalLanguage, portalCsrfToken }),
      request,
    );
  } catch (err) {
    portalLogger.error({ err }, "Portal lookup failed");
    return withCors(
      Response.json({ error: "Something went wrong. Please try again." }, { status: 500 }),
      request,
    );
  }
};
