#!/usr/bin/env node
/**
 * Data migration: backfill shopifyOrderId from Fynd's affiliate_order_id.
 *
 * Finds return cases where shopifyOrderId is a Fynd internal ID (not a Shopify
 * GID or numeric ID) and replaces it with the affiliate_order_id extracted from
 * the stored fyndPayloadJson. This unblocks refund processing.
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

function isValidShopifyId(id) {
  if (!id) return false;
  if (id.startsWith("gid://")) return true;
  if (/^\d+$/.test(id)) return true;
  if (id.startsWith("manual:")) return true;
  return false;
}

function extractAffiliateOrderId(payloadJson) {
  if (!payloadJson) return null;
  try {
    const fp = JSON.parse(payloadJson);
    // Top-level
    const topLevel =
      fp.affiliate_order_id ??
      fp.affiliateOrderId ??
      fp.external_order_id ??
      fp.channel_order_id;
    if (typeof topLevel === "string" && topLevel.trim()) return topLevel.trim();
    // Nested under .order
    if (fp.order) {
      const nested = fp.order.affiliate_order_id ?? fp.order.external_order_id;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    // From items/shipments array
    const items = fp.items ?? fp.shipments ?? [];
    if (Array.isArray(items) && items.length > 0) {
      const first = items[0];
      const fromItem =
        first.affiliate_order_id ??
        first.external_order_id ??
        first.order?.affiliate_order_id;
      if (typeof fromItem === "string" && fromItem.trim()) return fromItem.trim();
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

async function main() {
  // Find all return cases with a non-Shopify shopifyOrderId that have Fynd payload
  const candidates = await prisma.returnCase.findMany({
    where: {
      shopifyOrderId: { not: null },
      fyndPayloadJson: { not: null },
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

  let updated = 0;
  let noAffiliate = 0;

  for (const rc of toFix) {
    const affiliateId = extractAffiliateOrderId(rc.fyndPayloadJson);
    if (!affiliateId) {
      noAffiliate++;
      if (DRY_RUN) console.log(`  SKIP ${rc.returnRequestNo ?? rc.id}: no affiliate_order_id in payload`);
      continue;
    }

    const newId = affiliateId.replace(/^#/, "").trim();
    if (!newId || newId === rc.shopifyOrderId) continue;

    if (DRY_RUN) {
      console.log(`  WOULD FIX ${rc.returnRequestNo ?? rc.id}: "${rc.shopifyOrderId}" → "${newId}"`);
    } else {
      await prisma.returnCase.update({
        where: { id: rc.id },
        data: { shopifyOrderId: newId },
      });
    }
    updated++;
  }

  console.log(`[backfill] ${DRY_RUN ? "Would fix" : "Fixed"}: ${updated} | No affiliate_order_id: ${noAffiliate}`);
}

main()
  .catch((err) => {
    // Non-fatal: log but don't block app startup
    console.error("[backfill] Migration error (non-fatal):", err.message ?? err);
  })
  .finally(() => prisma.$disconnect());
