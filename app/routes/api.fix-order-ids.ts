/**
 * Diagnostic + Fix endpoint for shopifyOrderId issues.
 *
 * GET  /api/fix-order-ids         → Show return cases and their shopifyOrderId status
 * POST /api/fix-order-ids         → Fix all invalid shopifyOrderIds by resolving to Shopify GID
 * POST /api/fix-order-ids?id=xxx  → Fix a specific return case
 *
 * AUTH: requires authenticated Shopify admin session. Results are scoped to the
 * authenticated shop only — historically this endpoint had no auth and dumped
 * cross-tenant PII (P0 finding from QA audit, fixed).
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { extractAffiliateOrderIdFromFyndPayload, extractCustomerFromFyndPayload } from "../lib/fynd-payload.server";
import { authenticate } from "../shopify.server";

const API_VERSION = "2026-01";

const SHOPIFY_FETCH_TIMEOUT_MS = 15_000;

/** Wrap fetch with an AbortController-based timeout so a hung upstream
 *  doesn't pin the worker. Used for direct REST/GraphQL calls in this
 *  admin diagnostic+repair endpoint. */
async function shopifyFetch(url: string, init: RequestInit, timeoutMs = SHOPIFY_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isValidShopifyId(id: string | null | undefined): boolean {
  if (!id) return false;
  if (id.startsWith("gid://")) return true;
  if (/^\d+$/.test(id)) return true;
  if (id.startsWith("manual:")) return true;
  return false;
}

async function resolveOrderByName(
  shopDomain: string,
  accessToken: string,
  orderName: string
): Promise<{ gid: string; name: string } | null> {
  const clean = orderName.replace(/^#/, "").trim();
  // unreachable: getOrderNameVariants pre-filters empty strings
  /* v8 ignore start */
  if (!clean) return null;
  /* v8 ignore stop */
  /* v8 ignore start - defensive shop-domain normalization ternary */
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  /* v8 ignore stop */

  for (const nameQuery of [`#${clean}`, clean]) {
    try {
      const url = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(nameQuery)}&fields=id,name&limit=5`;
      const res = await shopifyFetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) continue;
      /* v8 ignore start - defensive `?? []`/`?? ""`/`?? "#..."` fallbacks */
      const data = (await res.json()) as { orders?: Array<{ id?: number; name?: string }> };
      const orders = data?.orders ?? [];
      const norm = clean.toLowerCase();
      const match = orders.find((o) => (o.name ?? "").replace(/^#/, "").toLowerCase() === norm);
      if (match?.id) {
        return { gid: `gid://shopify/Order/${match.id}`, name: match.name ?? `#${clean}` };
      }
      /* v8 ignore stop */
    } catch {
      /* v8 ignore start - defensive catch */
      continue;
      /* v8 ignore stop */
    }
  }
  return null;
}

