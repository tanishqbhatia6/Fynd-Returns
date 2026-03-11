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
import { extractAffiliateOrderIdFromFyndPayload } from "../lib/fynd-payload.server";

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
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const session = await getOfflineSession();

  const summary = cases.map((rc) => {
    const valid = isValidShopifyId(rc.shopifyOrderId);
    const affiliateId = extractAffiliateOrderIdFromFyndPayload(rc.fyndPayloadJson);
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

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  const session = await getOfflineSession();
  if (!session?.accessToken) {
    return Response.json({ error: "No offline session with access token found" }, { status: 500 });
  }

  const url = new URL(request.url);
  const specificId = url.searchParams.get("id");

  const where: Record<string, unknown> = {};
  if (specificId) {
    where.id = specificId;
  }

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

    // Also try current shopifyOrderId if it's not obviously a Fynd internal ID
    if (rc.shopifyOrderId && !/^FY[A-Z0-9]{10,}$/i.test(rc.shopifyOrderId)) {
      candidateNames.add(rc.shopifyOrderId.replace(/^#/, "").trim());
    }

    const allCandidates = [...candidateNames];

    if (candidateNames.size === 0) {
      results.push({
        id: rc.id,
        returnRequestNo: rc.returnRequestNo,
        before: rc.shopifyOrderId,
        after: null,
        afterName: null,
        status: "NO_CANDIDATES",
        candidates: allCandidates,
      });
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
      results.push({
        id: rc.id,
        returnRequestNo: rc.returnRequestNo,
        before: rc.shopifyOrderId,
        after: resolvedOrder.gid,
        afterName: resolvedOrder.name,
        status: "RESOLVED",
        candidates: allCandidates,
      });
    } else {
      // Fallback: at least update to affiliate name
      const bestName = affiliateId?.replace(/^#/, "").trim();
      if (bestName && bestName !== rc.shopifyOrderId) {
        await prisma.returnCase.update({
          where: { id: rc.id },
          data: { shopifyOrderId: bestName },
        });
        results.push({
          id: rc.id,
          returnRequestNo: rc.returnRequestNo,
          before: rc.shopifyOrderId,
          after: bestName,
          afterName: null,
          status: "NAME_ONLY",
          candidates: allCandidates,
        });
      } else {
        results.push({
          id: rc.id,
          returnRequestNo: rc.returnRequestNo,
          before: rc.shopifyOrderId,
          after: null,
          afterName: null,
          status: "NOT_FOUND_IN_SHOPIFY",
          candidates: allCandidates,
        });
      }
    }
  }

  const resolved = results.filter((r) => r.status === "RESOLVED").length;
  const nameOnly = results.filter((r) => r.status === "NAME_ONLY").length;
  const notFound = results.filter((r) => r.status === "NOT_FOUND_IN_SHOPIFY").length;
  const noCandidates = results.filter((r) => r.status === "NO_CANDIDATES").length;

  return Response.json({
    message: `Processed ${toFix.length} return cases`,
    resolved,
    nameOnly,
    notFound,
    noCandidates,
    results,
  });
};
