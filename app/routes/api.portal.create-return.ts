import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import shopify from "../shopify.server";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { fetchOrder, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, withRestCredentials } from "../lib/shopify-admin.server";
import { sendNewReturnNotification } from "../lib/notification.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { evaluateAutoApproveRules, parseAutoApproveRules } from "../lib/auto-approve.server";
import { parseJsonArray } from "../lib/parse-json";

type ReturnOffer = {
  reasonCode?: string;
  tag?: string;
  offerType: "discount_pct" | "discount_flat";
  offerValue: number;
  message: string;
};

function matchReturnOffers(
  offers: ReturnOffer[],
  reasonCode: string | undefined,
  productTags: string[],
): ReturnOffer | null {
  if (!offers || offers.length === 0) return null;
  const tagsLower = productTags.map((t) => t.toLowerCase());
  for (const offer of offers) {
    const reasonMatch = !offer.reasonCode || offer.reasonCode === reasonCode;
    const tagMatch = !offer.tag || tagsLower.includes(offer.tag.toLowerCase());
    if (reasonMatch && tagMatch) return offer;
  }
  return null;
}

async function createDiscountCode(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  offer: ReturnOffer,
  shopDomain: string,
): Promise<{ code: string; error?: string }> {
  const code = `KEEP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const isPercentage = offer.offerType === "discount_pct";
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 90);

  const MUTATION = `#graphql
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { nodes { code } } } } }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: `Return Offer - ${code}`,
      code,
      startsAt: new Date().toISOString(),
      endsAt: endsAt.toISOString(),
      usageLimit: 1,
      customerSelection: { all: true },
      customerGets: {
        value: isPercentage
          ? { percentage: offer.offerValue / 100 }
          : { discountAmount: { amount: offer.offerValue, appliesOnEachItem: false } },
        items: { all: true },
      },
    },
  };

  try {
    const res = await admin.graphql(MUTATION, { variables });
    const json = (await res.json()) as {
      data?: {
        discountCodeBasicCreate?: {
          codeDiscountNode?: { id: string };
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      };
    };
    const errors = json.data?.discountCodeBasicCreate?.userErrors ?? [];
    if (errors.length > 0) {
      return { code: "", error: errors.map((e) => e.message).join("; ") };
    }
    return { code };
  } catch (err) {
    return { code: "", error: err instanceof Error ? err.message : "Failed to create discount code" };
  }
}

