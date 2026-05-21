/**
 * Server-side Fynd status polling for stale returns.
 * Fetches fresh shipment data from Fynd for active returns that haven't been checked recently.
 * Triggered on dashboard load (throttled) and admin return detail view.
 */

import prisma from "../db.server";
import { createFyndClientOrError, type FyndPlatformClient } from "./fynd.server";
import {
  parseFyndOrderDetailsForTab,
  extractFyndJourney,
  isLikelyFyndId,
} from "./fynd-payload.server";
import { shouldAdvanceFyndStatus } from "./fynd-webhook.server";
import { fyndLogger } from "./observability/logger.server";
import { withSpan } from "./observability/tracing.server";

const STALE_THRESHOLD_MS = 30 * 60_000; // 30 minutes
const BATCH_SIZE = 5;
let lastPollRun = 0;
const POLL_THROTTLE_MS = 10 * 60_000; // 10 minutes

function normalizeFyndStatus(status: string | null | undefined): string | null {
  const normalized = (status ?? "").toLowerCase().replace(/\s+/g, "_").trim();
  return normalized || null;
}

const APP_STATUS_ORDER: Record<string, number> = {
  initiated: 0,
  pending: 1,
  approved: 2,
  "in progress": 3,
  processing: 3,
  completed: 4,
};

function applyReturnProgress(
  updateData: Record<string, unknown>,
  currentStatus: string,
  returnStatus: string,
) {
  const currentLevel = APP_STATUS_ORDER[currentStatus.toLowerCase()] ?? 0;
  if (
    ["return_initiated", "bag_confirmed"].includes(returnStatus) &&
    currentLevel < APP_STATUS_ORDER.approved
  ) {
    updateData.status = "approved";
  }
  if (
    [
      "return_dp_assigned",
      "return_bag_picked",
      "return_bag_in_transit",
      "out_for_pickup",
      "dp_out_for_pickup",
      "return_bag_out_for_delivery",
      "out_for_delivery_to_store",
    ].includes(returnStatus) &&
    currentLevel < APP_STATUS_ORDER["in progress"]
  ) {
    updateData.status = "in progress";
  }
  if (
    ["return_bag_delivered", "return_delivered", "return_accepted", "return_completed"].includes(
      returnStatus,
    ) &&
    currentLevel < APP_STATUS_ORDER.completed
  ) {
    updateData.status = "completed";
  }
}

