import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fetchOrderByOrderNumber, OrderAccessError } from "../lib/shopify-admin.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import shopify from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const orderNumber = url.searchParams.get("orderNumber");
  if (!shopParam || !orderNumber) {
    return withCors(Response.json({ error: "shop and orderNumber required" }, { status: 400 }), request);
  }
  const shopDomain = shopParam.includes(".") ? shopParam : `${shopParam}.myshopify.com`;

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  try {
    const { admin } = await shopify.unauthenticated.admin(shopDomain);
    const order = await fetchOrderByOrderNumber(admin, orderNumber);
    if (!order) {
      return withCors(Response.json({ error: "Order not found" }, { status: 404 }), request);
    }
    return withCors(Response.json({ order }), request);
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