const NON_TERMINAL_STATUSES = ["initiated", "pending", "processing", "in progress", "approved"];

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

  const rl = checkRateLimit(request, "portal.create-return");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const body = await request.json();
    const shop = body.shop as string | undefined;
    const orderId = body.orderId as string | undefined;
    const shopifyOrderNameRaw = (body.shopifyOrderName as string | undefined)?.trim();
    const shopifyOrderName = shopifyOrderNameRaw?.startsWith("#")
      ? shopifyOrderNameRaw
      : shopifyOrderNameRaw
        ? `#${shopifyOrderNameRaw}`
        : undefined;
    const customerEmail = (body.customerEmail as string | undefined)?.trim().toLowerCase();
    const customerPhone = (body.customerPhone as string | undefined)?.trim().replace(/[^\d+]/g, '') || null;
    const customerName = (body.customerName as string | undefined)?.trim() || null;
    const customerCity = (body.customerCity as string | undefined)?.trim() || null;
    const customerCountry = (body.customerCountry as string | undefined)?.trim() || null;
    const customerAddress1 = (body.customerAddress1 as string | undefined)?.trim().slice(0, 500) || null;
    const customerAddress2 = (body.customerAddress2 as string | undefined)?.trim().slice(0, 500) || null;
    const customerProvince = (body.customerProvince as string | undefined)?.trim().slice(0, 100) || null;
    const customerZip = (body.customerZip as string | undefined)?.trim().slice(0, 20) || null;
    const customerLandmark = (body.customerLandmark as string | undefined)?.trim().slice(0, 500) || null;
    const items = body.items as Array<{ lineItemId: string; qty: number; reasonCode?: string; condition?: string; fyndShipmentId?: string; fyndBagId?: string }> | undefined;
    const manualMode = body.manual === true;
    const manualItemDescription = (body.manualItemDescription as string | undefined)?.trim();
    const customerNotes = (body.customerNotes as string | undefined)?.trim();
    const customerMediaRaw = body.customerMedia as Array<{ name?: string; mimeType?: string; size?: number; dataUrl?: string }> | undefined;
    const currencyCode = (body.currency as string | undefined)?.trim().toUpperCase().slice(0, 10) || null;
    const resolutionType = (body.resolutionType as string | undefined) === "exchange" ? "exchange" : "refund";
    const exchangePreference = resolutionType === "exchange"
      ? (body.exchangePreference as string | undefined)?.trim().slice(0, 500) || null
      : null;

    if (!shop || !shopifyOrderName) {
      return withCors(
        Response.json({ error: "Shop and order number are required" }, { status: 400 }),
        request
      );
    }
    const orderNameClean = shopifyOrderName.replace(/^#/, "").trim();
    if (!orderNameClean || orderNameClean.length > 64) {
      return withCors(
        Response.json({ error: "Invalid order number" }, { status: 400 }),
        request
      );
    }
    if (!manualMode && !orderId) {
      return withCors(
        Response.json({ error: "orderId is required for automatic mode" }, { status: 400 }),
        request
      );
    }

    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    const settings = shopRecord.settings;
    const returnWindowDays = settings?.returnWindowDays ?? 30;

    const shopSession = await prisma.session.findFirst({ where: { shop: shopDomain } });
    const shopAccessToken = shopSession?.accessToken ?? "";

    // Blocklist check
    if (settings?.blocklistEnabled && settings.id) {
      const blockChecks: { type: string; value: string }[] = [];
      if (customerEmail) blockChecks.push({ type: "email", value: customerEmail });
      if (customerPhone) blockChecks.push({ type: "phone", value: customerPhone });
      if (shopifyOrderName) blockChecks.push({ type: "order_name", value: shopifyOrderName.toLowerCase() });

      if (blockChecks.length > 0) {
        const blocked = await prisma.blocklistEntry.findFirst({
          where: {
            settingsId: settings.id,
            OR: blockChecks.map((c) => ({ type: c.type, value: c.value })),
          },
        });
        if (blocked) {
          return withCors(
            Response.json({
              error: "Unable to process return request. Please contact support.",
            }, { status: 403 }),
            request,
          );
        }
      }
    }

    // Return offer: if customer is accepting an offer, generate discount code instead of creating return
    const acceptOffer = body.acceptOffer === true;
    if (acceptOffer && !manualMode) {
      if (!settings?.returnOffersEnabled) {
        return withCors(Response.json({ error: "Return offers are not enabled" }, { status: 400 }), request);
      }
      const offersArr = parseJsonArray<ReturnOffer>(settings.returnOffersJson ?? null, []);
      const firstReasonCode = (body.items as Array<{ reasonCode?: string }> | undefined)?.[0]?.reasonCode;
      const allTags = ((body.lineItemsWithPrice ?? []) as Array<{ productTags?: string[] }>).flatMap((li) => li.productTags ?? []);
      const matchedOffer = matchReturnOffers(offersArr, firstReasonCode, allTags);
      if (!matchedOffer) {
        return withCors(Response.json({ error: "No matching offer found" }, { status: 400 }), request);
      }
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const discountResult = await createDiscountCode(admin, matchedOffer, shopDomain);
        if (discountResult.error || !discountResult.code) {
          return withCors(Response.json({ error: discountResult.error || "Failed to generate discount code" }, { status: 500 }), request);
        }
        return withCors(
          Response.json({
            success: true,
            offerAccepted: true,
            discountCode: discountResult.code,
            offerMessage: matchedOffer.message,
            offerValue: matchedOffer.offerValue,
            offerType: matchedOffer.offerType,
          }),
          request,
        );
      } catch (err) {
        console.error("[Portal create-return] Offer discount code error:", err);
        return withCors(Response.json({ error: "Could not generate discount code. Please try again." }, { status: 500 }), request);
      }
    }

    let effectiveOrderId = manualMode ? `manual:${shopifyOrderName}` : orderId!;

    // Ensure shopifyOrderId is always a valid Shopify GID when possible.
    // If the portal sends an order name (e.g. FYNDSHOPIFYX14126) instead of a GID,
    // resolve it to the real Shopify GID now so future lookups are instant.
    if (!manualMode && effectiveOrderId && !effectiveOrderId.startsWith("gid://") && !/^\d+$/.test(effectiveOrderId)) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const searchId = effectiveOrderId.replace(/^#/, "").trim();
        const resolved = await fetchOrderByFyndAffiliateId(admin, searchId);
        if (resolved?.id) {
          console.log(`[create-return] Resolved orderId "${effectiveOrderId}" → "${resolved.id}"`);
          // Backfill the FyndOrderMapping with the resolved Shopify GID for future lookups
          if (resolved.id.startsWith("gid://") && shopifyOrderName) {
            prisma.fyndOrderMapping.upsert({
              where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName } },
              create: { shopId: shopRecord.id, shopifyOrderName, shopifyOrderId: resolved.id, searchStrategy: "create_return_resolve" },
              update: { shopifyOrderId: resolved.id },
            }).catch(() => {});
          }
          effectiveOrderId = resolved.id;
        }
      } catch (err) {
        console.warn(`[create-return] Could not resolve orderId "${effectiveOrderId}":`, err);
      }

      // Fallback: check FyndOrderMapping for a cached Shopify GID if Shopify search failed.
      // The order lookup endpoint caches Fynd → Shopify mappings when building synthetic orders.
      if (!effectiveOrderId.startsWith("gid://")) {
        try {
          const mapping = await prisma.fyndOrderMapping.findFirst({
            where: {
              shopId: shopRecord.id,
              OR: [
                { shopifyOrderName: { equals: effectiveOrderId, mode: "insensitive" } },
                { shopifyOrderName: { equals: `#${effectiveOrderId}`, mode: "insensitive" } },
                { fyndOrderId: { equals: effectiveOrderId, mode: "insensitive" } },
              ],
            },
          });
          if (mapping?.shopifyOrderId?.startsWith("gid://")) {
            console.log(`[create-return] Resolved orderId "${effectiveOrderId}" → "${mapping.shopifyOrderId}" via FyndOrderMapping`);
            effectiveOrderId = mapping.shopifyOrderId;
          }
        } catch {
          // Non-fatal
        }
      }
    }
    let itemsToCreate: Array<{ lineItemId: string; qty: number; reasonCode?: string; notes?: string; condition?: string; fyndShipmentId?: string; fyndBagId?: string }>;
    let lineItemsWithPrice: Array<{
      id: string;
      title?: string;
      variantTitle?: string;
      price?: string;
      imageUrl?: string;
      productTags?: string[];
    }> = [];

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (manualMode) {
      if (!customerEmail) {
        return withCors(
          Response.json({ error: "Email is required for manual return requests" }, { status: 400 }),
          request
        );
      }
      if (!EMAIL_REGEX.test(customerEmail)) {
        return withCors(
          Response.json({ error: "Please enter a valid email address" }, { status: 400 }),
          request
        );
      }
      if (!manualItemDescription || manualItemDescription.length < 3) {
        return withCors(
          Response.json({ error: "Please describe the item(s) you want to return (at least 3 characters)" }, { status: 400 }),
          request
        );
      }
      if (manualItemDescription.length > 2000) {
        return withCors(
          Response.json({ error: "Item description is too long" }, { status: 400 }),
          request
        );
      }
      itemsToCreate = [{ lineItemId: "manual", qty: 1, reasonCode: body.reasonCode || "Other", notes: manualItemDescription }];

      // Best-effort fulfillment check for manual returns
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const manualOrderLookup = await fetchOrderByOrderNumber(admin, orderNameClean);
        if (manualOrderLookup) {
          const manualFulfill = (manualOrderLookup.displayFulfillmentStatus ?? "").toUpperCase();
          const manualFinancial = (manualOrderLookup.displayFinancialStatus ?? "").toUpperCase();
          if (manualFulfill === "UNFULFILLED" || manualFulfill === "" || manualFulfill === "SCHEDULED" || manualFulfill === "ON_HOLD") {
            return withCors(
              Response.json({
                error: "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
              }, { status: 400 }),
              request
            );
          }
          if (manualFinancial === "REFUNDED" || manualFinancial === "VOIDED") {
            return withCors(
              Response.json({
                error: "This order has already been refunded and is not eligible for a return.",
              }, { status: 400 }),
              request
            );
          }
        }
      } catch {
        // If lookup fails (e.g., PCDA, session not found), allow manual submission — admin will review
      }
    } else {
      if (!items || !Array.isArray(items) || items.length === 0) {
        return withCors(
          Response.json({ error: "At least one item must be selected for return" }, { status: 400 }),
          request
        );
      }
      for (const it of items) {
        if (!it?.lineItemId || typeof it.qty !== "number" || it.qty < 1) {
          return withCors(
            Response.json({ error: "Each item must have lineItemId and qty >= 1" }, { status: 400 }),
            request
          );
        }
        if (it.qty > 999) {
          return withCors(
            Response.json({ error: "Item quantity exceeds maximum allowed" }, { status: 400 }),
            request
          );
        }
      }
      if (items.length > 100) {
        return withCors(
          Response.json({ error: "Too many items in return request" }, { status: 400 }),
          request
        );
      }
      itemsToCreate = items.map((it) => ({
        lineItemId: String(it.lineItemId).slice(0, 256),
        qty: Math.min(Math.max(1, Math.floor(it.qty)), 999),
        reasonCode: it.reasonCode ? String(it.reasonCode).slice(0, 256) : undefined,
        condition: it.condition ? String(it.condition).slice(0, 64) : undefined,
        fyndShipmentId: it.fyndShipmentId ? String(it.fyndShipmentId).slice(0, 256) : undefined,
        fyndBagId: it.fyndBagId ? String(it.fyndBagId).slice(0, 256) : undefined,
      }));
    }

    // ── Resolve non-GID lineItemIds to real Shopify line item GIDs ──
    // When the portal sends Fynd bag IDs (e.g. "3777852") instead of Shopify GIDs
    // (e.g. "gid://shopify/LineItem/16891834630294"), fetch the Shopify order and
    // match items by title/SKU to get the correct GIDs for refund processing.
    // Also stores resolved SKU for future SKU matching in refund flow.
    const resolvedLineItemSkus = new Map<string, string>(); // newLineItemId → sku
    const lineItemIdMapping = new Map<string, string>(); // newLineItemId → originalPortalId
    if (!manualMode) {
      const hasNonGidLineItems = itemsToCreate.some(
        (it) => it.lineItemId !== "manual" && !it.lineItemId.startsWith("gid://shopify/LineItem/")
      );
      if (hasNonGidLineItems) {
        try {
          const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
          const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
          // If effectiveOrderId is a GID, fetch directly; otherwise try resolving by name
          let shopifyOrder = effectiveOrderId.startsWith("gid://")
            ? await fetchOrder(admin, effectiveOrderId)
            : null;
          // Fallback: if not a GID, try searching Shopify by order name/affiliate ID
          if (!shopifyOrder && !effectiveOrderId.startsWith("gid://")) {
            const searchId = effectiveOrderId.replace(/^#/, "").trim();
            const resolved = await fetchOrderByFyndAffiliateId(admin, searchId);
            if (resolved) {
              shopifyOrder = resolved;
              // Also update effectiveOrderId to the resolved GID since we found the order
              if (resolved.id.startsWith("gid://")) {
                console.log(`[create-return] Late-resolved orderId "${effectiveOrderId}" → "${resolved.id}" during line item resolution`);
                effectiveOrderId = resolved.id;
              }
            }
          }
          if (shopifyOrder?.lineItems && shopifyOrder.lineItems.length > 0) {
            const shopifyLineItems = shopifyOrder.lineItems;
            // Build lookup maps for matching: by title (lowercased), by SKU
            const byTitle = new Map<string, typeof shopifyLineItems[0]>();
            const bySku = new Map<string, typeof shopifyLineItems[0]>();
            for (const sli of shopifyLineItems) {
              if (sli.title) byTitle.set(sli.title.toLowerCase(), sli);
              if (sli.sku) bySku.set(sli.sku.toLowerCase(), sli);
            }

            // Also build lineItemsWithPrice title lookup for cross-referencing
            const portalItemById = new Map<string, { title?: string; sku?: string }>();
            const rawLineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
              id: string; title?: string; sku?: string;
            }>;
            for (const li of rawLineItemsWithPrice) {
              portalItemById.set(li.id, li);
            }

            for (const it of itemsToCreate) {
              if (it.lineItemId === "manual" || it.lineItemId.startsWith("gid://shopify/LineItem/")) continue;
              const originalId = it.lineItemId;
              // Try to find the matching Shopify line item
              const portalItem = portalItemById.get(it.lineItemId);
              const titleToMatch = portalItem?.title?.toLowerCase();
              const skuToMatch = portalItem?.sku?.toLowerCase();

              let matched: typeof shopifyLineItems[0] | undefined;
              // Match by SKU first (more reliable)
              if (skuToMatch) matched = bySku.get(skuToMatch);
              // Fall back to title match
              if (!matched && titleToMatch) matched = byTitle.get(titleToMatch);
              // If only one Shopify line item exists, use it (common for single-item orders)
              if (!matched && shopifyLineItems.length === 1) matched = shopifyLineItems[0];

              if (matched) {
                console.log(`[create-return] Resolved lineItemId "${it.lineItemId}" → "${matched.id}" (${matched.title}, sku: ${matched.sku})`);
                it.lineItemId = matched.id;
                lineItemIdMapping.set(matched.id, originalId);
                if (matched.sku) resolvedLineItemSkus.set(matched.id, matched.sku);
              }
            }
          }
        } catch (err) {
          console.warn("[create-return] Could not resolve line item IDs:", err);
          // Non-fatal: proceed with original IDs; refund flow has its own fallback
        }
      }
    }

    // Per-line-item quantity pre-check: allow new returns for the same order
    // as long as there is remaining quantity for the requested line items.
    // This replaces the old blanket duplicate check that blocked ALL returns
    // for an order if any non-terminal return existed.
    if (!manualMode && itemsToCreate.length > 0 && effectiveOrderId && !effectiveOrderId.startsWith("manual:")) {
      const preCheckLineItemIds = itemsToCreate.map((it) => it.lineItemId).filter((id) => id !== "manual");
      if (preCheckLineItemIds.length > 0) {
        const existingReturnItems = await prisma.returnItem.findMany({
          where: {
            shopifyLineItemId: { in: preCheckLineItemIds },
            returnCase: {
              shopId: shopRecord.id,
              shopifyOrderId: effectiveOrderId,
              status: { notIn: ["rejected", "cancelled"] },
            },
          },
          select: { shopifyLineItemId: true, qty: true },
        });
        const preAlreadyReturnedMap: Record<string, number> = {};
        for (const ri of existingReturnItems) {
          if (ri.shopifyLineItemId) {
            preAlreadyReturnedMap[ri.shopifyLineItemId] = (preAlreadyReturnedMap[ri.shopifyLineItemId] ?? 0) + ri.qty;
          }
        }
        const lineItemEstimates = (body.lineItemEstimates ?? []) as Array<{ lineItemId: string; quantity: number }>;
        for (const sel of itemsToCreate) {
          if (sel.lineItemId === "manual") continue;
          const alreadyReturned = preAlreadyReturnedMap[sel.lineItemId] ?? 0;
          const originalQty = lineItemEstimates.find((e) => e.lineItemId === sel.lineItemId)?.quantity
            ?? (body.lineItemsWithPrice as Array<{ id: string; quantity?: number }> | undefined)
              ?.find((l) => l.id === sel.lineItemId)?.quantity
            ?? 999;
          if (alreadyReturned + sel.qty > originalQty) {
            const liInfo = (body.lineItemsWithPrice as Array<{ id: string; title?: string }> | undefined)
              ?.find((l) => l.id === sel.lineItemId);
            return withCors(
              Response.json({
                error: `Return quantity exceeds available for "${liInfo?.title ?? sel.lineItemId}". ${alreadyReturned} already in return, ${sel.qty} requested, but only ${originalQty} ordered.`,
              }, { status: 400 }),
              request,
            );
          }
        }
      }
    }

    // Server-side fulfillment status validation (non-manual mode)
    if (!manualMode && orderId) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const liveOrder = await fetchOrder(admin, orderId);
        if (liveOrder) {
          const fulfillStatus = (liveOrder.displayFulfillmentStatus ?? "").toUpperCase();
          const finStatus = (liveOrder.displayFinancialStatus ?? "").toUpperCase();

          if (fulfillStatus === "UNFULFILLED" || fulfillStatus === "" || fulfillStatus === "SCHEDULED" || fulfillStatus === "ON_HOLD") {
            return withCors(
              Response.json({
                error: "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
              }, { status: 400 }),
              request
            );
          }
          if (finStatus === "REFUNDED" || finStatus === "VOIDED") {
            return withCors(
              Response.json({
                error: "This order has already been refunded and is not eligible for a return.",
              }, { status: 400 }),
              request
            );
          }
        }
      } catch (fulfillErr) {
        console.warn("[Portal create-return] Fulfillment status check failed:", fulfillErr);
        // If we can't verify, fall through — the order lookup would have already blocked in the portal
      }
    }

    // Server-side Fynd status gate for return initiation (skip for admin overrides)
    if (!manualMode && orderId && !(body.adminOverride === true)) {
      try {
        const fyndMapping = await prisma.fyndOrderMapping.findFirst({
          where: {
            shopId: shopRecord.id,
            OR: [
              { shopifyOrderName: { equals: shopifyOrderName, mode: "insensitive" } },
              { shopifyOrderName: { equals: `#${shopifyOrderName.replace(/^#/, "")}`, mode: "insensitive" } },
            ],
          },
        });
        if (fyndMapping?.fyndOrderId && settings?.allowedFyndStatusesForReturn) {
          let allowedReturnStatuses: string[] = [];
          try {
            const parsed = JSON.parse(settings.allowedFyndStatusesForReturn);
            if (Array.isArray(parsed) && parsed.length > 0) {
              allowedReturnStatuses = parsed.map((s: unknown) => String(s).toLowerCase().trim());
            }
          } catch { /* ignore */ }

          if (allowedReturnStatuses.length > 0) {
            // Try to get current Fynd status from existing return cases or webhook logs
            const latestLog = await prisma.fyndWebhookLog.findFirst({
              where: {
                affiliateOrderId: { equals: fyndMapping.fyndOrderId, mode: "insensitive" },
                fyndStatus: { not: null },
              },
              orderBy: { createdAt: "desc" },
              select: { fyndStatus: true },
            });
            if (latestLog?.fyndStatus) {
              const currentStatus = latestLog.fyndStatus.toLowerCase().replace(/[\s_]+/g, "_").trim();
              const isAllowed = allowedReturnStatuses.some((s) => {
                const norm = s.replace(/[\s_]+/g, "_").trim();
                return currentStatus === norm || currentStatus.includes(norm);
              });
              if (!isAllowed) {
                const friendly = latestLog.fyndStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                return withCors(
                  Response.json({
                    error: `Return cannot be initiated. Current shipment status is "${friendly}". Returns are allowed when status is: ${allowedReturnStatuses.map((s) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).join(", ")}.`,
                  }, { status: 400 }),
                  request,
                );
              }
            }
          }
        }
      } catch (gateErr) {
        console.warn("[Portal create-return] Fynd status gate check failed:", gateErr);
      }
    }

    if (!manualMode) {
      const orderCreatedAt = body.orderCreatedAt as string | undefined;
      const orderDate = orderCreatedAt ? new Date(orderCreatedAt) : new Date();
      const windowEnd = new Date(orderDate);
      windowEnd.setDate(windowEnd.getDate() + returnWindowDays);
      if (new Date() > windowEnd) {
        return withCors(
          Response.json({
            error: `Return window has expired. Returns are accepted within ${returnWindowDays} days of order date.`,
          }, { status: 400 }),
          request
        );
      }

      lineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
        id: string;
        title?: string;
        variantTitle?: string;
        price?: string;
        imageUrl?: string;
        productTags?: string[];
      }>;
      const validLineIds = new Set(lineItemsWithPrice.map((l) => l.id));
      for (const sel of itemsToCreate) {
        if (sel.lineItemId === "manual") continue;
        if (!validLineIds.has(sel.lineItemId)) {
          return withCors(
            Response.json({ error: "Invalid line item selected. Please refresh and try again." }, { status: 400 }),
            request
          );
        }
        const li = lineItemsWithPrice.find((l) => l.id === sel.lineItemId);
        const price = li?.price ? parseFloat(li.price) : undefined;
        const tags = li?.productTags ?? [];
        const eligibility = checkReturnEligibility(settings, {
          orderDate: orderCreatedAt ? new Date(orderCreatedAt) : new Date(),
          productPrice: price,
          productTags: tags.length ? tags : undefined,
          customerCountry: body.shippingCountry,
          customerProvince: body.shippingProvince,
        });
        if (!eligibility.eligible) {
          return withCors(
            Response.json({ error: eligibility.reason ?? "Item not eligible for return" }, { status: 400 }),
            request
          );
        }
      }
    }

    // Validate and sanitize uploaded media (max 5 files, images + videos, max 5MB each)
    const MAX_MEDIA_FILES = 5;
    const MAX_MEDIA_SIZE = 5 * 1024 * 1024;
    const ALLOWED_MEDIA_PREFIXES = [
      "data:image/jpeg", "data:image/png", "data:image/gif", "data:image/webp",
      "data:video/mp4", "data:video/webm", "data:video/quicktime",
    ];
    let customerMediaJson: string | null = null;
    if (Array.isArray(customerMediaRaw) && customerMediaRaw.length > 0) {
      const validMedia = customerMediaRaw
        .slice(0, MAX_MEDIA_FILES)
        .filter((m) => {
          if (!m?.dataUrl || typeof m.dataUrl !== "string") return false;
          if (!ALLOWED_MEDIA_PREFIXES.some((p) => m.dataUrl!.startsWith(p))) return false;
          const sizeEstimate = Math.ceil((m.dataUrl.length * 3) / 4);
          if (sizeEstimate > MAX_MEDIA_SIZE) return false;
          return true;
        })
        .map((m) => ({
          name: String(m.name ?? "upload").slice(0, 255),
          mimeType: String(m.mimeType ?? "image/jpeg").slice(0, 64),
          dataUrl: m.dataUrl,
        }));
      if (validMedia.length > 0) {
        customerMediaJson = JSON.stringify(validMedia);
      }
    }

    // Determine status using auto-approve rules
    let status: string;
    if (settings?.autoApproveEnabled) {
      const autoRules = parseAutoApproveRules(settings.autoApproveRulesJson);
      if (autoRules.length > 0) {
        // Build context for rule evaluation
        let orderValue: number | undefined;
        if (!manualMode && lineItemsWithPrice.length > 0) {
          orderValue = lineItemsWithPrice.reduce((sum, li) => {
            const p = li.price ? parseFloat(li.price) : 0;
            return sum + (Number.isFinite(p) ? p : 0);
          }, 0);
        }
        const firstReasonCode = itemsToCreate[0]?.reasonCode;
        const allTags = lineItemsWithPrice.flatMap((li) => li.productTags ?? []);

        let customerReturnCount: number | undefined;
        if (customerEmail) {
          customerReturnCount = await prisma.returnCase.count({
            where: { shopId: shopRecord.id, customerEmailNorm: customerEmail },
          });
        }

        const ruleResult = evaluateAutoApproveRules(autoRules, {
          orderValue,
          returnReason: firstReasonCode,
          productTags: allTags.length > 0 ? allTags : undefined,
          customerEmail: customerEmail ?? undefined,
          customerReturnCount,
        });

        if (ruleResult === "manual_review") {
          status = "initiated";
        } else if (ruleResult === "approve") {
          status = "approved";
        } else {
          status = "approved";
        }
      } else {
        status = "approved";
      }
    } else {
      status = "initiated";
    }

    // Green return eligibility check
    let qualifiesForGreenReturn = false;
    if (settings?.greenReturnsEnabled && !manualMode) {
      const greenThreshold = settings.greenReturnsThreshold ? parseFloat(String(settings.greenReturnsThreshold)) : null;
      let greenTagsArr: string[] = [];
      try {
        if (settings.greenReturnsProductTags) {
          greenTagsArr = JSON.parse(settings.greenReturnsProductTags);
        }
      } catch { /* invalid JSON, skip tag check */ }

      const itemTotalValue = lineItemsWithPrice.reduce((sum, li) => {
        const selectedItem = itemsToCreate.find((it) => it.lineItemId === li.id);
        if (!selectedItem) return sum;
        const p = li.price ? parseFloat(li.price) : 0;
        return sum + (Number.isFinite(p) ? p * selectedItem.qty : 0);
      }, 0);

      const belowThreshold = greenThreshold != null && greenThreshold > 0 && itemTotalValue > 0 && itemTotalValue < greenThreshold;

      const allItemTags = lineItemsWithPrice
        .filter((li) => itemsToCreate.some((it) => it.lineItemId === li.id))
        .flatMap((li) => li.productTags ?? [])
        .map((t) => t.toLowerCase());
      const tagsMatch = greenTagsArr.length > 0 && greenTagsArr.some((gt) => allItemTags.includes(gt.toLowerCase()));

      qualifiesForGreenReturn = belowThreshold || tagsMatch;
    }

    // Atomic transaction: per-line-item quantity validation + create return + event in one go
    const txLineItemEstimates = (body.lineItemEstimates ?? []) as Array<{ lineItemId: string; quantity: number }>;
    let returnCase: Awaited<ReturnType<typeof prisma.returnCase.create>> & { returnRequestNo?: string | null };
    try {
      returnCase = await prisma.$transaction(async (tx) => {
        // Per-line-item quantity validation inside transaction (race-safe)
        if (!manualMode && itemsToCreate.length > 0 && effectiveOrderId && !effectiveOrderId.startsWith("manual:")) {
          const requestedLineItemIds = itemsToCreate.map((it) => it.lineItemId).filter((id) => id !== "manual");
          const existingReturnItems = await tx.returnItem.findMany({
            where: {
              shopifyLineItemId: { in: requestedLineItemIds },
              returnCase: {
                shopId: shopRecord.id,
                shopifyOrderId: effectiveOrderId,
                status: { notIn: ["rejected", "cancelled"] },
              },
            },
            select: { shopifyLineItemId: true, qty: true },
          });
          const alreadyReturnedMap: Record<string, number> = {};
          for (const ri of existingReturnItems) {
            if (ri.shopifyLineItemId) {
              alreadyReturnedMap[ri.shopifyLineItemId] = (alreadyReturnedMap[ri.shopifyLineItemId] ?? 0) + ri.qty;
            }
          }
          // SKU fallback: for Fynd orders, stored shopifyLineItemId may differ from current IDs
          const txRequestedSkus = itemsToCreate
            .map((it) => resolvedLineItemSkus.get(it.lineItemId) || (lineItemsWithPrice.find((l) => l.id === it.lineItemId) as { sku?: string } | undefined)?.sku)
            .filter(Boolean) as string[];
          if (txRequestedSkus.length > 0) {
            try {
              const skuItems = await tx.returnItem.findMany({
                where: {
                  sku: { in: txRequestedSkus },
                  returnCase: {
                    shopId: shopRecord.id,
                    shopifyOrderId: effectiveOrderId,
                    status: { notIn: ["rejected", "cancelled"] },
                  },
                },
                select: { sku: true, qty: true, shopifyLineItemId: true },
              });
              for (const ri of skuItems) {
                if (!ri.sku) continue;
                const matchingItem = itemsToCreate.find((it) => {
                  const itSku = resolvedLineItemSkus.get(it.lineItemId)
                    || (lineItemsWithPrice.find((l) => l.id === it.lineItemId) as { sku?: string } | undefined)?.sku;
                  return itSku === ri.sku;
                });
                if (matchingItem && !(alreadyReturnedMap[matchingItem.lineItemId] > 0)) {
                  alreadyReturnedMap[matchingItem.lineItemId] = (alreadyReturnedMap[matchingItem.lineItemId] ?? 0) + ri.qty;
                }
              }
            } catch { /* non-fatal SKU fallback */ }
          }
          for (const sel of itemsToCreate) {
            if (sel.lineItemId === "manual") continue;
            const alreadyReturned = alreadyReturnedMap[sel.lineItemId] ?? 0;
            const liInfo = lineItemsWithPrice.find((l) => l.id === sel.lineItemId);
            const originalQty = txLineItemEstimates.find((e) => e.lineItemId === sel.lineItemId)?.quantity
              ?? (body.lineItemsWithPrice as Array<{ id: string; quantity?: number }> | undefined)
                ?.find((l) => l.id === sel.lineItemId)?.quantity
              ?? 999;
            if (alreadyReturned + sel.qty > originalQty) {
              throw new Error(`QUANTITY_EXCEEDED:${liInfo?.title ?? sel.lineItemId}`);
            }
          }
        }

        const orderCreatedAtValue = body.orderCreatedAt
          ? new Date(body.orderCreatedAt as string)
          : body.orderProcessedAt
            ? new Date(body.orderProcessedAt as string)
            : null;

        const rc = await tx.returnCase.create({
          data: {
            shopId: shopRecord.id,
            shopifyOrderId: effectiveOrderId,
            shopifyOrderName,
            customerEmailNorm: customerEmail || null,
            customerPhoneNorm: customerPhone || null,
            customerName: customerName || null,
            customerCity: customerCity || null,
            customerCountry: customerCountry || null,
            customerAddress1: customerAddress1 || null,
            customerAddress2: customerAddress2 || null,
            customerProvince: customerProvince || null,
            customerZip: customerZip || null,
            customerLandmark: customerLandmark || null,
            customerNotes: customerNotes || null,
            customerMediaJson: customerMediaJson,
            currency: currencyCode,
            status,
            resolutionType,
            exchangePreference: exchangePreference || null,
            createdByChannel: (body.createdByChannel as string) ?? "portal",
            createdByStaff: (body.createdByStaff as string) ?? null,
            crmTicketId: (body.crmTicketId as string) ?? null,
            crmNotes: (body.crmNotes as string) ?? null,
            isGreenReturn: qualifiesForGreenReturn,
            fyndSyncStatus: status === "approved" && !qualifiesForGreenReturn ? "pending" : null,
            orderProcessedAt: orderCreatedAtValue,
            // Set fyndShipmentId from items (use first item's shipmentId, or common shipmentId if all match)
            fyndShipmentId: (() => {
              const shipIds = (itemsToCreate ?? []).map(it => it.fyndShipmentId).filter(Boolean) as string[];
              if (shipIds.length === 0) return null;
              const unique = [...new Set(shipIds)];
              return unique.length === 1 ? unique[0] : shipIds[0]; // prefer single shipment; fallback to first
            })(),
            items: {
              create: itemsToCreate.map((it) => {
                // After line item ID resolution, the ID may have changed from a Fynd bag ID
                // to a Shopify GID. Look up liInfo using the original portal ID if needed.
                const originalPortalId = lineItemIdMapping.get(it.lineItemId) ?? it.lineItemId;
                const liInfo = lineItemsWithPrice?.find((l) => l.id === it.lineItemId || l.id === originalPortalId);
                const resolvedSku = resolvedLineItemSkus.get(it.lineItemId);
                return {
                  shopifyLineItemId: it.lineItemId,
                  title: liInfo?.title || it.notes || null,
                  variantTitle: liInfo?.variantTitle || null,
                  sku: resolvedSku || (liInfo as { sku?: string } | undefined)?.sku || null,
                  price: (() => {
                    const raw = liInfo?.price;
                    if (!raw) return null;
                    if (typeof raw === "object") {
                      const obj = raw as Record<string, unknown>;
                      const v = obj.amount ?? obj.value ?? obj.effective ?? obj.transfer_price ?? obj.price_effective;
                      return v != null ? String(v) : null;
                    }
                    return String(raw);
                  })(),
                  imageUrl: liInfo?.imageUrl || null,
                  qty: it.qty,
                  reasonCode: it.reasonCode || null,
                  notes: it.notes || null,
                  condition: it.condition || null,
                  fyndShipmentId: it.fyndShipmentId || null,
                  fyndBagId: it.fyndBagId || null,
                };
              }),
            },
          },
          include: { items: true },
        });

        const returnRequestNo = formatReturnRequestId(rc.id);
        await tx.returnCase.update({
          where: { id: rc.id },
          data: { returnRequestNo },
        });

        await tx.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "portal",
            eventType: status === "approved" ? "auto_approved" : "initiated",
            payloadJson: JSON.stringify({
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              customerName: customerName || null,
              itemCount: itemsToCreate.length,
              manual: manualMode,
              ...(qualifiesForGreenReturn ? { greenReturn: true } : {}),
            }),
          },
        });

        if (qualifiesForGreenReturn) {
          await tx.returnEvent.create({
            data: {
              returnCaseId: rc.id,
              source: "system",
              eventType: "green_return_qualified",
              payloadJson: JSON.stringify({
                reason: "Item value below threshold or product tags matched green return criteria",
              }),
            },
          });
        }

        return { ...rc, returnRequestNo };
      });
    } catch (txErr) {
      if (txErr instanceof Error && txErr.message.startsWith("QUANTITY_EXCEEDED:")) {
        const itemTitle = txErr.message.replace("QUANTITY_EXCEEDED:", "");
        return withCors(
          Response.json({
            error: `Return quantity exceeds available quantity for: ${itemTitle}. Please refresh and try again.`,
          }, { status: 400 }),
          request
        );
      }
      throw txErr;
    }

    try {
      await sendNewReturnNotification({
        shopDomain,
        orderName: shopifyOrderName,
        customerEmail: customerEmail || undefined,
        itemCount: itemsToCreate.length,
        returnRequestId: returnCase.returnRequestNo ?? "",
        shopName: shopDomain.replace(".myshopify.com", ""),
      });
    } catch (notifyErr) {
      console.warn("[Portal create-return] New return notification failed:", notifyErr);
    }

    // When auto-approved, sync to Fynd so webhook can match returns (skip for green returns)
    if (status === "approved" && !manualMode && orderId && !qualifiesForGreenReturn) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const order = await fetchOrder(admin, orderId);
        const affiliateOrderId = order?.affiliateOrderId ?? null;
        const fyndSettings = shopRecord.settings as Parameters<typeof createFyndClientOrError>[0] | null;
        const fyndResult = fyndSettings
          ? await createFyndClientOrError(fyndSettings, { requirePlatform: true })
          : { ok: false as const, error: "Fynd not configured" };
        if (fyndResult.ok && "getShipments" in fyndResult.client) {
          // Re-fetch with items for Fynd sync
          const rcWithItems = await prisma.returnCase.findUnique({
            where: { id: returnCase.id },
            include: { items: true },
          });
          if (!rcWithItems) throw new Error("Return case not found after creation");
          const fyndSync = await createReturnOnFynd(fyndResult.client, rcWithItems, {
            affiliateOrderId,
            targetShipmentId: rcWithItems.fyndShipmentId || null,
          });
          if (fyndSync.success && (fyndSync.fyndReturnId ?? fyndSync.fyndShipmentId ?? fyndSync.alreadyExists)) {
            await prisma.returnCase.update({
              where: { id: returnCase.id },
              data: {
                fyndSyncStatus: "synced",
                fyndSyncError: null,
                ...(fyndSync.fyndReturnId && { fyndReturnId: fyndSync.fyndReturnId }),
                ...(fyndSync.fyndReturnNo && { fyndReturnNo: fyndSync.fyndReturnNo }),
                ...(fyndSync.fyndOrderId && { fyndOrderId: fyndSync.fyndOrderId }),
                ...(fyndSync.fyndShipmentId && { fyndShipmentId: fyndSync.fyndShipmentId }),
                ...(fyndSync.fyndPayload != null && {
                  fyndPayloadJson: JSON.stringify(fyndSync.fyndPayload),
                }),
              },
            });
            await prisma.returnEvent.create({
              data: {
                returnCaseId: returnCase.id,
                source: "portal",
                eventType: "fynd_sync",
                payloadJson: JSON.stringify({
                  fyndReturnId: fyndSync.fyndReturnId,
                  fyndShipmentId: fyndSync.fyndShipmentId,
                  alreadyExists: fyndSync.alreadyExists ?? false,
                }),
              },
            });
          }
        }
      } catch (fyndErr) {
        const errMsg = fyndErr instanceof Error ? fyndErr.message : String(fyndErr);
        console.warn("[Portal create-return] Fynd sync failed:", errMsg);
        // Schedule automatic retry instead of requiring manual admin intervention
        try {
          const { scheduleRetry } = await import("../lib/fynd-retry.server");
          await scheduleRetry(returnCase.id, errMsg);
        } catch { /* Non-fatal */ }
      }
    }

    const itemSummaries = itemsToCreate.map((it) => {
      if (it.lineItemId === "manual") {
        return { title: it.notes ?? "Manual return", qty: it.qty };
      }
      const li = lineItemsWithPrice.find((l) => l.id === it.lineItemId);
      return { title: li?.title ?? "Item", qty: it.qty };
    });

    const nextSteps =
      status === "approved"
        ? "Your return has been approved. The store will process your refund."
        : "The store will review your request. You'll receive an email once it's approved or if more information is needed.";

    return withCors(
      Response.json({
        success: true,
        returnId: returnCase.id,
        returnRequestId: formatReturnRequestId(returnCase.id),
        status: returnCase.status,
        message:
          status === "approved"
            ? "Return approved. Refund will be processed by the store."
            : "Return request submitted. You will be notified once it is reviewed.",
        summary: {
          orderName: shopifyOrderName,
          itemsCount: itemsToCreate.length,
          items: itemSummaries,
          status: returnCase.status,
          createdAt: returnCase.createdAt,
          nextSteps,
        },
      }),
      request
    );
  } catch (err) {
    console.error("Portal create return:", err);
    // Only expose safe, customer-facing error messages — never internal details
    const SAFE_PATTERNS = [
      /order has not been fulfilled/i,
      /already been refunded/i,
      /at least one item/i,
      /return window/i,
      /not eligible/i,
      /already pending/i,
      /required/i,
      /invalid.*email/i,
      /expired/i,
    ];
    const errMsg = err instanceof Error ? err.message : "";
    const isSafe = SAFE_PATTERNS.some((p) => p.test(errMsg));
    return withCors(
      Response.json({
        error: isSafe ? errMsg : "Something went wrong. Please try again later.",
      }, { status: 500 }),
      request
    );
  }
};
