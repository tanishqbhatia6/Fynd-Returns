import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fetchOrderByOrderNumber, OrderAccessError } from "../lib/shopify-admin.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import shopify from "../shopify.server";
import { formatReturnRequestId } from "../lib/return-request-id";

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
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const orderNumber = (url.searchParams.get("orderNumber") ?? "").replace(/^#/, "").trim();
  if (!shopParam) {
    return withCors(Response.json({ error: "Shop is required" }, { status: 400 }), request);
  }
  if (!orderNumber) {
    return withCors(Response.json({ error: "Order number is required" }, { status: 400 }), request);
  }
  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  // Check for existing return cases for this order (by order name)
  const existingReturns = await prisma.returnCase.findMany({
    where: {
      shopId: shopRecord.id,
      shopifyOrderName: { in: [`#${orderNumber}`, orderNumber] },
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
    const order = await fetchOrderByOrderNumber(admin, orderNumber);
    if (!order) {
      return withCors(Response.json({
        error: "Order not found",
        existingReturns: formattedReturns,
        activeReturns,
      }, { status: 404 }), request);
    }
    return withCors(Response.json({
      order,
      existingReturns: formattedReturns,
      activeReturns,
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
      Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order" }, { status: 500 }),
      request
    );
  }
};
