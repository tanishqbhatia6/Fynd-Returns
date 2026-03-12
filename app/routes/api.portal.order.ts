import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { fetchOrderByOrderNumber, fetchOrderByGid, OrderAccessError, withRestCredentials, type OrderForPortal } from "../lib/shopify-admin.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import shopify from "../shopify.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { parseJsonArray } from "../lib/parse-json";
import { createFyndClientOrError } from "../lib/fynd.server";

/** Fynd statuses that indicate the shipment has been delivered to the customer */
const FYND_DELIVERED_STATUSES = new Set([
  "delivery_done", "delivered", "bag_delivered", "handed_over_to_customer", "handed_over_to_dg",
  "return_initiated", "return_bag_picked", "return_bag_in_transit",
  "return_bag_out_for_delivery", "return_bag_delivered", "return_bag_not_received",
  "return_completed", "credit_note_generated", "refund_initiated", "refund_done",
  "out_for_delivery_to_store",
]);

/** Type for per-shipment data returned to the portal */
type FyndShipmentForReturn = {
  shipmentId: string;
  shipmentStatus: string;
  eligible: boolean;
  eligibilityReason?: string;
  items: Array<{
    id: string;
    bagId: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    price: string;
    imageUrl: string | null;
    productTags: string[];
  }>;
};

/** Safely extract a string from a value that may be an object (Fynd API inconsistency) */
function safeStr(val: unknown, fallback = ""): string {
  if (val == null) return fallback;
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const extracted = obj.status ?? obj.title ?? obj.name ?? obj.display_name ?? obj.value ?? obj.text ?? obj.label;
    if (extracted != null && typeof extracted !== "object") return String(extracted);
  }
  return fallback;
}

/** Safely extract a currency code from a value that may be a string or Fynd currency object */
function safeCurrencyCode(val: unknown, fallback = "INR"): string {
  if (val == null) return fallback;
  if (typeof val === "string") return val.trim() || fallback;
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const code = obj.currency_code ?? obj.code ?? obj.currency_symbol ?? obj.iso_code ?? obj.value;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return fallback;
}

/** Safely extract an image URL from a value that may be a string or object */
function safeImageUrl(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === "string") return val;
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const url = obj.secure_url ?? obj.url ?? obj.src ?? obj.original ?? obj.value;
    if (typeof url === "string") return url;
  }
  return null;
}

/** Check if a Fynd shipment status is eligible for return (delivered OR merchant-allowed) */
function isShipmentEligibleForReturn(
  status: string,
  allowedFyndStatusesForReturn: string[],
): boolean {
  if (FYND_DELIVERED_STATUSES.has(status)) return true;
  if (allowedFyndStatusesForReturn.length === 0) return true; // Gate OFF (null) = allow all statuses
  const normalized = status.toLowerCase().replace(/[\s_]+/g, "_").trim();
  return allowedFyndStatusesForReturn.some((s) => {
    const normalizedAllowed = s.toLowerCase().replace(/[\s_]+/g, "_").trim();
    return normalized === normalizedAllowed || normalized.includes(normalizedAllowed);
  });
}

/** Parse the allowedFyndStatusesForReturn JSON setting into a string array */
function parseAllowedFyndStatuses(settings: { allowedFyndStatusesForReturn?: string | null } | null): string[] {
  try {
    const raw = settings?.allowedFyndStatusesForReturn;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return (parsed as unknown[]).map((s) => String(s).toLowerCase().trim());
    }
  } catch { /* ignore */ }
  return [];
}

