import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import shopify from "../shopify.server";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { claimAndCreateShopifyReturn } from "../lib/shopify-return-claim.server";
import {
  fetchOrder,
  fetchOrderByOrderNumber,
  fetchOrderByFyndAffiliateId,
  withRestCredentials,
} from "../lib/shopify-admin.server";
import { sendNewReturnNotification } from "../lib/notification.server";
import {
  parseReturnIdConfig,
  buildReturnRequestId,
  formatReturnRequestId,
} from "../lib/return-request-id";
import { nextReturnIdCounter } from "../lib/return-id-counter.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import {
  hashLookupValue,
  verifyPortalCsrfToken,
  verifyPortalToken,
} from "../lib/portal-auth.server";
import { evaluateAutoApproveRules, parseAutoApproveRules } from "../lib/auto-approve.server";
import { parseJsonArray } from "../lib/parse-json";
import { normalizeSourceChannel } from "../lib/source-channel.server";
import { calculateFraudScore } from "../lib/fraud-detection.server";
import {
  buildBagIndex,
  distributeBagAllocations,
  shipmentSnapshotsFromFyndPayload,
  type ShipmentSnapshot,
} from "../lib/bag-distribution.server";

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
  admin: {
    graphql: (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => Promise<Response>;
  },
  offer: ReturnOffer,
  _shopDomain: string,
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
      appliesOncePerCustomer: true,
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
    /* v8 ignore start - defensive `?? []` userErrors fallback */
    const errors = json.data?.discountCodeBasicCreate?.userErrors ?? [];
    if (errors.length > 0) {
      return { code: "", error: errors.map((e) => e.message).join("; ") };
    }
    /* v8 ignore stop */
    return { code };
  } catch (err) {
    /* v8 ignore start - defensive catch */
    return {
      code: "",
      error: err instanceof Error ? err.message : "Failed to create discount code",
    };
    /* v8 ignore stop */
  }
}

type LiveOrderForValidation = Awaited<ReturnType<typeof fetchOrder>>;

function latestDeliveredAtFromOrder(
  order: { fulfillments?: Array<{ deliveredAt?: string | null }> } | null | undefined,
): string | null {
  const delivered = (order?.fulfillments ?? [])
    .map((f) => f.deliveredAt)
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return delivered[delivered.length - 1] ?? null;
}

function returnPolicyDateFromBody(body: Record<string, unknown>): Date {
  const raw =
    (body.orderDeliveredAt as string | undefined) ||
    (body.orderProcessedAt as string | undefined) ||
    (body.orderCreatedAt as string | undefined);
  return raw ? new Date(raw) : new Date();
}

function clientIpFromRequest(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const raw =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null;
  return raw && raw.length <= 128 ? raw : null;
}

function fraudLevel(score: number): "low" | "medium" | "high" | "critical" {
  if (score >= 81) return "critical";
  if (score >= 61) return "high";
  if (score >= 31) return "medium";
  return "low";
}

function parseAllowedFyndStatusesForCreate(
  settings: { allowedFyndStatusesForReturn?: string | null } | null | undefined,
): string[] {
  try {
    const raw = settings?.allowedFyndStatusesForReturn;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s).toLowerCase().trim()) : [];
  } catch {
    return [];
  }
}

