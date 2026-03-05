import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fetchOrderByOrderNumber, OrderAccessError } from "../lib/shopify-admin.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import shopify from "../shopify.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { parseJsonArray } from "../lib/parse-json";

/**
 * Portal order lookup API.
 * Returns order details + any existing return cases for the order.
 * This allows the portal to show existing return status instead of
 * allowing duplicate return creation.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }

  const rl = checkRateLimit(request, "portal.order");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").replace(/^#/, "").replace(/[^\w\-]/g, "").trim();
  if (!shopParam) {
    return withCors(Response.json({ error: "Shop is required" }, { status: 400 }), request);
  }
  if (!orderNumber || orderNumber.length > 64) {
    return withCors(Response.json({ error: "Valid order number is required" }, { status: 400 }), request);
  }
  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  // Check for existing return cases for this order (by order name, fyndOrderId, or fyndShipmentId)
  const existingReturns = await prisma.returnCase.findMany({
    where: {
      shopId: shopRecord.id,
      OR: [
        { shopifyOrderName: { in: [`#${orderNumber}`, orderNumber] } },
        { fyndOrderId: { contains: orderNumber, mode: "insensitive" } },
      ],
    },
    include: {
      items: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // Format existing returns for the portal
  const formattedReturns = existingReturns.map((r) => ({
    id: r.id,
    returnRequestId: r.returnRequestNo ?? formatReturnRequestId(r.id),
    status: r.status,
    refundStatus: r.refundStatus,
    createdAt: r.createdAt,
    fyndReturnNo: r.fyndReturnNo,
    items: r.items.map((i) => ({
      lineItemId: i.shopifyLineItemId,
      title: i.notes || i.sku || i.shopifyLineItemId,
      sku: i.sku,
      qty: i.qty,
      reasonCode: i.reasonCode,
    })),
  }));

  // Active returns = non-terminal statuses
  const ACTIVE_STATUSES = ["initiated", "pending", "processing", "in progress", "approved"];
  const activeReturns = formattedReturns.filter((r) =>
    ACTIVE_STATUSES.includes(r.status?.toLowerCase() ?? "")
  );

  try {
    const { admin } = await shopify.unauthenticated.admin(shopDomain);
    let order = await fetchOrderByOrderNumber(admin, orderNumber);

    // If Shopify name search didn't find it, try FyndOrderMapping by fyndOrderId or shopifyOrderName
    if (!order) {
      const fyndMapping = await prisma.fyndOrderMapping.findFirst({
        where: {
          shopId: shopRecord.id,
          OR: [
            { fyndOrderId: { contains: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { in: [orderNumber, `#${orderNumber}`], mode: "insensitive" } },
          ],
        },
      });
      if (fyndMapping?.shopifyOrderName) {
        order = await fetchOrderByOrderNumber(admin, fyndMapping.shopifyOrderName.replace(/^#/, ""));
      }
    }

    // Also try ReturnCase.fyndOrderId or shopifyOrderName -> resolve Shopify order
    if (!order) {
      const fyndCase = await prisma.returnCase.findFirst({
        where: {
          shopId: shopRecord.id,
          OR: [
            { fyndOrderId: { contains: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { in: [orderNumber, `#${orderNumber}`], mode: "insensitive" } },
          ],
        },
        select: { shopifyOrderName: true },
      });
      if (fyndCase?.shopifyOrderName) {
        order = await fetchOrderByOrderNumber(admin, fyndCase.shopifyOrderName.replace(/^#/, ""));
      }
    }

    if (!order) {
      return withCors(Response.json({
        error: "Order not found",
        existingReturns: formattedReturns,
        activeReturns,
      }, { status: 404 }), request);
    }

    // Fulfillment status gate: only allow returns for fulfilled orders
    const fulfillmentStatus = (order.displayFulfillmentStatus ?? "").toUpperCase();
    const financialStatus = (order.displayFinancialStatus ?? "").toUpperCase();

    const FULFILLED_STATUSES = ["FULFILLED", "PARTIALLY_FULFILLED"];
    const BLOCKED_FINANCIAL = ["REFUNDED", "VOIDED"];
    const BLOCKED_FULFILLMENT = ["UNFULFILLED", "SCHEDULED", "ON_HOLD"];

    const isFulfilled = FULFILLED_STATUSES.includes(fulfillmentStatus);
    const isBlocked = BLOCKED_FULFILLMENT.includes(fulfillmentStatus) || BLOCKED_FINANCIAL.includes(financialStatus);

    let returnEligibility: { eligible: boolean; reason?: string } = { eligible: true };

    if (!isFulfilled || isBlocked) {
      if (financialStatus === "REFUNDED" || financialStatus === "VOIDED") {
        returnEligibility = {
          eligible: false,
          reason: "This order has already been refunded and is not eligible for a return.",
        };
      } else if (fulfillmentStatus === "UNFULFILLED" || fulfillmentStatus === "") {
        returnEligibility = {
          eligible: false,
          reason: "This order has not been shipped yet. Returns can only be created for orders that have been delivered.",
        };
      } else if (fulfillmentStatus === "ON_HOLD") {
        returnEligibility = {
          eligible: false,
          reason: "This order is currently on hold. Please contact support for assistance.",
        };
      } else if (fulfillmentStatus === "SCHEDULED") {
        returnEligibility = {
          eligible: false,
          reason: "This order is scheduled for fulfillment but has not shipped yet. Returns can only be created after delivery.",
        };
      } else if (fulfillmentStatus === "PARTIALLY_FULFILLED") {
        returnEligibility = { eligible: true };
      } else {
        returnEligibility = {
          eligible: false,
          reason: "This order is not eligible for a return at this time.",
        };
      }
    }

    // Product-level eligibility: check tags, return window, region restrictions
    if (returnEligibility.eligible) {
      const settings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
      const allProductTags = (order.lineItems ?? []).flatMap((li) => li.productTags ?? []);
      const ruleCheck = checkReturnEligibility(settings, {
        orderDate: order.createdAt ? new Date(order.createdAt) : undefined,
        productTags: allProductTags,
        customerCountry: order.shippingCountry ?? undefined,
        customerProvince: order.shippingProvince ?? undefined,
      });
      if (!ruleCheck.eligible) {
        returnEligibility = ruleCheck;
      }
    }

    // Per-item eligibility: mark items with restricted tags as non-returnable
    const settings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
    const itemEligibility = (order.lineItems ?? []).map((li) => {
      const itemCheck = checkReturnEligibility(settings, {
        orderDate: order.createdAt ? new Date(order.createdAt) : undefined,
        productTags: li.productTags ?? [],
        productPrice: li.price ? parseFloat(li.price) : undefined,
        customerCountry: order.shippingCountry ?? undefined,
        customerProvince: order.shippingProvince ?? undefined,
      });
      return { lineItemId: li.id, eligible: itemCheck.eligible, reason: itemCheck.reason };
    });

    const returnWindowDays = settings?.returnWindowDays ?? 30;
    const orderDateStr = order.processedAt ?? order.createdAt;
    let returnDeadline: string | null = null;
    let daysRemaining: number | null = null;
    if (orderDateStr) {
      const orderDate = new Date(orderDateStr);
      const deadline = new Date(orderDate);
      deadline.setDate(deadline.getDate() + returnWindowDays);
      returnDeadline = deadline.toISOString();
      daysRemaining = Math.ceil((deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    }

    // Estimated refund amounts per line item
    const returnFeeAmount = settings?.returnFeeAmount ? Number(settings.returnFeeAmount) : 0;
    const returnFeeCurrency = order.currencyCode || settings?.returnFeeCurrency || settings?.shopCurrency || "USD";
    const lineItemEstimates = (order.lineItems ?? []).map((li) => {
      const price = li.price ? parseFloat(li.price) : 0;
      const qty = li.quantity ?? 1;
      return { lineItemId: li.id, unitPrice: price, quantity: qty, subtotal: price * qty };
    });
    const itemsTotal = lineItemEstimates.reduce((s, e) => s + e.subtotal, 0);
    const estimatedRefundTotal = Math.max(0, itemsTotal - returnFeeAmount);

    // Return offers data
    let returnOffersData: { enabled: boolean; offers: Array<{ reasonCode?: string; tag?: string; offerType: string; offerValue: number; message: string }> } = { enabled: false, offers: [] };
    if (settings?.returnOffersEnabled) {
      const offersArr = parseJsonArray<{ reasonCode?: string; tag?: string; offerType: string; offerValue: number; message: string }>(settings.returnOffersJson ?? null, []);
      returnOffersData = { enabled: true, offers: offersArr };
    }

    return withCors(Response.json({
      order,
      existingReturns: formattedReturns,
      activeReturns,
      returnEligibility,
      itemEligibility,
      returnDeadline,
      daysRemaining,
      returnFee: returnFeeAmount > 0 ? { amount: returnFeeAmount, currency: returnFeeCurrency } : null,
      estimatedRefundTotal,
      lineItemEstimates,
      returnOffers: returnOffersData,
    }), request);
  } catch (err) {
    console.error("Portal order fetch:", err);
    if ((err as { name?: string }).name === "SessionNotFoundError") {
      return withCors(Response.json({ error: "Store has not connected the app. Please contact the store." }, { status: 403 }), request);
    }
    if (err instanceof OrderAccessError) {
      return withCors(
        Response.json({
          fallback: true,
          orderNumber: orderNumber?.replace(/^#/, "").trim(),
          error: "We couldn't fetch your order automatically. Use the form below to submit your return request—the store will process it manually.",
          existingReturns: formattedReturns,
          activeReturns,
        }, { status: 200 }),
        request
      );
    }
    const msg = (err as Error)?.message ?? "";
    if (msg.includes("not approved") || msg.includes("Order object") || msg.includes("protected")) {
      return withCors(
        Response.json({
          fallback: true,
          orderNumber: orderNumber?.replace(/^#/, "").trim(),
          error: "We couldn't fetch your order automatically. Use the form below to submit your return request—the store will process it manually.",
          existingReturns: formattedReturns,
          activeReturns,
        }, { status: 200 }),
        request
      );
    }
    return withCors(
      Response.json({
        fallback: true,
        orderNumber: orderNumber?.replace(/^#/, "").trim(),
        error: "We couldn't find this order automatically. Please use the form below to submit your return request.",
        existingReturns: formattedReturns,
        activeReturns,
      }, { status: 200 }),
      request
    );
  }
};
