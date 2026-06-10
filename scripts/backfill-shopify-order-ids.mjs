#!/usr/bin/env node
/**
 * Data migration: backfill shopifyOrderId from Fynd's affiliate_order_id.
 *
 * Finds return cases where shopifyOrderId is a Fynd internal ID (not a Shopify
 * GID or numeric ID) and:
 * 1. Extracts affiliate_order_id from fyndPayloadJson (using same normalization as the app)
 * 2. Resolves the order name to a Shopify GID via Admin GraphQL
 * 3. Updates shopifyOrderId to the GID (fast path) and shopifyOrderName
 *
 * Idempotent — safe to run on every deploy. Exits silently when nothing to fix.
 *
 * Usage:
 *   node scripts/backfill-shopify-order-ids.mjs            # auto mode (runs on deploy)
 *   node scripts/backfill-shopify-order-ids.mjs --dry-run   # preview only
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");
const API_VERSION = "2026-01";

function isValidShopifyId(id) {
  if (!id) return false;
  if (id.startsWith("gid://")) return true;
  if (/^\d+$/.test(id)) return true;
  if (id.startsWith("manual:")) return true;
  return false;
}

/**
 * Normalize Fynd payload to an array of shipment-like objects.
 * Mirrors the app's normalizeFyndPayload() logic exactly.
 */
function normalizeFyndPayload(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const o = payload;
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.shipments)) return o.shipments;
  if (Array.isArray(o.results)) return o.results;
  if (o.data && Array.isArray(o.data.items)) return o.data.items;
  if (o.order && typeof o.order === "object" && Array.isArray(o.order.shipments)) return o.order.shipments;
  if (o.order && typeof o.order === "object" && Array.isArray(o.order.bags)) return o.order.bags;
  if (typeof o === "object" && Object.keys(o).length > 0) return [o];
  return [];
}

/**
 * Extract affiliate_order_id from Fynd payload using proper normalization.
 * Mirrors the app's extractAffiliateOrderIdFromFyndPayload() logic.
 */
