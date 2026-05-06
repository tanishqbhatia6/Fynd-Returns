#!/usr/bin/env node
/**
 * Data migration: auto-populate the refund gate for Fynd-integrated shops
 * that haven't configured one yet.
 *
 * Bug #2 enforcement — without `allowedFyndStatusesForRefund`, the refund gate
 * is disabled and a Shopify refund can be issued before Fynd has cleared the
 * return. This backfills a safe default ("after_qc": refund only after the
 * warehouse accepts the items) for any Fynd-integrated shop where the gate is
 * still null/empty AND no preset has been chosen.
 *
 * Idempotent — safe to run on every deploy. Skips:
 *   - shops with no Fynd integration (fyndApiType / fyndApplicationId both null)
 *   - shops that already have a non-empty allowedFyndStatusesForRefund set
 *   - shops that explicitly chose "none" or "custom" as their refundGatePreset
 *
 * Usage:
 *   node scripts/backfill-refund-gate-preset.mjs            # auto mode (runs on deploy)
 *   node scripts/backfill-refund-gate-preset.mjs --dry-run  # preview only
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");

const REFUND_FLOW_STATUSES = [
  "refund_initiated",
  "refund_on_hold",
  "refund_acknowledged",
  "refund_pending",
  "refund_pending_for_approval",
  "beneficiary_awaited",
  "manual_refund",
  "credit_note_generated",
];

const AFTER_QC_STATUSES = [
  "return_accepted",
  "return_completed",
  ...REFUND_FLOW_STATUSES,
];

function isAlreadyConfigured(raw) {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const candidates = await prisma.shopSettings.findMany({
    where: {
      OR: [{ fyndApiType: { not: null } }, { fyndApplicationId: { not: null } }],
    },
    select: {
      id: true,
      shopId: true,
      fyndApiType: true,
      allowedFyndStatusesForRefund: true,
      refundGatePreset: true,
    },
  });

  if (candidates.length === 0) {
    console.log("[backfill-refund-gate] no Fynd-integrated shops found, nothing to do");
    return;
  }

  let updated = 0;
  let skippedConfigured = 0;
  let skippedExplicit = 0;
  for (const s of candidates) {
    if (s.refundGatePreset === "none" || s.refundGatePreset === "custom") {
      skippedExplicit += 1;
      continue;
    }
    if (isAlreadyConfigured(s.allowedFyndStatusesForRefund)) {
      skippedConfigured += 1;
      continue;
    }
    if (DRY_RUN) {
      console.log(`[backfill-refund-gate] would set after_qc on shop ${s.shopId}`);
      updated += 1;
      continue;
    }
    await prisma.shopSettings.update({
      where: { id: s.id },
      data: {
        allowedFyndStatusesForRefund: JSON.stringify(AFTER_QC_STATUSES),
        refundGatePreset: "after_qc",
      },
    });
    updated += 1;
  }

  console.log(
    `[backfill-refund-gate] candidates=${candidates.length} updated=${updated} ` +
    `skippedConfigured=${skippedConfigured} skippedExplicit=${skippedExplicit}` +
    (DRY_RUN ? " (DRY-RUN)" : ""),
  );
}

main()
  .catch((err) => {
    console.error("[backfill-refund-gate] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
