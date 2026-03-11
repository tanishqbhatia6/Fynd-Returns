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

const NON_TERMINAL_STATUSES = ["initiated", "pending", "processing", "in progress"];

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
    const items = body.items as Array<{ lineItemId: string; qty: number; reasonCode?: string }> | undefined;
    const manualMode = body.manual === true;
    const manualItemDescription = (body.manualItemDescription as string | undefined)?.trim();
    const customerNotes = (body.customerNotes as string | undefined)?.trim();
    const customerMediaRaw = body.customerMedia as Array<{ name?: string; mimeType?: string; size?: number; dataUrl?: string }> | undefined;
    const currencyCode = (body.currency as string | undefined)?.trim().toUpperCase().slice(0, 10) || null;

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
    // If the portal sends an affiliate_order_id (e.g. FYNDSHOPIFYX14126) or a fynd: prefixed ID,
    // resolve it to the real Shopify GID now so it never gets stored as a Fynd internal ID.
    if (!manualMode && effectiveOrderId && !effectiveOrderId.startsWith("gid://") && !/^\d+$/.test(effectiveOrderId)) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const searchId = effectiveOrderId.replace(/^fynd:/, "").replace(/^#/, "").trim();
        const resolved = await fetchOrderByFyndAffiliateId(admin, searchId);
        if (resolved?.id) {
          console.log(`[create-return] Resolved orderId "${effectiveOrderId}" → "${resolved.id}"`);
          effectiveOrderId = resolved.id;
        }
      } catch (err) {
        console.warn(`[create-return] Could not resolve orderId "${effectiveOrderId}":`, err);
      }
    }
    let itemsToCreate: Array<{ lineItemId: string; qty: number; reasonCode?: string; notes?: string }>;
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
      }));
    }

    // Race-safe duplicate check: will be re-checked inside transaction
    const existingPreCheck = await prisma.returnCase.findFirst({
      where: {
        shopId: shopRecord.id,
        shopifyOrderId: effectiveOrderId,
        status: { in: NON_TERMINAL_STATUSES },
      },
    });
    if (existingPreCheck) {
      return withCors(
        Response.json({
          error: "A return request for this order is already pending. Please wait for approval or rejection.",
        }, { status: 409 }),
        request
      );
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

    // Validate and sanitize uploaded media (max 5 files, images only for DB storage, max 5MB each)
    const MAX_MEDIA_FILES = 5;
    const MAX_MEDIA_SIZE = 5 * 1024 * 1024;
    const ALLOWED_MEDIA_PREFIXES = ["data:image/jpeg", "data:image/png", "data:image/gif", "data:image/webp"];
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

    // Atomic transaction: re-check for duplicates + create return + event in one go
    let returnCase: Awaited<ReturnType<typeof prisma.returnCase.create>> & { returnRequestNo?: string | null };
    try {
      returnCase = await prisma.$transaction(async (tx) => {
        // Re-check inside transaction to prevent race conditions
        const dup = await tx.returnCase.findFirst({
          where: {
            shopId: shopRecord.id,
            shopifyOrderId: effectiveOrderId,
            status: { in: NON_TERMINAL_STATUSES },
          },
        });
        if (dup) {
          throw new Error("DUPLICATE_RETURN");
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
            customerNotes: customerNotes || null,
            customerMediaJson: customerMediaJson,
            currency: currencyCode,
            status,
            isGreenReturn: qualifiesForGreenReturn,
            fyndSyncStatus: status === "approved" && !qualifiesForGreenReturn ? "pending" : null,
            orderProcessedAt: orderCreatedAtValue,
            items: {
              create: itemsToCreate.map((it) => {
                const liInfo = lineItemsWithPrice?.find((l) => l.id === it.lineItemId);
                return {
                  shopifyLineItemId: it.lineItemId,
                  title: liInfo?.title || it.notes || null,
                  variantTitle: liInfo?.variantTitle || null,
                  sku: null,
                  price: liInfo?.price || null,
                  imageUrl: liInfo?.imageUrl || null,
                  qty: it.qty,
                  reasonCode: it.reasonCode || null,
                  notes: it.notes || null,
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
      if (txErr instanceof Error && txErr.message === "DUPLICATE_RETURN") {
        return withCors(
          Response.json({
            error: "A return request for this order is already pending. Please wait for approval or rejection.",
          }, { status: 409 }),
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
          const fyndSync = await createReturnOnFynd(fyndResult.client, rcWithItems, { affiliateOrderId });
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
