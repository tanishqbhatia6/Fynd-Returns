import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRefund, createDiscountCodeRefund, createShopifyReturn, closeShopifyReturnBestEffort, fetchOrder, fetchOrderByGid, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, fetchOrderLineItemsOnly, fetchOrderLineItemsByName, withRestCredentials, type RefundMethodConfig } from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { sendRejectionNotification, sendApprovalNotification, sendRefundNotification, sendCustomerNoteNotification, sendCancellationNotification, sendCancellationDeclinedNotification } from "../lib/notification.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import { extractShippingDetailsFromFyndPayload, isLikelyFyndId } from "../lib/fynd-payload.server";
import { scheduleRetry } from "../lib/fynd-retry.server";
import { withSpan, addBusinessEvent, startTimer, setSpanAttributes } from "../lib/observability/tracing.server";
import { refundLogger } from "../lib/observability/logger.server";
import { returnActionCounter, returnActionDuration, refundCounter, refundAmountHistogram, fyndSyncCounter, returnsApprovedCounter, returnsRejectedCounter, returnsCompletedCounter, appErrorCounter } from "../lib/observability/metrics.server";
import { auditReturnAction } from "../lib/observability/audit.server";
import { annotateSLO } from "../lib/observability/slo.server";
import { setRequestContext } from "../lib/observability/request-context.server";

const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];

function enrichFyndError(msg: string): string {
  if (!msg) return msg;
  const is403 = /403|forbidden/i.test(msg);
  const hasGuidance = /company\/orders|scopes|Fynd Partners|Settings.*Integrations|Test Platform/i.test(msg);
  if (is403 && !hasGuidance) {
    return `${msg} — Sync uses the same OAuth flow as Test Platform. If Test Platform passes in Settings → Integrations but sync still fails, the write endpoint may require additional permissions—contact Fynd support.`;
  }
  return msg;
}

/** Classify a Fynd sync error for structured UI display */
function classifyFyndError(msg: string): "config_error" | "network_error" | "timeout" | "api_error" {
  if (/not configured|configure|Platform API|Settings.*Integrations|Client ID|Company ID/i.test(msg)) return "config_error";
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|network|socket hang up|DNS/i.test(msg)) return "network_error";
  if (/ETIMEDOUT|timeout|timed out|aborted/i.test(msg)) return "timeout";
  return "api_error";
}

function enrichRefundError(msg: string, ctx: { method?: string | null; orderName?: string | null }): string {
  if (!msg) return msg;
  if (/no transactions|transactions cannot be empty/i.test(msg) && ctx.method === "original")
    return `${msg} — This may be a COD or gift-card order. Try "Store credit" or "Discount code" refund method instead.`;
  if (/customer.*not found|store.*credit.*no.*customer|store_credit.*customer/i.test(msg))
    return `${msg} — Store credit requires the customer to have a Shopify account. Use "Discount code" method instead.`;
  if (/already.*been.*refunded|already refunded/i.test(msg))
    return `${msg} — Check Shopify Admin for order ${ctx.orderName ?? ""} to verify refund status.`;
  if (/location|restock/i.test(msg))
    return `${msg} — Try a different restock location, or disable restocking in Settings → Return Settings.`;
  if (/gift.*card|store_credit.*amount/i.test(msg))
    return `${msg} — Use "Discount code" refund method for gift card or store credit orders.`;
  return msg;
}

function isRedirectResponse(err: unknown): boolean {
  if (err instanceof Response) {
    return err.status >= 300 && err.status < 400;
  }
  return false;
}