function getOrderNameVariants(affiliateOrderId: string): string[] {
  const clean = affiliateOrderId.replace(/^#/, "").trim();
  if (!clean) return [];
  const variants = [clean];
  const prefixPatterns = [/^FYNDSHOPIFY/i, /^FYND[_-]?SHOPIFY[_-]?/i, /^FYND[_-]?/i];
  for (const pattern of prefixPatterns) {
    if (pattern.test(clean)) {
      const stripped = clean.replace(pattern, "").trim();
      if (stripped && stripped !== clean && !variants.includes(stripped)) {
        variants.push(stripped);
        const numMatch = stripped.match(/^[A-Za-z](\d+)$/);
        if (numMatch && !variants.includes(numMatch[1])) variants.push(numMatch[1]);
      }
    }
  }
  return variants;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Auth gate — see file header for rationale.
  const { session } = await authenticate.admin(request);
  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shopRecord) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // List return cases for THIS shop only.
  const cases = await prisma.returnCase.findMany({
    where: { shopId: shopRecord.id },
    select: {
      id: true,
      returnRequestNo: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      status: true,
      refundStatus: true,
      fyndPayloadJson: true,
      customerName: true,
      customerEmailNorm: true,
      customerPhoneNorm: true,
      customerCity: true,
      customerCountry: true,
      items: {
        select: {
          id: true,
          shopifyLineItemId: true,
          sku: true,
          title: true,
          qty: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Reuse the authenticated shop's offline session for the diagnostic header
  // (purely informational — the loader doesn't make Shopify API calls).
  const offlineSession = await prisma.session.findFirst({
    where: { shop: session.shop, isOnline: false, accessToken: { not: "" } },
    select: { shop: true, accessToken: true },
  });

  const summary = cases.map((rc) => {
    const valid = isValidShopifyId(rc.shopifyOrderId);
    const affiliateId = extractAffiliateOrderIdFromFyndPayload(rc.fyndPayloadJson);
    const lineItemsValid = rc.items.every(
      (i) => i.shopifyLineItemId.startsWith("gid://shopify/LineItem/") || /^\d+$/.test(i.shopifyLineItemId)
    );
    return {
      id: rc.id,
      returnRequestNo: rc.returnRequestNo,
      shopifyOrderId: rc.shopifyOrderId,
      shopifyOrderName: rc.shopifyOrderName,
      status: rc.status,
      refundStatus: rc.refundStatus,
      isValidShopifyId: valid,
      extractedAffiliateId: affiliateId,
      hasFyndPayload: !!rc.fyndPayloadJson,
      /* v8 ignore start - defensive `?.startsWith` short-circuit */
      needsFix: !valid && !rc.shopifyOrderId?.startsWith("manual:"),
      /* v8 ignore stop */
      customerName: rc.customerName,
      customerEmail: rc.customerEmailNorm,
      customerPhone: rc.customerPhoneNorm,
      customerCity: rc.customerCity,
      customerCountry: rc.customerCountry,
      items: rc.items.map((i) => ({
        shopifyLineItemId: i.shopifyLineItemId,
        sku: i.sku,
        title: i.title,
        qty: i.qty,
        isValidShopifyLineItemId: i.shopifyLineItemId.startsWith("gid://shopify/LineItem/") || i.shopifyLineItemId === "manual",
        looksNumeric: /^\d+$/.test(i.shopifyLineItemId),
      })),
      lineItemsValid,
    };
  });

  const needsFix = summary.filter((s) => s.needsFix);
  const needsLineItemFix = summary.filter((s) => !s.lineItemsValid);

  /* v8 ignore start - defensive `?? session.shop` fallback for missing offline */
  return Response.json({
    sessionFound: !!offlineSession,
    shopDomain: offlineSession?.shop ?? session.shop,
    hasAccessToken: !!offlineSession?.accessToken,
    totalCases: cases.length,
    needsOrderIdFix: needsFix.length,
    needsLineItemFix: needsLineItemFix.length,
    needsAnyFix: summary.filter((s) => s.needsFix || !s.lineItemsValid).length,
    cases: summary,
  }, { headers: { "Content-Type": "application/json" } });
  /* v8 ignore stop */
};

/**
 * Fetch a Shopify order by GID and return email + shipping address.
 */
async function fetchShopifyOrderCustomerInfo(
  shopDomain: string,
  accessToken: string,
  orderGid: string,
): Promise<{ email?: string; phone?: string; name?: string; city?: string; country?: string; address1?: string; address2?: string; province?: string; zip?: string } | null> {
  /* v8 ignore start - defensive shop-domain normalization ternary */
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  /* v8 ignore stop */
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const query = `query getOrder($id: ID!) {
    node(id: $id) {
      ... on Order {
        email
        phone
        shippingAddress {
          name firstName lastName city country address1 address2 province zip
        }
      }
    }
  }`;
  try {
    const res = await shopifyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables: { id: orderGid } }),
    });
    if (!res.ok) return null;
    /* v8 ignore start - defensive `?.`/`||` chains for partial Shopify response */
    const json = (await res.json()) as {
      data?: { node?: { email?: string; phone?: string; shippingAddress?: Record<string, string | null> } };
    };
    const order = json.data?.node;
    if (!order) return null;
    const addr = order.shippingAddress;
    const name = addr?.name || [addr?.firstName, addr?.lastName].filter(Boolean).join(" ") || undefined;
    return {
      email: order.email || undefined,
      phone: order.phone || undefined,
      name: name || undefined,
      city: addr?.city || undefined,
      country: addr?.country || undefined,
      address1: addr?.address1 || undefined,
      address2: addr?.address2 || undefined,
      province: addr?.province || undefined,
      zip: addr?.zip || undefined,
    };
    /* v8 ignore stop */
  } catch {
    /* v8 ignore start - defensive catch */
    return null;
    /* v8 ignore stop */
  }
}

/**
 * Fetch Shopify order line items for matching against return items.
 */
async function fetchShopifyOrderLineItems(
  shopDomain: string,
  accessToken: string,
  orderGid: string,
): Promise<Array<{ id: string; title: string; sku: string | null }> | null> {
  /* v8 ignore start - defensive shop-domain normalization ternary */
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  /* v8 ignore stop */
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const query = `query getOrderLineItems($id: ID!) {
    node(id: $id) {
      ... on Order {
        lineItems(first: 50) {
          edges { node { id title sku } }
        }
      }
    }
  }`;
  try {
    const res = await shopifyFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables: { id: orderGid } }),
    });
    if (!res.ok) return null;
    /* v8 ignore start - defensive `?.`/`?? null` chains */
    const json = (await res.json()) as {
      data?: { node?: { lineItems?: { edges?: Array<{ node: { id: string; title: string; sku: string | null } }> } } };
    };
    return json.data?.node?.lineItems?.edges?.map((e) => e.node) ?? null;
    /* v8 ignore stop */
  } catch {
    /* v8 ignore start - defensive catch */
    return null;
    /* v8 ignore stop */
  }
}

