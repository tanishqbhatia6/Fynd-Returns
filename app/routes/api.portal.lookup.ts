import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { hashLookupValue } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { getTrackingInfoFromFyndPayload, parseFyndOrderDetailsForTab, extractFyndJourney, getPickupAddressFromFyndPayload, type FyndOrderDetailsTab } from "../lib/fynd-payload.server";
import { fetchOrdersByCustomer, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { createFyndClientOrError, type FyndClientResult, type ShipmentsListingSearchType } from "../lib/fynd.server";
import shopify from "../shopify.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";

type FyndClient = Extract<FyndClientResult, { ok: true }>["client"];

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

    const shopWithSettings = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    const settingsForFynd = shopWithSettings?.settings as Parameters<typeof createFyndClientOrError>[0] | null;
    let fyndClient: FyndClient | null = null;
    if (settingsForFynd) {
      const fyndResult = await createFyndClientOrError(settingsForFynd, { requirePlatform: true });
      if (fyndResult.ok) fyndClient = fyndResult.client;
    }

    const FYND_CONCURRENCY = 3;
    const MAX_FYND_LOOKUPS = 10;

    async function enrichReturn(r: typeof returnsRaw[0]) {
      let payload = (r as { fyndPayloadJson?: string | null }).fyndPayloadJson;

      if (fyndClient && "searchShipmentsByExternalOrderId" in fyndClient && r.shopifyOrderName && r.fyndShipmentId) {
        try {
          const orderNumber = r.shopifyOrderName.replace(/^#/, "");
          const searchResult = await fyndClient.searchShipmentsByExternalOrderId(orderNumber, {
            fulfillmentType: "RETURN"
          });
          const items = searchResult?.items || searchResult?.shipments || searchResult?.data?.items || (searchResult as Record<string, unknown>)?.results || [];
          const matchedShipment = (items as Record<string, unknown>[]).find((s) => String(s.shipment_id || s.id) === String(r.fyndShipmentId));
          if (matchedShipment) {
            payload = JSON.stringify([matchedShipment]);
          }
        } catch (fErr) {
          console.warn("Could not fetch realtime tracking for return", r.id, fErr);
        }
      }

      const trackingInfo = getTrackingInfoFromFyndPayload(payload);
      const returnJourney = payload ? extractFyndJourney(payload, "return") : [];
      const pickupAddress = getPickupAddressFromFyndPayload(payload);
      return {
        ...r,
        trackingInfo: trackingInfo ?? undefined,
        returnJourney,
        pickupAddress: pickupAddress ?? undefined,
      };
    }

    const returnsNeedingFynd = returnsRaw.filter((r) => r.shopifyOrderName && r.fyndShipmentId).slice(0, MAX_FYND_LOOKUPS);
    const returnsWithoutFynd = returnsRaw.filter((r) => !returnsNeedingFynd.includes(r));

    const returns: Awaited<ReturnType<typeof enrichReturn>>[] = [];

    for (let i = 0; i < returnsNeedingFynd.length; i += FYND_CONCURRENCY) {
      const batch = returnsNeedingFynd.slice(i, i + FYND_CONCURRENCY);
      const results = await Promise.all(batch.map(enrichReturn));
      returns.push(...results);
    }

    for (const r of returnsWithoutFynd) {
      const payload = (r as { fyndPayloadJson?: string | null }).fyndPayloadJson;
      const trackingInfo = getTrackingInfoFromFyndPayload(payload);
      const returnJourney = payload ? extractFyndJourney(payload, "return") : [];
      const pickupAddress = getPickupAddressFromFyndPayload(payload);
      returns.push({ ...r, trackingInfo: trackingInfo ?? undefined, returnJourney, pickupAddress: pickupAddress ?? undefined });
    }

    returns.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    type PortalOrder = {
      id: string; name: string; createdAt: string; email?: string | null;
      totalPrice?: string; subtotalPrice?: string; totalDiscounts?: string;
      currencyCode?: string;
      displayFinancialStatus?: string; displayFulfillmentStatus?: string;
      lineItems?: Array<{ id: string; title: string; variantTitle?: string | null; quantity: number; price?: string | null; discountedPrice?: string | null; imageUrl?: string | null }>;
      shippingAddress?: Record<string, string | null | undefined> | null;
      fyndData?: (FyndOrderDetailsTab & { forwardJourney?: unknown }) | null;
    };
    let orders: PortalOrder[] = [];
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
            const FYND_ENRICH_TIMEOUT = 12_000;
            const enrichPromise = (async () => {
              const extractSearchItems = (res: Record<string, unknown>): unknown[] => {
                const candidates = [res?.items, res?.shipments, (res?.data as Record<string, unknown>)?.items, res?.results];
                for (const c of candidates) { if (Array.isArray(c) && c.length > 0) return c; }
                return [];
              };

              // Check persistent cache first
              let cachedMapping: { fyndOrderId?: string | null; fyndShipmentId?: string | null; searchStrategy?: string | null } | null = null;
              try {
                cachedMapping = await prisma.fyndOrderMapping.findUnique({
                  where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: order.name } },
                });
              } catch { /* cache miss is fine */ }

              // Build all search candidates upfront
              const searchCandidates: Array<{ value: string; type: ShipmentsListingSearchType; strategy: string }> = [];

              // If we have a cached mapping, try it first
              if (cachedMapping?.fyndOrderId) {
                searchCandidates.push({ value: cachedMapping.fyndOrderId, type: "order_id" as ShipmentsListingSearchType, strategy: "cached_order_id" });
              }
              if (cachedMapping?.fyndShipmentId) {
                searchCandidates.push({ value: cachedMapping.fyndShipmentId, type: "shipment_id" as ShipmentsListingSearchType, strategy: "cached_shipment_id" });
              }

              searchCandidates.push({ value: orderNumber, type: "external_order_id", strategy: "external_order_id" });
              const numericPart = orderNumber.replace(/^[A-Za-z]+/i, "");
              if (numericPart && numericPart !== orderNumber) {
                searchCandidates.push({ value: numericPart, type: "external_order_id", strategy: "stripped_prefix" });
              }
              if (order.name) {
                searchCandidates.push({ value: order.name.replace(/^#/, ""), type: "channel_order_id", strategy: "channel_order_id" });
              }
              if (order.affiliateOrderId) {
                searchCandidates.push({ value: order.affiliateOrderId, type: "channel_order_id", strategy: "affiliate_order_id" });
              }
              if (order.id) {
                searchCandidates.push({ value: order.id.split("/").pop() || "", type: "order_id", strategy: "shopify_gid" });
              }

              for (const candidate of searchCandidates) {
                if (!candidate.value) continue;
                try {
                  const searchResult = await fyndClient.searchShipmentsByExternalOrderId(candidate.value, {
                    fulfillmentType: "FULFILLMENT",
                    parentViewSlug: "all",
                    childViewSlug: "all",
                    searchType: candidate.type,
                  });
                  const items = extractSearchItems(searchResult as Record<string, unknown>);
                  if (items.length > 0) {
                    const payloadJson = JSON.stringify(searchResult);
                    const parsed = parseFyndOrderDetailsForTab(payloadJson);
                    if (parsed) {
                      (parsed as { forwardJourney?: unknown }).forwardJourney = extractFyndJourney(payloadJson, "forward");
                    }

                    // Cache successful mapping for future lookups
                    const firstItem = items[0] as Record<string, unknown>;
                    const mappedFyndOrderId = String(firstItem?.order_id ?? firstItem?.fynd_order_id ?? candidate.value ?? "");
                    const mappedFyndShipmentId = String(firstItem?.shipment_id ?? firstItem?.id ?? "");
                    if (mappedFyndOrderId || mappedFyndShipmentId) {
                      prisma.fyndOrderMapping.upsert({
                        where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: order.name } },
                        create: {
                          shopId: shopRecord.id,
                          shopifyOrderName: order.name,
                          shopifyOrderId: order.id,
                          fyndOrderId: mappedFyndOrderId || null,
                          fyndShipmentId: mappedFyndShipmentId || null,
                          searchStrategy: candidate.strategy,
                        },
                        update: {
                          fyndOrderId: mappedFyndOrderId || undefined,
                          fyndShipmentId: mappedFyndShipmentId || undefined,
                          searchStrategy: candidate.strategy,
                        },
                      }).catch(() => { /* Non-fatal cache write */ });
                    }

                    return parsed;
                  }
                } catch {
                  continue;
                }
              }
              return null;
            })();

            try {
              fyndData = await Promise.race([
                enrichPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), FYND_ENRICH_TIMEOUT)),
              ]);
            } catch (fErr) {
              console.warn("Fynd enrichment failed for order", orderNumber, fErr);
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
    return withCors(Response.json({ error: "Something went wrong. Please try again." }, { status: 500 }), request);
  }
};