async function extractErrorMessage(err: unknown): Promise<string> {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT")) {
      return "Unable to connect to external service. Please try again later.";
    }
    return msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
  }
  if (typeof err === "object" && err !== null && "ok" in err && typeof (err as Response).json === "function") {
    const res = err as Response;
    try {
      const j = await res.json().catch(() => ({}));
      const msg = (j as { error?: string; message?: string })?.error ?? (j as { error?: string; message?: string })?.message;
      if (typeof msg === "string" && msg.trim()) {
        const safe = msg.length > 300 ? msg.slice(0, 300) + "..." : msg;
        return safe;
      }
    } catch {
      /* ignore */
    }
    return `Request failed (${res.status}). Please check Fynd configuration and try again.`;
  }
  const s = String(err);
  if (s === "[object Response]" || s === "[object Object]") return "Request failed. Please check Fynd configuration and try again.";
  return s.length > 300 ? s.slice(0, 300) + "..." : s;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const elapsed = startTimer();

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const id = params.id;
  if (!id) return Response.json({ error: "Return ID required" }, { status: 400 });

  const { session, admin: rawAdmin } = await authenticate.admin(request);
  // Attach REST credentials so order lookups can fall back to REST API (exact name match)
  const sessionAccessToken = session.accessToken ?? "";
  refundLogger.info({ shop: session.shop, hasAccessToken: !!sessionAccessToken, tokenLength: sessionAccessToken.length }, "[actions] authenticated");
  const admin = withRestCredentials(rawAdmin, session.shop, sessionAccessToken);
  const sessionEmail = (session as unknown as { email?: string | null }).email ?? null;
  const shopWithSettings = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
  if (!shopWithSettings) return Response.json({ error: "Shop not found" }, { status: 404 });
  const shop = shopWithSettings;

  // Set request context for tracing after auth
  setRequestContext(request, { shopDomain: shop.shopDomain, shopId: shop.id });

  const returnCase = await prisma.returnCase.findFirst({
    where: { id, shopId: shop.id },
    include: { items: true },
  });
  if (!returnCase) return Response.json({ error: "Return not found" }, { status: 404 });

  const isTerminal = TERMINAL_STATUSES.includes(returnCase.status.toLowerCase());

  // Helper for logging Shopify return close/decline events
  const logShopifyReturnEvent = async (evt: { eventType: string; payloadJson: string }) => {
    await prisma.returnEvent.create({ data: { returnCaseId: id, source: "admin", ...evt } }).catch(() => {});
  };

  let body: { action: string; status?: string; note?: string; notesForCustomer?: string; refund?: boolean; rejectionReason?: string; locationId?: string; refundMethod?: string; storeCreditPct?: number; bonusAmount?: number; resolutionType?: string; exchangeItems?: Array<{ variantId: string; quantity: number }>; splitMode?: string; splitScAmount?: number; splitOrigAmount?: number };
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
  } else {
    const formData = await request.formData();
    const jsonStr = formData.get("json") as string | null;
    const actionVal = formData.get("action") as string | null;
    const noteVal = formData.get("note") as string | null;
    const notesForCustomerVal = formData.get("notesForCustomer") as string | null;
    const rejectionReasonVal = formData.get("rejectionReason") as string | null;
    if (jsonStr) {
      try {
        body = JSON.parse(jsonStr) as typeof body;
      } catch {
        body = { action: actionVal || "unknown" };
      }
    } else {
      body = { action: actionVal || "unknown" };
    }
    if (noteVal !== null && noteVal !== undefined) body.note = noteVal;
    if (notesForCustomerVal !== null && notesForCustomerVal !== undefined) body.notesForCustomer = notesForCustomerVal;
    if (rejectionReasonVal !== null && rejectionReasonVal !== undefined) body.rejectionReason = rejectionReasonVal;
    // Address fields for edit_details
    const addrFields = ["customerAddress1", "customerAddress2", "customerCity", "customerProvince", "customerZip", "customerCountry", "customerLandmark"] as const;
    for (const field of addrFields) {
      const val = formData.get(field) as string | null;
      if (val !== null) (body as Record<string, unknown>)[field] = val;
    }
  }

  const { action: actionType, status: newStatus, note, notesForCustomer, refund: doRefund, rejectionReason, locationId: requestedLocationId, refundMethod: bodyRefundMethod, storeCreditPct: bodyStoreCreditPct, bonusAmount: bodyBonusAmount, resolutionType: bodyResolutionType, exchangeItems: bodyExchangeItems, splitMode: bodySplitMode, splitScAmount: bodySplitScAmount, splitOrigAmount: bodySplitOrigAmount } = body;
  const { carrier: bodyCarrier, trackingNumber: bodyTrackingNumber, labelUrl: bodyLabelUrl, qrCodeUrl: bodyQrCodeUrl, returnInstructions: bodyReturnInstructions } = body as typeof body & { carrier?: string; trackingNumber?: string; labelUrl?: string; qrCodeUrl?: string; returnInstructions?: string };

  if (actionType === "update_status" && newStatus) {
    return await withSpan("return.action.update_status", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "update_status",
      "status.from": returnCase.status,
      "status.to": newStatus,
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const validStatuses = ["pending", "processing", "in progress", "approved", "rejected", "completed", "cancelled", "initiated"];
        if (!validStatuses.includes(newStatus.toLowerCase())) {
          returnActionCounter.add(1, { action: "update_status", outcome: "error" });
          return Response.json({ error: `Invalid status: ${newStatus}` }, { status: 400 });
        }
        await prisma.returnCase.update({
          where: { id },
          data: { status: newStatus, adminNotes: note || returnCase.adminNotes },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "status_updated",
            payloadJson: JSON.stringify({ from: returnCase.status, to: newStatus, note, adminEmail: sessionEmail }),
          },
        });
        // Close/decline Shopify return when moving to a terminal status
        if (["completed", "cancelled", "rejected"].includes(newStatus.toLowerCase())) {
          const closeAction = newStatus.toLowerCase() === "rejected" ? "decline" : "close";
          await closeShopifyReturnBestEffort(admin, returnCase, {
            action: closeAction as "close" | "decline",
            declineReason: closeAction === "decline" ? (note || "Return rejected") : undefined,
            logEvent: logShopifyReturnEvent,
          });
        }

        addBusinessEvent("return.status_updated", { "status.from": returnCase.status, "status.to": newStatus });
        returnActionCounter.add(1, { action: "update_status", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "update_status" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "update_status", outcome: "error" });
        appErrorCounter.add(1, { action: "update_status" });
        returnActionDuration.record(actionTimer(), { action: "update_status" });
        throw err;
      }
    });
  }

  if (actionType === "add_note") {
    return await withSpan("return.action.add_note", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "add_note",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        await prisma.returnCase.update({
          where: { id },
          data: { adminNotes: note ?? returnCase.adminNotes },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "note_added",
            payloadJson: JSON.stringify({ note: note || null, adminEmail: sessionEmail }),
          },
        });

        returnActionCounter.add(1, { action: "add_note", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "add_note" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "add_note", outcome: "error" });
        appErrorCounter.add(1, { action: "add_note" });
        returnActionDuration.record(actionTimer(), { action: "add_note" });
        throw err;
      }
    });
  }

  if (actionType === "save_notes_for_customer") {
    return await withSpan("return.action.save_notes_for_customer", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "save_notes_for_customer",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const val = notesForCustomer !== undefined ? (notesForCustomer || null) : (returnCase as { notesForCustomer?: string | null }).notesForCustomer ?? null;
        await prisma.returnCase.update({
          where: { id },
          data: { notesForCustomer: val },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "notes_for_customer_published",
            payloadJson: notesForCustomer ? JSON.stringify({ notesForCustomer, adminEmail: sessionEmail }) : null,
          },
        });
        // Send email notification to customer when a note is published
        if (val && returnCase.customerEmailNorm) {
          sendCustomerNoteNotification({
            shopDomain: session.shop,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName,
            note: val,
            shopName: undefined,
            returnId: returnCase.returnRequestNo ?? returnCase.id,
          }).catch((e) => refundLogger.warn({ err: e }, "[save_notes_for_customer] Notification failed"));
        }

        returnActionCounter.add(1, { action: "save_notes_for_customer", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "save_notes_for_customer" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "save_notes_for_customer", outcome: "error" });
        appErrorCounter.add(1, { action: "save_notes_for_customer" });
        returnActionDuration.record(actionTimer(), { action: "save_notes_for_customer" });
        throw err;
      }
    });
  }

  if (actionType === "approve") {
    return await withSpan("return.action.approve", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "approve",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (isTerminal) {
          returnActionCounter.add(1, { action: "approve", outcome: "error" });
          return Response.json({ error: `Cannot approve: return is already ${returnCase.status}` }, { status: 400 });
        }
        const isGreenReturn = returnCase.isGreenReturn === true;
        let fyndReturnId: string | null = null;
        let fyndReturnNo: string | null = null;
        let fyndError: string | null = null;
        let fyndOrderId: string | null = null;
        let fyndShipmentId: string | null = null;
        let fyndPayloadJson: string | null = null;

        const settingsForApprove = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null; fyndConsolidateReturns?: boolean; fyndConsolidateWindowHours?: number } | undefined;

        // Consolidation mode: queue for batch instead of immediate Fynd sync
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
          // Create Shopify Return even in consolidation mode (Fynd is deferred, but Shopify should know immediately)
          const consOrderId = returnCase.shopifyOrderId;
          const canCreateConsReturn = consOrderId
            && !consOrderId.startsWith("manual:")
            && (consOrderId.startsWith("gid://") || /^\d+$/.test(consOrderId))
            && !returnCase.shopifyReturnId;
          if (canCreateConsReturn) {
            try {
              const shopifyReturnResult = await createShopifyReturn(
                admin, consOrderId,
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
                shopDomain: session.shop,
                to: returnCase.customerEmailNorm,
                orderName: returnCase.shopifyOrderName || "your order",
                notes: note || undefined,
                shopName: session.shop?.replace(".myshopify.com", ""),
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
            ? await createFyndClientOrError(settingsForApprove, { requirePlatform: true })
            : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations and connect Fynd with Platform API to create returns on Fynd." };
          if (fyndClientResult.ok && "getShipments" in fyndClientResult.client) {
            const fyndClient = fyndClientResult.client;
            let affiliateOrderId: string | null = null;
            if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
              try {
                const order = returnCase.shopifyOrderId
                  ? await fetchOrder(admin, returnCase.shopifyOrderId)
                  : await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim());
                affiliateOrderId = order?.affiliateOrderId ?? null;
              } catch (orderFetchErr) {
                // Non-fatal: Fynd sync can still proceed without affiliateOrderId
                refundLogger.warn({ err: orderFetchErr }, "[Approve] Order fetch for affiliateOrderId failed (non-fatal)");
              }
            }
            const syncStartTime = Date.now();
            try {
              const fyndResult = await createReturnOnFynd(fyndClient, returnCase, {
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
              // BUG FIX: Widen success check — accept fyndShipmentId and alreadyExists (not just fyndReturnId)
              if (fyndResult.success && (fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? fyndResult.alreadyExists)) {
                fyndReturnId = fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? null;
                fyndReturnNo = fyndResult.fyndReturnNo ?? null;
                fyndOrderId = fyndResult.fyndOrderId ?? null;
                fyndShipmentId = fyndResult.fyndShipmentId ?? null;
                try {
                  fyndPayloadJson = fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
                } catch {
                  fyndPayloadJson = null;
                }
                fyndSyncCounter.add(1, { outcome: "success" });
                addBusinessEvent("return.fynd_sync_completed", { "return.id": returnCase.id, "fynd.return_id": fyndReturnId || "", "duration_ms": fyndSyncDurationMs });
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
            // Config errors are NOT transient — don't schedule retry
          } else {
            fyndError = "Fynd return creation requires Platform API (Company ID + Client ID/Secret). Configure in Settings → Integrations.";
            // Config errors are NOT transient — don't schedule retry
          }
        }
        // Safety net: if sync was attempted (non-green, non-consolidation) but produced
        // neither a return ID nor an explicit error, mark it as a transient failure so it
        // gets auto-retried and the admin sees a clear status instead of a silent null.
        if (!isGreenReturn && !fyndReturnId && !fyndError) {
          fyndError = "Fynd sync completed but did not return a return ID. The return may have been created — check the Fynd dashboard, or retry.";
          isTransientFyndError = true;
        }

        const validResolutionTypes = ["refund", "exchange", "store_credit", "replacement"];
        const resolvedType = bodyResolutionType && validResolutionTypes.includes(bodyResolutionType)
          ? bodyResolutionType
          : "refund";

        // Auto-populate shipping info from Fynd response
        let autoShippingData: Record<string, string> = {};
        if (fyndPayloadJson) {
          const shippingInfo = extractShippingDetailsFromFyndPayload(fyndPayloadJson);
          if (shippingInfo && (shippingInfo.carrier || shippingInfo.trackingNumber)) {
            autoShippingData.returnLabelJson = JSON.stringify({
              carrier: shippingInfo.carrier,
              trackingNumber: shippingInfo.trackingNumber,
              trackingUrl: shippingInfo.trackingUrl,
              labelUrl: shippingInfo.labelUrl,
              invoiceUrl: shippingInfo.invoiceUrl,
              invoiceNumber: shippingInfo.invoiceNumber,
              source: "fynd",
            });
            if (shippingInfo.trackingNumber && !isLikelyFyndId(shippingInfo.trackingNumber)) autoShippingData.forwardAwb = shippingInfo.trackingNumber;
          }
        }

        // Compute retry scheduling for transient failures (2 min initial backoff)
        const retryNextTime = fyndError && isTransientFyndError ? new Date(Date.now() + 2 * 60_000) : undefined;

        // Idempotent transition: only flip pending/initiated/processing → approved.
        // updateMany returns { count: 0 } if a concurrent request already moved the row,
        // which lets us short-circuit instead of double-firing Fynd sync + notifications
        // (P1 finding from QA audit — repro: rapid double-click of the Approve button).
        const updateResult = await prisma.returnCase.updateMany({
          where: {
            id,
            status: { in: ["pending", "initiated", "processing", "in progress"] },
          },
          data: {
            status: "approved",
            resolutionType: resolvedType,
            adminNotes: note || returnCase.adminNotes,
            // "synced" on success, "retry_scheduled" on transient failure, "failed" on config error.
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
          // Concurrent approval already won. Return the current state without
          // creating a duplicate event or duplicate Fynd sync.
          returnActionCounter.add(1, { action: "approve", outcome: "idempotent_noop" });
          return Response.json({ success: true, idempotent: true });
        }
        // Approval event
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
        // Rich Fynd sync event — separate from approval for tracing visibility
        if (fyndReturnId) {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "fynd_sync",
              payloadJson: JSON.stringify({
                action: "approval_sync",
                status: "success",
                fyndReturnId: fyndReturnId || null,
                fyndReturnNo: fyndReturnNo || null,
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

        // ── Shopify Return creation (non-blocking) ──
        // Create a Return record in Shopify so it appears in Shopify Admin's Returns tab.
        // Only for non-green, non-manual returns with a valid Shopify order GID.
        const effectiveOrderId = returnCase.shopifyOrderId;
        const shouldCreateShopifyReturn =
          !isGreenReturn
          && effectiveOrderId
          && !effectiveOrderId.startsWith("manual:")
          && (effectiveOrderId.startsWith("gid://") || /^\d+$/.test(effectiveOrderId))
          && !returnCase.shopifyReturnId; // Don't recreate if already exists

        if (shouldCreateShopifyReturn) {
          try {
            const shopifyReturnResult = await createShopifyReturn(
              admin,
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
              // Non-fatal: log the error but don't block approval
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
            // Catch-all: never let Shopify Return creation crash the approval
            refundLogger.warn({ err }, "[Approve] Shopify Return creation crashed (non-fatal)");
          }
        }

        if (returnCase.customerEmailNorm) {
          try {
            await sendApprovalNotification({
              shopDomain: session.shop,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              notes: note || undefined,
              shopName: session.shop?.replace(".myshopify.com", ""),
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
  }

  if (actionType === "retry_fynd_sync") {
    return await withSpan("return.action.retry_fynd_sync", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "retry_fynd_sync",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          return Response.json({ error: "Return must be approved first" }, { status: 400 });
        }
        // Allow retry if: no fyndReturnId, OR sync is in a failed/retry state.
        // This lets admins force-retry even if a previous attempt stored a partial ID.
        const syncStatus = (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus;
        if (returnCase.fyndReturnId && syncStatus !== "failed" && syncStatus !== "retry_scheduled") {
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndSuccess=already_synced`);
        }

        addBusinessEvent("return.fynd_sync_started", { "return.id": returnCase.id, "sync.type": "manual_retry" });

        const settingsRetry = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
        const fyndRetryResult = settingsRetry
          ? await createFyndClientOrError(settingsRetry, { requirePlatform: true })
          : { ok: false as const, error: "Fynd is not configured. Configure Fynd with Platform API in Settings → Integrations." };
        if (!fyndRetryResult.ok) {
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(fyndRetryResult.error)}`);
        }
        const fyndClient = fyndRetryResult.client;
        if (!("getShipments" in fyndClient)) {
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("Sync to Fynd requires Platform API. Switch to Platform in Settings → Integrations.")}`);
        }
        let affiliateOrderId: string | null = null;
        let fyndResult: Awaited<ReturnType<typeof createReturnOnFynd>> | null = null;
        let retryDurationMs = 0;
        let retryCrashError: string | null = null;

        try {
          if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
            const order = returnCase.shopifyOrderId
              ? await fetchOrder(admin, returnCase.shopifyOrderId)
              : await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim());
            affiliateOrderId = order?.affiliateOrderId ?? null;
          }
          const retryStartTime = Date.now();
          fyndResult = await createReturnOnFynd(fyndClient, returnCase, {
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
          retryDurationMs = Date.now() - retryStartTime;
        } catch (err) {
          // Catch network errors, timeouts, or any crash from fetchOrder / createReturnOnFynd
          retryCrashError = enrichFyndError(err instanceof Error ? err.message : String(err));
          refundLogger.error({ err }, "[retry_fynd_sync] Unhandled error");
        }

        // Handle crash — update status and redirect with error
        if (retryCrashError || !fyndResult) {
          const crashMsg = retryCrashError || "Fynd sync failed unexpectedly. Check server logs for details.";
          await prisma.returnCase.update({
            where: { id },
            data: { fyndSyncStatus: "failed", fyndSyncError: crashMsg },
          }).catch(() => {});
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id, source: "admin", eventType: "fynd_sync_failed",
              payloadJson: JSON.stringify({ action: "manual_retry", status: "crashed", error: crashMsg, errorType: classifyFyndError(crashMsg), adminEmail: sessionEmail }),
            },
          }).catch(() => {});
          fyndSyncCounter.add(1, { outcome: "error" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(crashMsg)}`);
        }

        const hasFyndId = fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId;
        if (fyndResult.success && (hasFyndId || fyndResult.alreadyExists)) {
          let payloadJson: string | null = null;
          try {
            payloadJson = fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
          } catch {
            payloadJson = null;
          }
          await prisma.returnCase.update({
            where: { id },
            data: {
              fyndReturnId: fyndResult.fyndReturnId ?? fyndResult.fyndShipmentId ?? null,
              fyndReturnNo: fyndResult.fyndReturnNo ?? null,
              fyndOrderId: fyndResult.fyndOrderId ?? null,
              fyndShipmentId: fyndResult.fyndShipmentId ?? null,
              ...(payloadJson != null && { fyndPayloadJson: payloadJson }),
              fyndSyncStatus: "synced",
              fyndSyncError: null,
              fyndSyncNextRetry: null,
              fyndSyncRetries: 0,
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "fynd_sync",
              payloadJson: JSON.stringify({
                action: "manual_retry",
                status: "success",
                fyndReturnId: fyndResult.fyndReturnId ?? null,
                fyndReturnNo: fyndResult.fyndReturnNo ?? null,
                fyndShipmentId: fyndResult.fyndShipmentId ?? null,
                alreadyExists: fyndResult.alreadyExists ?? false,
                durationMs: retryDurationMs,
                retryAttempt: (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0,
                adminEmail: sessionEmail,
              }),
            },
          });
          // Also create Shopify Return if not already created
          if (!returnCase.shopifyReturnId) {
            const retryOrderId = returnCase.shopifyOrderId;
            const canCreateReturn = retryOrderId
              && !retryOrderId.startsWith("manual:")
              && (retryOrderId.startsWith("gid://") || /^\d+$/.test(retryOrderId))
              && returnCase.isGreenReturn !== true;
            if (canCreateReturn) {
              try {
                const shopifyReturnResult = await createShopifyReturn(
                  admin, retryOrderId,
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
                  refundLogger.info({ shopifyReturnId: shopifyReturnResult.shopifyReturnId }, "[retry_fynd_sync] Also created Shopify Return");
                } else {
                  refundLogger.warn({ error: shopifyReturnResult.error }, "[retry_fynd_sync] Shopify Return creation failed (non-fatal)");
                }
              } catch (err) {
                refundLogger.warn({ err }, "[retry_fynd_sync] Shopify Return creation crashed (non-fatal)");
              }
            }
          }

          fyndSyncCounter.add(1, { outcome: "success" });
          addBusinessEvent("return.fynd_sync_completed", { "return.id": returnCase.id, "fynd.return_id": fyndResult.fyndReturnId || "", "sync.type": "manual_retry" });
          returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
          annotateSLO("api_latency_p99", { durationMs: elapsed() });

          const successParam = fyndResult.alreadyExists ? "already_exists" : "1";
          throw redirect(`/app/returns/${id}?fyndSuccess=${successParam}`);
        }
        const rawErr = fyndResult.error?.trim();
        const errMsg = enrichFyndError(
          rawErr || (fyndResult.success ? "Sync completed but Fynd did not return a return ID. Check Fynd dashboard." : "Unknown Fynd error")
        );
        // Update status on failure so the UI shows the error
        await prisma.returnCase.update({
          where: { id },
          data: { fyndSyncStatus: "failed", fyndSyncError: errMsg },
        }).catch(() => {});
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "fynd_sync_failed",
            payloadJson: JSON.stringify({
              action: "manual_retry",
              status: "failed",
              error: errMsg,
              errorType: classifyFyndError(errMsg),
              durationMs: retryDurationMs,
              retryAttempt: (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0,
              adminEmail: sessionEmail,
            }),
          },
        });

        fyndSyncCounter.add(1, { outcome: "error" });
        returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });

        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(errMsg)}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "retry_fynd_sync", outcome: "error" });
        appErrorCounter.add(1, { action: "retry_fynd_sync" });
        returnActionDuration.record(actionTimer(), { action: "retry_fynd_sync" });
        throw err;
      }
    });
  }

  if (actionType === "refresh_fynd_details") {
    return await withSpan("return.action.refresh_fynd_details", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "refresh_fynd_details",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
        if (!externalOrderId || returnCase.shopifyOrderId?.startsWith("manual:")) {
          returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("No order number. Refresh from Fynd requires a valid order number.")}`);
        }
        const settings = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
        const fyndResult = settings
          ? await createFyndClientOrError(settings, { requirePlatform: true })
          : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations." };
        if (!fyndResult.ok) {
          returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(fyndResult.error)}`);
        }
        const fyndClient = fyndResult.client;
        if (!("searchShipmentsByExternalOrderId" in fyndClient)) {
          returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("Refresh from Fynd requires Platform API. Configure in Settings → Integrations.")}`);
        }
        try {
          const searchRes = await fyndClient.searchShipmentsByExternalOrderId(externalOrderId, {
            searchType: "external_order_id",
            groupEntity: "shipments",
            pageNo: 1,
            pageSize: 20,
            // No fulfillmentType filter — fetch ALL shipments (forward + return)
            parentViewSlug: "all",
            childViewSlug: "all",
            sortType: "sla_asc",
          });
          const items = searchRes?.items ?? searchRes?.shipments ?? (searchRes as { data?: { items?: unknown[] } })?.data?.items ?? [];
          if (!Array.isArray(items) || items.length === 0) {
            throw new Error(`No shipments found for order ${externalOrderId}. Check order number and date range.`);
          }
          let payload: unknown = searchRes;
          let fyndOrderId = (searchRes as { orderId?: string; shipmentId?: string }).orderId ?? (searchRes as { orderId?: string; shipmentId?: string }).shipmentId ?? null;
          // Prefer full shipment details (with orderPrice, orderItems) from Platform API when available
          if (fyndOrderId && "getShipments" in fyndClient) {
            try {
              const fullShipments = await fyndClient.getShipments(fyndOrderId);
              if (fullShipments != null) {
                const fullList = Array.isArray(fullShipments)
                  ? fullShipments
                  : (fullShipments as { items?: unknown[] })?.items ?? (fullShipments as { shipments?: unknown[] })?.shipments ?? [];
                if (fullList.length > 0) {
                  payload = fullShipments;
                }
              }
            } catch {
              // Fall back to portal search result if getShipments fails
            }
          }
          const payloadJson = payload != null ? JSON.stringify(payload) : null;

          // Extract return shipment logistics and backfill returnLabelJson + returnAwb
          const returnLogisticsData: Record<string, unknown> = {};
          const allItems = Array.isArray(items) ? items as Record<string, unknown>[] : [];
          const returnShipment = allItems.find((s) => {
            const jt = String(s.journey_type ?? "").toLowerCase();
            const st = String(s.status ?? s.shipment_status ?? "").toLowerCase();
            return jt === "return" || st.startsWith("return_");
          });
          if (returnShipment) {
            const dp = (returnShipment.delivery_partner_details ?? returnShipment.dp_details ?? {}) as Record<string, unknown>;
            const meta = (returnShipment.meta ?? {}) as Record<string, unknown>;
            const inv = returnShipment.invoice as Record<string, unknown> | undefined;
            const invLinks = (inv?.links ?? {}) as Record<string, unknown>;
            const rCarrier = String(dp.display_name ?? dp.name ?? returnShipment.dp_name ?? meta.cp_name ?? "").trim() || null;
            const rAwbRaw = dp.awb_no ?? returnShipment.awb_no ?? meta.awb_no ?? meta.awb;
            const rAwb = typeof rAwbRaw === "string" && rAwbRaw.trim() ? rAwbRaw.trim() : null;
            const rTrackUrl = String(returnShipment.tracking_url ?? returnShipment.track_url ?? dp.track_url ?? dp.tracking_url ?? meta.tracking_url ?? "").trim() || null;
            const rLabelUrl = inv ? (String(inv.label_url ?? invLinks.label ?? "").trim() || null) : null;
            const rInvoiceUrl = inv ? (String(inv.invoice_url ?? invLinks.invoice_a4 ?? "").trim() || null) : null;
            if (rCarrier || rAwb || rTrackUrl || rLabelUrl) {
              returnLogisticsData.returnLabelJson = JSON.stringify({
                carrier: rCarrier, trackingNumber: rAwb, trackingUrl: rTrackUrl,
                labelUrl: rLabelUrl, invoiceUrl: rInvoiceUrl, source: "fynd_api_refresh",
              });
              if (rAwb) returnLogisticsData.returnAwb = rAwb;
            }
          }

          await prisma.returnCase.update({
            where: { id },
            data: { fyndPayloadJson: payloadJson ?? undefined, ...(fyndOrderId && { fyndOrderId }), ...returnLogisticsData },
          });

          returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
          annotateSLO("api_latency_p99", { durationMs: elapsed() });

          throw redirect(`/app/returns/${id}?fyndRefresh=1`);
        } catch (err) {
          // Re-throw redirect Responses (they're not errors)
          if (isRedirectResponse(err)) throw err;
          if (err instanceof Response) throw err;
          const rawMsg = await extractErrorMessage(err);
          const msg = enrichFyndError(rawMsg);
          returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
          throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(msg)}`);
        }
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
        appErrorCounter.add(1, { action: "refresh_fynd_details" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        throw err;
      }
    });
  }

  if (actionType === "reject") {
    return await withSpan("return.action.reject", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "reject",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (isTerminal) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json({ error: `Cannot reject: return is already ${returnCase.status}` }, { status: 400 });
        }
        const reason = (rejectionReason ?? "").trim();
        if (!reason) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json({ error: "Rejection reason is required. Please provide a reason to show the customer." }, { status: 400 });
        }
        if (reason.length > 500) {
          returnActionCounter.add(1, { action: "reject", outcome: "error" });
          return Response.json({ error: "Rejection reason is too long" }, { status: 400 });
        }
        await prisma.returnCase.update({
          where: { id },
          data: {
            status: "rejected",
            rejectionReason: reason,
            adminNotes: note || returnCase.adminNotes,
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "rejected",
            payloadJson: JSON.stringify({ rejectionReason: reason, note: note || null, adminEmail: sessionEmail }),
          },
        });
        // Decline the Shopify return
        await closeShopifyReturnBestEffort(admin, returnCase, {
          action: "decline",
          declineReason: reason,
          logEvent: logShopifyReturnEvent,
        });
        if (returnCase.customerEmailNorm) {
          try {
            await sendRejectionNotification({
              shopDomain: session.shop,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              rejectionReason: reason,
              shopName: session.shop?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[Reject] Notification failed");
          }
        }

        addBusinessEvent("return.rejected", { "return.id": returnCase.id, "rejection.reason": reason });
        returnsRejectedCounter.add(1);
        auditReturnAction("rejected", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: returnCase.status, to: "rejected" } });
        returnActionCounter.add(1, { action: "reject", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "reject" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "reject", outcome: "error" });
        appErrorCounter.add(1, { action: "reject" });
        returnActionDuration.record(actionTimer(), { action: "reject" });
        throw err;
      }
    });
  }

  if (actionType === "process_refund") {
    return await withSpan("return.action.process_refund", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "process_refund",
      "refund.method": bodyRefundMethod || "default",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json({ error: "Return must be approved before processing refund" }, { status: 400 });
        }
        if (returnCase.refundStatus === "refunded") {
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json({ error: "Refund has already been processed" }, { status: 400 });
        }
        if (returnCase.shopifyOrderId?.startsWith("manual:")) {
          const orderName = returnCase.shopifyOrderName ?? returnCase.shopifyOrderId?.replace(/^manual:/, "") ?? "—";
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json({
            error: `This is a manual return request. Process the refund in Shopify Admin for order ${orderName}.`,
          }, { status: 400 });
        }

        // Auto-clear pending cancellation request when admin chooses to refund instead
        if (returnCase.cancellationRequestedAt) {
          await prisma.returnCase.update({
            where: { id },
            data: { cancellationRequestedAt: null },
          });
        }

        // Fynd status gate: block refund if current Fynd status is not in the allowed list
        const isFyndIntegrated = !!(returnCase.fyndOrderId || returnCase.fyndShipmentId || returnCase.fyndReturnId);
        if (isFyndIntegrated) {
          let allowedFyndStatuses: string[] = [];
          try {
            const raw = shop.settings?.allowedFyndStatusesForRefund;
            if (raw) {
              const parsed = JSON.parse(raw) as unknown;
              if (Array.isArray(parsed) && parsed.length > 0) {
                allowedFyndStatuses = parsed.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
              }
            }
          } catch { /* malformed JSON — treat as feature disabled */ }

          if (allowedFyndStatuses.length > 0) {
            const currentFyndStatus = (returnCase.fyndCurrentStatus ?? "").toLowerCase().trim();
            if (!currentFyndStatus) {
              returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
              return Response.json({
                error: "Cannot process refund: Fynd shipment status has not been received yet. Wait for a Fynd webhook update or manually sync the return status before processing the refund.",
              }, { status: 400 });
            }
            if (!allowedFyndStatuses.includes(currentFyndStatus)) {
              const displayAllowed = allowedFyndStatuses.map((s) => `"${s}"`).join(", ");
              returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
              return Response.json({
                error: `Cannot process refund: current Fynd status "${returnCase.fyndCurrentStatus}" is not in the allowed list. Allowed statuses: ${displayAllowed}. Update the allowed statuses in Settings → Return Settings, or wait for the Fynd status to change.`,
              }, { status: 400 });
            }
          }
        }

        let orderIdForRefund = returnCase.shopifyOrderId;

        // Collect line items — ONLY trust IDs that are proper Shopify GIDs (gid://shopify/LineItem/...)
        // Bare numeric IDs could be Fynd bag IDs (e.g. "3777852") which are NOT Shopify line items
        const rawLineItems = (returnCase.items ?? [])
          .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
          .map((i) => ({ id: i.shopifyLineItemId, quantity: i.qty, sku: i.sku }));
        const hasValidLineItemIds = rawLineItems.length > 0 && rawLineItems.every(
          (li) => li.id.startsWith("gid://shopify/LineItem/")
        );
        let lineItemsForRefund: Array<{ id: string; quantity: number }> = hasValidLineItemIds
          ? rawLineItems.map((li) => ({ id: li.id, quantity: li.quantity }))
          : []; // Invalid IDs (Fynd bag IDs) — will be resolved from Shopify order below

        if (!hasValidLineItemIds && rawLineItems.length > 0) {
          refundLogger.info({ sampleId: rawLineItems[0]?.id }, "[refund] Line item IDs are not Shopify GIDs — will fetch from Shopify order");
        }

        // Helper: persist resolved Shopify order back to DB + fill line items by SKU match
        const applyResolvedOrder = async (shopifyOrder: { id: string; name?: string; lineItems?: Array<{ id: string; quantity: number; sku?: string | null }> }) => {
          orderIdForRefund = shopifyOrder.id;
          const updates: Record<string, string> = { shopifyOrderId: shopifyOrder.id };
          if (shopifyOrder.name && !returnCase.shopifyOrderName) updates.shopifyOrderName = shopifyOrder.name;
          await prisma.returnCase.update({ where: { id }, data: updates }).catch(() => { /* non-fatal */ });
          // Always replace line items from the Shopify order (match by SKU or use all)
          if (shopifyOrder.lineItems?.length) {
            const returnItems = returnCase.items ?? [];
            if (returnItems.length > 0 && returnItems.some((i) => i.sku)) {
              // Match by SKU
              const matched: Array<{ id: string; quantity: number }> = [];
              for (const ri of returnItems) {
                const riSku = (ri.sku ?? "").toLowerCase().trim();
                if (!riSku) continue;
                const shopifyLi = shopifyOrder.lineItems.find(
                  (li) => li.sku && li.sku.toLowerCase().trim() === riSku
                );
                if (shopifyLi) {
                  matched.push({ id: shopifyLi.id, quantity: ri.qty });
                }
              }
              if (matched.length > 0) {
                lineItemsForRefund = matched;
                refundLogger.info({ matchCount: matched.length }, "[refund] Matched line items by SKU");
              } else {
                // SKU match failed — use all Shopify line items
                lineItemsForRefund = shopifyOrder.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
                refundLogger.info({ count: lineItemsForRefund.length }, "[refund] SKU match failed, using all Shopify line items");
              }
            } else {
              lineItemsForRefund = shopifyOrder.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
            }
          }
        };

        const isGid = orderIdForRefund?.startsWith("gid://");
        const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
        refundLogger.info({ orderIdForRefund, isGid, isNumericId, shopifyOrderName: returnCase.shopifyOrderName ?? "" }, "[refund] resolving order");
        if (!isGid && !isNumericId && orderIdForRefund && !orderIdForRefund.startsWith("manual:")) {
          // shopifyOrderId is not a valid Shopify GID/numeric — resolve it
          let resolved = false;

          // Strategy 1: Try shopifyOrderName directly (may contain affiliate_order_id)
          if (!resolved && returnCase.shopifyOrderName) {
            const order = await fetchOrderByFyndAffiliateId(admin, returnCase.shopifyOrderName).catch((err) => {
              refundLogger.warn({ shopifyOrderName: returnCase.shopifyOrderName, err: err?.message ?? err }, "[refund] Strategy 1 failed");
              return null;
            });
            if (order?.id) { await applyResolvedOrder(order); resolved = true; }
          }

          // Strategy 2: Try shopifyOrderId as an order name (strip # prefix)
          if (!resolved) {
            const cleanedOrderId = (orderIdForRefund ?? "").replace(/^#/, "").trim();
            const order = await fetchOrderByFyndAffiliateId(admin, cleanedOrderId).catch((err) => {
              refundLogger.warn({ cleanedOrderId, err: err?.message ?? err }, "[refund] Strategy 2 failed");
              return null;
            });
            if (order?.id) { await applyResolvedOrder(order); resolved = true; }
          }

          // Strategy 3: Extract all candidate IDs from Fynd payload
          if (!resolved && (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson) {
            try {
              const fp = JSON.parse((returnCase as { fyndPayloadJson: string }).fyndPayloadJson) as Record<string, unknown>;
              const inner = (fp.payload ?? fp.shipment ?? fp) as Record<string, unknown>;
              const items = (inner.items ?? inner.shipments ?? []) as Record<string, unknown>[];
              const meta = (inner.meta ?? {}) as Record<string, unknown>;
              const orderObj = (inner.order ?? {}) as Record<string, unknown>;
              const candidateIds = [
                inner.affiliate_order_id, inner.external_order_id, inner.channel_order_id,
                meta.affiliate_order_id, meta.external_order_id, meta.channel_order_id,
                orderObj.affiliate_order_id, orderObj.external_order_id,
                items[0]?.affiliate_order_id, items[0]?.external_order_id,
                (items[0]?.order as Record<string, unknown> | undefined)?.affiliate_order_id,
              ];
              const seen = new Set<string>();
              for (const raw of candidateIds) {
                const cleaned = typeof raw === "string" ? raw.replace(/^#/, "").trim() : "";
                if (!cleaned || seen.has(cleaned)) continue;
                seen.add(cleaned);
                const shopifyOrder = await fetchOrderByFyndAffiliateId(admin, cleaned).catch((err) => {
                  refundLogger.warn({ candidate: cleaned, err: err?.message ?? err }, "[refund] Strategy 3 candidate failed");
                  return null;
                });
                if (shopifyOrder?.id) {
                  await applyResolvedOrder(shopifyOrder);
                  resolved = true;
                  break;
                }
              }
            } catch (err) {
              refundLogger.warn({ err }, "[refund] Strategy 3 (payload extraction) failed");
            }
          }

          if (!resolved) {
            const fyndOid = orderIdForRefund;
            await prisma.returnEvent.create({
              data: { returnCaseId: id, source: "admin", eventType: "refund_failed", payloadJson: JSON.stringify({ error: `Could not resolve Shopify order from "${fyndOid}"`, note: note || null }) },
            });
            const msg = `This return is linked to Fynd order ID "${fyndOid}" which could not be found in Shopify. ` +
              `Process the refund directly in Fynd or your ERP. ` +
              `You can mark this return as completed using the status update action.`;
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            returnActionDuration.record(actionTimer(), { action: "process_refund" });
            return Response.json({ error: msg }, { status: 400 });
          }
        }

        const createFailedEvent = async (errorMsg: string) => {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "refund_failed",
              payloadJson: JSON.stringify({ error: errorMsg, note: note || null }),
            },
          });
        };

        if (!orderIdForRefund) {
          const msg = "Could not determine Shopify order. Check that the return has a valid order.";
          await createFailedEvent(msg);
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "process_refund" });
          return Response.json({ error: msg }, { status: 400 });
        }

        if (lineItemsForRefund.length === 0) {
          refundLogger.info({ orderIdForRefund }, "[refund] lineItemsForRefund is empty, fetching Shopify order to resolve line items");
          // Use PCDA-safe minimal queries first — these don't request email/phone/addresses
          // so they work even without Protected Customer Data Access approval.
          let minimalOrder: { id: string; name: string; lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }> } | null = null;

          // Strategy 0 (PRIMARY — PCDA-safe): Fetch line items only via GID
          if (orderIdForRefund) {
            minimalOrder = await fetchOrderLineItemsOnly(admin, orderIdForRefund).catch((err) => {
              refundLogger.warn({ orderIdForRefund, err: (err as Error)?.message ?? err }, "[refund] fetchOrderLineItemsOnly failed");
              return null;
            });
            refundLogger.info({ strategy: "0", result: minimalOrder ? `found ${minimalOrder.lineItems.length} line items` : "no result" }, "[refund] PCDA-safe GID");
          }

          // Strategy 0b (PCDA-safe by name): If GID didn't work, try order name search
          if (!minimalOrder && returnCase.shopifyOrderName) {
            const orderName = returnCase.shopifyOrderName.replace(/^#/, "").trim();
            if (orderName) {
              minimalOrder = await fetchOrderLineItemsByName(admin, orderName).catch((err) => {
                refundLogger.warn({ orderName, err: (err as Error)?.message ?? err }, "[refund] fetchOrderLineItemsByName failed");
                return null;
              });
              refundLogger.info({ strategy: "0b", orderName, result: minimalOrder ? `found ${minimalOrder.lineItems.length} line items` : "no result" }, "[refund] PCDA-safe name");
              if (minimalOrder?.id && minimalOrder.id !== orderIdForRefund) {
                orderIdForRefund = minimalOrder.id;
                await prisma.returnCase.update({ where: { id }, data: { shopifyOrderId: minimalOrder.id } }).catch(() => {});
              }
            }
          }

          if (minimalOrder?.lineItems?.length) {
            const returnItems = returnCase.items ?? [];
            if (returnItems.length > 0 && returnItems.some((i: { sku?: string | null }) => i.sku)) {
              // Match by SKU to get correct quantities
              const matched: Array<{ id: string; quantity: number }> = [];
              for (const ri of returnItems) {
                const riSku = ((ri as { sku?: string | null }).sku ?? "").toLowerCase().trim();
                if (!riSku) continue;
                const shopifyLi = minimalOrder.lineItems.find(
                  (li) => li.sku && li.sku.toLowerCase().trim() === riSku
                );
                if (shopifyLi) matched.push({ id: shopifyLi.id, quantity: ri.qty });
              }
              lineItemsForRefund = matched.length > 0
                ? matched
                : minimalOrder.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
            } else {
              lineItemsForRefund = minimalOrder.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
            }
            refundLogger.info({ count: lineItemsForRefund.length }, "[refund] Resolved line items from PCDA-safe query");
          } else {
            // Fallback: try full queries (may fail due to PCDA, but worth trying)
            let order: Awaited<ReturnType<typeof fetchOrder>> = null;
            if (orderIdForRefund) {
              order = await fetchOrder(admin, orderIdForRefund).catch((err) => {
                refundLogger.warn({ orderIdForRefund, err: (err as Error)?.message ?? err }, "[refund] fetchOrder(full) failed");
                return null;
              });
              if (!order && returnCase.shopifyOrderName) {
                const orderName = returnCase.shopifyOrderName.replace(/^#/, "").trim();
                if (orderName) {
                  order = await fetchOrderByOrderNumber(admin, orderName).catch((err) => {
                    refundLogger.warn({ orderName, err: (err as Error)?.message ?? err }, "[refund] fetchOrderByOrderNumber failed");
                    return null;
                  });
                  if (order?.id && order.id !== orderIdForRefund) {
                    orderIdForRefund = order.id;
                    await prisma.returnCase.update({ where: { id }, data: { shopifyOrderId: order.id } }).catch(() => {});
                  }
                }
              }
            }
            if (order?.lineItems?.length) {
              lineItemsForRefund = order.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
              refundLogger.info({ count: lineItemsForRefund.length }, "[refund] Resolved line items from full query fallback");
            } else {
              refundLogger.error({ orderIdForRefund, shopifyOrderName: returnCase.shopifyOrderName }, "[refund] ALL order fetch strategies failed");
            }
          }
        }

        const bonusCreditEnabled = shop.settings?.bonusCreditEnabled ?? false;
        const bonusCreditPct = shop.settings?.bonusCreditPct ?? 10;
        const isGreenReturn = returnCase.isGreenReturn === true;

        if (bodyRefundMethod === "discount_code") {
          const prefix = shop.settings?.discountCodePrefix || "RETURN";
          const expiryDays = shop.settings?.discountCodeExpiryDays ?? 90;
          const returnRequestNo = (returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id.slice(0, 8).toUpperCase();

          const dcResult = await createDiscountCodeRefund(admin, {
            orderId: orderIdForRefund,
            lineItems: lineItemsForRefund,
            returnRequestNo,
            prefix,
            expiryDays,
            note: note || returnCase.adminNotes || undefined,
          });

          if (!dcResult.success) {
            const msg = dcResult.error ?? "Failed to create discount code.";
            await prisma.returnEvent.create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "refund_failed",
                payloadJson: JSON.stringify({ error: msg, method: "discount_code" }),
              },
            });
            refundCounter.add(1, { method: "discount_code", outcome: "error" });
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            returnActionDuration.record(actionTimer(), { action: "process_refund" });
            return Response.json({ error: msg }, { status: 400 });
          }

          const refundDetails = {
            method: "discount_code",
            discountCode: dcResult.discountCode,
            amount: dcResult.discountValue,
            currency: dcResult.discountCurrency,
            createdAt: new Date().toISOString(),
            source: "admin",
            expiryDays,
          };

          await prisma.returnCase.update({
            where: { id },
            data: {
              refundStatus: "refunded",
              refundJson: JSON.stringify(refundDetails),
              status: "completed",
              adminNotes: note || returnCase.adminNotes,
              discountCode: dcResult.discountCode,
              discountCodeValue: dcResult.discountValue,
            },
          });
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "refund_processed",
              payloadJson: JSON.stringify({ ...refundDetails, note: "Discount code refund created", adminEmail: sessionEmail }),
            },
          });
          // Close the Shopify return after discount code refund
          await closeShopifyReturnBestEffort(admin, returnCase, { logEvent: logShopifyReturnEvent });

          // Sync refund status to Fynd (push credit_note_generated) if enabled
          if (shop.settings?.syncRefundToFynd && returnCase.fyndShipmentId) {
            try {
              const fyndClientResult = await createFyndClientOrError(
                shop.settings as Parameters<typeof createFyndClientOrError>[0],
                { requirePlatform: true },
              );
              if (fyndClientResult.ok && "updateShipmentStatus" in fyndClientResult.client) {
                const fyndClient = fyndClientResult.client as import("../lib/fynd.server").FyndPlatformClient;
                const callId = returnCase.fyndOrderId || returnCase.fyndShipmentId;
                await fyndClient.updateShipmentStatus(callId, {
                  statuses: [{
                    shipments: [{ identifier: returnCase.fyndShipmentId }],
                    status: "credit_note_generated",
                  }],
                  task: false,
                  force_transition: false,
                  lock_after_transition: false,
                  unlock_before_transition: false,
                });
                refundLogger.info({ shipmentId: returnCase.fyndShipmentId }, "[process_refund] Fynd credit_note_generated synced (discount code)");
                await prisma.returnEvent.create({
                  data: { returnCaseId: id, source: "admin", eventType: "fynd_refund_synced", payloadJson: JSON.stringify({ status: "credit_note_generated", shipmentId: returnCase.fyndShipmentId, method: "discount_code" }) },
                }).catch(() => {});
              }
            } catch (fyndErr) {
              refundLogger.warn({ err: fyndErr }, "[process_refund] Fynd refund sync best-effort failed (discount code)");
              await prisma.returnEvent.create({
                data: { returnCaseId: id, source: "admin", eventType: "fynd_refund_sync_failed", payloadJson: JSON.stringify({ error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr), shipmentId: returnCase.fyndShipmentId }) },
              }).catch(() => {});
            }
          }

          if (returnCase.customerEmailNorm) {
            try {
              await sendRefundNotification({
                shopDomain: session.shop,
                to: returnCase.customerEmailNorm,
                orderName: returnCase.shopifyOrderName || "your order",
                amount: dcResult.discountValue,
                currency: dcResult.discountCurrency,
                shopName: session.shop?.replace(".myshopify.com", ""),
              });
            } catch (err) {
              refundLogger.warn({ err }, "[process_refund] Discount code notification failed");
            }
          }

          addBusinessEvent("return.refund_initiated", { "return.id": returnCase.id, "refund.amount": dcResult.discountValue ?? 0, "refund.method": "discount_code", "refund.currency": dcResult.discountCurrency || "" });
          refundCounter.add(1, { method: "discount_code", outcome: "success" });
          if (dcResult.discountValue) {
            refundAmountHistogram.record(Number(dcResult.discountValue), { currency: dcResult.discountCurrency || "USD", method: "discount_code" });
          }
          returnsCompletedCounter.add(1);
          auditReturnAction("refund_processed", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: returnCase.status, to: "completed" } }, { method: "discount_code", amount: dcResult.discountValue });
          returnActionCounter.add(1, { action: "process_refund", outcome: "success" });
          returnActionDuration.record(actionTimer(), { action: "process_refund" });
          annotateSLO("api_latency_p99", { durationMs: elapsed() });

          throw redirect(`/app/returns/${id}`);
        }

        // Validate storeCreditPct when method is "both" (percentage mode)
        if (bodyRefundMethod === "both" && bodySplitMode !== "amount") {
          const pct = Number(bodyStoreCreditPct ?? shop.settings?.refundStoreCreditPct ?? 50);
          if (isNaN(pct) || pct < 5 || pct > 95) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json({ error: "Store credit percentage must be between 5 and 95." }, { status: 400 });
          }
        }

        // Validate absolute amounts when splitMode is "amount"
        if (bodyRefundMethod === "both" && bodySplitMode === "amount") {
          const scAmt = Number(bodySplitScAmount);
          const origAmt = Number(bodySplitOrigAmount);
          if (isNaN(scAmt) || isNaN(origAmt) || scAmt < 0 || origAmt < 0) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json({ error: "Both store credit and original payment amounts must be non-negative numbers." }, { status: 400 });
          }
          if (scAmt === 0 && origAmt === 0) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json({ error: "At least one refund amount must be greater than zero." }, { status: 400 });
          }
        }

        let refundMethodCfg: RefundMethodConfig | null = null;
        if (bodyRefundMethod && ["original", "store_credit", "both"].includes(bodyRefundMethod)) {
          refundMethodCfg = {
            method: bodyRefundMethod as "original" | "store_credit" | "both",
            storeCreditPct: bodyStoreCreditPct,
            ...(bodySplitMode === "amount" ? {
              storeCreditAmount: Number(bodySplitScAmount),
              originalAmount: Number(bodySplitOrigAmount),
            } : {}),
          };
        } else {
          const settingsMethod = shop.settings?.refundPaymentMethod ?? "original";
          const settingsPct = shop.settings?.refundStoreCreditPct ?? 100;
          if (["original", "store_credit", "both"].includes(settingsMethod)) {
            refundMethodCfg = { method: settingsMethod as "original" | "store_credit" | "both", storeCreditPct: settingsPct };
          }
          const COD_RE = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
          if (orderIdForRefund && (orderIdForRefund.startsWith("gid://") || /^\d+$/.test(orderIdForRefund))) {
            try {
              const orderForCod = await fetchOrder(admin, orderIdForRefund);
              const isCod = (orderForCod?.paymentGatewayNames ?? []).some((g: string) => COD_RE.test(g))
                || orderForCod?.displayFinancialStatus === "PENDING";
              if (isCod && refundMethodCfg?.method === "original") {
                refundMethodCfg = { method: "store_credit" };
              }
            } catch { /* non-fatal; proceed with configured method */ }
          }
        }

        let bonusAmount = 0;
        if (bonusCreditEnabled && bodyBonusAmount != null && bodyBonusAmount > 0) {
          bonusAmount = bodyBonusAmount;
        } else if (bonusCreditEnabled && (refundMethodCfg?.method === "store_credit" || refundMethodCfg?.method === "both")) {
          const itemTotal = (returnCase.items ?? []).reduce((sum, it) => {
            return sum + (it.price ? parseFloat(it.price) * it.qty : 0);
          }, 0);
          if (itemTotal > 0) {
            bonusAmount = Math.round(itemTotal * (bonusCreditPct / 100) * 100) / 100;
          }
        }

        const skipLocation = isGreenReturn;
        const result = await createRefund(
          admin, orderIdForRefund, lineItemsForRefund,
          note || returnCase.adminNotes || undefined,
          isGreenReturn ? null : (requestedLocationId || undefined),
          refundMethodCfg,
          { bonusAmount, skipLocation },
        );
        if (!result.success) {
          const rawMsg = result.error ?? "Refund failed due to an unknown Shopify error. Check Shopify Admin.";
          const msg = enrichRefundError(rawMsg, { method: bodyRefundMethod, orderName: returnCase.shopifyOrderName });
          await createFailedEvent(msg);
          refundCounter.add(1, { method: refundMethodCfg?.method || "original", outcome: "error" });
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "process_refund" });
          return Response.json({ error: msg }, { status: 400 });
        }
        // Record which line items the refund actually covered. For partial refunds
        // this is the only audit trail showing what was paid out vs the broader
        // return scope — without it the admin can't answer "which items were
        // refunded?" without joining to the original refund mutation logs (P2
        // finding from QA audit).
        const refundedLineItems = (returnCase.items ?? [])
          .filter((it) => !!it.shopifyLineItemId && it.shopifyLineItemId !== "manual")
          .map((it) => ({
            id: it.shopifyLineItemId,
            sku: it.sku ?? null,
            qty: it.qty,
            // Snapshot of unit price at refund time (best-effort — Shopify computes
            // the actual refunded amount; this is the requested amount).
            unitPrice: it.price ?? null,
          }));
        const refundDetails = {
          refundId: result.refundId ?? null,
          amount: result.refundAmount ?? null,
          currency: result.refundCurrency ?? null,
          createdAt: result.refundCreatedAt ?? new Date().toISOString(),
          method: result.refundMethod ?? "original",
          source: "admin",
          locationId: requestedLocationId ?? null,
          refundedLineItems,
          ...(bonusAmount > 0 ? { bonusCreditAmount: bonusAmount.toFixed(2) } : {}),
          ...(isGreenReturn ? { greenReturn: true } : {}),
        };
        await prisma.returnCase.update({
          where: { id },
          data: {
            refundStatus: "refunded",
            refundJson: JSON.stringify(refundDetails),
            status: "completed",
            // Reconcile resolutionType with what actually happened. If the return was
            // approved as "exchange" but the admin processed a refund instead, we
            // need to flip the field — otherwise reports, customer comms, and the
            // exchange-flow gates downstream all see stale data (P1 finding).
            resolutionType: "refund",
            adminNotes: note || returnCase.adminNotes,
            ...(bonusAmount > 0 ? { bonusCreditAmount: bonusAmount.toFixed(2) } : {}),
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "refund_processed",
            payloadJson: JSON.stringify({
              ...refundDetails,
              note: "Refund created in Shopify",
              ...(bonusAmount > 0 ? { bonusCreditAmount: bonusAmount.toFixed(2), bonusCreditPct } : {}),
              adminEmail: sessionEmail,
            }),
          },
        });
        // Close the Shopify return after standard refund
        await closeShopifyReturnBestEffort(admin, returnCase, { logEvent: logShopifyReturnEvent });

        // Sync refund status to Fynd (push credit_note_generated) if enabled
        if (shop.settings?.syncRefundToFynd && returnCase.fyndShipmentId) {
          try {
            const fyndClientResult = await createFyndClientOrError(
              shop.settings as Parameters<typeof createFyndClientOrError>[0],
              { requirePlatform: true },
            );
            if (fyndClientResult.ok && "updateShipmentStatus" in fyndClientResult.client) {
              const fyndClient = fyndClientResult.client as import("../lib/fynd.server").FyndPlatformClient;
              const callId = returnCase.fyndOrderId || returnCase.fyndShipmentId;
              await fyndClient.updateShipmentStatus(callId, {
                statuses: [{
                  shipments: [{ identifier: returnCase.fyndShipmentId }],
                  status: "credit_note_generated",
                }],
                task: false,
                force_transition: false,
                lock_after_transition: false,
                unlock_before_transition: false,
              });
              refundLogger.info({ shipmentId: returnCase.fyndShipmentId }, "[process_refund] Fynd credit_note_generated synced");
              await prisma.returnEvent.create({
                data: { returnCaseId: id, source: "admin", eventType: "fynd_refund_synced", payloadJson: JSON.stringify({ status: "credit_note_generated", shipmentId: returnCase.fyndShipmentId }) },
              }).catch(() => {});
            }
          } catch (fyndErr) {
            refundLogger.warn({ err: fyndErr }, "[process_refund] Fynd refund sync best-effort failed");
            await prisma.returnEvent.create({
              data: { returnCaseId: id, source: "admin", eventType: "fynd_refund_sync_failed", payloadJson: JSON.stringify({ error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr), shipmentId: returnCase.fyndShipmentId }) },
            }).catch(() => {});
          }
        }

        if (returnCase.customerEmailNorm) {
          try {
            await sendRefundNotification({
              shopDomain: session.shop,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              shopName: session.shop?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[process_refund] Notification failed");
          }
        }

        const refundMethod = result.refundMethod ?? refundMethodCfg?.method ?? "original";
        addBusinessEvent("return.refund_initiated", { "return.id": returnCase.id, "refund.amount": result.refundAmount ?? 0, "refund.method": refundMethod, "refund.currency": result.refundCurrency || "" });
        refundCounter.add(1, { method: refundMethod, outcome: "success" });
        if (result.refundAmount) {
          refundAmountHistogram.record(Number(result.refundAmount), { currency: result.refundCurrency || "USD", method: refundMethod });
        }
        returnsCompletedCounter.add(1);
        auditReturnAction("refund_processed", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: returnCase.status, to: "completed" } }, { method: refundMethod, amount: result.refundAmount });
        returnActionCounter.add(1, { action: "process_refund", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "process_refund" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        const message = rawMessage || "Refund could not be processed. Please try again or process the refund manually in Shopify Admin.";
        refundLogger.error({ err, returnId: id }, "[process_refund] Error");
        try {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "refund_failed",
              payloadJson: JSON.stringify({ error: message, note: note || null }),
            },
          });
        } catch (logErr) {
          refundLogger.error({ err: logErr }, "[process_refund] Failed to log refund_failed event");
        }
        returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
        appErrorCounter.add(1, { action: "process_refund" });
        returnActionDuration.record(actionTimer(), { action: "process_refund" });
        return Response.json({ error: message }, { status: 500 });
      }
    });
  }

  if (actionType === "process_exchange") {
    return await withSpan("return.action.process_exchange", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "process_exchange",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Return must be approved before processing exchange" }, { status: 400 });
        }
        if (returnCase.exchangeOrderId) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Exchange order has already been created" }, { status: 400 });
        }
        if (returnCase.shopifyOrderId?.startsWith("manual:")) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Cannot create exchange for manual returns" }, { status: 400 });
        }

        // Fynd status gate: exchange order can only be created after bag is received at warehouse
        const FYND_EXCHANGE_ALLOWED_STATUSES = new Set([
          "return_bag_delivered", "return_accepted", "rto_bag_accepted", "deadstock",
          "refund_approved", "refund_initiated", "refund_completed", "return_completed",
          "deadstock_defective", "return_bag_lost", "rto_bag_delivered",
        ]);
        if (returnCase.fyndReturnId) {
          let fyndCurrentStatus: string | null = null;
          try {
            const payload = returnCase.fyndPayloadJson ? JSON.parse(returnCase.fyndPayloadJson) as Record<string, unknown> : null;
            fyndCurrentStatus = payload?.status ? String(payload.status) : null;
          } catch { /* ignore */ }
          if (fyndCurrentStatus && !FYND_EXCHANGE_ALLOWED_STATUSES.has(fyndCurrentStatus)) {
            returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
            return Response.json({
              error: `Exchange order can only be created after the return bag is received at the warehouse. Current Fynd status: "${fyndCurrentStatus}". Wait until the status is "return_bag_delivered" or later.`,
            }, { status: 400 });
          }
        }

        const order = returnCase.shopifyOrderId
          ? await fetchOrder(admin, returnCase.shopifyOrderId)
          : returnCase.shopifyOrderName
            ? await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim())
            : null;

        if (!order) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Could not fetch original order to create exchange" }, { status: 400 });
        }

        const customerEmail = order.email;
        if (!customerEmail) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Original order has no customer email - cannot create exchange draft order" }, { status: 400 });
        }

        const lineItemsForExchange = (returnCase.items ?? [])
          .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
          .map((item) => {
            const shopifyItem = (order.lineItems ?? []).find((li) =>
              li.id === item.shopifyLineItemId ||
              (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase())
            );
            return {
              title: item.title || shopifyItem?.title || item.sku || "Item",
              quantity: item.qty,
              originalUnitPrice: shopifyItem?.price || item.price || "0.00",
            };
          });

        if (lineItemsForExchange.length === 0) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "No line items available for exchange" }, { status: 400 });
        }

        const DRAFT_ORDER_CREATE = `#graphql
          mutation draftOrderCreate($input: DraftOrderInput!) {
            draftOrderCreate(input: $input) {
              draftOrder { id name }
              userErrors { field message }
            }
          }
        `;

        const draftInput = {
          email: customerEmail,
          note: `Exchange for return ${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id} (Order ${returnCase.shopifyOrderName || ""})`,
          lineItems: lineItemsForExchange.map((li) => ({
            title: li.title,
            quantity: li.quantity,
            originalUnitPrice: li.originalUnitPrice,
          })),
          ...(order.shippingAddress && {
            shippingAddress: {
              address1: order.shippingAddress.address1 || undefined,
              address2: order.shippingAddress.address2 || undefined,
              city: order.shippingAddress.city || undefined,
              province: order.shippingAddress.province || order.shippingAddress.provinceCode || undefined,
              country: order.shippingAddress.country || order.shippingAddress.countryCode || undefined,
              zip: order.shippingAddress.zip || undefined,
              firstName: order.shippingAddress.firstName || undefined,
              lastName: order.shippingAddress.lastName || undefined,
              phone: order.shippingAddress.phone || undefined,
            },
          }),
        };

        const draftRes = await admin.graphql(DRAFT_ORDER_CREATE, { variables: { input: draftInput } });
        const draftJson = (await draftRes.json()) as {
          data?: {
            draftOrderCreate?: {
              draftOrder?: { id: string; name: string } | null;
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
          errors?: Array<{ message: string }>;
        };

        // Top-level GraphQL errors (e.g. "Access denied for draftOrderCreate field. Required
        // access: 'write_draft_orders' access scope or 'write_quick_sale' access scope.")
        // are NOT surfaced via userErrors — handle them explicitly so merchants get a clear
        // remediation hint instead of a generic 500.
        if (Array.isArray(draftJson.errors) && draftJson.errors.length > 0) {
          const topErr = draftJson.errors.map((e) => e.message).join("; ");
          const scopeError = /access scope|write_draft_orders|write_quick_sale|access denied/i.test(topErr);
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({
            error: scopeError
              ? "This app needs the \"write_draft_orders\" permission to create an exchange order. Please reinstall the app or accept the updated permissions when prompted, then try again."
              : `Failed to create exchange draft order: ${topErr}`,
          }, { status: scopeError ? 403 : 400 });
        }

        const userErrors = draftJson.data?.draftOrderCreate?.userErrors ?? [];
        if (userErrors.length > 0) {
          const errMsg = userErrors.map((e) => e.message).join("; ");
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          // Detect the missing-scope error specifically and give the merchant an actionable
          // message rather than a raw GraphQL field-error string.
          const scopeError = /access scope|write_draft_orders|write_quick_sale|access denied/i.test(errMsg);
          const friendly = scopeError
            ? "This app needs the \"write_draft_orders\" permission to create an exchange order. Please reinstall the app or accept the updated permissions when prompted, then try again."
            : `Failed to create exchange draft order: ${errMsg}`;
          return Response.json({ error: friendly }, { status: 400 });
        }

        const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;
        if (!draftOrder?.id) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "Failed to create exchange draft order - no order returned" }, { status: 500 });
        }

        const exchangeItemsData = lineItemsForExchange.map((li) => ({
          title: li.title,
          quantity: li.quantity,
          price: li.originalUnitPrice,
        }));

        await prisma.returnCase.update({
          where: { id },
          data: {
            resolutionType: "exchange",
            exchangeOrderId: draftOrder.id,
            exchangeOrderName: draftOrder.name,
            exchangeItemsJson: JSON.stringify(exchangeItemsData),
          },
        });

        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "exchange_created",
            payloadJson: JSON.stringify({
              draftOrderId: draftOrder.id,
              draftOrderName: draftOrder.name,
              itemCount: exchangeItemsData.length,
              adminEmail: sessionEmail,
            }),
          },
        });
        // Close the Shopify return after exchange order creation
        await closeShopifyReturnBestEffort(admin, returnCase, { logEvent: logShopifyReturnEvent });

        if (returnCase.customerEmailNorm) {
          try {
            await sendApprovalNotification({
              shopDomain: session.shop,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              notes: `An exchange order (${draftOrder.name}) has been created for your return.`,
              shopName: session.shop?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[process_exchange] Notification failed");
          }
        }

        addBusinessEvent("return.exchange_created", { "return.id": returnCase.id, "exchange.order_id": draftOrder.id, "exchange.order_name": draftOrder.name, "exchange.item_count": exchangeItemsData.length });
        auditReturnAction("exchange_processed", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { resolutionType: { from: returnCase.resolutionType || "refund", to: "exchange" } }, { draftOrderId: draftOrder.id, draftOrderName: draftOrder.name });
        returnActionCounter.add(1, { action: "process_exchange", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "process_exchange" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        const message = rawMessage || "Exchange could not be processed. Please try again.";
        refundLogger.error({ err, returnId: id }, "[process_exchange] Error");
        try {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "exchange_failed",
              payloadJson: JSON.stringify({ error: message }),
            },
          });
        } catch (logErr) {
          refundLogger.error({ err: logErr }, "[process_exchange] Failed to log exchange_failed event");
        }
        returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
        appErrorCounter.add(1, { action: "process_exchange" });
        returnActionDuration.record(actionTimer(), { action: "process_exchange" });
        return Response.json({ error: message }, { status: 500 });
      }
    });
  }

  if (actionType === "update_label") {
    return await withSpan("return.action.update_label", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "update_label",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const carrier = (bodyCarrier ?? "").trim();
        const trackingNumber = (bodyTrackingNumber ?? "").trim();
        const labelUrl = (bodyLabelUrl ?? "").trim();
        const qrCodeUrl = (bodyQrCodeUrl ?? "").trim();

        const labelJson = JSON.stringify({
          carrier: carrier || null,
          trackingNumber: trackingNumber || null,
          labelUrl: labelUrl || null,
          qrCodeUrl: qrCodeUrl || null,
          adminEmail: sessionEmail,
        });

        await prisma.returnCase.update({
          where: { id },
          data: {
            returnLabelUrl: labelUrl || null,
            returnLabelJson: labelJson,
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "label_updated",
            payloadJson: labelJson,
          },
        });

        returnActionCounter.add(1, { action: "update_label", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "update_label" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "update_label", outcome: "error" });
        appErrorCounter.add(1, { action: "update_label" });
        returnActionDuration.record(actionTimer(), { action: "update_label" });
        throw err;
      }
    });
  }

  if (actionType === "update_instructions") {
    return await withSpan("return.action.update_instructions", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "update_instructions",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const instructions = (bodyReturnInstructions ?? "").trim();

        await prisma.shopSettings.upsert({
          where: { shopId: shop.id },
          create: { shopId: shop.id, defaultReturnInstructions: instructions || null },
          update: { defaultReturnInstructions: instructions || null },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "instructions_updated",
            payloadJson: JSON.stringify({ returnInstructions: instructions || null, adminEmail: sessionEmail }),
          },
        });

        returnActionCounter.add(1, { action: "update_instructions", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "update_instructions" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "update_instructions", outcome: "error" });
        appErrorCounter.add(1, { action: "update_instructions" });
        returnActionDuration.record(actionTimer(), { action: "update_instructions" });
        throw err;
      }
    });
  }

  // ── Approve customer cancellation request ──
  if (actionType === "approve_cancellation") {
    return await withSpan("return.action.approve_cancellation", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "approve_cancellation",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (returnCase.status.toLowerCase() !== "approved" || !returnCase.cancellationRequestedAt) {
          returnActionCounter.add(1, { action: "approve_cancellation", outcome: "error" });
          return Response.json(
            { error: "No pending cancellation request to approve" },
            { status: 400 },
          );
        }

        // Close Shopify Return BEFORE flipping our status. Previously the order was
        // (1) mark cancelled, (2) try to close on Shopify; if step 2 failed the
        // Shopify return stayed open forever with no auto-recovery (P1 finding).
        // Now we attempt the close first; on failure we keep the local status as
        // "approved" with a `shopifyCloseFailed` event so an admin can retry.
        const closeResult = await closeShopifyReturnBestEffort(admin, returnCase, {
          action: "close",
          logEvent: logShopifyReturnEvent,
        });
        const closeFailed = closeResult && typeof closeResult === "object" && "ok" in closeResult && closeResult.ok === false;
        if (closeFailed) {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "cancellation_blocked_by_shopify",
              payloadJson: JSON.stringify({
                reason: "Shopify return close failed; cancellation NOT applied locally so it can be retried.",
                error: (closeResult as { error?: string }).error ?? null,
                adminEmail: sessionEmail,
              }),
            },
          }).catch(() => {});
          returnActionCounter.add(1, { action: "approve_cancellation", outcome: "shopify_close_failed" });
          return Response.json({
            error: "Could not close the Shopify return. Cancellation has not been applied. Please retry, or close the Shopify return manually first.",
          }, { status: 502 });
        }

        await prisma.returnCase.update({
          where: { id },
          data: { status: "cancelled" },
        });

        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "cancellation_approved",
            payloadJson: JSON.stringify({
              reason: returnCase.cancellationReason || null,
              adminEmail: sessionEmail,
            }),
          },
        });

        // Best-effort Fynd cancel: trigger return_request_cancelled on Fynd
        const fyndReturnIdVal = returnCase.fyndReturnId;
        const fyndSyncStatus = (returnCase as unknown as { fyndSyncStatus?: string | null }).fyndSyncStatus;
        const fyndShipmentIdVal = returnCase.fyndShipmentId;
        const fyndOrderIdVal = returnCase.fyndOrderId;
        if ((fyndReturnIdVal || fyndSyncStatus === "synced") && fyndShipmentIdVal) {
          try {
            const settingsForCancel = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
            if (settingsForCancel) {
              const clientResult = await createFyndClientOrError(settingsForCancel, { requirePlatform: true });
              if (clientResult.ok && "updateShipmentStatus" in clientResult.client) {
                const fyndClient = clientResult.client as import("../lib/fynd.server").FyndPlatformClient;
                const cancelPayload = {
                  statuses: [
                    {
                      shipments: [{ identifier: fyndShipmentIdVal }],
                      status: "return_request_cancelled",
                    },
                  ],
                  task: false,
                  force_transition: false,
                  lock_after_transition: false,
                  unlock_before_transition: false,
                };
                const callId = fyndOrderIdVal || fyndShipmentIdVal;
                await fyndClient.updateShipmentStatus(callId, cancelPayload);
                refundLogger.info({ shipmentId: fyndShipmentIdVal }, "[approve_cancellation] Fynd return_request_cancelled sent");
              }
            }
          } catch (fyndErr) {
            refundLogger.warn({ err: fyndErr }, "[approve_cancellation] Fynd cancel best-effort failed");
            // Log event for audit trail but don't block cancellation
            await prisma.returnEvent.create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "fynd_cancel_failed",
                payloadJson: JSON.stringify({
                  error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr),
                  shipmentId: fyndShipmentIdVal,
                }),
              },
            }).catch(() => {});
          }
        }

        // Send cancellation confirmation email (fire-and-forget)
        if (returnCase.customerEmailNorm) {
          sendCancellationNotification({
            shopDomain: session.shop,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName,
            shopName: undefined,
            returnId: returnCase.returnRequestNo ?? returnCase.id,
            customerPhone: returnCase.customerPhoneNorm ?? null,
          }).catch((e) => refundLogger.warn({ err: e }, "[approve_cancellation] Notification failed"));
        }

        // Dispatch webhook (fire-and-forget)
        dispatchWebhookEvent(shop.id, "return.cancelled", {
          returnCaseId: id,
          returnRequestNo: returnCase.returnRequestNo,
          shopifyOrderName: returnCase.shopifyOrderName,
          previousStatus: "approved",
          cancelledBy: "admin_approved_customer_request",
          reason: returnCase.cancellationReason || null,
        });

        addBusinessEvent("return.cancellation_approved", { "return.id": returnCase.id });
        auditReturnAction("cancellation_approved", returnCase.id, shop.shopDomain, { type: "admin", identity: sessionEmail || "shop-admin" }, { status: { from: "approved", to: "cancelled" } });
        returnActionCounter.add(1, { action: "approve_cancellation", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "approve_cancellation" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        refundLogger.error({ err, returnId: id }, "[approve_cancellation] Error");
        returnActionCounter.add(1, { action: "approve_cancellation", outcome: "error" });
        appErrorCounter.add(1, { action: "approve_cancellation" });
        returnActionDuration.record(actionTimer(), { action: "approve_cancellation" });
        return Response.json({ error: rawMessage || "Failed to approve cancellation" }, { status: 500 });
      }
    });
  }

  // ── Decline customer cancellation request ──
  if (actionType === "decline_cancellation") {
    return await withSpan("return.action.decline_cancellation", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "decline_cancellation",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        if (returnCase.status.toLowerCase() !== "approved" || !returnCase.cancellationRequestedAt) {
          returnActionCounter.add(1, { action: "decline_cancellation", outcome: "error" });
          return Response.json(
            { error: "No pending cancellation request to decline" },
            { status: 400 },
          );
        }

        await prisma.returnCase.update({
          where: { id },
          data: {
            cancellationDeclinedAt: new Date(),
            cancellationDeclinedBy: sessionEmail,
            cancellationRequestedAt: null,
          },
        });

        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "cancellation_declined",
            payloadJson: JSON.stringify({
              reason: returnCase.cancellationReason || null,
              adminEmail: sessionEmail,
            }),
          },
        });

        // Send decline notification (fire-and-forget)
        if (returnCase.customerEmailNorm) {
          sendCancellationDeclinedNotification({
            shopDomain: session.shop,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName,
            shopName: undefined,
            returnId: returnCase.returnRequestNo ?? returnCase.id,
            customerPhone: returnCase.customerPhoneNorm ?? null,
          }).catch((e) => refundLogger.warn({ err: e }, "[decline_cancellation] Notification failed"));
        }

        addBusinessEvent("return.cancellation_declined", { "return.id": returnCase.id });
        returnActionCounter.add(1, { action: "decline_cancellation", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "decline_cancellation" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "decline_cancellation", outcome: "error" });
        appErrorCounter.add(1, { action: "decline_cancellation" });
        returnActionDuration.record(actionTimer(), { action: "decline_cancellation" });
        throw err;
      }
    });
  }

  if (actionType === "cancel_order") {
    return await withSpan("return.action.cancel_order", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "cancel_order",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const cancelReason = ((body as { cancelReason?: string }).cancelReason ?? "OTHER").toUpperCase();
        const validReasons = ["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"];
        if (!validReasons.includes(cancelReason)) {
          returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
          return Response.json({ error: `Invalid cancel reason: ${cancelReason}` }, { status: 400 });
        }
        const doRefundCancel = (body as { refund?: boolean }).refund !== false;
        const doRestock = (body as { restock?: boolean }).restock !== false;

        if (!returnCase.shopifyOrderId || returnCase.shopifyOrderId.startsWith("manual:")) {
          returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
          return Response.json({ error: "Cannot cancel: no valid Shopify order linked" }, { status: 400 });
        }

        let orderGid = returnCase.shopifyOrderId;
        if (!orderGid.startsWith("gid://")) {
          if (/^\d+$/.test(orderGid)) {
            orderGid = `gid://shopify/Order/${orderGid}`;
          } else {
            const orderByName = returnCase.shopifyOrderName
              ? await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim())
              : null;
            if (!orderByName?.id) {
              returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
              return Response.json({ error: "Could not resolve Shopify order for cancellation" }, { status: 400 });
            }
            orderGid = orderByName.id;
          }
        }

        const ORDER_CANCEL_MUTATION = `#graphql
          mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
            orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
              orderCancelUserErrors { field message }
            }
          }
        `;

        const cancelRes = await admin.graphql(ORDER_CANCEL_MUTATION, {
          variables: {
            orderId: orderGid,
            reason: cancelReason,
            refund: doRefundCancel,
            restock: doRestock,
          },
        });
        const cancelJson = (await cancelRes.json()) as {
          data?: {
            orderCancel?: {
              orderCancelUserErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
        };
        const cancelErrors = cancelJson.data?.orderCancel?.orderCancelUserErrors ?? [];
        if (cancelErrors.length > 0) {
          const errMsg = cancelErrors.map((e) => e.message).join("; ");
          returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
          return Response.json({ error: `Order cancellation failed: ${errMsg}` }, { status: 400 });
        }

        await prisma.returnCase.update({
          where: { id },
          data: {
            status: "cancelled",
            adminNotes: note || returnCase.adminNotes,
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "order_cancelled",
            payloadJson: JSON.stringify({
              orderId: orderGid,
              reason: cancelReason,
              refund: doRefundCancel,
              restock: doRestock,
              note: note || null,
              adminEmail: sessionEmail,
            }),
          },
        });

        addBusinessEvent("return.order_cancelled", { "return.id": returnCase.id, "order.id": orderGid, "cancel.reason": cancelReason });
        returnActionCounter.add(1, { action: "cancel_order", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "cancel_order" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        const message = rawMessage || "Order cancellation failed. Please try again or cancel manually in Shopify Admin.";
        refundLogger.error({ err, returnId: id }, "[cancel_order] Error");
        returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
        appErrorCounter.add(1, { action: "cancel_order" });
        returnActionDuration.record(actionTimer(), { action: "cancel_order" });
        return Response.json({ error: message }, { status: 500 });
      }
    });
  }

  if (actionType === "edit_details") {
    return await withSpan("return.action.edit_details", {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "edit_details",
    }, async (_span) => {
      const actionTimer = startTimer();
      try {
        const b = body as Record<string, unknown>;
        const trim = (v: unknown, max = 500) => typeof v === "string" ? v.trim().slice(0, max) || null : null;
        const updateData: Record<string, string | null> = {};
        if ("customerAddress1" in b) updateData.customerAddress1 = trim(b.customerAddress1);
        if ("customerAddress2" in b) updateData.customerAddress2 = trim(b.customerAddress2);
        if ("customerCity" in b) updateData.customerCity = trim(b.customerCity, 100);
        if ("customerProvince" in b) updateData.customerProvince = trim(b.customerProvince, 100);
        if ("customerZip" in b) updateData.customerZip = trim(b.customerZip, 20);
        if ("customerCountry" in b) updateData.customerCountry = trim(b.customerCountry, 100);
        if ("customerLandmark" in b) updateData.customerLandmark = trim(b.customerLandmark);
        await prisma.returnCase.update({ where: { id }, data: updateData });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "details_edited",
            payloadJson: JSON.stringify({ fields: Object.keys(updateData), adminEmail: sessionEmail }),
          },
        });

        returnActionCounter.add(1, { action: "edit_details", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "edit_details" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err) || err instanceof Response) throw err;
        returnActionCounter.add(1, { action: "edit_details", outcome: "error" });
        appErrorCounter.add(1, { action: "edit_details" });
        returnActionDuration.record(actionTimer(), { action: "edit_details" });
        throw err;
      }
    });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