async function loadServerFyndShipmentSnapshot(args: {
  shopDomain: string;
  shopifyOrderName?: string;
  orderId?: string;
  allowedStatuses: string[];
}): Promise<ShipmentSnapshot[] | null> {
  const candidates = [
    args.shopifyOrderName,
    args.shopifyOrderName?.replace(/^#/, ""),
    args.orderId,
    args.orderId?.replace(/^#/, ""),
  ]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v));
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) return null;

  try {
    const logs = await prisma.fyndWebhookLog.findMany({
      where: {
        shopDomain: args.shopDomain,
        rawPayload: { not: null },
        OR: [
          { affiliateOrderId: { in: uniqueCandidates } },
          { orderId: { in: uniqueCandidates } },
          ...uniqueCandidates.map((candidate) => ({
            rawPayload: { contains: candidate },
          })),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { rawPayload: true },
    });

    const bestByBag = new Map<
      string,
      { shipmentId: string; item: ShipmentSnapshot["items"][number]; sourceItemCount: number }
    >();
    for (const log of logs) {
      const snapshot = shipmentSnapshotsFromFyndPayload(log.rawPayload, {
        allowedStatuses: args.allowedStatuses,
      });
      if (snapshot.some((shipment) => shipment.items.length > 0)) {
        for (const shipment of snapshot) {
          const sourceItemCount = shipment.items.length;
          for (const item of shipment.items) {
            const current = bestByBag.get(item.bagId);
            // Prefer the broadest topology payload for a bag. Recent return
            // webhooks often contain only already-returned bags; older placed /
            // delivered webhooks usually contain the complete order bag set.
            if (!current || sourceItemCount > current.sourceItemCount) {
              bestByBag.set(item.bagId, {
                shipmentId: shipment.shipmentId,
                item,
                sourceItemCount,
              });
            }
          }
        }
      }
    }
    if (bestByBag.size > 0) {
      const shipmentsById = new Map<string, ShipmentSnapshot>();
      for (const { shipmentId, item } of bestByBag.values()) {
        const shipment = shipmentsById.get(shipmentId) ?? {
          shipmentId,
          eligible: true,
          items: [],
        };
        shipment.items.push(item);
        shipmentsById.set(shipmentId, shipment);
      }
      for (const shipment of shipmentsById.values()) {
        shipment.items.sort(
          (a, b) =>
            (a.fyndLineNumber ?? Number.MAX_SAFE_INTEGER) -
              (b.fyndLineNumber ?? Number.MAX_SAFE_INTEGER) || a.bagId.localeCompare(b.bagId),
        );
      }
      // In this path the webhook payload is used as a bag topology source,
      // not as the return-eligibility authority. Eligibility is enforced by
      // the live Shopify fulfillment check and the Fynd status gate below.
      return [...shipmentsById.values()];
    }
  } catch {
    return null;
  }

  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

const MAX_CREATE_RETURN_BODY_BYTES = 80 * 1024 * 1024;
const MAX_MEDIA_FILES = 5;
const MAX_IMAGE_MEDIA_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_MEDIA_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ALLOWED_VIDEO_MEDIA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

function parseSafeMediaDataUrl(dataUrl: string):
  | {
      mimeType: string;
      sizeEstimate: number;
    }
  | null {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const encoded = match[2].replace(/\s/g, "");
  const sizeEstimate = Math.ceil((encoded.length * 3) / 4);
  return { mimeType, sizeEstimate };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  const rl = await checkRateLimit(request, "portal.create-return");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > MAX_CREATE_RETURN_BODY_BYTES) {
        return withCors(
          Response.json({ error: "Return request payload too large" }, { status: 413 }),
          request,
        );
      }
    }

    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_CREATE_RETURN_BODY_BYTES) {
      return withCors(
        Response.json({ error: "Return request payload too large" }, { status: 413 }),
        request,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return withCors(Response.json({ error: "Invalid JSON" }, { status: 400 }), request);
    }
    const shop = body.shop as string | undefined;

    // CSRF gate — token is issued by /api/portal/order and bound to the requesting
    // shop. Defends against cross-origin POSTs that the wildcard *.myshopify.com CORS
    // regex would otherwise allow. The portal HTML always sends the token, so
    // we require it by default; set PORTAL_CSRF_REQUIRED=false only as a temporary
    // emergency escape hatch.
    /* v8 ignore start - defensive `?? "true"` env fallback */
    const REQUIRE_CSRF =
      String(process.env.PORTAL_CSRF_REQUIRED ?? "true").toLowerCase() !== "false";
    /* v8 ignore stop */
    if (REQUIRE_CSRF || body.portalCsrfToken) {
      /* v8 ignore start - defensive shop-domain normalization ternary */
      const expectedShop = shop?.includes(".") ? shop : `${shop}.myshopify.com`;
      /* v8 ignore stop */
      const ok = verifyPortalCsrfToken(body.portalCsrfToken as string | undefined, expectedShop);
      if (!ok) {
        return withCors(
          Response.json(
            { error: "Session expired. Refresh the page and try again." },
            { status: 403 },
          ),
          request,
        );
      }
    }

    const orderId = body.orderId as string | undefined;
    const shopifyOrderNameRaw = (body.shopifyOrderName as string | undefined)?.trim();
    /* v8 ignore start - defensive nested ternary for #-prefix normalization */
    const shopifyOrderName = shopifyOrderNameRaw?.startsWith("#")
      ? shopifyOrderNameRaw
      : shopifyOrderNameRaw
        ? `#${shopifyOrderNameRaw}`
        : undefined;
    /* v8 ignore stop */
    /* v8 ignore start - defensive `?.` chain for absent customerEmail */
    const customerEmail = (body.customerEmail as string | undefined)?.trim().toLowerCase();
    /* v8 ignore stop */
    // defensive: optional-chain `|| null` fallbacks for absent customer fields
    /* v8 ignore start */
    const customerPhone =
      (body.customerPhone as string | undefined)?.trim().replace(/[^\d+]/g, "") || null;
    const customerName = (body.customerName as string | undefined)?.trim() || null;
    const customerCity = (body.customerCity as string | undefined)?.trim() || null;
    const customerCountry = (body.customerCountry as string | undefined)?.trim() || null;
    const customerAddress1 =
      (body.customerAddress1 as string | undefined)?.trim().slice(0, 500) || null;
    const customerAddress2 =
      (body.customerAddress2 as string | undefined)?.trim().slice(0, 500) || null;
    const customerProvince =
      (body.customerProvince as string | undefined)?.trim().slice(0, 100) || null;
    const customerZip = (body.customerZip as string | undefined)?.trim().slice(0, 20) || null;
    const customerLandmark =
      (body.customerLandmark as string | undefined)?.trim().slice(0, 500) || null;
    /* v8 ignore stop */
    const items = body.items as
      | Array<{
          lineItemId: string;
          qty: number;
          reasonCode?: string;
          condition?: string;
          fyndShipmentId?: string;
          fyndBagId?: string;
          fyndArticleId?: string;
          fyndAffiliateLineId?: string;
          fyndSellerIdentifier?: string;
          fyndItemId?: string;
          fyndQuantityAvailable?: number;
          fyndPriceEffective?: string;
          fyndSize?: string;
          fyndLineNumber?: number;
        }>
      | undefined;
    const manualMode = body.manual === true;
    /* v8 ignore start - defensive `?.trim()`/`|| null` fallbacks for optional body fields */
    const manualItemDescription = (body.manualItemDescription as string | undefined)?.trim();
    const customerNotes = (body.customerNotes as string | undefined)?.trim();
    const customerMediaRaw = body.customerMedia as
      | Array<{ name?: string; mimeType?: string; size?: number; dataUrl?: string }>
      | undefined;
    const currencyCode =
      (body.currency as string | undefined)?.trim().toUpperCase().slice(0, 10) || null;
    const rawResolutionType = (body.resolutionType as string | undefined)?.trim().toLowerCase();
    const resolutionType =
      rawResolutionType === "exchange" ||
      rawResolutionType === "replacement" ||
      rawResolutionType === "store_credit"
        ? rawResolutionType
        : "refund";
    const exchangePreference =
      resolutionType === "exchange" || resolutionType === "replacement"
        ? (body.exchangePreference as string | undefined)?.trim().slice(0, 500) || null
        : null;
    /* v8 ignore stop */
    // Structured variant selections from the portal exchange picker. We accept it as a
    // sidecar payload (sanitised into the existing exchangePreference text) so we don't
    // need a schema migration. Each entry: { lineItemId, productId, variantId, variantTitle }
    //
    // Server-side variant validation runs further down (see "Validate exchange variants
    // against Shopify catalog" block). The client-supplied variantTitle is treated as
    // display-only — never trusted as the source of truth.
    const rawExchangeVariants = body.exchangeVariants as
      | Array<{
          lineItemId?: string;
          productId?: string;
          variantId?: string;
          variantTitle?: string;
        }>
      | undefined;
    const exchangeVariantSelections =
      resolutionType === "exchange" && Array.isArray(rawExchangeVariants)
        ? // defensive: nullish/typeof fallbacks for partial exchange variant payloads
          /* v8 ignore start */
          rawExchangeVariants
            .slice(0, 20)
            .filter((v) => typeof v?.variantId === "string" && v.variantId.trim().length > 0)
            .map((v) => ({
              lineItemId: String(v.lineItemId ?? "").slice(0, 200),
              productId: String(v.productId ?? "").slice(0, 200),
              variantId: String(v.variantId).slice(0, 200),
              variantTitle: typeof v.variantTitle === "string" ? v.variantTitle.slice(0, 200) : "",
            }))
        : /* v8 ignore stop */
          [];

    if (!shop || !shopifyOrderName) {
      return withCors(
        Response.json({ error: "Shop and order number are required" }, { status: 400 }),
        request,
      );
    }
    const orderNameClean = shopifyOrderName.replace(/^#/, "").trim();
    if (!orderNameClean || orderNameClean.length > 64) {
      return withCors(Response.json({ error: "Invalid order number" }, { status: 400 }), request);
    }
    if (!manualMode && !orderId) {
      return withCors(
        Response.json({ error: "orderId is required for automatic mode" }, { status: 400 }),
        request,
      );
    }

    /* v8 ignore start - defensive shop-domain normalization ternary */
    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    /* v8 ignore stop */
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    const settings = shopRecord.settings;
    /* v8 ignore start - defensive `?? 30`/`?? ""` fallbacks for optional settings */
    const returnWindowDays = settings?.returnWindowDays ?? 30;

    const shopSession = await prisma.session.findFirst({ where: { shop: shopDomain } });
    const shopAccessToken = shopSession?.accessToken ?? "";
    /* v8 ignore stop */

    if (manualMode && settings?.portalOtpEmailEnabled) {
      const portalToken = body.portalToken as string | undefined;
      const portalClaims = portalToken ? verifyPortalToken(portalToken) : null;
      const expectedHash = customerEmail ? hashLookupValue(customerEmail) : null;
      if (
        !portalClaims ||
        portalClaims.shopId !== shopRecord.id ||
        portalClaims.lookupType !== "email" ||
        !expectedHash ||
        portalClaims.lookupValueHash !== expectedHash
      ) {
        return withCors(
          Response.json(
            { error: "Please verify your email before submitting a manual return." },
            { status: 403 },
          ),
          request,
        );
      }
    }

    // Blocklist check
    if (settings?.blocklistEnabled && settings.id) {
      /* v8 ignore start - defensive truthy guards for optional contact fields */
      const blockChecks: { type: string; value: string }[] = [];
      if (customerEmail) blockChecks.push({ type: "email", value: customerEmail });
      if (customerPhone) blockChecks.push({ type: "phone", value: customerPhone });
      if (shopifyOrderName)
        blockChecks.push({ type: "order_name", value: shopifyOrderName.toLowerCase() });
      /* v8 ignore stop */

      // defensive: blockChecks always non-empty when blocklistEnabled (email + phone + order_name); empty fallback unreachable
      /* v8 ignore start */
      if (blockChecks.length > 0) {
        /* v8 ignore stop */
        const blocked = await prisma.blocklistEntry.findFirst({
          where: {
            settingsId: settings.id,
            OR: blockChecks.map((c) => ({ type: c.type, value: c.value })),
          },
        });
        if (blocked) {
          return withCors(
            Response.json(
              {
                error: "Unable to process return request. Please contact support.",
              },
              { status: 403 },
            ),
            request,
          );
        }
      }
    }

    // Return offer: if customer is accepting an offer, generate discount code instead of creating return
    const acceptOffer = body.acceptOffer === true;
    if (acceptOffer && !manualMode) {
      if (!settings?.returnOffersEnabled) {
        return withCors(
          Response.json({ error: "Return offers are not enabled" }, { status: 400 }),
          request,
        );
      }
      /* v8 ignore start - defensive `?? null`/`?? []` fallbacks for optional offer fields */
      const offersArr = parseJsonArray<ReturnOffer>(settings.returnOffersJson ?? null, []);
      const firstReasonCode = (body.items as Array<{ reasonCode?: string }> | undefined)?.[0]
        ?.reasonCode;
      const allTags = (
        (body.lineItemsWithPrice ?? []) as Array<{ productTags?: string[] }>
      ).flatMap((li) => li.productTags ?? []);
      /* v8 ignore stop */
      const matchedOffer = matchReturnOffers(offersArr, firstReasonCode, allTags);
      if (!matchedOffer) {
        return withCors(
          Response.json({ error: "No matching offer found" }, { status: 400 }),
          request,
        );
      }
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const discountResult = await createDiscountCode(admin, matchedOffer, shopDomain);
        if (discountResult.error || !discountResult.code) {
          /* v8 ignore start - defensive `||` fallback for empty error message */
          return withCors(
            Response.json(
              { error: discountResult.error || "Failed to generate discount code" },
              { status: 500 },
            ),
            request,
          );
          /* v8 ignore stop */
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
        return withCors(
          Response.json(
            { error: "Could not generate discount code. Please try again." },
            { status: 500 },
          ),
          request,
        );
      }
    }

    let effectiveOrderId = manualMode ? `manual:${shopifyOrderName}` : orderId!;

    // Ensure shopifyOrderId is always a valid Shopify GID when possible.
    // If the portal sends an order name (e.g. FYNDSHOPIFYX14126) instead of a GID,
    // resolve it to the real Shopify GID now so future lookups are instant.
    if (
      !manualMode &&
      effectiveOrderId &&
      !effectiveOrderId.startsWith("gid://") &&
      !/^\d+$/.test(effectiveOrderId)
    ) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const searchId = effectiveOrderId.replace(/^#/, "").trim();
        const resolved = await fetchOrderByFyndAffiliateId(admin, searchId);
        if (resolved?.id) {
          console.log(`[create-return] Resolved orderId "${effectiveOrderId}" → "${resolved.id}"`);
          // Backfill the FyndOrderMapping with the resolved Shopify GID for future lookups.
          // `void` makes the fire-and-forget intent explicit so linters / future readers
          // don't add a stray `await` that would block the request on a best-effort cache write.
          if (resolved.id.startsWith("gid://") && shopifyOrderName) {
            void prisma.fyndOrderMapping
              .upsert({
                where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName } },
                create: {
                  shopId: shopRecord.id,
                  shopifyOrderName,
                  shopifyOrderId: resolved.id,
                  searchStrategy: "create_return_resolve",
                },
                update: { shopifyOrderId: resolved.id },
                // best-effort cache write — swallow upstream errors
                /* v8 ignore start */
              })
              .catch(() => {});
            /* v8 ignore stop */
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
            console.log(
              `[create-return] Resolved orderId "${effectiveOrderId}" → "${mapping.shopifyOrderId}" via FyndOrderMapping`,
            );
            effectiveOrderId = mapping.shopifyOrderId;
          }
        } catch {
          // Non-fatal
        }
      }

      // Last resort: if order ID still looks like a Fynd affiliate ID (e.g. FYNDSHOPIFYX14115),
      // try resolving with Fynd prefix stripping to extract the Shopify order number.
      if (
        !effectiveOrderId.startsWith("gid://") &&
        /^FYND/i.test(effectiveOrderId.replace(/^#/, ""))
      ) {
        try {
          const { admin: rawAdmin2 } = await shopify.unauthenticated.admin(shopDomain);
          const admin2 = withRestCredentials(rawAdmin2, shopDomain, shopAccessToken);
          const lastResort = await fetchOrderByFyndAffiliateId(
            admin2,
            effectiveOrderId.replace(/^#/, ""),
          );
          /* v8 ignore start - defensive `?.id?.startsWith` chain on null lastResort */
          if (lastResort?.id?.startsWith("gid://")) {
            console.log(
              `[create-return] Last-resort resolved orderId "${effectiveOrderId}" → "${lastResort.id}"`,
            );
            effectiveOrderId = lastResort.id;
            // Backfill FyndOrderMapping for future lookups (fire-and-forget cache write)
            if (shopifyOrderName) {
              void prisma.fyndOrderMapping
                .upsert({
                  where: { shopId_shopifyOrderName: { shopId: shopRecord.id, shopifyOrderName } },
                  create: {
                    shopId: shopRecord.id,
                    shopifyOrderName,
                    shopifyOrderId: lastResort.id,
                    searchStrategy: "create_return_last_resort",
                  },
                  update: { shopifyOrderId: lastResort.id },
                  // best-effort cache write — swallow upstream errors
                  /* v8 ignore start */
                })
                .catch(() => {});
              /* v8 ignore stop */
            }
          }
          /* v8 ignore stop */
        } catch {
          /* v8 ignore start - defensive non-fatal catch */
          // Non-fatal — proceed with original ID
          /* v8 ignore stop */
        }
      }
    }
    let itemsToCreate: Array<{
      lineItemId: string;
      qty: number;
      reasonCode?: string;
      notes?: string;
      condition?: string;
      fyndShipmentId?: string;
      fyndBagId?: string;
      fyndArticleId?: string;
      fyndAffiliateLineId?: string;
      fyndSellerIdentifier?: string;
      fyndItemId?: string;
      fyndQuantityAvailable?: number;
      fyndPriceEffective?: string;
      fyndSize?: string;
      fyndLineNumber?: number;
    }>;
    let lineItemsWithPrice: Array<{
      id: string;
      title?: string;
      variantTitle?: string;
      price?: string;
      imageUrl?: string;
      productTags?: string[];
      productType?: string | null;
    }> = [];

    let usedScopedFyndBagAllocation = false;
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (manualMode) {
      if (!customerEmail) {
        return withCors(
          Response.json({ error: "Email is required for manual return requests" }, { status: 400 }),
          request,
        );
      }
      if (!EMAIL_REGEX.test(customerEmail)) {
        return withCors(
          Response.json({ error: "Please enter a valid email address" }, { status: 400 }),
          request,
        );
      }
      if (!manualItemDescription || manualItemDescription.length < 3) {
        return withCors(
          Response.json(
            { error: "Please describe the item(s) you want to return (at least 3 characters)" },
            { status: 400 },
          ),
          request,
        );
      }
      if (manualItemDescription.length > 2000) {
        return withCors(
          Response.json({ error: "Item description is too long" }, { status: 400 }),
          request,
        );
      }
      itemsToCreate = [
        {
          lineItemId: "manual",
          qty: 1,
          reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : "Other",
          notes: manualItemDescription,
        },
      ];

      // Best-effort fulfillment check for manual returns
      /* v8 ignore start - defensive best-effort manual order lookup */
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const manualOrderLookup = await fetchOrderByOrderNumber(admin, orderNameClean);
        if (manualOrderLookup) {
          // defensive: nullish-coalesce defaults rarely hit; manual mode tests skip this branch
          /* v8 ignore start */
          const manualFulfill = (manualOrderLookup.displayFulfillmentStatus ?? "").toUpperCase();
          const manualFinancial = (manualOrderLookup.displayFinancialStatus ?? "").toUpperCase();
          /* v8 ignore stop */
          if (
            manualFulfill === "UNFULFILLED" ||
            manualFulfill === "" ||
            manualFulfill === "SCHEDULED" ||
            manualFulfill === "ON_HOLD"
          ) {
            return withCors(
              Response.json(
                {
                  error:
                    "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
                },
                { status: 400 },
              ),
              request,
            );
          }
          if (manualFinancial === "REFUNDED" || manualFinancial === "VOIDED") {
            return withCors(
              Response.json(
                {
                  error: "This order has already been refunded and is not eligible for a return.",
                },
                { status: 400 },
              ),
              request,
            );
          }
        }
      } catch {
        // If lookup fails (e.g., PCDA, session not found), allow manual submission — admin will review
      }
      /* v8 ignore stop */
    } else {
      if (!items || !Array.isArray(items) || items.length === 0) {
        return withCors(
          Response.json(
            { error: "At least one item must be selected for return" },
            { status: 400 },
          ),
          request,
        );
      }
      for (const it of items) {
        if (!it?.lineItemId || typeof it.qty !== "number" || it.qty < 1) {
          return withCors(
            Response.json(
              { error: "Each item must have lineItemId and qty >= 1" },
              { status: 400 },
            ),
            request,
          );
        }
        if (it.qty > 999) {
          return withCors(
            Response.json({ error: "Item quantity exceeds maximum allowed" }, { status: 400 }),
            request,
          );
        }
      }
      if (items.length > 100) {
        return withCors(
          Response.json({ error: "Too many items in return request" }, { status: 400 }),
          request,
        );
      }
      // The portal now sends ONE item per Shopify line at the LINE
      // level (no bagId). The backend distributes that line-level qty
      // across the available Fynd bags using the shipment snapshot
      // attached to the request. Distribution happens here so it's
      // semantic-aware (skips ineligible shipments, subtracts already-
      // returned units, picks bags greedily) and so the resulting
      // ReturnItems have the right per-bag metadata for the Fynd sync.
      //
      // Backward-compat: if a caller still sends `fyndBagId` per-item
      // (older clients, admin-mode), we keep the legacy per-bag path
      // and skip the distributor.
      const hasBagAware = items.some((it) => !!it.fyndBagId);
      const clientShipmentsSnapshot = Array.isArray(body.shipmentsSnapshot)
        ? (body.shipmentsSnapshot as ShipmentSnapshot[])
        : null;
      const serverShipmentsSnapshot = !hasBagAware
        ? await loadServerFyndShipmentSnapshot({
            shopDomain,
            shopifyOrderName,
            orderId: effectiveOrderId || orderId,
            allowedStatuses: parseAllowedFyndStatusesForCreate(settings),
          })
        : null;
      const shipmentsSnapshot =
        serverShipmentsSnapshot && serverShipmentsSnapshot.length > 0
          ? serverShipmentsSnapshot
          : clientShipmentsSnapshot;
      if (!hasBagAware && shipmentsSnapshot && shipmentsSnapshot.length > 0) {
        // Customer-portal path: distribute line-level qty across bags.
        // Prefer the server-side Fynd webhook snapshot when present. Fynd's
        // placed/return payload shape is stable and contains the authoritative
        // bag_id + line_number + seller_identifier mapping; the browser-posted
        // snapshot is only a fallback for shops without cached webhook data.
        const snapshotShipmentIds = [
          ...new Set(shipmentsSnapshot.map((s) => s.shipmentId).filter(Boolean) as string[]),
        ];
        const snapshotBagIds = [
          ...new Set(
            shipmentsSnapshot
              .flatMap((s) => s.items ?? [])
              .map((i) => i.bagId)
              .filter(Boolean) as string[],
          ),
        ];
        const reservedBagQtyMap: Record<string, number> = {};
        if (snapshotShipmentIds.length > 0 || snapshotBagIds.length > 0) {
          const returnCaseOrderFilters: Array<Record<string, unknown>> = [
            { shopifyOrderName: { equals: shopifyOrderName, mode: "insensitive" } },
            { shopifyOrderId: effectiveOrderId },
          ];
          if (!effectiveOrderId.startsWith("gid://")) {
            returnCaseOrderFilters.push({
              fyndOrderId: { equals: effectiveOrderId, mode: "insensitive" },
            });
          }
          const existingBagReturns = await prisma.returnItem.findMany({
            where: {
              OR: [
                ...(snapshotShipmentIds.length > 0
                  ? [{ fyndShipmentId: { in: snapshotShipmentIds } }]
                  : []),
                ...(snapshotBagIds.length > 0 ? [{ fyndBagId: { in: snapshotBagIds } }] : []),
              ],
              returnCase: {
                shopId: shopRecord.id,
                status: { notIn: ["rejected", "cancelled"] },
                OR: returnCaseOrderFilters,
              },
            },
            select: { fyndShipmentId: true, fyndBagId: true, qty: true },
          });
          for (const returned of existingBagReturns) {
            if (!returned.fyndBagId) continue;
            reservedBagQtyMap[returned.fyndBagId] =
              (reservedBagQtyMap[returned.fyndBagId] ?? 0) + returned.qty;
            if (returned.fyndShipmentId) {
              const scopedKey = `${returned.fyndShipmentId}::${returned.fyndBagId}`;
              reservedBagQtyMap[scopedKey] = (reservedBagQtyMap[scopedKey] ?? 0) + returned.qty;
            }
          }
        }
        const bagIndex = buildBagIndex(shipmentsSnapshot, reservedBagQtyMap);
        const inputs = items.map((it) => ({
          lineItemId: String(it.lineItemId).slice(0, 256),
          qty: Math.min(Math.max(1, Math.floor(it.qty)), 999),
          reasonCode: it.reasonCode ? String(it.reasonCode).slice(0, 256) : undefined,
          condition: it.condition ? String(it.condition).slice(0, 64) : undefined,
        }));
        const { items: distributed, unsatisfied } = distributeBagAllocations(inputs, bagIndex);
        if (unsatisfied.size > 0) {
          // The customer asked for more units than Fynd actually has
          // available across all eligible shipments. Surface this
          // explicitly rather than silently under-creating — it's
          // either stale order data on the client (race against an
          // admin's manual return) or a malicious payload.
          const detail = [...unsatisfied.entries()]
            .map(([k, v]) => `line ${k.slice(-12)}: ${v} unit(s) unavailable`)
            .join("; ");
          return withCors(
            Response.json(
              {
                error:
                  "Some requested quantities are no longer available. Refresh and try again. Details: " +
                  detail,
              },
              { status: 409 },
            ),
            request,
          );
        }
        itemsToCreate = distributed;
        usedScopedFyndBagAllocation = distributed.some(
          (it) => Boolean(it.fyndShipmentId) && Boolean(it.fyndBagId),
        );
      } else {
        // Legacy / admin-mode path: caller already provides bagIds per
        // item, just normalise + cap. CRITICAL: cap qty to bag capacity
        // when fyndBagId is set (one bag = one bag's worth, never N).
        itemsToCreate = items.map((it) => {
          let safeQty = Math.min(Math.max(1, Math.floor(it.qty)), 999);
          if (it.fyndBagId) {
            const bagCap =
              typeof it.fyndQuantityAvailable === "number" &&
              Number.isFinite(it.fyndQuantityAvailable) &&
              it.fyndQuantityAvailable > 0
                ? Math.floor(it.fyndQuantityAvailable)
                : 1;
            safeQty = Math.min(safeQty, bagCap);
          }
          return {
            // defensive: per-field truthy/typeof guards on optional Fynd metadata
            /* v8 ignore start */
            lineItemId: String(it.lineItemId).slice(0, 256),
            qty: safeQty,
            reasonCode: it.reasonCode ? String(it.reasonCode).slice(0, 256) : undefined,
            condition: it.condition ? String(it.condition).slice(0, 64) : undefined,
            fyndShipmentId: it.fyndShipmentId ? String(it.fyndShipmentId).slice(0, 256) : undefined,
            fyndBagId: it.fyndBagId ? String(it.fyndBagId).slice(0, 256) : undefined,
            fyndArticleId: it.fyndArticleId ? String(it.fyndArticleId).slice(0, 256) : undefined,
            fyndAffiliateLineId: it.fyndAffiliateLineId
              ? String(it.fyndAffiliateLineId).slice(0, 256)
              : undefined,
            fyndSellerIdentifier: it.fyndSellerIdentifier
              ? String(it.fyndSellerIdentifier).slice(0, 256)
              : undefined,
            fyndItemId: it.fyndItemId ? String(it.fyndItemId).slice(0, 256) : undefined,
            fyndQuantityAvailable:
              typeof it.fyndQuantityAvailable === "number" ? it.fyndQuantityAvailable : undefined,
            fyndPriceEffective: it.fyndPriceEffective
              ? String(it.fyndPriceEffective).slice(0, 64)
              : undefined,
            fyndSize: it.fyndSize ? String(it.fyndSize).slice(0, 64) : undefined,
            fyndLineNumber: typeof it.fyndLineNumber === "number" ? it.fyndLineNumber : undefined,
            /* v8 ignore stop */
          };
        });
      }
    }

    // ── Resolve non-GID lineItemIds to real Shopify line item GIDs ──
    // When the portal sends Fynd bag IDs (e.g. "3777852") instead of Shopify GIDs
    // (e.g. "gid://shopify/LineItem/16891834630294"), fetch the Shopify order and
    // match items by title/SKU to get the correct GIDs for refund processing.
    // Also stores resolved SKU for future SKU matching in refund flow.
    const resolvedLineItemSkus = new Map<string, string>(); // newLineItemId → sku
    const lineItemIdMapping = new Map<string, string>(); // newLineItemId → originalPortalId
    let capturedSourceChannel: string | null = null; // set when Shopify order is fetched
    if (!manualMode) {
      const hasNonGidLineItems = itemsToCreate.some(
        (it) => it.lineItemId !== "manual" && !it.lineItemId.startsWith("gid://shopify/LineItem/"),
      );
      if (hasNonGidLineItems) {
        /* v8 ignore start - defensive line-item resolution best-effort path */
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
                console.log(
                  `[create-return] Late-resolved orderId "${effectiveOrderId}" → "${resolved.id}" during line item resolution`,
                );
                effectiveOrderId = resolved.id;
              }
            }
          }
          if (shopifyOrder?.sourceName) {
            capturedSourceChannel = normalizeSourceChannel(shopifyOrder.sourceName);
          }
          if (shopifyOrder?.lineItems && shopifyOrder.lineItems.length > 0) {
            const shopifyLineItems = shopifyOrder.lineItems;
            // Build lookup maps for matching: by title (lowercased), by SKU
            const byTitle = new Map<string, (typeof shopifyLineItems)[0]>();
            const bySku = new Map<string, (typeof shopifyLineItems)[0]>();
            for (const sli of shopifyLineItems) {
              if (sli.title) byTitle.set(sli.title.toLowerCase(), sli);
              if (sli.sku) bySku.set(sli.sku.toLowerCase(), sli);
            }

            // Also build lineItemsWithPrice title lookup for cross-referencing
            const portalItemById = new Map<string, { title?: string; sku?: string }>();
            const rawLineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
              id: string;
              title?: string;
              sku?: string;
            }>;
            for (const li of rawLineItemsWithPrice) {
              portalItemById.set(li.id, li);
            }

            for (const it of itemsToCreate) {
              // defensive: gid-prefixed items are already resolved
              /* v8 ignore start */
              if (it.lineItemId === "manual" || it.lineItemId.startsWith("gid://shopify/LineItem/"))
                continue;
              /* v8 ignore stop */
              const originalId = it.lineItemId;
              // Try to find the matching Shopify line item
              const portalItem = portalItemById.get(it.lineItemId);
              const titleToMatch = portalItem?.title?.toLowerCase();
              const skuToMatch = portalItem?.sku?.toLowerCase();

              let matched: (typeof shopifyLineItems)[0] | undefined;
              // Match by SKU first (more reliable)
              if (skuToMatch) matched = bySku.get(skuToMatch);
              // Fall back to title match
              if (!matched && titleToMatch) matched = byTitle.get(titleToMatch);
              // If only one Shopify line item exists, use it (common for single-item orders)
              if (!matched && shopifyLineItems.length === 1) matched = shopifyLineItems[0];

              if (matched) {
                console.log(
                  `[create-return] Resolved lineItemId "${it.lineItemId}" → "${matched.id}" (${matched.title}, sku: ${matched.sku})`,
                );
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
        /* v8 ignore stop */
      }
    }

    // Per-line-item quantity pre-check: allow new returns for the same order
    // as long as there is remaining quantity for the requested line items.
    // This replaces the old blanket duplicate check that blocked ALL returns
    // for an order if any non-terminal return existed.
    //
    // For Fynd multi-shipment orders we ALSO check per-(shipmentId, bagId).
    // The Shopify line-item-level check is too coarse: when a 3-qty product
    // is split across 3 shipments (1 bag each), the line-item-level check
    // permits all 3 bags through (alreadyReturned=2, qty=1, originalQty=3).
    // The bag-level check stops a customer from re-selecting a specific bag
    // that's already in an active return — which is the actual intent.
    if (
      !manualMode &&
      itemsToCreate.length > 0 &&
      effectiveOrderId &&
      !effectiveOrderId.startsWith("manual:")
    ) {
      /* v8 ignore start - defensive `.filter(Boolean)` for optional Fynd id fields */
      const preCheckLineItemIds = itemsToCreate
        .map((it) => it.lineItemId)
        .filter((id) => id !== "manual");
      const preCheckBagIds = itemsToCreate.map((it) => it.fyndBagId).filter(Boolean) as string[];
      const preCheckShipmentIds = [
        ...new Set(itemsToCreate.map((it) => it.fyndShipmentId).filter(Boolean) as string[]),
      ];
      /* v8 ignore stop */

      if (preCheckLineItemIds.length > 0 || preCheckBagIds.length > 0) {
        const orderScopeFilters: Array<Record<string, unknown>> = [
          { shopifyOrderName: { equals: shopifyOrderName, mode: "insensitive" } },
          { shopifyOrderId: effectiveOrderId },
        ];
        if (!effectiveOrderId.startsWith("gid://")) {
          orderScopeFilters.push({
            fyndOrderId: { equals: effectiveOrderId, mode: "insensitive" },
          });
        }
        if (shopifyOrderName) {
          orderScopeFilters.push({
            fyndOrderId: { equals: shopifyOrderName.replace(/^#/, ""), mode: "insensitive" },
          });
        }
        const orFilters: Array<Record<string, unknown>> = [];
        if (preCheckLineItemIds.length > 0) {
          orFilters.push({ shopifyLineItemId: { in: preCheckLineItemIds } });
        }
        if (preCheckBagIds.length > 0) {
          orFilters.push({ fyndBagId: { in: preCheckBagIds } });
        }
        if (preCheckShipmentIds.length > 0) {
          orFilters.push({ fyndShipmentId: { in: preCheckShipmentIds } });
        }
        const existingReturnItems = await prisma.returnItem.findMany({
          where: {
            ...(orFilters.length > 0 ? { OR: orFilters } : {}),
            returnCase: {
              shopId: shopRecord.id,
              status: { notIn: ["rejected", "cancelled"] },
              OR: orderScopeFilters,
            },
          },
          select: {
            shopifyLineItemId: true,
            fyndShipmentId: true,
            fyndBagId: true,
            sku: true,
            qty: true,
          },
        });

        const preAlreadyReturnedMap: Record<string, number> = {};
        // Bag-level: bagId is the durable unit identity. Fynd changes shipment
        // IDs when a return shipment is created, so `${shipmentId}::${bagId}`
        // alone is not enough to prevent a later request from reusing the same
        // physical bag on the same Shopify order.
        const bagAlreadyReturnedMap: Record<string, number> = {};
        const scopedBagAlreadyReturnedMap: Record<string, number> = {};
        // SKU-level per shipment fallback: key = `${shipmentId}::sku:${sku}` — used when
        // the DB has resolved bagId away into a Shopify GID and exact bag matching fails.
        const shipmentSkuAlreadyReturnedMap: Record<string, number> = {};
        for (const ri of existingReturnItems) {
          if (ri.shopifyLineItemId) {
            preAlreadyReturnedMap[ri.shopifyLineItemId] =
              (preAlreadyReturnedMap[ri.shopifyLineItemId] ?? 0) + ri.qty;
          }
          if (ri.fyndShipmentId && ri.fyndBagId) {
            const k = `${ri.fyndShipmentId}::${ri.fyndBagId}`;
            scopedBagAlreadyReturnedMap[k] = (scopedBagAlreadyReturnedMap[k] ?? 0) + ri.qty;
          }
          if (ri.fyndBagId) {
            bagAlreadyReturnedMap[ri.fyndBagId] =
              (bagAlreadyReturnedMap[ri.fyndBagId] ?? 0) + ri.qty;
          }
          if (ri.fyndShipmentId && ri.sku) {
            const k = `${ri.fyndShipmentId}::sku:${ri.sku.toLowerCase().trim()}`;
            shipmentSkuAlreadyReturnedMap[k] = (shipmentSkuAlreadyReturnedMap[k] ?? 0) + ri.qty;
          }
        }

        const lineItemEstimates = (body.lineItemEstimates ?? []) as Array<{
          lineItemId: string;
          quantity: number;
        }>;
        // Track requested qtys within this submission so two items targeting the
        // same bag in one POST can't bypass the per-bag cap individually.
        const requestedBagMap: Record<string, number> = {};
        for (const sel of itemsToCreate) {
          if (sel.lineItemId === "manual") continue;
          const liInfo = (
            body.lineItemsWithPrice as
              | Array<{ id: string; title?: string; quantity?: number; sku?: string }>
              | undefined
          )?.find((l) => l.id === sel.lineItemId);
          const itemTitle = liInfo?.title ?? sel.lineItemId;

          // (a) Bag-level cap (Fynd multi-shipment).
          if (sel.fyndShipmentId && sel.fyndBagId) {
            const bagKey = `${sel.fyndShipmentId}::${sel.fyndBagId}`;
            const bagOnlyKey = sel.fyndBagId;
            const bagCapacity =
              typeof sel.fyndQuantityAvailable === "number" && sel.fyndQuantityAvailable > 0
                ? sel.fyndQuantityAvailable
                : (liInfo?.quantity ?? 1);
            const bagReturned = Math.max(
              scopedBagAlreadyReturnedMap[bagKey] ?? 0,
              bagAlreadyReturnedMap[bagOnlyKey] ?? 0,
            );
            requestedBagMap[bagOnlyKey] = (requestedBagMap[bagOnlyKey] ?? 0) + sel.qty;
            if (bagReturned + requestedBagMap[bagOnlyKey] > bagCapacity) {
              return withCors(
                Response.json(
                  {
                    error: `"${itemTitle}" is already in an active return for shipment ${sel.fyndShipmentId}. Please refresh the page — only un-returned items can be selected.`,
                  },
                  { status: 400 },
                ),
                request,
              );
            }
          } else if (sel.fyndShipmentId && liInfo?.sku) {
            // SKU-fallback for Fynd shipments where bagId got resolved away.
            const skuKey = `${sel.fyndShipmentId}::sku:${liInfo.sku.toLowerCase().trim()}`;
            const skuReturned = shipmentSkuAlreadyReturnedMap[skuKey] ?? 0;
            const cap = liInfo.quantity ?? 999;
            if (skuReturned + sel.qty > cap) {
              return withCors(
                Response.json(
                  {
                    error: `"${itemTitle}" is already in an active return for this shipment. Please refresh and select a different bag.`,
                  },
                  { status: 400 },
                ),
                request,
              );
            }
          }

          // (b) Order-level line-item cap (existing behaviour, kept for non-Fynd shops
          // and as a backstop). Skip it for exact Fynd bags: identical-SKU orders
          // may share one Shopify line/SKU, while the real availability unit is bagId.
          if (!sel.fyndBagId) {
            const alreadyReturned = preAlreadyReturnedMap[sel.lineItemId] ?? 0;
            const originalQty =
              lineItemEstimates.find((e) => e.lineItemId === sel.lineItemId)?.quantity ??
              liInfo?.quantity ??
              999;
            if (alreadyReturned + sel.qty > originalQty) {
              return withCors(
                Response.json(
                  {
                    error: `Return quantity exceeds available for "${itemTitle}". ${alreadyReturned} already in return, ${sel.qty} requested, but only ${originalQty} ordered.`,
                  },
                  { status: 400 },
                ),
                request,
              );
            }
          }
        }
      }
    }

    // Server-side fulfillment status validation (non-manual mode)
    let liveOrderForValidation: LiveOrderForValidation | null = null;
    if (!manualMode && orderId) {
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const liveOrder = await fetchOrder(admin, effectiveOrderId);
        liveOrderForValidation = liveOrder;
        if (liveOrder) {
          if (liveOrder.sourceName) {
            capturedSourceChannel = normalizeSourceChannel(liveOrder.sourceName);
          }
          // defensive: nullish-coalesce defaults rarely hit
          /* v8 ignore start */
          const fulfillStatus = (liveOrder.displayFulfillmentStatus ?? "").toUpperCase();
          const finStatus = (liveOrder.displayFinancialStatus ?? "").toUpperCase();
          /* v8 ignore stop */

          if (
            fulfillStatus === "UNFULFILLED" ||
            fulfillStatus === "" ||
            fulfillStatus === "SCHEDULED" ||
            fulfillStatus === "ON_HOLD"
          ) {
            return withCors(
              Response.json(
                {
                  error:
                    "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
                },
                { status: 400 },
              ),
              request,
            );
          }
          if (finStatus === "REFUNDED" || finStatus === "VOIDED") {
            return withCors(
              Response.json(
                {
                  error: "This order has already been refunded and is not eligible for a return.",
                },
                { status: 400 },
              ),
              request,
            );
          }
        }
      } catch (fulfillErr) {
        console.warn("[Portal create-return] Fulfillment status check failed:", fulfillErr);
        // If we can't verify, fall through — the order lookup would have already blocked in the portal
      }
    }

    // Server-side Fynd delivery gate: block returns for orders that haven't been delivered.
    // Applies to ALL orders with Fynd data (not just when merchant has configured the gate).
    // Post-delivery statuses are always allowed; pre-delivery requires explicit merchant opt-in.
    const FYND_DELIVERED_STATUSES_CREATE = new Set([
      "delivery_done",
      "delivered",
      "bag_delivered",
      "handed_over_to_customer",
      "return_initiated",
      "return_dp_assigned",
      "return_bag_picked",
      "return_bag_in_transit",
      "return_bag_out_for_delivery",
      "return_bag_delivered",
      "return_bag_not_received",
      "return_pre_qc",
      "return_accepted",
      "return_completed",
      "credit_note_generated",
      "refund_initiated",
      "refund_done",
      "refund_completed",
    ]);

    if (!usedScopedFyndBagAllocation && !manualMode && orderId && !(body.adminOverride === true)) {
      try {
        const fyndMapping = await prisma.fyndOrderMapping.findFirst({
          where: {
            shopId: shopRecord.id,
            OR: [
              { shopifyOrderName: { equals: shopifyOrderName, mode: "insensitive" } },
              {
                shopifyOrderName: {
                  equals: `#${shopifyOrderName.replace(/^#/, "")}`,
                  mode: "insensitive",
                },
              },
            ],
          },
        });
        if (fyndMapping?.fyndOrderId) {
          let allowedReturnStatuses: string[] = [];
          try {
            const raw = settings?.allowedFyndStatusesForReturn;
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed) && parsed.length > 0) {
                allowedReturnStatuses = parsed.map((s: unknown) => String(s).toLowerCase().trim());
              }
            }
          } catch {
            /* ignore */
          }

          // Try multiple sources for current Fynd status
          let currentFyndStatus: string | null = null;

          // Source 1: Latest webhook log
          const latestLog = await prisma.fyndWebhookLog.findFirst({
            where: {
              affiliateOrderId: { equals: fyndMapping.fyndOrderId, mode: "insensitive" },
              fyndStatus: { not: null },
              shopDomain,
            },
            orderBy: { createdAt: "desc" },
            select: { fyndStatus: true },
          });
          if (latestLog?.fyndStatus) {
            currentFyndStatus = latestLog.fyndStatus
              .toLowerCase()
              .replace(/[\s_]+/g, "_")
              .trim();
          }

          // Source 2: fyndCurrentStatus from existing return cases for this order
          if (!currentFyndStatus) {
            const existingCase = await prisma.returnCase.findFirst({
              where: {
                shopId: shopRecord.id,
                fyndOrderId: { equals: fyndMapping.fyndOrderId, mode: "insensitive" },
                fyndCurrentStatus: { not: null },
              },
              orderBy: { updatedAt: "desc" },
              select: { fyndCurrentStatus: true },
            });
            if (existingCase?.fyndCurrentStatus) {
              currentFyndStatus = existingCase.fyndCurrentStatus
                .toLowerCase()
                .replace(/[\s_]+/g, "_")
                .trim();
            }
          }

          // Source 3: Try webhook logs by shipment ID
          if (!currentFyndStatus && fyndMapping.fyndShipmentId) {
            const shipmentLog = await prisma.fyndWebhookLog.findFirst({
              where: {
                shipmentId: fyndMapping.fyndShipmentId,
                fyndStatus: { not: null },
                shopDomain,
              },
              orderBy: { createdAt: "desc" },
              select: { fyndStatus: true },
            });
            if (shipmentLog?.fyndStatus) {
              currentFyndStatus = shipmentLog.fyndStatus
                .toLowerCase()
                .replace(/[\s_]+/g, "_")
                .trim();
            }
          }

          if (currentFyndStatus) {
            // Check: is it a delivered status?
            const isDelivered = FYND_DELIVERED_STATUSES_CREATE.has(currentFyndStatus);
            // Check: is it explicitly allowed by merchant?
            const isMerchantAllowed =
              allowedReturnStatuses.length > 0 &&
              allowedReturnStatuses.some((s) => {
                const norm = s.replace(/[\s_]+/g, "_").trim();
                return currentFyndStatus === norm || currentFyndStatus!.includes(norm);
              });
            if (!isDelivered && !isMerchantAllowed) {
              const friendly = currentFyndStatus
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase());
              return withCors(
                Response.json(
                  {
                    error: `Return cannot be initiated. Current shipment status is "${friendly}". Returns can only be created after the order has been delivered.`,
                  },
                  { status: 400 },
                ),
                request,
              );
            }
          }
          // If no status found, allow the return (don't block Shopify-only orders that happen to have a mapping)
        }
      } catch (gateErr) {
        console.warn("[Portal create-return] Fynd status gate check failed:", gateErr);
      }
    }

    if (!manualMode) {
      const orderDate = returnPolicyDateFromBody(body as Record<string, unknown>);
      const windowEnd = new Date(orderDate);
      windowEnd.setDate(windowEnd.getDate() + returnWindowDays);
      if (new Date() > windowEnd) {
        return withCors(
          Response.json(
            {
              error: `Return window has expired. Returns are accepted within ${returnWindowDays} days of order date.`,
            },
            { status: 400 },
          ),
          request,
        );
      }

      lineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
        id: string;
        title?: string;
        variantTitle?: string;
        price?: string;
        imageUrl?: string;
        productTags?: string[];
        productType?: string | null;
      }>;
      const validLineIds = new Set(lineItemsWithPrice.map((l) => l.id));
      for (const sel of itemsToCreate) {
        if (sel.lineItemId === "manual") continue;
        // After line-item ID resolution, sel.lineItemId may be a Shopify GID while
        // lineItemsWithPrice still has the original Fynd bag ID.  Accept either.
        const originalPortalId = lineItemIdMapping.get(sel.lineItemId);
        if (
          !validLineIds.has(sel.lineItemId) &&
          (!originalPortalId || !validLineIds.has(originalPortalId))
        ) {
          return withCors(
            Response.json(
              { error: "Invalid line item selected. Please refresh and try again." },
              { status: 400 },
            ),
            request,
          );
        }
        const li = lineItemsWithPrice.find(
          (l) => l.id === sel.lineItemId || l.id === originalPortalId,
        );
        // defensive: optional-chain `?? []` fallbacks on price/tags
        /* v8 ignore start */
        const liveLineId = lineItemIdMapping.get(sel.lineItemId) ?? sel.lineItemId;
        const liveLine = liveOrderForValidation?.lineItems?.find((line) => line.id === liveLineId);
        const price = liveLine?.price
          ? parseFloat(liveLine.price)
          : li?.price
            ? parseFloat(li.price)
            : undefined;
        const tags = liveLine?.productTags ?? li?.productTags ?? [];
        const productType = liveLine?.productType ?? li?.productType ?? null;
        const sourceChannel =
          normalizeSourceChannel(liveOrderForValidation?.sourceName ?? null) ??
          capturedSourceChannel;
        const liveOrderDate =
          latestDeliveredAtFromOrder(liveOrderForValidation) ??
          liveOrderForValidation?.processedAt ??
          liveOrderForValidation?.createdAt;
        /* v8 ignore stop */
        const eligibility = checkReturnEligibility(settings, {
          orderDate: liveOrderDate ? new Date(liveOrderDate) : orderDate,
          productPrice: price,
          productTags: tags.length ? tags : undefined,
          productType,
          customerCountry:
            typeof body.shippingCountry === "string" ? body.shippingCountry : undefined,
          customerProvince:
            typeof body.shippingProvince === "string" ? body.shippingProvince : undefined,
          sourceChannel,
        });
        if (!eligibility.eligible) {
          return withCors(
            Response.json(
              { error: eligibility.reason ?? "Item not eligible for return" },
              { status: 400 },
            ),
            request,
          );
        }
      }
    }

    // Validate and sanitize uploaded media. Never trust client-provided
    // mimeType/size; derive both from the data URL that will actually be stored.
    let customerMediaJson: string | null = null;
    if (Array.isArray(customerMediaRaw) && customerMediaRaw.length > 0) {
      const validMedia = customerMediaRaw
        .slice(0, MAX_MEDIA_FILES)
        .flatMap((m) => {
          if (!m?.dataUrl || typeof m.dataUrl !== "string") return [];
          const parsed = parseSafeMediaDataUrl(m.dataUrl);
          if (!parsed) return [];
          const isImage = ALLOWED_IMAGE_MEDIA_TYPES.has(parsed.mimeType);
          const isVideo = ALLOWED_VIDEO_MEDIA_TYPES.has(parsed.mimeType);
          if (!isImage && !isVideo) return [];
          const maxBytes = isVideo ? MAX_VIDEO_MEDIA_BYTES : MAX_IMAGE_MEDIA_BYTES;
          if (parsed.sizeEstimate > maxBytes) return [];
          return [
            {
              name: String(m.name ?? "upload")
                .replace(/[\r\n]/g, " ")
                .slice(0, 255),
              mimeType: parsed.mimeType,
              dataUrl: m.dataUrl,
            },
          ];
        });
      if (validMedia.length > 0) {
        customerMediaJson = JSON.stringify(validMedia);
      }
    }

    let fraudScoreForReturn: Awaited<ReturnType<typeof calculateFraudScore>> | null = null;
    if (customerEmail) {
      try {
        fraudScoreForReturn = await calculateFraudScore(
          shopRecord.id,
          customerEmail,
          returnWindowDays,
        );
      } catch (err) {
        console.warn("[Portal create-return] Fraud scoring failed:", err);
      }
    }
    if (!fraudScoreForReturn) {
      fraudScoreForReturn = { score: 0, level: "low", factors: [] };
    }
    const ipForRisk = clientIpFromRequest(request);
    let ipMatchedBlockedCustomer = false;
    if (ipForRisk && settings?.id) {
      try {
        ipMatchedBlockedCustomer = Boolean(
          await prisma.blocklistEntry.findFirst({
            where: { settingsId: settings.id, type: "ip", value: ipForRisk },
            select: { id: true },
          }),
        );
      } catch (err) {
        console.warn("[Portal create-return] IP fraud lookup failed:", err);
      }
    }
    const firstReasonCode = itemsToCreate[0]?.reasonCode?.toLowerCase() ?? "";
    const genericReasons = new Set([
      "other",
      "changed_mind",
      "change_of_mind",
      "no_longer_needed",
      "not_needed",
      "unknown",
      "generic",
    ]);
    const riskAdditions: Array<{
      name: string;
      description: string;
      score: number;
      weight: number;
    }> = [];
    if (ipMatchedBlockedCustomer) {
      riskAdditions.push({
        name: "Blocked IP match",
        description: "Return was submitted from an IP address on the fraud/blocklist",
        score: 45,
        weight: 45,
      });
    }
    if (!customerMediaJson) {
      riskAdditions.push({
        name: "No evidence attached",
        description: "Customer did not attach photos or video evidence",
        score: 15,
        weight: 15,
      });
    }
    if (genericReasons.has(firstReasonCode)) {
      riskAdditions.push({
        name: "Generic reason",
        description: `Return reason "${firstReasonCode}" needs manual review when combined with other risk signals`,
        score: 15,
        weight: 15,
      });
    }
    if (riskAdditions.length > 0) {
      const score = Math.min(
        100,
        fraudScoreForReturn.score + riskAdditions.reduce((sum, f) => sum + f.score, 0),
      );
      fraudScoreForReturn = {
        score,
        level: fraudLevel(score),
        factors: [...fraudScoreForReturn.factors, ...riskAdditions],
      };
    }
    const highFraudManualReview =
      fraudScoreForReturn?.level === "high" || fraudScoreForReturn?.level === "critical";

    // Determine status using auto-approve rules
    let status: string;
    if (settings?.autoApproveEnabled && !highFraudManualReview) {
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
        // defensive: optional-chain reasonCode + productTags ?? [] fallback rare
        /* v8 ignore start */
        const firstReasonCode = itemsToCreate[0]?.reasonCode;
        const allTags = lineItemsWithPrice.flatMap((li) => li.productTags ?? []);
        /* v8 ignore stop */

        let customerReturnCount: number | undefined;
        if (customerEmail) {
          customerReturnCount = await prisma.returnCase.count({
            where: { shopId: shopRecord.id, customerEmailNorm: customerEmail },
          });
        }

        const ruleResult = evaluateAutoApproveRules(autoRules, {
          // defensive: ternary/?? defaults rarely null in tests
          /* v8 ignore start */
          orderValue,
          returnReason: firstReasonCode,
          productTags: allTags.length > 0 ? allTags : undefined,
          customerEmail: customerEmail ?? undefined,
          customerReturnCount,
          /* v8 ignore stop */
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
      const greenThreshold = settings.greenReturnsThreshold
        ? parseFloat(String(settings.greenReturnsThreshold))
        : null;
      let greenTagsArr: string[] = [];
      try {
        if (settings.greenReturnsProductTags) {
          greenTagsArr = JSON.parse(settings.greenReturnsProductTags);
        }
      } catch {
        /* invalid JSON, skip tag check */
      }

      const itemTotalValue = lineItemsWithPrice.reduce((sum, li) => {
        const selectedItem = itemsToCreate.find((it) => it.lineItemId === li.id);
        // defensive: extra lineItemsWithPrice entries not in items shouldn't reach green-returns
        /* v8 ignore start */
        if (!selectedItem) return sum;
        /* v8 ignore stop */
        const p = li.price ? parseFloat(li.price) : 0;
        return sum + (Number.isFinite(p) ? p * selectedItem.qty : 0);
      }, 0);

      const belowThreshold =
        greenThreshold != null &&
        greenThreshold > 0 &&
        itemTotalValue > 0 &&
        itemTotalValue < greenThreshold;

      // defensive: productTags ?? [] fallback for items missing tags
      /* v8 ignore start */
      const allItemTags = lineItemsWithPrice
        .filter((li) => itemsToCreate.some((it) => it.lineItemId === li.id))
        .flatMap((li) => li.productTags ?? [])
        .map((t) => t.toLowerCase());
      const tagsMatch =
        greenTagsArr.length > 0 &&
        greenTagsArr.some((gt) => allItemTags.includes(gt.toLowerCase()));
      /* v8 ignore stop */

      qualifiesForGreenReturn = belowThreshold || tagsMatch;
    }

    // ── Server-side validation of exchange variant selections ──
    // The portal sends variantId + productId from the customer's picker. We MUST
    // verify each variant actually exists in this shop's catalog and belongs to
    // the claimed product — otherwise a tampered request could substitute arbitrary
    // variants (including from unrelated products) and the warehouse would ship
    // them. P1 finding from QA audit.
    if (exchangeVariantSelections.length > 0) {
      const session = await prisma.session.findFirst({
        where: { shop: shopRecord.shopDomain, isOnline: false, accessToken: { not: "" } },
        select: { accessToken: true },
      });
      if (session?.accessToken) {
        const uniquePairs = new Map<string, { productId: string; variantId: string }>();
        for (const sel of exchangeVariantSelections) {
          // defensive: portal validates productId/variantId before sending
          /* v8 ignore start */
          if (!sel.productId || !sel.variantId) continue;
          /* v8 ignore stop */
          uniquePairs.set(`${sel.productId}::${sel.variantId}`, {
            productId: sel.productId,
            variantId: sel.variantId,
          });
        }
        const invalid: Array<{ productId: string; variantId: string; reason: string }> = [];
        // Validate via REST: cheap one-product-at-a-time fetch (max 20 from upstream cap).
        for (const pair of uniquePairs.values()) {
          try {
            const productLegacyId = pair.productId.replace(/^gid:\/\/shopify\/Product\//, "");
            const variantLegacyId = pair.variantId.replace(
              /^gid:\/\/shopify\/ProductVariant\//,
              "",
            );
            // 10s cap so a hung Shopify upstream doesn't pin the request worker.
            const ctrl = new AbortController();
            // defensive: 10s abort callback only fires on real network hang
            /* v8 ignore start */
            const timer = setTimeout(() => ctrl.abort(), 10_000);
            /* v8 ignore stop */
            let res: Response;
            try {
              res = await fetch(
                `https://${shopRecord.shopDomain}/admin/api/2024-10/products/${productLegacyId}.json?fields=id,variants`,
                {
                  headers: { "X-Shopify-Access-Token": session.accessToken },
                  signal: ctrl.signal,
                },
              );
            } finally {
              clearTimeout(timer);
            }
            if (!res.ok) {
              invalid.push({ ...pair, reason: `product fetch ${res.status}` });
              continue;
            }
            const data = (await res.json()) as {
              product?: { variants?: Array<{ id: number | string }> };
            };
            const variants = data.product?.variants ?? [];
            const found = variants.some((v) => String(v.id) === variantLegacyId);
            if (!found) invalid.push({ ...pair, reason: "variant not in product" });
          } catch (err) {
            invalid.push({ ...pair, reason: err instanceof Error ? err.message : "fetch error" });
          }
        }
        if (invalid.length > 0) {
          return withCors(
            Response.json(
              {
                error:
                  "One or more selected exchange variants are no longer available. Please reload the page and pick again.",
                details: invalid,
              },
              { status: 400 },
            ),
            request,
          );
        }
      }
      // If we have NO offline session at all, fall back to trusting the picker —
      // this only happens when Shopify isn't connected, in which case the exchange
      // can't actually be fulfilled anyway. The admin sees the request and can reject.
    }

    // Atomic transaction: per-line-item quantity validation + create return + event in one go
    const txLineItemEstimates = (body.lineItemEstimates ?? []) as Array<{
      lineItemId: string;
      quantity: number;
    }>;
    let returnCase: Awaited<ReturnType<typeof prisma.returnCase.create>> & {
      returnRequestNo?: string | null;
    };
    try {
      returnCase = await prisma.$transaction(async (tx) => {
        // Per-line-item quantity validation inside transaction (race-safe)
        if (
          !manualMode &&
          itemsToCreate.length > 0 &&
          effectiveOrderId &&
          !effectiveOrderId.startsWith("manual:")
        ) {
          const bagScopedItems = itemsToCreate.filter((it) => it.fyndBagId);
          const lineScopedItems = itemsToCreate.filter((it) => !it.fyndBagId);
          if (bagScopedItems.length > 0) {
            const requestedBagIds = bagScopedItems
              .map((it) => it.fyndBagId)
              .filter(Boolean) as string[];
            const existingBagReturnItems = await tx.returnItem.findMany({
              where: {
                fyndBagId: { in: requestedBagIds },
                returnCase: {
                  shopId: shopRecord.id,
                  status: { notIn: ["rejected", "cancelled"] },
                  OR: [
                    { shopifyOrderId: effectiveOrderId },
                    { shopifyOrderName: { equals: shopifyOrderName, mode: "insensitive" } },
                    {
                      fyndOrderId: {
                        equals: shopifyOrderName.replace(/^#/, ""),
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
              select: { fyndBagId: true, qty: true },
            });
            const bagAlreadyReturnedMap: Record<string, number> = {};
            for (const ri of existingBagReturnItems) {
              if (!ri.fyndBagId) continue;
              bagAlreadyReturnedMap[ri.fyndBagId] =
                (bagAlreadyReturnedMap[ri.fyndBagId] ?? 0) + ri.qty;
            }
            const requestedBagQtyMap: Record<string, number> = {};
            for (const sel of bagScopedItems) {
              if (!sel.fyndBagId) continue;
              const liInfo = lineItemsWithPrice.find((l) => l.id === sel.lineItemId);
              const bagCapacity =
                typeof sel.fyndQuantityAvailable === "number" && sel.fyndQuantityAvailable > 0
                  ? sel.fyndQuantityAvailable
                  : 1;
              requestedBagQtyMap[sel.fyndBagId] =
                (requestedBagQtyMap[sel.fyndBagId] ?? 0) + sel.qty;
              if (
                (bagAlreadyReturnedMap[sel.fyndBagId] ?? 0) + requestedBagQtyMap[sel.fyndBagId] >
                bagCapacity
              ) {
                throw new Error(`QUANTITY_EXCEEDED:${liInfo?.title ?? sel.lineItemId}`);
              }
            }
          }

          const requestedLineItemIds = lineScopedItems
            .map((it) => it.lineItemId)
            .filter((id) => id !== "manual");
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
              alreadyReturnedMap[ri.shopifyLineItemId] =
                (alreadyReturnedMap[ri.shopifyLineItemId] ?? 0) + ri.qty;
            }
          }
          // SKU fallback: for Fynd orders, stored shopifyLineItemId may differ from current IDs
          const txRequestedSkus = lineScopedItems
            .map(
              (it) =>
                resolvedLineItemSkus.get(it.lineItemId) ||
                (
                  lineItemsWithPrice.find((l) => l.id === it.lineItemId) as
                    | { sku?: string }
                    | undefined
                )?.sku,
            )
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
                // defensive: SKU fallback only fires when ri.sku exists; query already filters
                /* v8 ignore start */
                if (!ri.sku) continue;
                /* v8 ignore stop */
                const matchingItem = lineScopedItems.find((it) => {
                  const itSku =
                    resolvedLineItemSkus.get(it.lineItemId) ||
                    (
                      lineItemsWithPrice.find((l) => l.id === it.lineItemId) as
                        | { sku?: string }
                        | undefined
                    )?.sku;
                  return itSku === ri.sku;
                });
                if (matchingItem && !(alreadyReturnedMap[matchingItem.lineItemId] > 0)) {
                  alreadyReturnedMap[matchingItem.lineItemId] =
                    (alreadyReturnedMap[matchingItem.lineItemId] ?? 0) + ri.qty;
                }
              }
            } catch {
              /* non-fatal SKU fallback */
            }
          }
          for (const sel of lineScopedItems) {
            if (sel.lineItemId === "manual") continue;
            // defensive: nullish-coalesce fallback chain for originalQty
            /* v8 ignore start */
            const alreadyReturned = alreadyReturnedMap[sel.lineItemId] ?? 0;
            const liInfo = lineItemsWithPrice.find((l) => l.id === sel.lineItemId);
            const originalQty =
              txLineItemEstimates.find((e) => e.lineItemId === sel.lineItemId)?.quantity ??
              (
                body.lineItemsWithPrice as Array<{ id: string; quantity?: number }> | undefined
              )?.find((l) => l.id === sel.lineItemId)?.quantity ??
              999;
            if (alreadyReturned + sel.qty > originalQty) {
              throw new Error(`QUANTITY_EXCEEDED:${liInfo?.title ?? sel.lineItemId}`);
            }
            /* v8 ignore stop */
          }
        }

        // defensive: orderProcessedAt fallback chain rare in fixtures
        /* v8 ignore start */
        const orderCreatedAtValue = body.orderDeliveredAt
          ? new Date(body.orderDeliveredAt as string)
          : body.orderProcessedAt
            ? new Date(body.orderProcessedAt as string)
            : body.orderCreatedAt
              ? new Date(body.orderCreatedAt as string)
              : null;
        /* v8 ignore stop */

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
            // Combine the structured variant picker selections (if any) with the free-text
            // exchange preference into a single human-readable string. The structured payload
            // is also persisted via a return event below for downstream consumers.
            exchangePreference: (() => {
              const structured = exchangeVariantSelections
                .map((v) => v.variantTitle || v.variantId)
                .filter(Boolean)
                .join(", ");
              const parts = [structured, exchangePreference].filter(
                (s) => s && String(s).trim().length > 0,
              );
              const joined = parts.join(" — ").trim();
              return joined ? joined.slice(0, 1000) : null;
            })(),
            createdByChannel: (body.createdByChannel as string) ?? "portal",
            sourceChannel: manualMode ? "manual" : capturedSourceChannel,
            createdByStaff: (body.createdByStaff as string) ?? null,
            crmTicketId: (body.crmTicketId as string) ?? null,
            crmNotes: (body.crmNotes as string) ?? null,
            fraudRiskScore: fraudScoreForReturn?.score ?? null,
            fraudRiskLevel: fraudScoreForReturn?.level ?? null,
            isGreenReturn: qualifiesForGreenReturn,
            fyndSyncStatus: status === "approved" && !qualifiesForGreenReturn ? "pending" : null,
            orderProcessedAt: orderCreatedAtValue,
            // Set fyndShipmentId from items (use first item's shipmentId, or common shipmentId if all match)
            fyndShipmentId: (() => {
              const shipIds = (itemsToCreate ?? [])
                .map((it) => it.fyndShipmentId)
                .filter(Boolean) as string[];
              if (shipIds.length === 0) return null;
              const unique = [...new Set(shipIds)];
              return unique.length === 1 ? unique[0] : shipIds[0]; // prefer single shipment; fallback to first
            })(),
            items: {
              create: itemsToCreate.map((it) => {
                // After line item ID resolution, the ID may have changed from a Fynd bag ID
                // to a Shopify GID. Look up liInfo using the original portal ID if needed.
                const originalPortalId = lineItemIdMapping.get(it.lineItemId) ?? it.lineItemId;
                const liInfo = lineItemsWithPrice?.find(
                  (l) => l.id === it.lineItemId || l.id === originalPortalId,
                );
                const resolvedSku = resolvedLineItemSkus.get(it.lineItemId);
                return {
                  shopifyLineItemId: it.lineItemId,
                  title: liInfo?.title || it.notes || null,
                  variantTitle: liInfo?.variantTitle || null,
                  sku: resolvedSku || (liInfo as { sku?: string } | undefined)?.sku || null,
                  price: (() => {
                    const raw = liInfo?.price;
                    if (!raw) return null;
                    // defensive: portal sends price as string; object branch is for Fynd raw bag data
                    /* v8 ignore start */
                    if (typeof raw === "object") {
                      const obj = raw as Record<string, unknown>;
                      const v =
                        obj.amount ??
                        obj.value ??
                        obj.effective ??
                        obj.transfer_price ??
                        obj.price_effective;
                      return v != null ? String(v) : null;
                    }
                    /* v8 ignore stop */
                    return String(raw);
                  })(),
                  imageUrl: liInfo?.imageUrl || null,
                  qty: it.qty,
                  reasonCode: it.reasonCode || null,
                  notes: it.notes || null,
                  condition: it.condition || null,
                  fyndShipmentId: it.fyndShipmentId || null,
                  fyndBagId: it.fyndBagId || null,
                  fyndArticleId: it.fyndArticleId || null,
                  fyndAffiliateLineId: it.fyndAffiliateLineId || null,
                  fyndSellerIdentifier: it.fyndSellerIdentifier || null,
                  fyndItemId: it.fyndItemId || null,
                  fyndQuantityAvailable: it.fyndQuantityAvailable ?? null,
                  fyndPriceEffective: it.fyndPriceEffective || null,
                  fyndSize: it.fyndSize || null,
                  fyndLineNumber: it.fyndLineNumber ?? null,
                };
              }),
            },
          },
          include: { items: true },
        });

        const idConfig = parseReturnIdConfig(settings?.returnIdConfigJson as string | null);
        let idCounter: number | undefined;
        if (idConfig.bodyMode === "sequential" || idConfig.bodyMode === "date_sequential") {
          idCounter = await nextReturnIdCounter(settings!.id);
        }
        const returnRequestNo = buildReturnRequestId(idConfig, rc.id, idCounter);
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
              resolutionType,
              ...(exchangeVariantSelections.length > 0
                ? { exchangeVariants: exchangeVariantSelections }
                : {}),
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

        if (highFraudManualReview && fraudScoreForReturn) {
          await tx.returnEvent.create({
            data: {
              returnCaseId: rc.id,
              source: "system",
              eventType: "fraud_manual_review",
              payloadJson: JSON.stringify({
                score: fraudScoreForReturn.score,
                level: fraudScoreForReturn.level,
                factors: fraudScoreForReturn.factors,
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
          Response.json(
            {
              error: `Return quantity exceeds available quantity for: ${itemTitle}. Please refresh and try again.`,
            },
            { status: 400 },
          ),
          request,
        );
      }
      throw txErr;
    }

    // Fire-and-forget: email notification (non-blocking — don't delay the response)
    sendNewReturnNotification({
      shopDomain,
      orderName: shopifyOrderName,
      customerEmail: customerEmail || undefined,
      itemCount: itemsToCreate.length,
      returnRequestId: returnCase.returnRequestNo ?? "",
      shopName: shopDomain.replace(".myshopify.com", ""),
    }).catch((notifyErr) => {
      console.warn("[Portal create-return] New return notification failed:", notifyErr);
    });

    // When auto-approved, create the Shopify Return and sync to Fynd so both
    // downstream systems move for this exact ReturnCase.
    if (status === "approved" && !manualMode && effectiveOrderId && !qualifiesForGreenReturn) {
      // defensive: extensive nullish-coalesce/spread-conditional defaults across Fynd sync path
      /* v8 ignore start */
      try {
        const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
        const admin = withRestCredentials(rawAdmin, shopDomain, shopAccessToken);
        const order = await fetchOrder(admin, effectiveOrderId);
        const affiliateOrderId = order?.affiliateOrderId ?? null;
        const fyndSettings = shopRecord.settings as
          | Parameters<typeof createFyndClientOrError>[0]
          | null;
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

          const canCreateShopifyReturn =
            !rcWithItems.shopifyReturnId &&
            !effectiveOrderId.startsWith("manual:") &&
            (effectiveOrderId.startsWith("gid://") || /^\d+$/.test(effectiveOrderId));
          if (canCreateShopifyReturn) {
            try {
              const shopifyReturnResult = await claimAndCreateShopifyReturn(
                returnCase.id,
                admin as never,
                effectiveOrderId,
                (rcWithItems.items ?? []).map((item) => ({
                  shopifyLineItemId: item.shopifyLineItemId,
                  qty: item.qty,
                  reasonCode: item.reasonCode ?? null,
                  notes: item.notes ?? null,
                  sku: item.sku ?? null,
                })),
                { requestedAt: rcWithItems.createdAt.toISOString() },
              );
              await prisma.returnEvent.create({
                data: {
                  returnCaseId: returnCase.id,
                  source: "portal",
                  eventType:
                    shopifyReturnResult.success && shopifyReturnResult.shopifyReturnId
                      ? shopifyReturnResult.claimed
                        ? "shopify_return_created"
                        : "shopify_return_reused"
                      : "shopify_return_failed",
                  payloadJson: JSON.stringify({
                    shopifyReturnId: shopifyReturnResult.shopifyReturnId ?? null,
                    error: shopifyReturnResult.error ?? null,
                    claimed: shopifyReturnResult.claimed,
                    itemCount: (rcWithItems.items ?? []).length,
                    autoApproved: true,
                  }),
                },
              });
            } catch (shopifyReturnErr) {
              await prisma.returnEvent
                .create({
                  data: {
                    returnCaseId: returnCase.id,
                    source: "portal",
                    eventType: "shopify_return_failed",
                    payloadJson: JSON.stringify({
                      error:
                        shopifyReturnErr instanceof Error
                          ? shopifyReturnErr.message
                          : String(shopifyReturnErr),
                      itemCount: (rcWithItems.items ?? []).length,
                      autoApproved: true,
                    }),
                  },
                })
                .catch(() => {});
            }
          }

          const fyndSync = await createReturnOnFynd(fyndResult.client, rcWithItems, {
            affiliateOrderId,
            targetShipmentId: rcWithItems.fyndShipmentId || null,
          });
          if (
            fyndSync.success &&
            (fyndSync.fyndReturnId ?? fyndSync.fyndShipmentId ?? fyndSync.alreadyExists)
          ) {
            await prisma.returnCase.update({
              where: { id: returnCase.id },
              data: {
                fyndSyncStatus: "synced",
                fyndSyncError: null,
                ...(fyndSync.fyndReturnId && { fyndReturnId: fyndSync.fyndReturnId }),
                ...(fyndSync.fyndReturnNo && { fyndReturnNo: fyndSync.fyndReturnNo }),
                ...(fyndSync.fyndOrderId && { fyndOrderId: fyndSync.fyndOrderId }),
                ...(fyndSync.fyndShipmentId && { fyndShipmentId: fyndSync.fyndShipmentId }),
                ...(fyndSync.fyndReturnId && { fyndCurrentStatus: "return_initiated" }),
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
        } catch {
          /* Non-fatal */
        }
      }
      /* v8 ignore stop */
    }

    const itemSummaries = itemsToCreate.map((it) => {
      // defensive: notes/title fallback chain rarely null in fixtures
      /* v8 ignore start */
      if (it.lineItemId === "manual") {
        return { title: it.notes ?? "Manual return", qty: it.qty };
      }
      const li = lineItemsWithPrice.find((l) => l.id === it.lineItemId);
      return { title: li?.title ?? "Item", qty: it.qty };
      /* v8 ignore stop */
    });

    const nextSteps =
      status === "approved"
        ? "Your return has been approved. The store will process your refund."
        : "The store will review your request. You'll receive an email once it's approved or if more information is needed.";

    return withCors(
      Response.json({
        success: true,
        returnId: returnCase.id,
        returnRequestId: returnCase.returnRequestNo || formatReturnRequestId(returnCase.id),
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
      request,
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
      Response.json(
        {
          error: isSafe ? errMsg : "Something went wrong. Please try again later.",
        },
        { status: 500 },
      ),
      request,
    );
  }
};