async function fetchFyndReturnPayload(
  client: FyndPlatformClient,
  rc: { fyndOrderId?: string | null; shopifyOrderName?: string | null },
): Promise<{ payload: unknown; orderId?: string | null } | null> {
  if (rc.fyndOrderId) {
    return { payload: await client.getShipments(rc.fyndOrderId), orderId: rc.fyndOrderId };
  }

  const orderName = rc.shopifyOrderName?.replace(/^#/, "").trim();
  if (!orderName) return null;

  const listing = await client.searchShipmentsByExternalOrderId(orderName);
  if (listing.orderId) {
    return { payload: await client.getShipments(listing.orderId), orderId: listing.orderId };
  }
  return { payload: listing, orderId: null };
}

export async function pollStaleReturns(): Promise<{ checked: number; updated: number }> {
  if (Date.now() - lastPollRun < POLL_THROTTLE_MS) {
    return { checked: 0, updated: 0 };
  }
  lastPollRun = Date.now();

  return withSpan(
    "fynd.poll.stale_returns",
    { "poll.batch_size": BATCH_SIZE, "poll.stale_threshold_ms": STALE_THRESHOLD_MS },
    async (span) => {
      const result = { checked: 0, updated: 0 };
      const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

      try {
        const staleReturns = await prisma.returnCase.findMany({
          where: {
            status: { in: ["approved", "processing", "in progress"] },
            fyndShipmentId: { not: null },
            OR: [{ lastFyndStatusCheck: null }, { lastFyndStatusCheck: { lt: staleCutoff } }],
          },
          include: { shop: { include: { settings: true } } },
          take: BATCH_SIZE,
          orderBy: { lastFyndStatusCheck: { sort: "asc", nulls: "first" } },
        });

        span.setAttribute("poll.stale_count", staleReturns.length);

        const clientCache = new Map<string, FyndPlatformClient | null>();

        for (const rc of staleReturns) {
          result.checked++;
          if (!rc.shop.settings?.fyndCredentials || !rc.fyndShipmentId) continue;

          try {
            let client = clientCache.get(rc.shopId);
            if (client === undefined) {
              const clientResult = await createFyndClientOrError(rc.shop.settings);
              client =
                clientResult.ok && "getShipments" in clientResult.client
                  ? (clientResult.client as FyndPlatformClient)
                  : null;
              clientCache.set(rc.shopId, client);
            }
            if (!client) continue;

            const fetchResult = await fetchFyndReturnPayload(client, rc);
            if (fetchResult?.payload) {
              const payloadJson = JSON.stringify(fetchResult.payload);
              const parsed = parseFyndOrderDetailsForTab(payloadJson);
              const returnJourney = extractFyndJourney(payloadJson, "return");
              const returnShipment =
                parsed?.shipments?.find((ship) => {
                  const status = normalizeFyndStatus(ship.shipmentStatus);
                  return (
                    ship.journeyType === "return" ||
                    !!status?.startsWith("return_") ||
                    status === "out_for_pickup" ||
                    status === "dp_out_for_pickup" ||
                    status === "out_for_delivery_to_store"
                  );
                }) ?? null;
              const latestReturnStep =
                returnJourney.length > 0 ? returnJourney[returnJourney.length - 1] : null;
              const returnStatus =
                normalizeFyndStatus(returnShipment?.shipmentStatus) ??
                normalizeFyndStatus(latestReturnStep?.status);

              const updateData: Record<string, unknown> = {
                lastFyndStatusCheck: new Date(),
                fyndPayloadJson: payloadJson,
                ...(fetchResult.orderId && !rc.fyndOrderId
                  ? { fyndOrderId: fetchResult.orderId }
                  : {}),
              };

              if (returnStatus) {
                if (shouldAdvanceFyndStatus(rc.fyndCurrentStatus, returnStatus)) {
                  updateData.fyndCurrentStatus = returnStatus;
                }
                applyReturnProgress(updateData, rc.status, returnStatus);
              }

              const forwardShipment =
                parsed?.shipments?.find((ship) => ship.journeyType !== "return") ??
                parsed?.shipments?.[0];
              if (
                forwardShipment?.forwardAwb &&
                !rc.forwardAwb &&
                !isLikelyFyndId(forwardShipment.forwardAwb)
              ) {
                updateData.forwardAwb = forwardShipment.forwardAwb;
              }

              await prisma.returnCase.update({
                where: { id: rc.id },
                data: updateData,
              });

              if (returnJourney.length > 0) {
                const latestStep = returnJourney[returnJourney.length - 1];
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
            fyndLogger.warn({ err, returnCaseId: rc.id }, `[fynd-poll] Failed for return ${rc.id}`);
            await prisma.returnCase
              .update({
                where: { id: rc.id },
                data: { lastFyndStatusCheck: new Date() },
              })
              .catch(() => {});
          }
        }
      } catch (err) {
        fyndLogger.error({ err }, "[fynd-poll] Error");
      }

      if (result.checked > 0) {
        fyndLogger.info(
          { checked: result.checked, updated: result.updated },
          `[fynd-poll] Checked ${result.checked} stale returns, updated ${result.updated}`,
        );
      }

      span.setAttributes({
        "poll.checked": result.checked,
        "poll.updated": result.updated,
      });

      return result;
    },
  );
}

export async function refreshSingleReturn(returnCaseId: string): Promise<boolean> {
  try {
    const rc = await prisma.returnCase.findUnique({
      where: { id: returnCaseId },
      include: { shop: { include: { settings: true } } },
    });
    if (!rc?.fyndShipmentId || !rc.shop.settings?.fyndCredentials) return false;
    if (!["approved", "processing", "in progress", "completed"].includes(rc.status)) return false;

    const clientResult = await createFyndClientOrError(rc.shop.settings);
    if (!clientResult.ok || !("getShipments" in clientResult.client)) return false;

    const client = clientResult.client as FyndPlatformClient;
    const fetchResult = await fetchFyndReturnPayload(client, rc);
    if (!fetchResult?.payload) return false;

    const payloadJson = JSON.stringify(fetchResult.payload);
    const parsed = parseFyndOrderDetailsForTab(payloadJson);
    const returnJourney = extractFyndJourney(payloadJson, "return");
    const returnShipment =
      parsed?.shipments?.find((ship) => {
        const status = normalizeFyndStatus(ship.shipmentStatus);
        return (
          ship.journeyType === "return" ||
          !!status?.startsWith("return_") ||
          status === "out_for_pickup" ||
          status === "dp_out_for_pickup" ||
          status === "out_for_delivery_to_store"
        );
      }) ?? null;
    const latestReturnStep =
      returnJourney.length > 0 ? returnJourney[returnJourney.length - 1] : null;
    const returnStatus =
      normalizeFyndStatus(returnShipment?.shipmentStatus) ??
      normalizeFyndStatus(latestReturnStep?.status);

    const updateData: Record<string, unknown> = {
      lastFyndStatusCheck: new Date(),
      fyndPayloadJson: payloadJson,
      ...(fetchResult.orderId && !rc.fyndOrderId ? { fyndOrderId: fetchResult.orderId } : {}),
    };

    // defensive: parsed.shipments optional chain; happy-path always populated in fixtures
    /* v8 ignore start */
    const forwardShipment =
      parsed?.shipments?.find((ship) => ship.journeyType !== "return") ?? parsed?.shipments?.[0];
    if (forwardShipment) {
      /* v8 ignore stop */
      if (
        forwardShipment.forwardAwb &&
        !rc.forwardAwb &&
        !isLikelyFyndId(forwardShipment.forwardAwb)
      )
        updateData.forwardAwb = forwardShipment.forwardAwb;
    }

    if (returnStatus) {
      if (shouldAdvanceFyndStatus(rc.fyndCurrentStatus, returnStatus)) {
        updateData.fyndCurrentStatus = returnStatus;
      }
      applyReturnProgress(updateData, rc.status, returnStatus);
    }

    await prisma.returnCase.update({
      where: { id: returnCaseId },
      data: updateData,
    });

    return true;
  } catch (err) {
    fyndLogger.warn({ err, returnCaseId }, `[fynd-poll] Refresh failed for ${returnCaseId}`);
    return false;
  }
}
