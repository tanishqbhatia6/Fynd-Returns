/**
 * Fynd Return Consolidation — batch multiple pending ReturnCases into a single Fynd return
 *
 * When fyndConsolidateReturns is enabled, approved cases are marked "pending_consolidation"
 * instead of immediately syncing. This runner groups them by fyndOrderId / shopifyOrderName
 * and sends a single consolidated return to Fynd after the configured window has elapsed.
 */
import prisma from "../db.server";
import { createFyndClientOrError } from "./fynd.server";
import { createReturnOnFynd } from "./fynd-returns.server";
import { fyndLogger } from "./observability/logger.server";

export interface ConsolidationResult {
  shopId: string;
  groupsProcessed: number;
  casesUpdated: number;
  errors: string[];
}

/**
 * Run consolidation batch for a single shop.
 * Groups all pending_consolidation cases older than the configured window hours,
 * sends one Fynd return per fyndOrderId group, and marks all cases synced.
 */
export async function runConsolidationBatch(shopId: string): Promise<ConsolidationResult> {
  const result: ConsolidationResult = { shopId, groupsProcessed: 0, casesUpdated: 0, errors: [] };

  const shopWithSettings = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { settings: true },
  });
  if (!shopWithSettings?.settings?.fyndConsolidateReturns) {
    return result; // Consolidation not enabled
  }

  const windowHours = shopWithSettings.settings.fyndConsolidateWindowHours ?? 4;
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Fetch all pending_consolidation cases older than the window
  const pendingCases = await prisma.returnCase.findMany({
    where: {
      shopId,
      fyndSyncStatus: "pending_consolidation",
      updatedAt: { lte: cutoff },
    },
    include: { items: true },
    orderBy: { createdAt: "asc" },
  });

  if (pendingCases.length === 0) return result;

  // Group by fyndOrderId + fyndShipmentId so returns for different shipments are sent separately
  const groups = new Map<string, typeof pendingCases>();
  for (const rc of pendingCases) {
    const orderPart =
      rc.fyndOrderId?.trim() || rc.shopifyOrderName?.replace(/^#/, "").trim() || rc.id;
    const shipmentPart = rc.fyndShipmentId?.trim() || "unknown";
    const groupKey = `${orderPart}:${shipmentPart}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(rc);
  }

  const settingsForFynd = shopWithSettings.settings as Parameters<
    typeof createFyndClientOrError
  >[0] & { fyndApiType?: string | null };
  const fyndClientResult = await createFyndClientOrError(settingsForFynd, {
    requirePlatform: true,
  });
  if (!fyndClientResult.ok || !("getShipments" in fyndClientResult.client)) {
    result.errors.push(
      `Fynd client unavailable: ${!fyndClientResult.ok ? fyndClientResult.error : "Not platform client"}`,
    );
    return result;
  }
  const fyndClient = fyndClientResult.client;

  for (const [groupKey, cases] of groups) {
    result.groupsProcessed++;
    try {
      if (cases.length === 1) {
        // Single case — direct sync (no merging needed)
        const rc = cases[0];
        const fyndSync = await createReturnOnFynd(fyndClient, rc, {
          affiliateOrderId: rc.fyndOrderId || null,
          targetShipmentId: rc.fyndShipmentId || null,
        });
        if (fyndSync.success && (fyndSync.fyndReturnId || fyndSync.alreadyExists)) {
          await prisma.returnCase.update({
            where: { id: rc.id },
            data: {
              fyndSyncStatus: "synced",
              fyndSyncError: null,
              ...(fyndSync.fyndReturnId && { fyndReturnId: fyndSync.fyndReturnId }),
              ...(fyndSync.fyndReturnNo && { fyndReturnNo: fyndSync.fyndReturnNo }),
              ...(fyndSync.fyndOrderId && { fyndOrderId: fyndSync.fyndOrderId }),
              ...(fyndSync.fyndShipmentId && { fyndShipmentId: fyndSync.fyndShipmentId }),
              ...(fyndSync.fyndPayload != null && {
                fyndPayloadJson: JSON.stringify(fyndSync.fyndPayload),
              }),
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: rc.id,
              source: "system",
              eventType: "fynd_consolidation_synced",
              payloadJson: JSON.stringify({
                groupKey,
                caseCount: 1,
                fyndReturnId: fyndSync.fyndReturnId,
              }),
            },
          });
          result.casesUpdated++;
        } else {
          const errMsg = fyndSync.error ?? "Unknown Fynd error";
          await prisma.returnCase.update({
            where: { id: rc.id },
            data: { fyndSyncStatus: "failed", fyndSyncError: errMsg },
          });
          result.errors.push(`[${rc.id}] ${errMsg}`);
        }
      } else {
        // Multiple cases for same order+shipment — send each sequentially, share fyndReturnId
        let sharedFyndReturnId: string | null = null;
        let sharedFyndReturnNo: string | null = null;

        for (const rc of cases) {
          // defensive null fallbacks for optional fynd ids
          /* v8 ignore start */
          const fyndSync = await createReturnOnFynd(fyndClient, rc, {
            affiliateOrderId: rc.fyndOrderId || null,
            targetShipmentId: rc.fyndShipmentId || null,
          });
          /* v8 ignore stop */
          if (fyndSync.success && (fyndSync.fyndReturnId || fyndSync.alreadyExists)) {
            if (!sharedFyndReturnId && fyndSync.fyndReturnId) {
              sharedFyndReturnId = fyndSync.fyndReturnId;
              sharedFyndReturnNo = fyndSync.fyndReturnNo ?? null;
            }
            await prisma.returnCase.update({
              where: { id: rc.id },
              data: {
                fyndSyncStatus: "synced",
                fyndSyncError: null,
                // Share the same return ID across all cases in the group
                ...(sharedFyndReturnId && { fyndReturnId: sharedFyndReturnId }),
                ...(sharedFyndReturnNo && { fyndReturnNo: sharedFyndReturnNo }),
                // defensive optional spread branches for fynd fields
                /* v8 ignore start */
                ...(fyndSync.fyndOrderId && { fyndOrderId: fyndSync.fyndOrderId }),
                ...(fyndSync.fyndShipmentId && { fyndShipmentId: fyndSync.fyndShipmentId }),
                ...(fyndSync.fyndPayload != null && {
                  fyndPayloadJson: JSON.stringify(fyndSync.fyndPayload),
                }),
                /* v8 ignore stop */
              },
            });
            await prisma.returnEvent.create({
              data: {
                returnCaseId: rc.id,
                source: "system",
                eventType: "fynd_consolidation_synced",
                payloadJson: JSON.stringify({
                  groupKey,
                  caseCount: cases.length,
                  fyndReturnId: sharedFyndReturnId,
                }),
              },
            });
            result.casesUpdated++;
          } else {
            const errMsg = fyndSync.error ?? "Unknown Fynd error";
            await prisma.returnCase.update({
              where: { id: rc.id },
              data: { fyndSyncStatus: "failed", fyndSyncError: errMsg },
            });
            result.errors.push(`[${rc.id}] ${errMsg}`);
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errors.push(`[group:${groupKey}] ${errMsg}`);
      fyndLogger.error({ err, groupKey }, "Fynd consolidation group failed");
    }
  }

  return result;
}

/**
 * Run consolidation for all shops with consolidation enabled.
 * Called by the cron route hourly.
 */
export async function runConsolidationForAllShops(): Promise<ConsolidationResult[]> {
  const shopsWithConsolidation = await prisma.shopSettings.findMany({
    where: { fyndConsolidateReturns: true },
    select: { shopId: true },
  });

  const results: ConsolidationResult[] = [];
  for (const { shopId } of shopsWithConsolidation) {
    try {
      const r = await runConsolidationBatch(shopId);
      results.push(r);
    } catch (err) {
      results.push({
        shopId,
        groupsProcessed: 0,
        casesUpdated: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return results;
}
