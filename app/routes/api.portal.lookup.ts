import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { hashLookupValue } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { getTrackingInfoFromFyndPayload, parseFyndOrderDetailsForTab } from "../lib/fynd-payload.server";
import { fetchOrdersByCustomer, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import shopify from "../shopify.server";

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
  try {
    const { shop, lookupType, lookupValue } = await request.json();
    if (!shop || !lookupType || !lookupValue) {
      return withCors(Response.json({ error: "shop, lookupType, lookupValue required" }, { status: 400 }), request);
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

    const shopWithSettings = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    const settingsForFynd = shopWithSettings?.settings as Parameters<typeof createFyndClientOrError>[0] | null;
    let fyndClient: any = null;
    if (settingsForFynd) {
      const fyndResult = await createFyndClientOrError(settingsForFynd, { requirePlatform: true });
      if (fyndResult.ok) fyndClient = fyndResult.client;
    }

    const returns = await Promise.all(returnsRaw.map(async (r) => {
      let payload = (r as { fyndPayloadJson?: string | null }).fyndPayloadJson;

      if (fyndClient && r.shopifyOrderName && r.fyndShipmentId) {
        try {
          const orderNumber = r.shopifyOrderName.replace(/^#/, "");
          const searchResult = await fyndClient.searchShipmentsByExternalOrderId(orderNumber, {
            fulfillmentType: "RETURN"
          });
          const items = searchResult?.items || searchResult?.shipments || searchResult?.data?.items || searchResult?.results || [];
          const matchedShipment = items.find((s: any) => String(s.shipment_id || s.id) === String(r.fyndShipmentId));
          if (matchedShipment) {
            payload = JSON.stringify([matchedShipment]);
          }
        } catch (fErr) {
          console.warn("Could not fetch realtime tracking for return", r.id, fErr);
        }
      }

      const trackingInfo = getTrackingInfoFromFyndPayload(payload);
      return {
        ...r,
        trackingInfo: trackingInfo ?? undefined,
      };
    }));

    let orders: Array<{ id: string; name: string; createdAt: string; email?: string | null; totalPrice?: string; displayFinancialStatus?: string; displayFulfillmentStatus?: string; fyndData?: any }> = [];
    if (lookupType === "email" && norm.includes("@")) {
      try {
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        orders = await fetchOrdersByCustomer(admin, norm);
      } catch (err) {
        console.error("Portal lookup orders by email:", err);
      }
    } else if (lookupType === "order_no") {
      try {
        const orderNumber = norm.replace(/^#/, "");
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        const order = await fetchOrderByOrderNumber(admin, orderNumber);

        let fyndData = null;
        if (order) {
          if (fyndClient && "searchShipmentsByExternalOrderId" in fyndClient) {
            try {
              let searchResult = await fyndClient.searchShipmentsByExternalOrderId(orderNumber, {
                fulfillmentType: "FULFILLMENT",
                parentViewSlug: "all",
                childViewSlug: "all"
              });
              let items = searchResult?.items || searchResult?.shipments || searchResult?.data?.items || searchResult?.results || [];

              if (items.length === 0 && order.affiliateOrderId) {
                searchResult = await fyndClient.searchShipmentsByExternalOrderId(order.affiliateOrderId, {
                  fulfillmentType: "FULFILLMENT",
                  parentViewSlug: "all",
                  childViewSlug: "all",
                  searchType: "channel_order_id"
                });
                items = searchResult?.items || searchResult?.shipments || searchResult?.data?.items || searchResult?.results || [];
              }

              if (items.length === 0 && order.id) {
                searchResult = await fyndClient.searchShipmentsByExternalOrderId(order.id.split("/").pop() || "", {
                  fulfillmentType: "FULFILLMENT",
                  parentViewSlug: "all",
                  childViewSlug: "all",
                  searchType: "order_id"
                });
                items = searchResult?.items || searchResult?.shipments || searchResult?.data?.items || searchResult?.results || [];
              }

              const payloadJson = searchResult != null ? JSON.stringify(searchResult) : null;
              if (payloadJson && items.length > 0) {
                fyndData = parseFyndOrderDetailsForTab(payloadJson);
              }
            } catch (fErr) {
              console.warn("Fynd search shipment error for order", orderNumber, fErr);
            }
          }

          orders.push({
            ...order,
            fyndData
          });
        }
      } catch (err) {
        console.error("Portal lookup order by order_no:", err);
      }
    }

    return withCors(Response.json({ orders, returns }), request);
  } catch (err) {
    console.error("Portal lookup:", err);
    return withCors(Response.json({ error: (err as Error).message }, { status: 500 }), request);
  }
};
