#!/usr/bin/env node
/**
 * Data migration: backfill FyndWebhookLog records with enrichment fields.
 *
 * Parses each log's rawPayload JSON and extracts:
 *   affiliateOrderId, fyndStatus, eventType, carrier, awbNumber, trackingUrl,
 *   customerName, customerEmail, customerPhone
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

/** Unwrap Fynd envelope: body may wrap real payload under .payload, .shipment, or be flat */
function unwrapPayload(raw) {
  if (!raw) return null;
  try {
    const body = JSON.parse(raw);
    const inner = body.payload ?? body.shipment ?? body;
    // Merge meta fields up
    if (inner?.meta && typeof inner.meta === "object") {
      const meta = inner.meta;
      if (!inner.order_id && meta.order_id) inner.order_id = meta.order_id;
      if (!inner.affiliate_order_id && meta.affiliate_order_id) inner.affiliate_order_id = meta.affiliate_order_id;
      if (!inner.external_order_id && meta.external_order_id) inner.external_order_id = meta.external_order_id;
      if (!inner.channel_order_id && meta.channel_order_id) inner.channel_order_id = meta.channel_order_id;
    }
    // Extract event type from envelope
    const event = body?.event && typeof body.event === "object" ? body.event : null;
    const eventType = event?.type ?? event?.name ?? null;
    return { inner, eventType, body };
  } catch {
    return null;
  }
}

function str(val) {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function extractAffiliateOrderId(p) {
  return str(p.affiliate_order_id)
    ?? str(p.affiliateOrderId)
    ?? str(p.external_order_id)
    ?? str(p.channel_order_id)
    ?? str(p.meta?.affiliate_order_id)
    ?? str(p.meta?.external_order_id)
    ?? str(p.meta?.channel_order_id)
    ?? str(p.order?.affiliate_order_id)
    ?? str(p.shipments?.[0]?.order?.affiliate_order_id)
    ?? null;
}

function extractFyndStatus(p) {
  return str(p.refund_status)
    ?? str(p.refund_status_flag)
    ?? str(p.status)
    ?? str(p.current_shipment_status)
    ?? str(p.shipments?.[0]?.refund_status)
    ?? str(p.shipments?.[0]?.status)
    ?? str(p.order?.shipments?.[0]?.refund_status)
    ?? str(p.order?.shipments?.[0]?.status)
    ?? null;
}

function extractCustomer(p) {
  const addr = p.delivery_address ?? p.billing_address ?? {};
  const meta = p.meta ?? {};
  const firstName = str(addr.first_name) ?? "";
  const lastName = str(addr.last_name) ?? "";
  const name = str(addr.name) ?? [firstName, lastName].filter(Boolean).join(" ") || null;
  const email = str(addr.email) ?? str(meta.email) ?? null;
  const phone = str(addr.phone) ?? str(addr.mobile) ?? str(meta.mobile) ?? str(meta.phone) ?? null;
  return { name, email, phone };
}

function extractShipping(p) {
  const dp = p.dp_details ?? {};
  const meta = p.meta ?? {};
  const carrier = str(dp.display_name) ?? str(dp.name) ?? str(p.display_name) ?? str(meta.cp_name) ?? null;
  const awb = str(dp.awb_no) ?? str(p.awb_no) ?? str(meta.awb_no) ?? null;
  const trackingUrl = str(p.tracking_url) ?? str(p.track_url) ?? str(dp.track_url) ?? str(dp.tracking_url) ?? null;
  return { carrier, awb, trackingUrl };
}

async function main() {
  // Find logs that have rawPayload but are missing enrichment fields
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
    const parsed = unwrapPayload(log.rawPayload);
    if (!parsed) {
      skipped++;
      continue;
    }

    const { inner, eventType } = parsed;
    const affiliateOrderId = extractAffiliateOrderId(inner);
    const fyndStatus = extractFyndStatus(inner);
    const customer = extractCustomer(inner);
    const shipping = extractShipping(inner);

    const data = {};
    if (!log.affiliateOrderId && affiliateOrderId) data.affiliateOrderId = affiliateOrderId;
    if (!log.fyndStatus && fyndStatus) data.fyndStatus = fyndStatus;
    if (!log.eventType && eventType) data.eventType = eventType;
    if (!log.carrier && shipping.carrier) data.carrier = shipping.carrier;
    if (!log.awbNumber && shipping.awb) data.awbNumber = shipping.awb;
    if (!log.trackingUrl && shipping.trackingUrl) data.trackingUrl = shipping.trackingUrl;
    if (!log.customerName && customer.name) data.customerName = customer.name;
    if (!log.customerEmail && customer.email) data.customerEmail = customer.email;
    if (!log.customerPhone && customer.phone) data.customerPhone = customer.phone;

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
