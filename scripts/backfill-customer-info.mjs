#!/usr/bin/env node
/**
 * Data migration: backfill customer info and currency on ReturnCase records.
 *
 * Parses each return's fyndPayloadJson to extract:
 * - customerName, customerEmailNorm, customerPhoneNorm
 * - customerCity, customerCountry, customerAddress1, customerProvince, customerZip
 * - currency (from Fynd prices)
 *
 * Idempotent — safe to run on every deploy. Exits silently when nothing to fix.
 *
 * Usage:
 *   node scripts/backfill-customer-info.mjs            # auto mode (runs on deploy)
 *   node scripts/backfill-customer-info.mjs --dry-run   # preview only
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

function str(val) {
  return typeof val === "string" && val.trim() ? val.trim() : null;
}

function safeParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract customer info from Fynd payload */
function extractCustomer(payloadJson) {
  const fp = safeParse(payloadJson);
  if (!fp) return null;

  const inner = fp.payload ?? fp.shipment ?? fp;
  const addr = inner.delivery_address ?? inner.billing_address ?? {};
  const meta = inner.meta ?? {};

  const firstName = str(addr.first_name) ?? "";
  const lastName = str(addr.last_name) ?? "";
  const name = str(addr.name) ?? ([firstName, lastName].filter(Boolean).join(" ") || null);
  const email = str(addr.email) ?? str(meta.email);
  const phone = str(addr.phone) ?? str(addr.mobile) ?? str(meta.mobile) ?? str(meta.phone);
  const city = str(addr.city);
  const country = str(addr.country);
  const address1 = str(addr.address1) ?? str(addr.address);
  const province = str(addr.state) ?? str(addr.province);
  const zip = str(addr.pincode) ?? str(addr.zip) ?? str(addr.postal_code);

  if (!name && !email && !phone) return null;
  return { name, email, phone, city, country, address1, province, zip };
}

/** Extract currency from Fynd payload prices */
function extractCurrency(payloadJson) {
  const fp = safeParse(payloadJson);
  if (!fp) return null;

  const inner = fp.payload ?? fp.shipment ?? fp;

  // Try prices.currency_code, order_value.currency, meta.currency
  const prices = inner.prices ?? {};
  const orderValue = inner.order_value ?? {};
  const meta = inner.meta ?? {};
  const bags = inner.bags ?? inner.bag_list_with_details ?? [];
  const firstBag = Array.isArray(bags) && bags.length > 0 ? bags[0] : {};
  const bagPrices = firstBag.prices ?? firstBag.financial_breakup ?? {};

  const currency =
    str(prices.currency_code) ?? str(prices.currency) ??
    str(orderValue.currency) ?? str(orderValue.currency_code) ??
    str(bagPrices.currency_code) ?? str(bagPrices.currency) ??
    str(meta.currency) ?? str(meta.currency_code);

  return currency ? currency.toUpperCase().slice(0, 10) : null;
}

async function main() {
  // Find return cases missing customer info OR currency that have Fynd payload
  const cases = await prisma.returnCase.findMany({
    where: {
      fyndPayloadJson: { not: { equals: null } },
      OR: [
        { customerName: null },
        { customerEmailNorm: null },
        { currency: null },
      ],
    },
    select: {
      id: true,
      returnRequestNo: true,
      customerName: true,
      customerEmailNorm: true,
      customerPhoneNorm: true,
      customerCity: true,
      customerCountry: true,
      customerAddress1: true,
      customerProvince: true,
      customerZip: true,
      currency: true,
      fyndPayloadJson: true,
    },
  });

  if (cases.length === 0) {
    console.log("[backfill-customer-info] All return cases already have customer info. Skipping.");
    return;
  }

  console.log(`[backfill-customer-info] Found ${cases.length} return case(s) to enrich.`);
  if (DRY_RUN) console.log("[backfill-customer-info] DRY RUN — no changes will be made.\n");

  let updated = 0;
  let skipped = 0;

  for (const rc of cases) {
    const data = {};

    // Backfill customer info
    if (!rc.customerName || !rc.customerEmailNorm) {
      const cust = extractCustomer(rc.fyndPayloadJson);
      if (cust) {
        if (!rc.customerName && cust.name) data.customerName = cust.name;
        if (!rc.customerEmailNorm && cust.email) data.customerEmailNorm = cust.email.toLowerCase();
        if (!rc.customerPhoneNorm && cust.phone) data.customerPhoneNorm = cust.phone;
        if (!rc.customerCity && cust.city) data.customerCity = cust.city;
        if (!rc.customerCountry && cust.country) data.customerCountry = cust.country;
        if (!rc.customerAddress1 && cust.address1) data.customerAddress1 = cust.address1;
        if (!rc.customerProvince && cust.province) data.customerProvince = cust.province;
        if (!rc.customerZip && cust.zip) data.customerZip = cust.zip;
      }
    }

    // Backfill currency
    if (!rc.currency) {
      const currency = extractCurrency(rc.fyndPayloadJson);
      if (currency) data.currency = currency;
    }

    if (Object.keys(data).length === 0) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  WOULD ENRICH ${rc.returnRequestNo ?? rc.id}: ${JSON.stringify(data)}`);
    } else {
      await prisma.returnCase.update({ where: { id: rc.id }, data });
    }
    updated++;
  }

  console.log(`[backfill-customer-info] ${DRY_RUN ? "Would enrich" : "Enriched"}: ${updated} | Skipped: ${skipped}`);
}

main()
  .catch((err) => {
    console.error("[backfill-customer-info] Migration error (non-fatal):", err.message ?? err);
  })
  .finally(() => prisma.$disconnect());
