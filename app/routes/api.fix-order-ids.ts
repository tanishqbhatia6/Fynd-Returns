/**
 * Diagnostic + Fix endpoint for shopifyOrderId issues.
 *
 * GET  /api/fix-order-ids         → Show all return cases and their shopifyOrderId status
 * POST /api/fix-order-ids         → Fix all invalid shopifyOrderIds by resolving to Shopify GID
 * POST /api/fix-order-ids?id=xxx  → Fix a specific return case
 *
 * Uses the offline Shopify session from DB — no admin auth needed.
 * Protected by a simple token check.
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { extractAffiliateOrderIdFromFyndPayload, extractCustomerFromFyndPayload } from "../lib/fynd-payload.server";

const API_VERSION = "2026-01";

function isValidShopifyId(id: string | null | undefined): boolean {
  if (!id) return false;
  if (id.startsWith("gid://")) return true;
  if (/^\d+$/.test(id)) return true;
  if (id.startsWith("manual:")) return true;
  return false;
}

async function getOfflineSession() {
  return prisma.session.findFirst({
    where: { isOnline: false, accessToken: { not: "" } },
    select: { shop: true, accessToken: true },
  });
}

async function resolveOrderByName(
  shopDomain: string,
  accessToken: string,
  orderName: string
): Promise<{ gid: string; name: string } | null> {
  const clean = orderName.replace(/^#/, "").trim();
  if (!clean) return null;
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;

  for (const nameQuery of [`#${clean}`, clean]) {
    try {
      const url = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(nameQuery)}&fields=id,name&limit=5`;
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { orders?: Array<{ id?: number; name?: string }> };
      const orders = data?.orders ?? [];
      const norm = clean.toLowerCase();
      const match = orders.find((o) => (o.name ?? "").replace(/^#/, "").toLowerCase() === norm);
      if (match?.id) {
        return { gid: `gid://shopify/Order/${match.id}`, name: match.name ?? `#${clean}` };
      }
    } catch {
      continue;
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
  // List all return cases and their status
  const cases = await prisma.returnCase.findMany({
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

  const session = await getOfflineSession();

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
      needsFix: !valid && !rc.shopifyOrderId?.startsWith("manual:"),
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

  return Response.json({
    sessionFound: !!session,
    shopDomain: session?.shop ?? null,
    hasAccessToken: !!(session?.accessToken),
    totalCases: cases.length,
    needsFix: needsFix.length,
    cases: summary,
  }, { headers: { "Content-Type": "application/json" } });
};

/**
 * Fetch a Shopify order by GID and return email + shipping address.
 */