/** Safely extract a numeric price string from Fynd price fields that may be objects */
function extractNumericPrice(val: unknown): string {
  if (val == null) return "0";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    const n = parseFloat(val);
    return isNaN(n) ? "0" : val;
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const numeric = obj.amount ?? obj.value ?? obj.effective ?? obj.transfer_price ?? obj.price_effective ?? obj.mrp;
    if (numeric != null && typeof numeric !== "object") return String(numeric);
  }
  return "0";
}

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
        { shopifyOrderName: { equals: `#${orderNumber}`, mode: "insensitive" } },
        { shopifyOrderName: { equals: orderNumber, mode: "insensitive" } },
        { fyndOrderId: { equals: orderNumber, mode: "insensitive" } },
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

  // Multi-shipment data — populated in Fynd synthetic path or Fynd enrichment for Shopify orders
  let fyndShipmentsForReturn: FyndShipmentForReturn[] | null = null;

  try {
    const shopSession = await prisma.session.findFirst({ where: { shop: shopDomain } });
    const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
    const admin = withRestCredentials(rawAdmin, shopDomain, shopSession?.accessToken ?? "");
    let order = await fetchOrderByOrderNumber(admin, orderNumber);

    // If Shopify name search didn't find it, try FyndOrderMapping by fyndOrderId or shopifyOrderName
    if (!order) {
      let fyndMapping = await prisma.fyndOrderMapping.findFirst({
        where: {
          shopId: shopRecord.id,
          OR: [
            { fyndOrderId: { equals: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { equals: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { equals: `#${orderNumber}`, mode: "insensitive" } },
          ],
        },
      });
      if (!fyndMapping) {
        fyndMapping = await prisma.fyndOrderMapping.findFirst({
          where: {
            shopId: shopRecord.id,
            fyndOrderId: { equals: `#${orderNumber}`, mode: "insensitive" },
          },
        });
      }
      if (fyndMapping) {
        // Fast path: use orderByIdentifier with stored GID
        if (fyndMapping.shopifyOrderId?.startsWith("gid://")) {
          order = await fetchOrderByGid(admin, fyndMapping.shopifyOrderId);
        }
        if (!order && fyndMapping.shopifyOrderName) {
          order = await fetchOrderByOrderNumber(admin, fyndMapping.shopifyOrderName.replace(/^#/, ""));
        }
      }
    }

    // Also try ReturnCase.fyndOrderId or shopifyOrderName -> resolve Shopify order
    if (!order) {
      const fyndCase = await prisma.returnCase.findFirst({
        where: {
          shopId: shopRecord.id,
          OR: [
            { fyndOrderId: { equals: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { equals: orderNumber, mode: "insensitive" } },
            { shopifyOrderName: { equals: `#${orderNumber}`, mode: "insensitive" } },
          ],
        },
        select: { shopifyOrderId: true, shopifyOrderName: true },
      });
      if (fyndCase) {
        if (fyndCase.shopifyOrderId?.startsWith("gid://")) {
          order = await fetchOrderByGid(admin, fyndCase.shopifyOrderId);
        }
        if (!order && fyndCase.shopifyOrderName) {
          order = await fetchOrderByOrderNumber(admin, fyndCase.shopifyOrderName.replace(/^#/, ""));
        }
      }
    }

    // Fynd fallback: if Shopify couldn't find the order (e.g. missing read_all_orders scope,
    // or order is outside Shopify's default scope window), search Fynd by external_order_id.
    // The searched value IS the Shopify order name (e.g. FYNDSHOPIFYX14126 = #FYNDSHOPIFYX14126).
    // Fynd stores the Shopify order name as affiliate_order_id / external_order_id in the shipment.
    // First retry Shopify using Fynd's affiliate_order_id.
    // If Shopify still can't resolve it, build a synthetic order from Fynd bag/item data
    // so the customer can see the item selector with quantities and submit a proper return.
    if (!order) {
      try {
        const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
        if (shopSettings) {
          const fyndResult = await createFyndClientOrError(
            shopSettings as Parameters<typeof createFyndClientOrError>[0],
            { requirePlatform: true }
          );
          if (fyndResult.ok && "searchShipmentsByExternalOrderId" in fyndResult.client) {
            const searchRes = await fyndResult.client.searchShipmentsByExternalOrderId(orderNumber, {
              searchType: "external_order_id",
              pageSize: 5,
              fulfillmentType: "FULFILLMENT",
            });
            const rawShipments = (
              searchRes?.items ?? searchRes?.shipments ??
              (searchRes as { data?: { items?: unknown[] } })?.data?.items ?? []
            ) as Record<string, unknown>[];
            // Filter to forward shipments only
            const forwardShipments = rawShipments.filter((s) => {
              const jt = (typeof s.journey_type === "string" ? s.journey_type : "").toLowerCase();
              return jt !== "return";
            });
            const shipments = forwardShipments.length > 0 ? forwardShipments : rawShipments;
            if (shipments.length > 0) {
              const first = shipments[0];
              // Extract the Shopify order name Fynd has on record.
              // Fynd stores this as affiliate_order_id (primary) or external_order_id.
              // There is no channel_order_id field in Fynd's shipments-listing response.
              const affiliateOrderId = String(
                first.affiliate_order_id ?? first.external_order_id ?? ""
              ).replace(/^#/, "").trim();
              // Only retry Shopify if the affiliate_order_id differs from what was already searched
              if (affiliateOrderId && affiliateOrderId !== orderNumber) {
                order = await fetchOrderByOrderNumber(admin, affiliateOrderId).catch(() => null);
              }
              // Shopify still can't resolve it — build synthetic order from Fynd bags/items
              // so the portal can show the item selector with checkboxes and quantities.
              if (!order) {
                // Collect all items/bags across all shipments for this order
                type FyndLineItem = {
                  id: string;
                  bagId: string;
                  title: string;
                  variantTitle: string | null;
                  sku: string | null;
                  quantity: number;
                  price: string;
                  imageUrl: string | null;
                  productTags: string[];
                };
                const lineItems: FyndLineItem[] = [];
                const collectedShipments: FyndShipmentForReturn[] = [];

                for (const shipment of shipments) {
                  const sShipmentId = String(shipment.shipment_id ?? shipment.id ?? `fynd-ship-${collectedShipments.length}`);
                  const sStatus = safeStr(shipment.status ?? shipment.shipment_status, "").toLowerCase();
                  const shipmentItems: FyndShipmentForReturn["items"] = [];

                  // Fynd structures items under bags[].articles, bags[].items, or top-level bags
                  const bags = (Array.isArray(shipment.bags) ? shipment.bags : []) as Record<string, unknown>[];
                  for (const bag of bags) {
                    const bagId = String(bag.bag_id ?? bag.id ?? `fynd-bag-${lineItems.length}`);
                    const articles = Array.isArray(bag.articles) ? bag.articles
                      : Array.isArray(bag.items) ? bag.items
                      : bag.item ? [bag.item] : [];
                    for (const article of articles as Record<string, unknown>[]) {
                      const itemObj = (article.item ?? article) as Record<string, unknown>;
                      const priceInfo = (bag.prices ?? bag.price_info ?? article.price_info ?? {}) as Record<string, unknown>;
                      const rawPrice = priceInfo.transfer_price ?? priceInfo.price_effective ?? priceInfo.amount_paid ?? priceInfo.mrp ?? 0;
                      const price = extractNumericPrice(rawPrice);
                      const qty = typeof bag.quantity === "number" ? bag.quantity
                        : typeof article.quantity === "number" ? article.quantity : 1;
                      const itemId = String(bag.bag_id ?? bag.id ?? article.id ?? article.article_id ?? `fynd-${lineItems.length}`);
                      const title = safeStr(itemObj.name, "") || safeStr(itemObj.item_name, "") || safeStr(itemObj.title, "") || safeStr(article.name, "") || "Item";
                      const size = safeStr(itemObj.l3_category_name, "") || safeStr(itemObj.size, "") || safeStr(article.size, "") || safeStr(bag.size, "");
                      const skuVal = article.seller_identifier ?? article.uid ?? itemObj.item_id ?? null;
                      const sku = skuVal != null ? String(skuVal) : null;
                      const imageArr = Array.isArray(itemObj.images) ? itemObj.images : [];
                      const imageUrl = imageArr.length > 0 ? safeImageUrl(imageArr[0]) : null;
                      const item: FyndLineItem = {
                        id: itemId,
                        bagId,
                        title,
                        variantTitle: size || null,
                        sku,
                        quantity: qty,
                        price,
                        imageUrl,
                        productTags: [],
                      };
                      lineItems.push(item);
                      shipmentItems.push(item);
                    }
                    // Fallback: if no articles, use bag-level item data
                    if ((Array.isArray(bag.articles) ? bag.articles : []).length === 0 &&
                        (Array.isArray(bag.items) ? bag.items : []).length === 0 &&
                        !bag.item) {
                      const priceInfo = (bag.prices ?? bag.price_info ?? {}) as Record<string, unknown>;
                      const rawBagPrice = priceInfo.transfer_price ?? priceInfo.price_effective ?? priceInfo.amount_paid ?? priceInfo.mrp ?? 0;
                      const price = extractNumericPrice(rawBagPrice);
                      const qty = typeof bag.quantity === "number" ? bag.quantity : 1;
                      const itemId = String(bag.bag_id ?? bag.id ?? `fynd-bag-${lineItems.length}`);
                      const bagItem = (bag.item ?? {}) as Record<string, unknown>;
                      const title = safeStr(bagItem.name, "") || safeStr(bagItem.item_name, "") || safeStr(bag.item_name, "") || safeStr(bag.name, "") || "Item";
                      const size = safeStr(bagItem.l3_category_name, "") || safeStr(bagItem.size, "") || safeStr(bag.size, "");
                      const sku = bag.seller_identifier != null ? String(bag.seller_identifier)
                        : bag.article_id != null ? String(bag.article_id) : null;
                      const imageArr = Array.isArray(bagItem.images) ? bagItem.images : [];
                      const imageUrl = imageArr.length > 0 ? safeImageUrl(imageArr[0]) : null;
                      const item: FyndLineItem = {
                        id: itemId,
                        bagId,
                        title,
                        variantTitle: size || null,
                        sku,
                        quantity: qty,
                        price,
                        imageUrl,
                        productTags: [],
                      };
                      lineItems.push(item);
                      shipmentItems.push(item);
                    }
                  }

                  // Per-shipment eligibility based on Fynd status + merchant settings
                  const merchantAllowedStatuses = parseAllowedFyndStatuses(shopSettings as { allowedFyndStatusesForReturn?: string | null } | null);
                  const isEligible = isShipmentEligibleForReturn(sStatus, merchantAllowedStatuses);
                  collectedShipments.push({
                    shipmentId: sShipmentId,
                    shipmentStatus: sStatus,
                    eligible: isEligible,
                    eligibilityReason: isEligible ? undefined : "This shipment has not been delivered yet. Returns can only be created after delivery.",
                    items: shipmentItems,
                  });
                }

                // Deduplicate by id in case same bag appears across shipments
                const seen = new Set<string>();
                const dedupedLineItems = lineItems.filter((li) => {
                  if (seen.has(li.id)) return false;
                  seen.add(li.id);
                  return true;
                });

                const orderName = String(first.affiliate_order_id ?? first.external_order_id ?? `#${orderNumber}`);
                const createdAt = safeStr(first.orderDate, "") || safeStr(first.shipment_created_at, "") || safeStr(first.created_at, "") || new Date().toISOString();

                // Extract customer data from Fynd shipment fields
                const firstBag = Array.isArray(first.bags) ? (first.bags as Record<string, unknown>[])[0] : null;
                const deliveryAddr = ((firstBag?.delivery_address ?? first.delivery_address ?? {}) as Record<string, unknown>);
                const customerDet = ((first.customer_details ?? {}) as Record<string, unknown>);
                const billingDet = ((first.billing_details ?? {}) as Record<string, unknown>);
                const fyndEmail = String(customerDet.email ?? billingDet.email ?? "").trim() || null;
                const fyndPhone = String(customerDet.phone ?? deliveryAddr.phone ?? "").trim() || null;
                const fyndName = String(customerDet.name ?? deliveryAddr.name ?? "").trim() || null;
                const fyndCity = String(deliveryAddr.city ?? "").trim() || null;
                const fyndState = String(deliveryAddr.state ?? deliveryAddr.state_code ?? "").trim() || null;
                const fyndCountry = String(deliveryAddr.country ?? "").trim() || null;
                const fyndPincode = String(deliveryAddr.pincode ?? deliveryAddr.zip ?? "").trim() || null;
                const fyndAddress1 = String(deliveryAddr.address ?? deliveryAddr.address1 ?? "").trim() || null;
                const fyndAddress2 = String(deliveryAddr.area ?? deliveryAddr.address2 ?? "").trim() || null;
                const fyndLandmark = String(deliveryAddr.landmark ?? "").trim() || null;
                const [fyndFirst, ...fyndRestName] = (fyndName ?? "").split(" ");
                const fyndLast = fyndRestName.join(" ");

                // Use affiliate_order_id (= Shopify order name) as the synthetic order ID,
                // NOT first.order_id which is the Fynd internal ID (e.g. FYMP69B039D201063966).
                // This ensures create-return can resolve it to a Shopify GID later, and even if
                // Shopify can't find the order, we store a meaningful Shopify-side identifier
                // instead of an opaque Fynd internal ID in the shopifyOrderId field.
                const syntheticOrderId = String(
                  affiliateOrderId || first.external_order_id || orderNumber
                );

                // Cache the Fynd-to-Shopify mapping early so create-return, webhook, and future
                // lookups can resolve IDs without re-querying Fynd.
                const fyndInternalOrderId = String(first.order_id ?? "").trim() || null;
                const fyndFirstShipmentId = String(first.shipment_id ?? "").trim() || null;
                if (fyndInternalOrderId || fyndFirstShipmentId) {
                  const cleanOrderName = orderName.startsWith("#") ? orderName : `#${orderName}`;
                  await prisma.fyndOrderMapping.upsert({
                    where: {
                      shopId_shopifyOrderName: {
                        shopId: shopRecord.id,
                        shopifyOrderName: cleanOrderName,
                      },
                    },
                    create: {
                      shopId: shopRecord.id,
                      shopifyOrderName: cleanOrderName,
                      shopifyOrderId: syntheticOrderId,
                      fyndOrderId: fyndInternalOrderId,
                      fyndShipmentId: fyndFirstShipmentId,
                      searchStrategy: "fynd_fallback",
                    },
                    update: {
                      ...(fyndInternalOrderId ? { fyndOrderId: fyndInternalOrderId } : {}),
                      ...(fyndFirstShipmentId ? { fyndShipmentId: fyndFirstShipmentId } : {}),
                    },
                  }).catch((e: unknown) => {
                    console.warn("[portal/order] FyndOrderMapping upsert failed:", e);
                  });
                }

                // Extract current Fynd shipment status for the return gate
                const extractedFyndStatus = safeStr(first.shipment_status ?? first.status, "");

                order = {
                  id: syntheticOrderId,
                  name: orderName.startsWith("#") ? orderName : `#${orderName}`,
                  createdAt,
                  processedAt: createdAt,
                  displayFulfillmentStatus: "FULFILLED",
                  displayFinancialStatus: "PAID",
                  currencyCode: safeCurrencyCode(first.currency, "INR"),
                  _fyndShipmentStatus: extractedFyndStatus.toLowerCase().trim() || null,
                  _isFyndSyntheticOrder: true,
                  email: fyndEmail,
                  phone: fyndPhone,
                  shippingCountry: fyndCountry || null,
                  shippingProvince: fyndState || null,
                  shippingAddress: (fyndName || fyndCity || fyndAddress1) ? {
                    address1: fyndAddress1 || undefined,
                    address2: fyndAddress2 || undefined,
                    firstName: fyndFirst || undefined,
                    lastName: fyndLast || undefined,
                    city: fyndCity || undefined,
                    province: fyndState || undefined,
                    provinceCode: fyndState || undefined,
                    zip: fyndPincode || undefined,
                    country: fyndCountry || undefined,
                    countryCode: fyndCountry || undefined,
                    landmark: fyndLandmark || undefined,
                  } : null,
                  lineItems: dedupedLineItems,
                  fulfillments: [],
                } as OrderForPortal;
                // Store multi-shipment data for the response
                if (collectedShipments.length > 0) {
                  fyndShipmentsForReturn = collectedShipments;
                }
                // Cache all shipment IDs in FyndOrderMapping (comma-separated)
                const allShipmentIds = collectedShipments.map(s => s.shipmentId).filter(Boolean);
                if (allShipmentIds.length > 0) {
                  prisma.fyndOrderMapping.upsert({
                    where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName: `#${orderNumber}` } },
                    create: {
                      shopId: shopRecord.id,
                      shopifyOrderName: `#${orderNumber}`,
                      fyndOrderId: String(first.order_id ?? first.fynd_order_id ?? ""),
                      fyndShipmentId: allShipmentIds.join(","),
                    },
                    update: {
                      fyndOrderId: String(first.order_id ?? first.fynd_order_id ?? "") || undefined,
                      fyndShipmentId: allShipmentIds.join(","),
                    },
                  }).catch(() => {});
                }
              }
            }
          }
        }
      } catch { /* non-fatal — Fynd not configured or unavailable */ }
    }

    // For Shopify-resolved orders: also try to fetch Fynd shipment data for multi-shipment grouping
    if (order && !fyndShipmentsForReturn) {
      try {
        const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });
        if (shopSettings) {
          const fyndResult = await createFyndClientOrError(
            shopSettings as Parameters<typeof createFyndClientOrError>[0],
            { requirePlatform: true }
          );
          if (fyndResult.ok && "searchShipmentsByExternalOrderId" in fyndResult.client) {
            const searchOrderNum = (order.name ?? "").replace(/^#/, "").trim() || orderNumber;
            const searchRes = await fyndResult.client.searchShipmentsByExternalOrderId(searchOrderNum, {
              searchType: "external_order_id",
              pageSize: 10,
              fulfillmentType: "FULFILLMENT",
            });
            const rawShipments = (
              searchRes?.items ?? searchRes?.shipments ??
              (searchRes as { data?: { items?: unknown[] } })?.data?.items ?? []
            ) as Record<string, unknown>[];
            const forwardOnly = rawShipments.filter((s) => {
              const jt = (typeof s.journey_type === "string" ? s.journey_type : "").toLowerCase();
              return jt !== "return";
            });
            const fyndShipments = forwardOnly.length > 0 ? forwardOnly : rawShipments;
            if (fyndShipments.length > 1) {
              // Multiple shipments exist — build per-shipment item grouping
              // Map Fynd bags to Shopify line items by SKU matching
              const shopifyLineItems = order.lineItems ?? [];
              const enrichedShipments: FyndShipmentForReturn[] = [];
              for (const fShip of fyndShipments) {
                const sId = String(fShip.shipment_id ?? fShip.id ?? "");
                const sStatus = safeStr(fShip.status ?? fShip.shipment_status, "").toLowerCase();
                const enrichMerchantStatuses = parseAllowedFyndStatuses(shopSettings as { allowedFyndStatusesForReturn?: string | null } | null);
                const isEligible = isShipmentEligibleForReturn(sStatus, enrichMerchantStatuses);
                const bags = (Array.isArray(fShip.bags) ? fShip.bags : []) as Record<string, unknown>[];
                const shipItems: FyndShipmentForReturn["items"] = [];
                for (const bag of bags) {
                  const bagId = String(bag.bag_id ?? bag.id ?? "");
                  const articles = Array.isArray(bag.articles) ? bag.articles
                    : Array.isArray(bag.items) ? bag.items
                    : bag.item ? [bag.item] : [];
                  for (const article of articles as Record<string, unknown>[]) {
                    const itemObj = (article.item ?? article) as Record<string, unknown>;
                    const skuVal = article.seller_identifier ?? article.uid ?? itemObj.item_id ?? null;
                    const sku = skuVal != null ? String(skuVal) : null;
                    const qty = typeof bag.quantity === "number" ? bag.quantity
                      : typeof article.quantity === "number" ? article.quantity : 1;
                    // Try to match to a Shopify line item by SKU
                    const matchedShopify = sku ? shopifyLineItems.find(li => li.sku === sku) : null;
                    const title = matchedShopify?.title ?? (safeStr(itemObj.name, "") || safeStr(itemObj.item_name, "") || "Item");
                    const variantTitle = (matchedShopify?.variantTitle ?? (safeStr(itemObj.size, "") || safeStr(bag.size, ""))) || null;
                    const imageUrl = matchedShopify?.imageUrl ?? null;
                    const priceInfo = (bag.prices ?? bag.price_info ?? article.price_info ?? {}) as Record<string, unknown>;
                    const rawPrice = priceInfo.transfer_price ?? priceInfo.price_effective ?? priceInfo.amount_paid ?? priceInfo.mrp ?? 0;
                    const price = matchedShopify?.price ?? extractNumericPrice(rawPrice);
                    shipItems.push({
                      id: matchedShopify?.id ?? bagId,
                      bagId,
                      title,
                      variantTitle,
                      sku,
                      quantity: qty,
                      price,
                      imageUrl,
                      productTags: matchedShopify?.productTags ?? [],
                    });
                  }
                  // Fallback: bag-level item
                  if (articles.length === 0) {
                    const bagItem = (bag.item ?? {}) as Record<string, unknown>;
                    const skuVal = bag.seller_identifier ?? bag.article_id ?? null;
                    const sku = skuVal != null ? String(skuVal) : null;
                    const qty = typeof bag.quantity === "number" ? bag.quantity : 1;
                    const matchedShopify = sku ? shopifyLineItems.find(li => li.sku === sku) : null;
                    const title = matchedShopify?.title ?? (safeStr(bagItem.name, "") || safeStr(bagItem.item_name, "") || "Item");
                    const priceInfo = (bag.prices ?? bag.price_info ?? {}) as Record<string, unknown>;
                    const rawPrice = priceInfo.transfer_price ?? priceInfo.price_effective ?? 0;
                    const price = matchedShopify?.price ?? extractNumericPrice(rawPrice);
                    shipItems.push({
                      id: matchedShopify?.id ?? bagId,
                      bagId,
                      title,
                      variantTitle: matchedShopify?.variantTitle ?? null,
                      sku,
                      quantity: qty,
                      price,
                      imageUrl: matchedShopify?.imageUrl ?? null,
                      productTags: matchedShopify?.productTags ?? [],
                    });
                  }
                }
                enrichedShipments.push({
                  shipmentId: sId,
                  shipmentStatus: sStatus,
                  eligible: isEligible,
                  eligibilityReason: isEligible ? undefined : "This shipment has not been delivered yet.",
                  items: shipItems,
                });
              }
              if (enrichedShipments.length > 0) {
                fyndShipmentsForReturn = enrichedShipments;
              }
            }
          }
        }
      } catch { /* non-fatal — Fynd enrichment is best-effort */ }
    }

    if (!order) {
      return withCors(Response.json({
        error: "Order not found",
        existingReturns: formattedReturns,
        activeReturns,
      }, { status: 404 }), request);
    }

    // Load shop settings for eligibility gates (load once, reuse below)
    const settings = await prisma.shopSettings.findUnique({ where: { shopId: shopRecord.id } });

    // Fulfillment status gate: allowed statuses are configurable in settings
    const fulfillmentStatus = (order.displayFulfillmentStatus ?? "").toUpperCase();
    const financialStatus = (order.displayFinancialStatus ?? "").toUpperCase();

    const ALWAYS_BLOCKED_FINANCIAL = ["REFUNDED", "VOIDED"];

    // Admin-configurable allowed fulfillment statuses; default to FULFILLED + PARTIALLY_FULFILLED
    let allowedFulfillmentStatuses: string[] = ["FULFILLED", "PARTIALLY_FULFILLED"];
    try {
      const raw = (settings as { portalAllowedFulfillmentStatuses?: string | null } | null)?.portalAllowedFulfillmentStatuses;
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.length > 0) {
          allowedFulfillmentStatuses = (parsed as unknown[]).map((s) => String(s).toUpperCase());
        }
      }
    } catch { /* use defaults */ }

    // For Fynd synthetic orders (displayFulfillmentStatus = "FULFILLED" set by us), trust the synthetic value
    // The Fynd status check already happened when we built the synthetic order — we only allow
    // delivery_done / handed_over_to_customer above, so no extra check needed here for synthetic orders.

    const isEligibleFulfillment = allowedFulfillmentStatuses.includes(fulfillmentStatus);
    const isBlockedFinancial = ALWAYS_BLOCKED_FINANCIAL.includes(financialStatus);

    let returnEligibility: { eligible: boolean; reason?: string } = { eligible: true };

    if (!isEligibleFulfillment || isBlockedFinancial) {
      if (isBlockedFinancial) {
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
      } else {
        returnEligibility = {
          eligible: false,
          reason: "This order is not eligible for a return at this time.",
        };
      }
    }

    // Fynd Status Gate for Return Initiation: when enabled, check if the Fynd shipment status
    // allows return initiation (only applies to Fynd synthetic orders)
    const orderAny = order as Record<string, unknown>;
    const fyndShipmentStatus = (orderAny._fyndShipmentStatus as string | null) ?? null;
    const isFyndSyntheticOrder = orderAny._isFyndSyntheticOrder === true;

    // For multi-shipment orders, skip the order-level Fynd gate entirely — per-shipment
    // eligibility is more accurate (each shipment has its own status). The multi-shipment
    // override block below (anyShipmentEligible) handles the aggregation.
    const hasMultiShipmentData = fyndShipmentsForReturn && fyndShipmentsForReturn.length > 1;

    if (returnEligibility.eligible && isFyndSyntheticOrder && fyndShipmentStatus && !hasMultiShipmentData) {
      const allowedFyndReturnStatuses = parseAllowedFyndStatuses(settings as { allowedFyndStatusesForReturn?: string | null } | null);
      if (allowedFyndReturnStatuses.length > 0) {
        const isAllowed = isShipmentEligibleForReturn(fyndShipmentStatus, allowedFyndReturnStatuses);
        if (!isAllowed) {
          const friendlyStatus = fyndShipmentStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          returnEligibility = {
            eligible: false,
            reason: `This order's current status is "${friendlyStatus}". Returns can be initiated when the shipment status is: ${allowedFyndReturnStatuses.map((s) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")}.`,
          };
        }
      }
    }

    // Product-level eligibility: check tags, return window, region restrictions
    if (returnEligibility.eligible) {
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
    // (settings already loaded above)
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

    // Per-line-item quantity already in return (excluding rejected/cancelled cases)
    // This allows the portal to grey out fully-returned items and cap quantity inputs
    const lineItemIds = (order.lineItems ?? []).map((li) => li.id);
    const returnedQtyMap: Record<string, number> = {};
    if (lineItemIds.length > 0) {
      try {
        const existingReturnItems = await prisma.returnItem.findMany({
          where: {
            shopifyLineItemId: { in: lineItemIds },
            returnCase: {
              shopId: shopRecord.id,
              status: { notIn: ["rejected", "cancelled"] },
            },
          },
          select: { shopifyLineItemId: true, qty: true },
        });
        for (const ri of existingReturnItems) {
          if (ri.shopifyLineItemId) {
            returnedQtyMap[ri.shopifyLineItemId] = (returnedQtyMap[ri.shopifyLineItemId] ?? 0) + ri.qty;
          }
        }
      } catch { /* non-fatal — quantity locks are advisory */ }
    }

    // SKU-based fallback for Fynd orders where stored shopifyLineItemId
    // may be a Fynd bag ID that doesn't match the current order's line item IDs
    if (order.lineItems && order.lineItems.length > 0) {
      const orderSkus = (order.lineItems ?? [])
        .filter((li: { id: string; sku?: string | null }) => li.sku)
        .map((li: { id: string; sku?: string | null }) => ({ id: li.id, sku: li.sku! }));
      if (orderSkus.length > 0) {
        try {
          const skuReturnItems = await prisma.returnItem.findMany({
            where: {
              sku: { in: orderSkus.map((s) => s.sku) },
              returnCase: {
                shopId: shopRecord.id,
                shopifyOrderName: order.name,
                status: { notIn: ["rejected", "cancelled"] },
              },
            },
            select: { sku: true, qty: true, shopifyLineItemId: true },
          });
          for (const ri of skuReturnItems) {
            if (!ri.sku) continue;
            const matchingItem = orderSkus.find((s) => s.sku === ri.sku);
            if (matchingItem) {
              // Avoid double-counting: skip if this line item was already counted via direct ID match
              const alreadyCounted = ri.shopifyLineItemId && returnedQtyMap[ri.shopifyLineItemId];
              if (!alreadyCounted) {
                returnedQtyMap[matchingItem.id] = (returnedQtyMap[matchingItem.id] ?? 0) + ri.qty;
              }
            }
          }
        } catch { /* non-fatal */ }
      }
    }

    // Portal exchange feature flag
    const portalExchangeEnabled = (settings as { portalExchangeEnabled?: boolean } | null)?.portalExchangeEnabled ?? false;
    const photoRequired = settings?.photoRequired ?? false;

    // Per-shipment returned quantity map (shipmentId → { lineItemId → qty })
    let shipmentReturnedQtyMap: Record<string, Record<string, number>> | null = null;
    if (fyndShipmentsForReturn && fyndShipmentsForReturn.length > 0) {
      // When multi-shipment, also override returnEligibility: eligible if ANY shipment is eligible
      const anyShipmentEligible = fyndShipmentsForReturn.some(s => s.eligible);
      if (anyShipmentEligible && !returnEligibility.eligible) {
        // Order-level check said ineligible (e.g. because we set displayFulfillmentStatus based on first),
        // but at least one shipment is delivered. Override to eligible (per-shipment gates handle the rest).
        returnEligibility = { eligible: true };
      }

      shipmentReturnedQtyMap = {};
      const allShipmentIds = fyndShipmentsForReturn.map(s => s.shipmentId);
      try {
        const shipmentReturnItems = await prisma.returnItem.findMany({
          where: {
            fyndShipmentId: { in: allShipmentIds },
            returnCase: {
              shopId: shopRecord.id,
              status: { notIn: ["rejected", "cancelled"] },
            },
          },
          select: { fyndShipmentId: true, shopifyLineItemId: true, qty: true },
        });
        for (const ri of shipmentReturnItems) {
          if (!ri.fyndShipmentId || !ri.shopifyLineItemId) continue;
          if (!shipmentReturnedQtyMap[ri.fyndShipmentId]) {
            shipmentReturnedQtyMap[ri.fyndShipmentId] = {};
          }
          shipmentReturnedQtyMap[ri.fyndShipmentId][ri.shopifyLineItemId] =
            (shipmentReturnedQtyMap[ri.fyndShipmentId][ri.shopifyLineItemId] ?? 0) + ri.qty;
        }
      } catch { /* non-fatal */ }
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
      returnedQtyMap,
      portalExchangeEnabled,
      photoRequired,
      // Multi-shipment data (null when single-shipment or Fynd not available)
      shipments: fyndShipmentsForReturn,
      shipmentReturnedQtyMap,
      fyndShipmentStatus,
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
