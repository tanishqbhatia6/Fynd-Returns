import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { getTrackingInfoFromFyndPayload, extractFyndJourney, getPickupAddressFromFyndPayload, type FyndOrderDetailsTab } from "../lib/fynd-payload.server";
import { fetchOrdersByCustomer, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import shopify from "../shopify.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { getPortalLabels } from "../lib/portal-i18n";

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

  const rl = checkRateLimit(request, "portal.lookup");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const { shop, lookupType, lookupValue } = await request.json();
    if (!shop || !lookupType || !lookupValue) {
      return withCors(Response.json({ error: "shop, lookupType, lookupValue required" }, { status: 400 }), request);
    }

    // Input validation
    const VALID_LOOKUP_TYPES = ["email", "phone", "order_no", "return_no", "return_id", "forward_awb", "return_awb"];
    if (!VALID_LOOKUP_TYPES.includes(lookupType)) {
      return withCors(Response.json({ error: "Invalid lookup type" }, { status: 400 }), request);
    }
    const lookupStr = String(lookupValue).trim();
    if (lookupStr.length > 256) {
      return withCors(Response.json({ error: "Lookup value too long" }, { status: 400 }), request);
    }
    if (lookupStr.length < 2) {
      return withCors(Response.json({ error: "Lookup value too short" }, { status: 400 }), request);
    }

    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    const norm = String(lookupValue).toLowerCase().trim();
    const rawValue = String(lookupValue).trim();

    const where: Record<string, unknown> = { shopId: shopRecord.id };
    if (lookupType === "return_id") {
      const returnIdUpper = rawValue.toUpperCase();
      where.OR = [
        { id: rawValue },
        { returnRequestNo: rawValue },
        { returnRequestNo: returnIdUpper },
      ];
    } else if (["return_no", "order_no"].includes(lookupType)) {
      where.OR = [
        { fyndReturnNo: { contains: norm, mode: "insensitive" } },
        { shopifyOrderName: { contains: norm, mode: "insensitive" } },
      ];
    } else if (["forward_awb", "return_awb"].includes(lookupType)) {
      where.OR = [
        { forwardAwb: { contains: norm, mode: "insensitive" } },
        { returnAwb: { contains: norm, mode: "insensitive" } },
      ];
    } else {
      where.OR = [
        { customerEmailNorm: { contains: norm, mode: "insensitive" } },
        { customerPhoneNorm: { contains: norm, mode: "insensitive" } },
      ];
    }

    const matches = await prisma.returnCase.findMany({ where, select: { id: true } });
    const matchedReturnIds = matches.map((m) => m.id);

    const returnsRaw =
      matchedReturnIds.length > 0
        ? await prisma.returnCase.findMany({
          where: { id: { in: matchedReturnIds }, shopId: shopRecord.id },
          include: {
            items: true,
            events: { orderBy: { happenedAt: "desc" }, take: 10 },
          },
          orderBy: { createdAt: "desc" },
        })
        : [];

    // Load shop settings for labels, language, and default instructions
    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
    const portalLanguage = shopSettings?.portalLanguage ?? "en";
    let portalLabelOverrides: Record<string, string> | null = null;
    try {
      if (shopSettings?.portalLabelsJson) portalLabelOverrides = JSON.parse(shopSettings.portalLabelsJson);
    } catch { /* ignore */ }
    const labels = getPortalLabels(portalLanguage, portalLabelOverrides);
    const defaultReturnInstructions = (shopSettings as { defaultReturnInstructions?: string | null } | null)?.defaultReturnInstructions ?? null;

    // Use cached Fynd payload from DB only — no live Fynd API calls here.
    // Live Fynd enrichment happens via separate /api/portal/fynd-enrich endpoint.
    const returns = returnsRaw.map((r) => {
      const payload = (r as { fyndPayloadJson?: string | null }).fyndPayloadJson;
      const trackingInfo = getTrackingInfoFromFyndPayload(payload);
      const returnJourney = payload ? extractFyndJourney(payload, "return") : [];
      const pickupAddress = getPickupAddressFromFyndPayload(payload);

      let returnLabelInfo: { carrier?: string | null; trackingNumber?: string | null; labelUrl?: string | null; qrCodeUrl?: string | null } | null = null;
      try {
        if ((r as { returnLabelJson?: string | null }).returnLabelJson) {
          returnLabelInfo = JSON.parse((r as { returnLabelJson?: string | null }).returnLabelJson!);
        }
      } catch { /* ignore */ }

      const isApproved = ["approved", "completed"].includes((r.status || "").toLowerCase());
      return {
        ...r,
        trackingInfo: trackingInfo ?? undefined,
        returnJourney,
        pickupAddress: pickupAddress ?? undefined,
        returnLabelUrl: isApproved ? (r as { returnLabelUrl?: string | null }).returnLabelUrl : undefined,
        returnLabelInfo: isApproved ? returnLabelInfo : undefined,
        returnInstructions: isApproved ? (defaultReturnInstructions || undefined) : undefined,
        _needsFyndEnrich: !!(r.shopifyOrderName && r.fyndShipmentId),
      };
    });

    returns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    type PortalOrder = {
      id: string; name: string; createdAt: string; email?: string | null;
      processedAt?: string | null; closedAt?: string | null; cancelledAt?: string | null;
      totalPrice?: string; subtotalPrice?: string; totalDiscounts?: string;
      currencyCode?: string;
      displayFinancialStatus?: string; displayFulfillmentStatus?: string;
      lineItems?: Array<{ id: string; title: string; variantTitle?: string | null; quantity: number; price?: string | null; discountedPrice?: string | null; imageUrl?: string | null }>;
      shippingAddress?: Record<string, string | null | undefined> | null;
      fulfillments?: Array<{
        id: string; status: string; createdAt: string;
        updatedAt?: string | null; deliveredAt?: string | null;
        displayStatus?: string | null; estimatedDeliveryAt?: string | null;
        inTransitAt?: string | null; totalQuantity?: number | null;
        trackingInfo: Array<{ number?: string | null; url?: string | null; company?: string | null }>;
      }>;
      fyndData?: (FyndOrderDetailsTab & { forwardJourney?: unknown }) | null;
      _needsFyndEnrich?: boolean;
    };
    let orders: PortalOrder[] = [];
    if (lookupType === "email" && norm.includes("@")) {
      try {
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        orders = (await fetchOrdersByCustomer(admin, norm)).map((o) => ({ ...o, fyndData: null, _needsFyndEnrich: true }));
      } catch (err) {
        console.error("Portal lookup orders by email:", err);
      }
    } else if (lookupType === "order_no") {
      try {
        const orderNumber = norm.replace(/^#/, "");
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        const order = await fetchOrderByOrderNumber(admin, orderNumber);
        if (order) {
          orders.push({ ...order, fyndData: null, _needsFyndEnrich: true });
        }
      } catch (err) {
        console.error("Portal lookup order by order_no:", err);
      }
    }

    return withCors(Response.json({ orders, returns, labels, portalLanguage }), request);
  } catch (err) {
    console.error("Portal lookup:", err);
    return withCors(Response.json({ error: "Something went wrong. Please try again." }, { status: 500 }), request);
  }
};