async function fetchShopifyOrderCustomerInfo(
  shopDomain: string,
  accessToken: string,
  orderGid: string,
): Promise<{ email?: string; phone?: string; name?: string; city?: string; country?: string; address1?: string; address2?: string; province?: string; zip?: string } | null> {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables: { id: orderGid } }),
    });
    if (!res.ok) return null;
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
  } catch {
    return null;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  const session = await getOfflineSession();
  if (!session?.accessToken) {
    return Response.json({ error: "No offline session with access token found" }, { status: 500 });
  }

  const url = new URL(request.url);
  const actionType = url.searchParams.get("action") ?? "fix"; // "fix" | "enrich"
  const specificId = url.searchParams.get("id");

  // ── ACTION: enrich — backfill customer data from Shopify order + Fynd payload ──
  if (actionType === "enrich") {
    const where: Record<string, unknown> = {};
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
          if (!rc.customerName && shopifyCustomer.name) enrichData.customerName = shopifyCustomer.name;
          if (!rc.customerEmailNorm && shopifyCustomer.email) enrichData.customerEmailNorm = shopifyCustomer.email.toLowerCase();
          if (!rc.customerPhoneNorm && shopifyCustomer.phone) enrichData.customerPhoneNorm = shopifyCustomer.phone;
          if (!rc.customerCity && shopifyCustomer.city) enrichData.customerCity = shopifyCustomer.city;
          if (!rc.customerCountry && shopifyCustomer.country) enrichData.customerCountry = shopifyCustomer.country;
          if (!rc.customerAddress1 && shopifyCustomer.address1) enrichData.customerAddress1 = shopifyCustomer.address1;
          if (!rc.customerAddress2 && shopifyCustomer.address2) enrichData.customerAddress2 = shopifyCustomer.address2;
          if (!rc.customerProvince && shopifyCustomer.province) enrichData.customerProvince = shopifyCustomer.province;
          if (!rc.customerZip && shopifyCustomer.zip) enrichData.customerZip = shopifyCustomer.zip;
        }
      }

      // Source 2: Fynd payload
      if (rc.fyndPayloadJson) {
        const fyndCustomer = extractCustomerFromFyndPayload(rc.fyndPayloadJson);
        if (fyndCustomer) {
          if (!enrichData.customerName && !rc.customerName && fyndCustomer.name) enrichData.customerName = fyndCustomer.name;
          if (!enrichData.customerEmailNorm && !rc.customerEmailNorm && fyndCustomer.email) enrichData.customerEmailNorm = fyndCustomer.email.toLowerCase();
          if (!enrichData.customerPhoneNorm && !rc.customerPhoneNorm && fyndCustomer.phone) enrichData.customerPhoneNorm = fyndCustomer.phone;
          if (!enrichData.customerCity && !rc.customerCity && fyndCustomer.city) enrichData.customerCity = fyndCustomer.city;
          if (!enrichData.customerCountry && !rc.customerCountry && fyndCustomer.country) enrichData.customerCountry = fyndCustomer.country;
          if (!enrichData.customerAddress1 && !rc.customerAddress1 && fyndCustomer.address1) enrichData.customerAddress1 = fyndCustomer.address1;
          if (!enrichData.customerAddress2 && !rc.customerAddress2 && fyndCustomer.address2) enrichData.customerAddress2 = fyndCustomer.address2;
          if (!enrichData.customerProvince && !rc.customerProvince && fyndCustomer.province) enrichData.customerProvince = fyndCustomer.province;
          if (!enrichData.customerZip && !rc.customerZip && fyndCustomer.zip) enrichData.customerZip = fyndCustomer.zip;
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

  // ── ACTION: fix — resolve shopifyOrderId to Shopify GID ──
  const where: Record<string, unknown> = {};
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
    },
  });

  const toFix = cases.filter((rc) => !isValidShopifyId(rc.shopifyOrderId) && !rc.shopifyOrderId?.startsWith("manual:"));

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
  }> = [];

  for (const rc of toFix) {
    const candidateNames = new Set<string>();
    if (rc.shopifyOrderName) candidateNames.add(rc.shopifyOrderName.replace(/^#/, "").trim());
    const affiliateId = extractAffiliateOrderIdFromFyndPayload(rc.fyndPayloadJson);
    if (affiliateId) candidateNames.add(affiliateId.replace(/^#/, "").trim());
    if (rc.shopifyOrderId && !/^FY[A-Z0-9]{10,}$/i.test(rc.shopifyOrderId)) {
      candidateNames.add(rc.shopifyOrderId.replace(/^#/, "").trim());
    }
    const allCandidates = [...candidateNames];

    if (candidateNames.size === 0) {
      results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, before: rc.shopifyOrderId, after: null, afterName: null, status: "NO_CANDIDATES", candidates: allCandidates });
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
      results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, before: rc.shopifyOrderId, after: resolvedOrder.gid, afterName: resolvedOrder.name, status: "RESOLVED", candidates: allCandidates });
    } else {
      const bestName = affiliateId?.replace(/^#/, "").trim();
      if (bestName && bestName !== rc.shopifyOrderId) {
        await prisma.returnCase.update({ where: { id: rc.id }, data: { shopifyOrderId: bestName } });
        results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, before: rc.shopifyOrderId, after: bestName, afterName: null, status: "NAME_ONLY", candidates: allCandidates });
      } else {
        results.push({ id: rc.id, returnRequestNo: rc.returnRequestNo, before: rc.shopifyOrderId, after: null, afterName: null, status: "NOT_FOUND_IN_SHOPIFY", candidates: allCandidates });
      }
    }
  }

  return Response.json({
    message: `Processed ${toFix.length} return cases`,
    resolved: results.filter((r) => r.status === "RESOLVED").length,
    nameOnly: results.filter((r) => r.status === "NAME_ONLY").length,
    notFound: results.filter((r) => r.status === "NOT_FOUND_IN_SHOPIFY").length,
    noCandidates: results.filter((r) => r.status === "NO_CANDIDATES").length,
    results,
  });
};
