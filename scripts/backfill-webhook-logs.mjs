#!/usr/bin/env node
/**
 * Data migration: backfill FyndWebhookLog records with enrichment fields.
 *
 * Parses each log's rawPayload JSON (or uses regex for truncated payloads)
 * and extracts: affiliateOrderId, fyndStatus, eventType, carrier, awbNumber,
 * trackingUrl, customerName, customerEmail, customerPhone
 *
 * Idempotent — safe to run on every deploy. Exits silently when nothing to fix.
 *
 * Usage:
 *   node scripts/backfill-webhook-logs.mjs            # auto mode (runs on deploy)
 *   node scripts/backfill-webhook-logs.mjs --dry-run   # preview only
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

function str(val) {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

/** Try JSON.parse; if it fails (truncated payload), return null */
function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract a JSON string value via regex — works on truncated payloads */
function regexExtract(raw, key) {
  if (!raw) return null;
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, "i");
  const m = raw.match(re);
  return m ? m[1].trim() : null;
}

/** Unwrap Fynd envelope and extract fields via JSON parsing */
function extractViaJson(raw) {
  const body = safeParse(raw);
  if (!body) return null;

  const inner = body.payload ?? body.shipment ?? body;

  // Merge meta fields
  if (inner?.meta && typeof inner.meta === "object") {
    const meta = inner.meta;
    if (!inner.order_id && meta.order_id) inner.order_id = meta.order_id;
    if (!inner.affiliate_order_id && meta.affiliate_order_id) inner.affiliate_order_id = meta.affiliate_order_id;
    if (!inner.external_order_id && meta.external_order_id) inner.external_order_id = meta.external_order_id;
    if (!inner.channel_order_id && meta.channel_order_id) inner.channel_order_id = meta.channel_order_id;
  }

  const event = body?.event && typeof body.event === "object" ? body.event : null;
  const eventType = str(event?.type) ?? str(event?.name);

  const affiliateOrderId =
    str(inner.affiliate_order_id) ?? str(inner.affiliateOrderId) ??
    str(inner.external_order_id) ?? str(inner.channel_order_id) ??
    str(inner.meta?.affiliate_order_id) ?? str(inner.meta?.external_order_id) ??
    str(inner.order?.affiliate_order_id) ??
    str(inner.shipments?.[0]?.order?.affiliate_order_id);

  const fyndStatus =
    str(inner.refund_status) ?? str(inner.refund_status_flag) ??
    str(inner.status) ?? str(inner.current_shipment_status) ??
    str(inner.shipments?.[0]?.refund_status) ?? str(inner.shipments?.[0]?.status);

  const addr = inner.delivery_address ?? inner.billing_address ?? {};
  const meta = inner.meta ?? {};
  const firstName = str(addr.first_name) ?? "";
  const lastName = str(addr.last_name) ?? "";
  const customerName = str(addr.name) ?? ([firstName, lastName].filter(Boolean).join(" ") || null);
  const customerEmail = str(addr.email) ?? str(meta.email);
  const customerPhone = str(addr.phone) ?? str(addr.mobile) ?? str(meta.mobile) ?? str(meta.phone);

  const dp = inner.dp_details ?? {};
  const carrier = str(dp.display_name) ?? str(dp.name) ?? str(inner.display_name) ?? str(meta.cp_name);
  const awbNumber = str(dp.awb_no) ?? str(inner.awb_no) ?? str(meta.awb_no);
  const trackingUrl = str(inner.tracking_url) ?? str(inner.track_url) ?? str(dp.track_url) ?? str(dp.tracking_url);

  return { affiliateOrderId, fyndStatus, eventType, customerName, customerEmail, customerPhone, carrier, awbNumber, trackingUrl };
}

/** Regex-based extraction for truncated/unparseable payloads */
function extractViaRegex(raw) {
  if (!raw) return {};
  return {
    affiliateOrderId:
      regexExtract(raw, "affiliate_order_id") ??
      regexExtract(raw, "external_order_id") ??
      regexExtract(raw, "channel_order_id"),
    fyndStatus:
      regexExtract(raw, "refund_status") ??
      regexExtract(raw, "current_shipment_status") ??
      regexExtract(raw, "status"),
    eventType: regexExtract(raw, "event_type") ?? regexExtract(raw, "event_name"),
    carrier: regexExtract(raw, "display_name") ?? regexExtract(raw, "cp_name"),
    awbNumber: regexExtract(raw, "awb_no"),
    trackingUrl: regexExtract(raw, "tracking_url") ?? regexExtract(raw, "track_url"),
    customerName: regexExtract(raw, "name"),
    customerEmail: regexExtract(raw, "email"),
    customerPhone: regexExtract(raw, "phone") ?? regexExtract(raw, "mobile"),
  };
}

