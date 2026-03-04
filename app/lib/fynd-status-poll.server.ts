/**
 * Server-side Fynd status polling for stale returns.
 * Fetches fresh shipment data from Fynd for active returns that haven't been checked recently.
 * Triggered on dashboard load (throttled) and admin return detail view.
 */

import prisma from "../db.server";
import { createFyndClientOrError, type FyndPlatformClient } from "./fynd.server";
import { parseFyndOrderDetailsForTab, extractFyndJourney } from "./fynd-payload.server";

const STALE_THRESHOLD_MS = 30 * 60_000; // 30 minutes
const BATCH_SIZE = 5;
let lastPollRun = 0;
const POLL_THROTTLE_MS = 10 * 60_000; // 10 minutes

export async function pollStaleReturns(): Promise<{ checked: number; updated: number }> {
  if (Date.now() - lastPollRun < POLL_THROTTLE_MS) {
    return { checked: 0, updated: 0 };
  }
  lastPollRun = Date.now();

  const result = { checked: 0, updated: 0 };
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  try {
    const staleReturns = await prisma.returnCase.findMany({
      where: {
        status: { in: ["approved", "processing", "in progress"] },
        fyndShipmentId: { not: null },
        OR: [
          { lastFyndStatusCheck: null },
          { lastFyndStatusCheck: { lt: staleCutoff } },
        ],
      },
      include: { shop: { include: { settings: true } } },
      take: BATCH_SIZE,
      orderBy: { lastFyndStatusCheck: { sort: "asc", nulls: "first" } },
    });

    const clientCache = new Map<string, FyndPlatformClient | null>();

    for (const rc of staleReturns) {
      result.checked++;
      if (!rc.shop.settings?.fyndCredentials || !rc.fyndShipmentId) continue;

      try {
        let client = clientCache.get(rc.shopId);
        if (client === undefined) {
          const clientResult = await createFyndClientOrError(rc.shop.settings);
          client = clientResult.ok && "getShipments" in clientResult.client ? clientResult.client as FyndPlatformClient : null;
          clientCache.set(rc.shopId, client);
        }
        if (!client) continue;

        const fyndOrderId = rc.fyndOrderId ?? rc.fyndShipmentId;
        const shipmentsRes = await client.getShipments(fyndOrderId);
        if (shipmentsRes) {
          const payloadJson = JSON.stringify(shipmentsRes);
          const parsed = parseFyndOrderDetailsForTab(payloadJson);
          const forwardJourney = extractFyndJourney(payloadJson, "forward");

          const updateData: Record<string, unknown> = {
            lastFyndStatusCheck: new Date(),
            fyndPayloadJson: payloadJson,
          };

          if (parsed?.shipments?.[0]?.shipmentStatus) {
            const fyndStatus = parsed.shipments[0].shipmentStatus.toLowerCase();
            if (fyndStatus.includes("delivered") || fyndStatus.includes("delivery_done")) {
              updateData.status = "completed";
            }

            if (parsed.shipments[0].forwardAwb && !rc.forwardAwb) {
              updateData.forwardAwb = parsed.shipments[0].forwardAwb;
            }
          }

          await prisma.returnCase.update({
            where: { id: rc.id },
            data: updateData,
          });

          if (forwardJourney.length > 0) {
            const latestStep = forwardJourney[forwardJourney.length - 1];
            await prisma.returnEvent.create({
              data: {
                returnCaseId: rc.id,
                source: "system",
                eventType: "fynd_status_poll",
                payloadJson: JSON.stringify({
                  latestStatus: latestStep.status,
                  displayName: latestStep.displayName,
                  timestamp: latestStep.time,
                }),
              },
            });
          }

          result.updated++;
        }
      } catch (err) {
        console.warn(`[fynd-poll] Failed for return ${rc.id}:`, err instanceof Error ? err.message : err);
        await prisma.returnCase.update({
          where: { id: rc.id },
          data: { lastFyndStatusCheck: new Date() },
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[fynd-poll] Error:", err instanceof Error ? err.message : err);
  }

  if (result.checked > 0) {
    console.log(`[fynd-poll] Checked ${result.checked} stale returns, updated ${result.updated}`);
  }

  return result;
}

export async function refreshSingleReturn(returnCaseId: string): Promise<boolean> {
  try {
    const rc = await prisma.returnCase.findUnique({
      where: { id: returnCaseId },
      include: { shop: { include: { settings: true } } },
    });
    if (!rc?.fyndShipmentId || !rc.shop.settings?.fyndCredentials) return false;

    const clientResult = await createFyndClientOrError(rc.shop.settings);
    if (!clientResult.ok || !("getShipments" in clientResult.client)) return false;

    const client = clientResult.client as FyndPlatformClient;
    const fyndOrderId = rc.fyndOrderId ?? rc.fyndShipmentId;
    const shipmentsRes = await client.getShipments(fyndOrderId);
    if (!shipmentsRes) return false;

    const payloadJson = JSON.stringify(shipmentsRes);
    const parsed = parseFyndOrderDetailsForTab(payloadJson);

    const updateData: Record<string, unknown> = {
      lastFyndStatusCheck: new Date(),
      fyndPayloadJson: payloadJson,
    };

    if (parsed?.shipments?.[0]) {
      const ship = parsed.shipments[0];
      if (ship.forwardAwb && !rc.forwardAwb) updateData.forwardAwb = ship.forwardAwb;
      const status = (ship.shipmentStatus ?? "").toLowerCase();
      if (status.includes("delivered") || status.includes("delivery_done")) {
        updateData.status = "completed";
      }
    }

    await prisma.returnCase.update({
      where: { id: returnCaseId },
      data: updateData,
    });

    return true;
  } catch (err) {
    console.warn(`[fynd-poll] Refresh failed for ${returnCaseId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}
