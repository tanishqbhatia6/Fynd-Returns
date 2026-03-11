import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { parseFyndOrderDetailsForTab, extractFyndJourney, getTrackingInfoFromFyndPayload, getPickupAddressFromFyndPayload } from "../lib/fynd-payload.server";
import { createFyndClientOrError, type FyndClientResult, type ShipmentsListingSearchType } from "../lib/fynd.server";
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
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  const rl = checkRateLimit(request, "portal.fynd-enrich");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const { shop, type, orderName, returnIds } = await request.json();
    if (!shop) {
      return withCors(Response.json({ error: "shop required" }, { status: 400 }), request);
    }

    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain }, include: { settings: true } });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    const settingsForFynd = shopRecord.settings as Parameters<typeof createFyndClientOrError>[0] | null;
    let fyndClient: FyndClient | null = null;
    if (settingsForFynd) {
      const fyndResult = await createFyndClientOrError(settingsForFynd, { requirePlatform: true });
      if (fyndResult.ok) fyndClient = fyndResult.client;
    }

    if (!fyndClient || !("searchShipmentsByExternalOrderId" in fyndClient)) {
      return withCors(Response.json({ fyndData: null, returnEnrichments: {} }), request);
    }

    const extractSearchItems = (res: Record<string, unknown>): unknown[] => {
      const candidates = [res?.items, res?.shipments, (res?.data as Record<string, unknown>)?.items, res?.results];
      for (const c of candidates) { if (Array.isArray(c) && c.length > 0) return c; }
      return [];
    };

    let fyndData = null;
    if (type === "order" && orderName) {
      const orderNumber = String(orderName).replace(/^#/, "");

      // ── Search strategy ordering ───────────────────────────────────────────────
      // ALWAYS run direct name-based searches first (channel_order_id, external_order_id).
      // These use the Shopify order name as the lookup key in Fynd — the most exact and
      // unambiguous match possible.
      //
      // Cached strategies (Fynd internal order_id / shipment_id) have been REMOVED from
      // the search loop because they were the root cause of cross-order contamination:
      //   1. DB stores fyndOrderId X for order A
      //   2. By mistake X actually belongs to order B
      //   3. Cached strategy returns B's data for A → wrong status / shipment ID
      //   4. Result is re-cached, contamination persists across restarts
      //
      // The DB cache is still WRITTEN on successful direct searches so future code paths
      // can use it, but it is no longer READ as a search fallback.
      // If neither direct search finds the order → fyndData = null → Shopify data shown.

      const searchCandidates: Array<{ value: string; type: ShipmentsListingSearchType; strategy: string }> = [
        { value: orderNumber, type: "external_order_id", strategy: "external_order_id" },
      ];

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
            // Secondary client-side filter: prefer forward shipments (journey_type !== 'return').
            // This is a safety net in case Fynd ignores the fulfillment_type URL param.
            const forwardItems = (items as Record<string, unknown>[]).filter((item) => {
              const jt = (typeof item.journey_type === "string" ? item.journey_type : "").toLowerCase();
              return jt !== "return";
            });
            const effectiveItems = forwardItems.length > 0 ? forwardItems : items;

            const payloadJson = JSON.stringify({ ...searchResult as Record<string, unknown>, items: effectiveItems });
            const parsed = parseFyndOrderDetailsForTab(payloadJson);
            if (parsed) {
              (parsed as { forwardJourney?: unknown }).forwardJourney = extractFyndJourney(payloadJson, "forward");
            }

            // Cache ALL forward shipment IDs (comma-separated), not just the first one.
            const firstItem = effectiveItems[0] as Record<string, unknown>;
            const mappedFyndOrderId = String(firstItem?.order_id ?? firstItem?.fynd_order_id ?? candidate.value ?? "");
            const allShipmentIds = (effectiveItems as Record<string, unknown>[])
              .map(s => String(s.shipment_id ?? s.id ?? "")).filter(Boolean);
            const mappedFyndShipmentId = allShipmentIds.length > 0 ? allShipmentIds.join(",") : String(firstItem?.shipment_id ?? firstItem?.id ?? "");
            if (mappedFyndOrderId || mappedFyndShipmentId) {
              prisma.fyndOrderMapping.upsert({
                where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: String(orderName) } },
                create: {
                  shopId: shopRecord.id,
                  shopifyOrderName: String(orderName),
                  fyndOrderId: mappedFyndOrderId || null,
                  fyndShipmentId: mappedFyndShipmentId || null,
                  searchStrategy: candidate.strategy,
                },
                update: {
                  fyndOrderId: mappedFyndOrderId || undefined,
                  fyndShipmentId: mappedFyndShipmentId || undefined,
                  searchStrategy: candidate.strategy,
                },
              }).catch(() => {});
            }

            fyndData = parsed;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    const returnEnrichments: Record<string, unknown> = {};
    if (type === "returns" && Array.isArray(returnIds) && returnIds.length > 0) {
      const ids = returnIds.slice(0, 10).map(String);
      const returnsRaw = await prisma.returnCase.findMany({
        where: { id: { in: ids }, shopId: shopRecord.id },
        select: { id: true, shopifyOrderName: true, fyndShipmentId: true, fyndPayloadJson: true },
      });

      await Promise.all(
        returnsRaw.map(async (r) => {
          if (!r.shopifyOrderName || !r.fyndShipmentId) return;
          try {
            const orderNumber = r.shopifyOrderName.replace(/^#/, "");
            const searchResult = await fyndClient!.searchShipmentsByExternalOrderId(orderNumber, {
              fulfillmentType: "RETURN",
            });
            const items = extractSearchItems(searchResult as Record<string, unknown>);
            // Prefer return shipments only; fall back to all if journey_type is absent.
            const returnItems = (items as Record<string, unknown>[]).filter((s) => {
              const jt = (typeof s.journey_type === "string" ? s.journey_type : "").toLowerCase();
              return jt === "return" || jt.includes("return");
            });
            const candidateItems = returnItems.length > 0 ? returnItems : items;
            // Try exact match by stored fyndShipmentId first.
            // Fall back to the first return-type shipment when the stored ID is stale/wrong (e.g. bag ID).
            const exactMatch = (candidateItems as Record<string, unknown>[]).find(
              (s) => String(s.shipment_id || s.id) === String(r.fyndShipmentId)
            );
            const matched = exactMatch ?? (candidateItems.length > 0 ? candidateItems[0] as Record<string, unknown> : null);
            if (matched) {
              const payload = JSON.stringify([matched]);
              const trackingInfo = getTrackingInfoFromFyndPayload(payload);
              const returnJourney = extractFyndJourney(payload, "return");
              const pickupAddress = getPickupAddressFromFyndPayload(payload);
              // Always use the live shipment_id from Fynd — overrides any stale bag ID in DB.
              const liveShipmentId = String(
                (matched as Record<string, unknown>).shipment_id ??
                (matched as Record<string, unknown>).shipmentId ??
                ""
              ) || undefined;
              returnEnrichments[r.id] = { trackingInfo, returnJourney, pickupAddress, fyndShipmentId: liveShipmentId };
            }
          } catch {
            // Non-fatal: return will show cached data
          }
        })
      );
    }

    return withCors(Response.json({ fyndData, returnEnrichments }), request);
  } catch (err) {
    console.error("Portal fynd-enrich:", err);
    return withCors(Response.json({ fyndData: null, returnEnrichments: {} }), request);
  }
};