async function main() {
  const logs = await prisma.fyndWebhookLog.findMany({
    where: {
      rawPayload: { not: null },
      OR: [
        { affiliateOrderId: null },
        { fyndStatus: null },
        { eventType: null },
        { carrier: null },
        { customerName: null },
      ],
    },
    select: {
      id: true,
      rawPayload: true,
      orderId: true,
      refundStatus: true,
      affiliateOrderId: true,
      fyndStatus: true,
      eventType: true,
      carrier: true,
      awbNumber: true,
      trackingUrl: true,
      customerName: true,
      customerEmail: true,
      customerPhone: true,
    },
  });

  if (logs.length === 0) {
    console.log("[backfill-webhook-logs] All logs already enriched. Skipping.");
    return;
  }

  console.log(`[backfill-webhook-logs] Found ${logs.length} log(s) to enrich.`);
  if (DRY_RUN) console.log("[backfill-webhook-logs] DRY RUN — no changes will be made.\n");

  let updated = 0;
  let skipped = 0;

  for (const log of logs) {
    // Try JSON parsing first, fall back to regex for truncated payloads
    const jsonExtracted = extractViaJson(log.rawPayload);
    const regexExtracted = extractViaRegex(log.rawPayload);

    const merged = {
      affiliateOrderId: jsonExtracted?.affiliateOrderId ?? regexExtracted.affiliateOrderId ?? null,
      fyndStatus: jsonExtracted?.fyndStatus ?? regexExtracted.fyndStatus ?? null,
      eventType: jsonExtracted?.eventType ?? regexExtracted.eventType ?? null,
      carrier: jsonExtracted?.carrier ?? regexExtracted.carrier ?? null,
      awbNumber: jsonExtracted?.awbNumber ?? regexExtracted.awbNumber ?? null,
      trackingUrl: jsonExtracted?.trackingUrl ?? regexExtracted.trackingUrl ?? null,
      customerName: jsonExtracted?.customerName ?? regexExtracted.customerName ?? null,
      customerEmail: jsonExtracted?.customerEmail ?? regexExtracted.customerEmail ?? null,
      customerPhone: jsonExtracted?.customerPhone ?? regexExtracted.customerPhone ?? null,
    };

    // Also backfill fyndStatus from the existing refundStatus column if available
    if (!merged.fyndStatus && log.refundStatus) {
      merged.fyndStatus = log.refundStatus;
    }

    const data = {};
    if (!log.affiliateOrderId && merged.affiliateOrderId) data.affiliateOrderId = merged.affiliateOrderId;
    if (!log.fyndStatus && merged.fyndStatus) data.fyndStatus = merged.fyndStatus;
    if (!log.eventType && merged.eventType) data.eventType = merged.eventType;
    if (!log.carrier && merged.carrier) data.carrier = merged.carrier;
    if (!log.awbNumber && merged.awbNumber) data.awbNumber = merged.awbNumber;
    if (!log.trackingUrl && merged.trackingUrl) data.trackingUrl = merged.trackingUrl;
    if (!log.customerName && merged.customerName) data.customerName = merged.customerName;
    if (!log.customerEmail && merged.customerEmail) data.customerEmail = merged.customerEmail;
    if (!log.customerPhone && merged.customerPhone) data.customerPhone = merged.customerPhone;

    if (Object.keys(data).length === 0) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD ENRICH ${log.id}: ${JSON.stringify(data)}`);
    } else {
      await prisma.fyndWebhookLog.update({ where: { id: log.id }, data });
    }
    updated++;
  }

  console.log(`[backfill-webhook-logs] ${DRY_RUN ? "Would enrich" : "Enriched"}: ${updated} | Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("[backfill-webhook-logs] Migration error (non-fatal):", err.message ?? err);
  })
  .finally(() => prisma.$disconnect());