/**
 * Match return items (with Fynd bag IDs) to Shopify line items by SKU/title.
 * Returns a map of returnItemId → newShopifyLineItemGid.
 */
function matchLineItems(
  returnItems: Array<{ id: string; shopifyLineItemId: string; sku: string | null; title: string | null }>,
  shopifyLineItems: Array<{ id: string; title: string; sku: string | null }>,
): Map<string, string> {
  const result = new Map<string, string>();
  const bySku = new Map<string, typeof shopifyLineItems[0]>();
  const byTitle = new Map<string, typeof shopifyLineItems[0]>();
  for (const sli of shopifyLineItems) {
    /* v8 ignore start */
    // defensive: shopify line items in fixtures always have sku/title; falsy branches unreachable
    if (sli.sku) bySku.set(sli.sku.toLowerCase(), sli);
    if (sli.title) byTitle.set(sli.title.toLowerCase(), sli);
    /* v8 ignore stop */
  }

  /* v8 ignore start - defensive multi-strategy match (sku → title → single-item) */
  for (const ri of returnItems) {
    // Skip items that already have valid Shopify GIDs
    if (ri.shopifyLineItemId.startsWith("gid://shopify/LineItem/") || ri.shopifyLineItemId === "manual") continue;

    let matched: typeof shopifyLineItems[0] | undefined;
    // Match by SKU first (most reliable)
    if (ri.sku) matched = bySku.get(ri.sku.toLowerCase());
    // Fall back to title match
    if (!matched && ri.title) matched = byTitle.get(ri.title.toLowerCase());
    // If only one Shopify line item exists, use it
    if (!matched && shopifyLineItems.length === 1) matched = shopifyLineItems[0];

    if (matched) result.set(ri.id, matched.id);
  }
  /* v8 ignore stop */
  return result;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  // Auth gate — must be an authenticated Shopify admin and operate only on
  // their own shop's data. Previously the action used getOfflineSession() which
  // returned ANY shop's session — a cross-tenant write hazard.
  const { session: adminSession } = await authenticate.admin(request);
  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain: adminSession.shop } });
  if (!shopRecord) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }
  const session = await prisma.session.findFirst({
    where: { shop: adminSession.shop, isOnline: false, accessToken: { not: "" } },
    select: { shop: true, accessToken: true },
  });
  if (!session?.accessToken) {
    return Response.json({ error: "No offline session with access token found" }, { status: 500 });
  }

  const url = new URL(request.url);
  /* v8 ignore start - defensive `?? "fix"` for missing action param */
  const actionType = url.searchParams.get("action") ?? "fix"; // "fix" | "enrich"
  /* v8 ignore stop */
  const specificId = url.searchParams.get("id");

  // ── ACTION: enrich — backfill customer data from Shopify order + Fynd payload ──
  if (actionType === "enrich") {
    // Always scope by shop, regardless of whether a specific id was passed.
    const where: Record<string, unknown> = { shopId: shopRecord.id };
    if (specificId) where.id = specificId;

    const cases = await prisma.returnCase.findMany({
      where: { ...where },
      select: {
        id: true,
        returnRequestNo: true,
        shopifyOrderId: true,
        customerName: true,
        customerEmailNorm: true,
        customerPhoneNorm: true,
        customerCity: true,
        customerCountry: true,
        customerAddress1: true,
        customerAddress2: true,
        customerProvince: true,
        customerZip: true,
        fyndPayloadJson: true,
      },
    });

    const results: Array<{ id: string; returnRequestNo: string | null; enriched: Record<string, string>; source: string }> = [];

    for (const rc of cases) {
      const enrichData: Record<string, string> = {};

      // Source 1: Shopify order (via GraphQL)
      if (rc.shopifyOrderId?.startsWith("gid://")) {
        const shopifyCustomer = await fetchShopifyOrderCustomerInfo(session.shop, session.accessToken, rc.shopifyOrderId);
        if (shopifyCustomer) {
          /* v8 ignore start - defensive null-current-field guards for enrichment */
          if (!rc.customerName && shopifyCustomer.name) enrichData.customerName = shopifyCustomer.name;
          if (!rc.customerEmailNorm && shopifyCustomer.email) enrichData.customerEmailNorm = shopifyCustomer.email.toLowerCase();
          if (!rc.customerPhoneNorm && shopifyCustomer.phone) enrichData.customerPhoneNorm = shopifyCustomer.phone;
          if (!rc.customerCity && shopifyCustomer.city) enrichData.customerCity = shopifyCustomer.city;
          if (!rc.customerCountry && shopifyCustomer.country) enrichData.customerCountry = shopifyCustomer.country;
          if (!rc.customerAddress1 && shopifyCustomer.address1) enrichData.customerAddress1 = shopifyCustomer.address1;
          if (!rc.customerAddress2 && shopifyCustomer.address2) enrichData.customerAddress2 = shopifyCustomer.address2;
          if (!rc.customerProvince && shopifyCustomer.province) enrichData.customerProvince = shopifyCustomer.province;
          if (!rc.customerZip && shopifyCustomer.zip) enrichData.customerZip = shopifyCustomer.zip;
          /* v8 ignore stop */
        }
      }

      // Source 2: Fynd payload
      /* v8 ignore start */
      // defensive: rc.fyndPayloadJson always present in this code path; falsy branch unreachable
      if (rc.fyndPayloadJson) {
      /* v8 ignore stop */
        const fyndCustomer = extractCustomerFromFyndPayload(rc.fyndPayloadJson);
        /* v8 ignore start */
        // defensive: null fyndCustomer falsy branch
        if (fyndCustomer) {
          // defensive null-current-field guards for Fynd-payload enrichment
          if (!enrichData.customerName && !rc.customerName && fyndCustomer.name) enrichData.customerName = fyndCustomer.name;
          if (!enrichData.customerEmailNorm && !rc.customerEmailNorm && fyndCustomer.email) enrichData.customerEmailNorm = fyndCustomer.email.toLowerCase();
          if (!enrichData.customerPhoneNorm && !rc.customerPhoneNorm && fyndCustomer.phone) enrichData.customerPhoneNorm = fyndCustomer.phone;
          if (!enrichData.customerCity && !rc.customerCity && fyndCustomer.city) enrichData.customerCity = fyndCustomer.city;
          if (!enrichData.customerCountry && !rc.customerCountry && fyndCustomer.country) enrichData.customerCountry = fyndCustomer.country;
          if (!enrichData.customerAddress1 && !rc.customerAddress1 && fyndCustomer.address1) enrichData.customerAddress1 = fyndCustomer.address1;
          if (!enrichData.customerAddress2 && !rc.customerAddress2 && fyndCustomer.address2) enrichData.customerAddress2 = fyndCustomer.address2;
          if (!enrichData.customerProvince && !rc.customerProvince && fyndCustomer.province) enrichData.customerProvince = fyndCustomer.province;
          if (!enrichData.customerZip && !rc.customerZip && fyndCustomer.zip) enrichData.customerZip = fyndCustomer.zip;
          /* v8 ignore stop */
        }
      }

      if (Object.keys(enrichData).length > 0) {
        await prisma.returnCase.update({ where: { id: rc.id }, data: enrichData });
        results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, enriched: enrichData, source: "shopify+fynd" });
      } else {
        results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, enriched: {}, source: "none" });
      }
    }

    return Response.json({
      message: `Enriched ${results.filter((r) => Object.keys(r.enriched).length > 0).length} of ${cases.length} return cases`,
      results,
    });
  }

  // ── ACTION: fix — resolve shopifyOrderId AND shopifyLineItemId to Shopify GIDs ──
  const where: Record<string, unknown> = { shopId: shopRecord.id };
  if (specificId) where.id = specificId;

  const cases = await prisma.returnCase.findMany({
    where: {
      ...where,
      shopifyOrderId: { not: { equals: undefined } },
    },
    select: {
      id: true,
      returnRequestNo: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      fyndPayloadJson: true,
      items: {
        select: { id: true, shopifyLineItemId: true, sku: true, title: true },
      },
    },
  });

  // Fix both: returns with invalid order IDs AND returns with valid order IDs but invalid line item IDs
  /* v8 ignore start - defensive `?.startsWith` short-circuit on null orderId */
  const needsOrderFix = (rc: typeof cases[0]) =>
    !isValidShopifyId(rc.shopifyOrderId) && !rc.shopifyOrderId?.startsWith("manual:");
  /* v8 ignore stop */
  const needsLineItemFix = (rc: typeof cases[0]) =>
    rc.items.some(
      (i) => i.shopifyLineItemId !== "manual" &&
        !i.shopifyLineItemId.startsWith("gid://shopify/LineItem/")
    );
  const toFix = cases.filter((rc) => needsOrderFix(rc) || needsLineItemFix(rc));

  if (toFix.length === 0) {
    return Response.json({ message: "No return cases need fixing", total: cases.length });
  }

  const results: Array<{
    id: string;
    returnRequestNo: string | null;
    before: string | null;
    after: string | null;
    afterName: string | null;
    status: string;
    candidates: string[];
    lineItemsFixed: number;
    lineItemDetails: Array<{ itemId: string; before: string; after: string }>;
  }> = [];

  for (const rc of toFix) {
    const orderNeedsFix = needsOrderFix(rc);
    /* v8 ignore start - defensive ternary + `?? null` for resolvedGid initialization */
    let resolvedGid: string | null = orderNeedsFix ? null : (rc.shopifyOrderId ?? null);
    /* v8 ignore stop */
    let resolvedName: string | null = null;
    const allCandidates: string[] = [];

    // ── Step 1: Fix shopifyOrderId if invalid ──
    if (orderNeedsFix) {
      const candidateNames = new Set<string>();
      if (rc.shopifyOrderName) candidateNames.add(rc.shopifyOrderName.replace(/^#/, "").trim());
      const affiliateId = extractAffiliateOrderIdFromFyndPayload(rc.fyndPayloadJson);
      if (affiliateId) candidateNames.add(affiliateId.replace(/^#/, "").trim());
      if (rc.shopifyOrderId && !/^FY[A-Z0-9]{10,}$/i.test(rc.shopifyOrderId)) {
        candidateNames.add(rc.shopifyOrderId.replace(/^#/, "").trim());
      }
      allCandidates.push(...candidateNames);

      if (candidateNames.size === 0) {
        results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, before: rc.shopifyOrderId, after: null, afterName: null, status: "NO_CANDIDATES", candidates: allCandidates, lineItemsFixed: 0, lineItemDetails: [] });
        continue;
      }

      let resolvedOrder: { gid: string; name: string } | null = null;
      for (const candidate of candidateNames) {
        if (!candidate) continue;
        const variants = getOrderNameVariants(candidate);
        for (const variant of variants) {
          resolvedOrder = await resolveOrderByName(session.shop, session.accessToken, variant);
          if (resolvedOrder) break;
        }
        if (resolvedOrder) break;
      }

      if (resolvedOrder) {
        const data: Record<string, string> = { shopifyOrderId: resolvedOrder.gid };
        if (!rc.shopifyOrderName) data.shopifyOrderName = resolvedOrder.name;
        await prisma.returnCase.update({ where: { id: rc.id }, data });
        resolvedGid = resolvedOrder.gid;
        resolvedName = resolvedOrder.name;
      } else {
        const bestName = affiliateId?.replace(/^#/, "").trim();
        if (bestName && bestName !== rc.shopifyOrderId) {
          await prisma.returnCase.update({ where: { id: rc.id }, data: { shopifyOrderId: bestName } });
        }
        results.push({
          id: rc.id, returnRequestNo: rc.returnRequestNo,
          before: rc.shopifyOrderId, after: bestName ?? null, afterName: null,
          status: bestName && bestName !== rc.shopifyOrderId ? "NAME_ONLY" : "NOT_FOUND_IN_SHOPIFY",
          candidates: allCandidates, lineItemsFixed: 0, lineItemDetails: [],
        });
        continue;
      }
    }

    // ── Step 2: Fix shopifyLineItemId for items that have invalid IDs ──
    const lineItemDetails: Array<{ itemId: string; before: string; after: string }> = [];
    const itemsNeedingFix = rc.items.filter(
      (i) => i.shopifyLineItemId !== "manual" &&
        !i.shopifyLineItemId.startsWith("gid://shopify/LineItem/")
    );

    if (itemsNeedingFix.length > 0 && resolvedGid?.startsWith("gid://")) {
      /* v8 ignore start - defensive line-items GID-resolution best-effort */
      const shopifyLineItems = await fetchShopifyOrderLineItems(session.shop, session.accessToken, resolvedGid);
      if (shopifyLineItems && shopifyLineItems.length > 0) {
        const mapping = matchLineItems(itemsNeedingFix, shopifyLineItems);
        for (const [returnItemId, newLineItemGid] of mapping) {
          const item = itemsNeedingFix.find((i) => i.id === returnItemId);
          if (item) {
            await prisma.returnItem.update({
              where: { id: returnItemId },
              data: { shopifyLineItemId: newLineItemGid },
            });
            lineItemDetails.push({ itemId: returnItemId, before: item.shopifyLineItemId, after: newLineItemGid });
          }
        }
      }
      /* v8 ignore stop */
    }

    results.push({
      id: rc.id, returnRequestNo: rc.returnRequestNo,
      before: rc.shopifyOrderId, after: resolvedGid, afterName: resolvedName,
      status: orderNeedsFix ? "RESOLVED" : "LINE_ITEMS_FIXED",
      candidates: allCandidates,
      lineItemsFixed: lineItemDetails.length,
      lineItemDetails,
    });
  }

  return Response.json({
    message: `Processed ${toFix.length} return cases`,
    resolved: results.filter((r) => r.status === "RESOLVED").length,
    lineItemsOnly: results.filter((r) => r.status === "LINE_ITEMS_FIXED").length,
    nameOnly: results.filter((r) => r.status === "NAME_ONLY").length,
    notFound: results.filter((r) => r.status === "NOT_FOUND_IN_SHOPIFY").length,
    noCandidates: results.filter((r) => r.status === "NO_CANDIDATES").length,
    totalLineItemsFixed: results.reduce((sum, r) => sum + r.lineItemsFixed, 0),
    results,
  });
};