function extractAffiliateOrderId(payloadJson) {
  if (!payloadJson) return null;
  try {
    const payload = JSON.parse(payloadJson);
    const list = normalizeFyndPayload(payload);
    const first = list[0];
    if (!first || typeof first !== "object") return null;

    const order = first.order;
    const meta = first.meta;

    const s =
      first.affiliate_order_id ??
      first.external_order_id ??
      first.channel_order_id ??
      order?.affiliate_order_id ??
      order?.external_order_id ??
      meta?.affiliate_order_id ??
      meta?.external_order_id ??
      meta?.channel_order_id;

    return typeof s === "string" && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Look up a Shopify order by name via Admin GraphQL.
 * Returns { gid, name } if found, null otherwise.
 */
async function resolveOrderByName(shopDomain, accessToken, orderName) {
  const clean = orderName.replace(/^#/, "").trim();
  if (!clean) return null;

  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const gql = `#graphql
    query ResolveOrderByName($query: String!) {
      orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
        }
      }
    }
  `;

  for (const nameQuery of [`name:#${clean}`, `name:${clean}`]) {
    try {
      const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: gql, variables: { query: nameQuery } }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.errors?.length) continue;
      const orders = data?.data?.orders?.nodes ?? [];
      const norm = clean.toLowerCase();
      const match = orders.find((o) => {
        const n = (o.name ?? "").replace(/^#/, "").toLowerCase();
        return n === norm;
      });
      if (match?.id?.startsWith("gid://shopify/Order/")) {
        return { gid: match.id, name: match.name ?? `#${clean}` };
      }
    } catch {
      // Continue
    }
  }
  return null;
}

/**
 * Generate order name variants from a Fynd affiliate_order_id.
 * e.g. FYNDSHOPIFYX14126 → ["FYNDSHOPIFYX14126", "X14126", "14126"]
 */
function getOrderNameVariants(affiliateOrderId) {
  const clean = affiliateOrderId.replace(/^#/, "").trim();
  if (!clean) return [];
  const variants = [clean];
  const prefixPatterns = [
    /^FYNDSHOPIFY/i,
    /^FYND[_-]?SHOPIFY[_-]?/i,
    /^FYND[_-]?/i,
  ];
  for (const pattern of prefixPatterns) {
    if (pattern.test(clean)) {
      const stripped = clean.replace(pattern, "").trim();
      if (stripped && stripped !== clean && !variants.includes(stripped)) {
        variants.push(stripped);
        const numMatch = stripped.match(/^[A-Za-z](\d+)$/);
        if (numMatch && !variants.includes(numMatch[1])) {
          variants.push(numMatch[1]);
        }
      }
    }
  }
  return variants;
}

async function main() {
  // Get offline session for direct Shopify GraphQL calls.
  const offlineSession = await prisma.session.findFirst({
    where: { isOnline: false, accessToken: { not: "" } },
    select: { shop: true, accessToken: true },
  });

  if (!offlineSession) {
    console.log("[backfill] No offline Shopify session found. Skipping order ID backfill.");
    return;
  }

  const { shop: shopDomain, accessToken } = offlineSession;
  console.log(`[backfill] Using shop: ${shopDomain}`);

  // Find all return cases with a non-Shopify shopifyOrderId
  const candidates = await prisma.returnCase.findMany({
    where: {
      shopifyOrderId: { not: "" },
    },
    select: {
      id: true,
      shopifyOrderId: true,
      shopifyOrderName: true,
      fyndPayloadJson: true,
      returnRequestNo: true,
    },
  });

  const toFix = candidates.filter((rc) => !isValidShopifyId(rc.shopifyOrderId));

  if (toFix.length === 0) {
    console.log("[backfill] No return cases need shopifyOrderId fix. Skipping.");
    return;
  }

  console.log(`[backfill] Found ${toFix.length} return case(s) with invalid shopifyOrderId.`);
  if (DRY_RUN) console.log("[backfill] DRY RUN — no changes will be made.\n");

  let resolved = 0;
  let updatedNameOnly = 0;
  let noAffiliate = 0;
  let notFoundInShopify = 0;

  for (const rc of toFix) {
    // Collect all candidate order names to try
    const candidateNames = new Set();

    // From shopifyOrderName (might already contain the affiliate_order_id)
    if (rc.shopifyOrderName) {
      candidateNames.add(rc.shopifyOrderName.replace(/^#/, "").trim());
    }

    // From Fynd payload
    const affiliateId = extractAffiliateOrderId(rc.fyndPayloadJson);
    if (affiliateId) {
      candidateNames.add(affiliateId.replace(/^#/, "").trim());
    }

    // Also try the current shopifyOrderId (might be an order name)
    if (rc.shopifyOrderId && !rc.shopifyOrderId.startsWith("FYMP") && !rc.shopifyOrderId.startsWith("FY")) {
      candidateNames.add(rc.shopifyOrderId.replace(/^#/, "").trim());
    }

    if (candidateNames.size === 0) {
      noAffiliate++;
      console.log(`  SKIP ${rc.returnRequestNo ?? rc.id}: no affiliate_order_id in payload or shopifyOrderName`);
      continue;
    }

    // Try to resolve each candidate to a Shopify GID via Admin GraphQL.
    let resolvedOrder = null;
    for (const candidate of candidateNames) {
      if (!candidate) continue;
      // Try all name variants (with Fynd prefix stripped)
      const variants = getOrderNameVariants(candidate);
      for (const variant of variants) {
        resolvedOrder = await resolveOrderByName(shopDomain, accessToken, variant);
        if (resolvedOrder) break;
      }
      if (resolvedOrder) break;
    }

    if (resolvedOrder) {
      const data = { shopifyOrderId: resolvedOrder.gid };
      if (!rc.shopifyOrderName) data.shopifyOrderName = resolvedOrder.name;

      if (DRY_RUN) {
        console.log(`  WOULD RESOLVE ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" → "${resolvedOrder.gid}" (name: ${resolvedOrder.name})`);
      } else {
        await prisma.returnCase.update({ where: { id: rc.id }, data });
        console.log(`  RESOLVED ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" → "${resolvedOrder.gid}" (name: ${resolvedOrder.name})`);
      }
      resolved++;
    } else {
      // Fallback: at least update to the affiliate_order_id (better than Fynd internal ID)
      const bestName = affiliateId?.replace(/^#/, "").trim();
      if (bestName && bestName !== rc.shopifyOrderId) {
        if (DRY_RUN) {
          console.log(`  WOULD UPDATE NAME ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" → "${bestName}" (could not resolve GID)`);
        } else {
          await prisma.returnCase.update({
            where: { id: rc.id },
            data: { shopifyOrderId: bestName },
          });
          console.log(`  UPDATED NAME ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" → "${bestName}" (could not resolve GID)`);
        }
        updatedNameOnly++;
      } else {
        notFoundInShopify++;
        console.log(`  NOT FOUND ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" — tried: [${[...candidateNames].join(", ")}]`);
      }
    }
  }

  console.log(`[backfill] Results: Resolved to GID: ${resolved} | Updated name only: ${updatedNameOnly} | Not found: ${notFoundInShopify} | No affiliate ID: ${noAffiliate}`);
}

main()
  .catch((err) => {
    // Non-fatal: log but don't block app startup
    console.error("[backfill] Migration error (non-fatal):", err.message ?? err);
  })
  .finally(() => prisma.$disconnect());
