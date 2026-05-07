/**
 * Bug #15 final defence layer — application-level mutex around
 * `createShopifyReturn`.
 *
 * Why this exists
 * ---------------
 * The Shopify-side idempotency check inside `createShopifyReturn`
 * (which scans the order's existing OPEN / REQUESTED / IN_PROGRESS
 * returns and reuses a matching one) is best-effort:
 *
 *   1. Shopify's `order.returns` connection is eventually consistent.
 *      A Return created moments earlier may not be visible to the next
 *      read within the same second.
 *   2. Each caller (handleApprove, handleRetryFyndSync, manual clicks,
 *      multiple browser tabs) reads `returnCase.shopifyReturnId` from a
 *      request-scoped snapshot. Concurrent calls all see `null` and all
 *      fire returnCreate. The Shopify-side guard catches some, but races
 *      slip through and produce duplicate returns on the same order
 *      (R1, R2, R3 covering the same single unit — exactly the symptom
 *      reported in the user's screenshot).
 *
 * Defence
 * -------
 * A DB-level mutex via the existing `shopifyReturnId` column. We
 * atomically transition it from `null` to a `PENDING:<uuid>` sentinel.
 * Only one worker wins; the winner fires returnCreate and writes the
 * real id back; losers either return the existing id (if a real one is
 * now set) or skip (if still `PENDING:` — another worker is mid-call).
 *
 * Crash policy
 * ------------
 * If the winning worker crashes mid-call, the row stays at `PENDING:`
 * forever and no further auto-retry can recreate. This is intentional —
 * we'd rather fail closed than open up duplicates again. Manual recovery:
 *
 *   UPDATE return_case SET shopify_return_id = NULL WHERE id = '...'
 *
 * A TTL-based reaper can be added later if this becomes operationally
 * painful; for now silent failure is preferable to silent duplication.
 */

import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { refundLogger } from "./observability/logger.server";
import {
  createShopifyReturn,
  type AdminGraphQL,
  type ShopifyReturnResult,
} from "./shopify-admin.server";

export type ClaimAndCreateResult = ShopifyReturnResult & {
  /** True if this caller actually created the Shopify return; false if
   *  another concurrent worker had already claimed/created it. */
  claimed: boolean;
};

export async function claimAndCreateShopifyReturn(
  returnCaseId: string,
  admin: AdminGraphQL,
  orderId: string,
  returnItems: Array<{
    shopifyLineItemId: string;
    qty: number;
    reasonCode?: string | null;
    notes?: string | null;
    sku?: string | null;
  }>,
  options?: { notifyCustomer?: boolean; requestedAt?: string },
): Promise<ClaimAndCreateResult> {
  const sentinel = `PENDING:${randomUUID()}`;
  const claim = await prisma.returnCase.updateMany({
    where: { id: returnCaseId, shopifyReturnId: null },
    data: { shopifyReturnId: sentinel },
  });
  if (claim.count === 0) {
    // Lost the race — someone has already claimed (or completed).
    const fresh = await prisma.returnCase.findUnique({
      where: { id: returnCaseId },
      select: { shopifyReturnId: true },
    });
    if (fresh?.shopifyReturnId && !fresh.shopifyReturnId.startsWith("PENDING:")) {
      refundLogger.info(
        { returnCaseId, shopifyReturnId: fresh.shopifyReturnId },
        "claimAndCreateShopifyReturn: another worker already created the Shopify return; reusing",
      );
      return { success: true, shopifyReturnId: fresh.shopifyReturnId, claimed: false };
    }
    refundLogger.info(
      { returnCaseId },
      "claimAndCreateShopifyReturn: another worker is currently creating the Shopify return; skipping",
    );
    return { success: true, claimed: false };
  }
  // We own the lock.
  try {
    const result = await createShopifyReturn(admin, orderId, returnItems, options);
    if (result.success && result.shopifyReturnId) {
      await prisma.returnCase.update({
        where: { id: returnCaseId },
        data: { shopifyReturnId: result.shopifyReturnId },
      });
      return { ...result, claimed: true };
    }
    // Failure (or no id returned). Revert the claim so a future retry can try again.
    await prisma.returnCase
      .updateMany({
        where: { id: returnCaseId, shopifyReturnId: sentinel },
        data: { shopifyReturnId: null },
      })
      .catch((err) =>
        refundLogger.error(
          { err, returnCaseId },
          "claimAndCreateShopifyReturn: failed to revert claim sentinel; manual cleanup may be needed",
        ),
      );
    return { ...result, claimed: true };
  } catch (err) {
    await prisma.returnCase
      .updateMany({
        where: { id: returnCaseId, shopifyReturnId: sentinel },
        data: { shopifyReturnId: null },
      })
      .catch((revertErr) =>
        refundLogger.error(
          { err: revertErr, returnCaseId },
          "claimAndCreateShopifyReturn: failed to revert claim sentinel after exception",
        ),
      );
    throw err;
  }
}
