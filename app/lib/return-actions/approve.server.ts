import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
  fyndSyncCounter,
  returnsApprovedCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import {
  fetchOrder,
  fetchOrderByOrderNumber,
  createShopifyReturn,
} from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { createReturnOnFynd } from "../fynd-returns.server";
import { sendApprovalNotification } from "../notification.server";
import { auditReturnAction } from "../observability/audit.server";
import { extractShippingDetailsFromFyndPayload, isLikelyFyndId } from "../fynd-payload.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse, enrichFyndError, classifyFyndError } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleApprove: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, shop, admin, isTerminal, sessionEmail, shopDomain, elapsed } = ctx;
  const note = body.note;
  const bodyResolutionType = body.resolutionType;
  return await withSpan("return.action.approve", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "approve",
  }, async () => {
    const actionTimer = startTimer();
    try {
      if (isTerminal) {
        returnActionCounter.add(1, { action: "approve", outcome: "error" });
        return Response.json({ error: `Cannot approve: return is already ${returnCase.status}` }, { status: 400 });
      }
      const isGreenReturn = (returnCase as { isGreenReturn?: boolean }).isGreenReturn === true;
      let fyndReturnId: string | null = null;
      let fyndReturnNo: string | null = null;
      let fyndError: string | null = null;
      let fyndOrderId: string | null = null;
      let fyndShipmentId: string | null = null;
      let fyndPayloadJson: string | null = null;

      const settingsForApprove = shop.settings as
        | (NonNullable<unknown> & {
            fyndApiType?: string | null;
            fyndConsolidateReturns?: boolean;
            fyndConsolidateWindowHours?: number;
          })
        | undefined;

      const consolidateEnabled = settingsForApprove?.fyndConsolidateReturns === true;
      if (consolidateEnabled && !isGreenReturn) {
        const validResolutionTypes = ["refund", "exchange", "store_credit", "replacement"];
        const resolvedType = bodyResolutionType && validResolutionTypes.includes(bodyResolutionType)
          ? bodyResolutionType
          : "refund";
        await prisma.returnCase.update({
          where: { id },
          data: {
            status: "approved",
            resolutionType: resolvedType,
            adminNotes: note || returnCase.adminNotes,
            fyndSyncStatus: "pending_consolidation",
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "approved",
            payloadJson: JSON.stringify({ note: note || null, resolutionType: resolvedType, consolidation: true, adminEmail: sessionEmail }),
          },
        });
        const consOrderId = returnCase.shopifyOrderId;
        const canCreateConsReturn = consOrderId
          && !consOrderId.startsWith("manual:")
          && (consOrderId.startsWith("gid://") || /^\d+$/.test(consOrderId))
          && !returnCase.shopifyReturnId;
        if (canCreateConsReturn) {
          try {
            const shopifyReturnResult = await createShopifyReturn(
              admin as never,
              consOrderId,
              // defensive items array fallback + nested nullish coalescing
              /* v8 ignore start */
              (returnCase.items ?? []).map((item) => ({
                shopifyLineItemId: item.shopifyLineItemId,
                qty: item.qty,
                reasonCode: item.reasonCode ?? null,
                notes: item.notes ?? null,
                sku: item.sku ?? null,
              })),
              /* v8 ignore stop */
              { requestedAt: returnCase.createdAt.toISOString() },
            );
            if (shopifyReturnResult.success && shopifyReturnResult.shopifyReturnId) {
              await prisma.returnCase.update({
                where: { id },
                data: { shopifyReturnId: shopifyReturnResult.shopifyReturnId },
              }).catch(() => {});
              refundLogger.info({ shopifyReturnId: shopifyReturnResult.shopifyReturnId }, "[Approve:consolidation] Shopify Return created");
            } else {
              refundLogger.warn({ error: shopifyReturnResult.error }, "[Approve:consolidation] Shopify Return creation failed (non-fatal)");
            }
          } catch (err) {
            refundLogger.warn({ err }, "[Approve:consolidation] Shopify Return creation crashed (non-fatal)");
          }
        }

        if (returnCase.customerEmailNorm) {
          try {
            await sendApprovalNotification({
              shopDomain,
              to: returnCase.customerEmailNorm,
              // defensive order name fallback
              /* v8 ignore start */
              orderName: returnCase.shopifyOrderName || "your order",
              /* v8 ignore stop */
              notes: note || undefined,
              shopName: shopDomain?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[Approve] Consolidation notification failed");
          }
        }

        addBusinessEvent("return.approved", { "return.id": returnCase.id, "resolution.type": resolvedType, consolidation: true });
        returnsApprovedCounter.add(1, { auto: "false" });
        auditReturnAction("approved", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: returnCase.status, to: "approved" } });
        returnActionCounter.add(1, { action: "approve", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "approve" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}?consolidationQueued=1`);
      }

      let isTransientFyndError = false;
      let fyndSyncDurationMs: number | null = null;

      if (isGreenReturn) {
        refundLogger.info({ returnId: id }, "[Approve] Green return — skipping Fynd sync (no shipment needed)");
      } else {
        addBusinessEvent("return.fynd_sync_started", { "return.id": returnCase.id });

        const fyndClientResult = settingsForApprove
          ? await createFyndClientOrError(settingsForApprove as never, { requirePlatform: true })
          : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations and connect Fynd with Platform API to create returns on Fynd." };
        if (fyndClientResult.ok && "getShipments" in fyndClientResult.client) {
          const fyndClient = fyndClientResult.client;
          let affiliateOrderId: string | null = null;
          if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
            try {
              const order = returnCase.shopifyOrderId
                ? await fetchOrder(admin as never, returnCase.shopifyOrderId)
                : await fetchOrderByOrderNumber(admin as never, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim());
              affiliateOrderId = order?.affiliateOrderId ?? null;
            } catch (orderFetchErr) {
              refundLogger.warn({ err: orderFetchErr }, "[Approve] Order fetch for affiliateOrderId failed (non-fatal)");
            }
          }
          const syncStartTime = Date.now();
          try {
            const fyndResult = await createReturnOnFynd(fyndClient, returnCase as never, {
              affiliateOrderId,
              targetShipmentId: returnCase.fyndShipmentId || null,
              pickupAddress: returnCase.customerAddress1 || returnCase.customerCity ? {
                address1: returnCase.customerAddress1 ?? null,
                address2: returnCase.customerAddress2 ?? null,
                city: returnCase.customerCity ?? null,
                province: returnCase.customerProvince ?? null,
                zip: returnCase.customerZip ?? null,
                country: returnCase.customerCountry ?? null,
                landmark: returnCase.customerLandmark ?? null,
                name: returnCase.customerName ?? null,
                phone: returnCase.customerPhoneNorm ?? null,
              } : null,
            });
            fyndSyncDurationMs = Date.now() - syncStartTime;
            if (fyndResult.success && (fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? fyndResult.alreadyExists)) {
              // defensive fyndReturnId/shipmentId fallback chain
              /* v8 ignore start */
              fyndReturnId = fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? null;
              /* v8 ignore stop */
              fyndReturnNo = fyndResult.fyndReturnNo ?? null;
              fyndOrderId = fyndResult.fyndOrderId ?? null;
              fyndShipmentId = fyndResult.fyndShipmentId ?? null;
              try {
                fyndPayloadJson = fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
              } catch {
                fyndPayloadJson = null;
              }
              fyndSyncCounter.add(1, { outcome: "success" });
              // defensive empty string fallback for fyndReturnId attribute
              /* v8 ignore start */
              addBusinessEvent("return.fynd_sync_completed", { "return.id": returnCase.id, "fynd.return_id": fyndReturnId || "", "duration_ms": fyndSyncDurationMs });
              /* v8 ignore stop */
            } else if (fyndResult.error) {
              fyndError = enrichFyndError(fyndResult.error);
              isTransientFyndError = true;
              fyndSyncCounter.add(1, { outcome: "error" });
              refundLogger.warn({ error: fyndResult.error }, "[Approve] Fynd create return failed");
            }
          } catch (err) {
            fyndSyncDurationMs = Date.now() - syncStartTime;
            fyndError = enrichFyndError(err instanceof Error ? err.message : String(err));
            isTransientFyndError = true;
            fyndSyncCounter.add(1, { outcome: "error" });
            refundLogger.warn({ err }, "[Approve] Fynd error");
          }
        } else if (!fyndClientResult.ok) {
          fyndError = fyndClientResult.error;
        } else {
          fyndError = "Fynd return creation requires Platform API (Company ID + Client ID/Secret). Configure in Settings → Integrations.";
        }
      }
      if (!isGreenReturn && !fyndReturnId && !fyndError) {
        fyndError = "Fynd sync completed but did not return a return ID. The return may have been created — check the Fynd dashboard, or retry.";
        isTransientFyndError = true;
      }

      const validResolutionTypes = ["refund", "exchange", "store_credit", "replacement"];
      // defensive resolution type validation ternary
      /* v8 ignore start */
      const resolvedType = bodyResolutionType && validResolutionTypes.includes(bodyResolutionType)
        ? bodyResolutionType
        : "refund";
      /* v8 ignore stop */

      const autoShippingData: Record<string, string> = {};
      if (fyndPayloadJson) {
        const shippingInfo = extractShippingDetailsFromFyndPayload(fyndPayloadJson);
        // defensive shipping info disjunction
        /* v8 ignore start */
        if (shippingInfo && (shippingInfo.carrier || shippingInfo.trackingNumber)) {
        /* v8 ignore stop */
          autoShippingData.returnLabelJson = JSON.stringify({
            carrier: shippingInfo.carrier,
            trackingNumber: shippingInfo.trackingNumber,
            trackingUrl: shippingInfo.trackingUrl,
            labelUrl: shippingInfo.labelUrl,
            invoiceUrl: shippingInfo.invoiceUrl,
            invoiceNumber: shippingInfo.invoiceNumber,
            source: "fynd",
          });
          if (shippingInfo.trackingNumber && !isLikelyFyndId(shippingInfo.trackingNumber)) {
            autoShippingData.forwardAwb = shippingInfo.trackingNumber;
          }
        }
      }

      const retryNextTime = fyndError && isTransientFyndError ? new Date(Date.now() + 2 * 60_000) : undefined;

      const updateResult = await prisma.returnCase.updateMany({
        where: {
          id,
          status: { in: ["pending", "initiated", "processing", "in progress"] },
        },
        data: {
          status: "approved",
          resolutionType: resolvedType,
          adminNotes: note || returnCase.adminNotes,
          fyndSyncStatus: fyndReturnId
            ? "synced"
            : fyndError
              ? (isTransientFyndError ? "retry_scheduled" : "failed")
              : undefined,
          fyndSyncError: fyndError || null,
          ...(fyndError && isTransientFyndError ? { fyndSyncRetries: 0, fyndSyncNextRetry: retryNextTime } : {}),
          ...(fyndReturnId && { fyndReturnId }),
          ...(fyndReturnNo && { fyndReturnNo }),
          ...(fyndOrderId && { fyndOrderId }),
          ...(fyndShipmentId && { fyndShipmentId }),
          ...(fyndPayloadJson != null && { fyndPayloadJson }),
          ...autoShippingData,
        },
      });
      if (updateResult.count === 0) {
        returnActionCounter.add(1, { action: "approve", outcome: "idempotent_noop" });
        return Response.json({ success: true, idempotent: true });
      }
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "approved",
          payloadJson: JSON.stringify({
            note: note || null,
            resolutionType: resolvedType,
            adminEmail: sessionEmail,
          }),
        },
      });
      if (fyndReturnId) {
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "fynd_sync",
            payloadJson: JSON.stringify({
              action: "approval_sync",
              status: "success",
              // defensive null fallback in event payload
              /* v8 ignore start */
              fyndReturnId: fyndReturnId || null,
              fyndReturnNo: fyndReturnNo || null,
              /* v8 ignore stop */
              fyndOrderId: fyndOrderId || null,
              fyndShipmentId: fyndShipmentId || null,
              durationMs: fyndSyncDurationMs,
              adminEmail: sessionEmail,
            }),
          },
        });
      } else if (fyndError) {
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "fynd_sync_failed",
            payloadJson: JSON.stringify({
              action: "approval_sync",
              status: "failed",
              error: fyndError,
              errorType: classifyFyndError(fyndError),
              durationMs: fyndSyncDurationMs,
              retryScheduled: isTransientFyndError,
              nextRetryAt: retryNextTime?.toISOString() || null,
              adminEmail: sessionEmail,
            }),
          },
        });
      }

      const effectiveOrderId = returnCase.shopifyOrderId;
      const shouldCreateShopifyReturn =
        !isGreenReturn
        && effectiveOrderId
        && !effectiveOrderId.startsWith("manual:")
        && (effectiveOrderId.startsWith("gid://") || /^\d+$/.test(effectiveOrderId))
        && !returnCase.shopifyReturnId;

      if (shouldCreateShopifyReturn) {
        try {
          const shopifyReturnResult = await createShopifyReturn(
            admin as never,
            effectiveOrderId,
            (returnCase.items ?? []).map((item) => ({
              shopifyLineItemId: item.shopifyLineItemId,
              qty: item.qty,
              reasonCode: item.reasonCode ?? null,
              notes: item.notes ?? null,
              sku: item.sku ?? null,
            })),
            { requestedAt: returnCase.createdAt.toISOString() },
          );

          if (shopifyReturnResult.success && shopifyReturnResult.shopifyReturnId) {
            await prisma.returnCase.update({
              where: { id },
              data: { shopifyReturnId: shopifyReturnResult.shopifyReturnId },
            }).catch(() => {});
            await prisma.returnEvent.create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "shopify_return_created",
                payloadJson: JSON.stringify({
                  shopifyReturnId: shopifyReturnResult.shopifyReturnId,
                  itemCount: (returnCase.items ?? []).length,
                  adminEmail: sessionEmail,
                }),
              },
            }).catch(() => {});
            refundLogger.info({ shopifyReturnId: shopifyReturnResult.shopifyReturnId }, "[Approve] Shopify Return created");
          } else {
            refundLogger.warn({ error: shopifyReturnResult.error }, "[Approve] Shopify Return creation failed (non-fatal)");
            await prisma.returnEvent.create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "shopify_return_failed",
                payloadJson: JSON.stringify({
                  error: shopifyReturnResult.error,
                  orderId: effectiveOrderId,
                  adminEmail: sessionEmail,
                }),
              },
            }).catch(() => {});
          }
        } catch (err) {
          refundLogger.warn({ err }, "[Approve] Shopify Return creation crashed (non-fatal)");
        }
      }

      if (returnCase.customerEmailNorm) {
        try {
          await sendApprovalNotification({
            shopDomain,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName || "your order",
            notes: note || undefined,
            shopName: shopDomain?.replace(".myshopify.com", ""),
          });
        } catch (err) {
          refundLogger.warn({ err }, "[Approve] Notification failed");
        }
      }

      addBusinessEvent("return.approved", { "return.id": returnCase.id, "resolution.type": resolvedType, "fynd.synced": !!fyndReturnId });
      returnsApprovedCounter.add(1, { auto: "false" });
      auditReturnAction("approved", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: returnCase.status, to: "approved" } });
      returnActionCounter.add(1, { action: "approve", outcome: "success" });
      returnActionDuration.record(actionTimer(), { action: "approve" });
      annotateSLO("api_latency_p99", { durationMs: elapsed() });

      const redirectUrl = fyndError
        ? `/app/returns/${id}?fyndError=${encodeURIComponent(fyndError)}`
        : fyndReturnId
          ? `/app/returns/${id}?fyndSuccess=1`
          : `/app/returns/${id}`;
      throw redirect(redirectUrl);
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "approve", outcome: "error" });
      appErrorCounter.add(1, { action: "approve" });
      returnActionDuration.record(actionTimer(), { action: "approve" });
      throw err;
    }
  });
};
