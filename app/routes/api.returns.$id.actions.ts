import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createRefund,
  createShopifyReturn,
  closeShopifyReturnBestEffort,
  fetchOrder,
  fetchOrderByGid,
  fetchOrderByOrderNumber,
  fetchOrderByFyndAffiliateId,
  fetchOrderLineItemsOnly,
  fetchOrderLineItemsByName,
  withRestCredentials,
  fetchVariantInfo,
  sendDraftOrderInvoice,
  type RefundMethodConfig,
  type ShopifyVariantInfo,
} from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import {
  sendRejectionNotification,
  sendApprovalNotification,
  sendRefundNotification,
  sendCustomerNoteNotification,
  sendCancellationNotification,
  sendCancellationDeclinedNotification,
} from "../lib/notification.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import { extractShippingDetailsFromFyndPayload, isLikelyFyndId } from "../lib/fynd-payload.server";
import { scheduleRetry } from "../lib/fynd-retry.server";
import {
  withSpan,
  addBusinessEvent,
  startTimer,
  setSpanAttributes,
} from "../lib/observability/tracing.server";
import { refundLogger } from "../lib/observability/logger.server";
import {
  returnActionCounter,
  returnActionDuration,
  refundCounter,
  refundAmountHistogram,
  fyndSyncCounter,
  returnsApprovedCounter,
  returnsRejectedCounter,
  returnsCompletedCounter,
  appErrorCounter,
} from "../lib/observability/metrics.server";
import { auditReturnAction } from "../lib/observability/audit.server";
import { annotateSLO } from "../lib/observability/slo.server";
import { setRequestContext } from "../lib/observability/request-context.server";
import {
  enrichFyndError,
  classifyFyndError,
  enrichRefundError,
  isRedirectResponse,
  extractErrorMessage,
} from "../lib/return-action-errors.server";
import {
  handleAddNote,
  handleSaveNotesForCustomer,
  handleUpdateLabel,
  handleUpdateInstructions,
  handleEditDetails,
  handleUpdateStatus,
  handleCancelOrder,
  handleReject,
  handleDeclineCancellation,
  handleRetryFyndSync,
  handleApproveCancellation,
  handleApprove,
  handleRefreshFyndDetails,
  handleProcessReplacement,
  handleProcessExchange,
  handleProcessRefund,
  type ReturnHandlerContext,
  type ReturnActionBody,
} from "../lib/return-actions";

const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const elapsed = startTimer();

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const id = params.id;
  if (!id) return Response.json({ error: "Return ID required" }, { status: 400 });

  const { session, admin: rawAdmin } = await authenticate.admin(request);
  // Attach REST credentials so order lookups can fall back to REST API (exact name match)
  /* v8 ignore start - defensive nullish fallbacks on session fields */
  const sessionAccessToken = session.accessToken ?? "";
  refundLogger.info(
    {
      shop: session.shop,
      hasAccessToken: !!sessionAccessToken,
      tokenLength: sessionAccessToken.length,
    },
    "[actions] authenticated",
  );
  const admin = withRestCredentials(rawAdmin, session.shop, sessionAccessToken);
  const sessionEmail = (session as unknown as { email?: string | null }).email ?? null;
  /* v8 ignore stop */
  const shopWithSettings = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
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
  /* v8 ignore start - thin closure passed to extracted handlers (covered in handler-level tests) */
  const logShopifyReturnEvent = async (evt: { eventType: string; payloadJson: string }) => {
    await prisma.returnEvent
      .create({ data: { returnCaseId: id, source: "admin", ...evt } })
      .catch(() => {});
  };
  /* v8 ignore stop */

  let body: {
    action: string;
    status?: string;
    note?: string;
    notesForCustomer?: string;
    refund?: boolean;
    rejectionReason?: string;
    locationId?: string;
    refundMethod?: string;
    storeCreditPct?: number;
    bonusAmount?: number;
    resolutionType?: string;
    exchangeItems?: Array<{ variantId: string; quantity: number }>;
    splitMode?: string;
    splitScAmount?: number;
    splitOrigAmount?: number;
  };
  /* v8 ignore start - defensive nullish fallback on header */
  const contentType = request.headers.get("content-type") || "";
  /* v8 ignore stop */
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
        /* v8 ignore start - defensive fallback when both jsonStr.parse and actionVal are null */
        body = { action: actionVal || "unknown" };
        /* v8 ignore stop */
      }
    } else {
      /* v8 ignore start - defensive fallback when actionVal is null */
      body = { action: actionVal || "unknown" };
      /* v8 ignore stop */
    }
    if (noteVal !== null && noteVal !== undefined) body.note = noteVal;
    if (notesForCustomerVal !== null && notesForCustomerVal !== undefined)
      body.notesForCustomer = notesForCustomerVal;
    if (rejectionReasonVal !== null && rejectionReasonVal !== undefined)
      body.rejectionReason = rejectionReasonVal;
    // Address fields for edit_details
    const addrFields = [
      "customerAddress1",
      "customerAddress2",
      "customerCity",
      "customerProvince",
      "customerZip",
      "customerCountry",
      "customerLandmark",
    ] as const;
    for (const field of addrFields) {
      const val = formData.get(field) as string | null;
      if (val !== null) (body as Record<string, unknown>)[field] = val;
    }
  }

  const {
    action: actionType,
    status: newStatus,
    note,
    notesForCustomer,
    refund: doRefund,
    rejectionReason,
    locationId: requestedLocationId,
    refundMethod: bodyRefundMethod,
    storeCreditPct: bodyStoreCreditPct,
    bonusAmount: bodyBonusAmount,
    resolutionType: bodyResolutionType,
    exchangeItems: bodyExchangeItems,
    splitMode: bodySplitMode,
    splitScAmount: bodySplitScAmount,
    splitOrigAmount: bodySplitOrigAmount,
  } = body;
  const {
    carrier: bodyCarrier,
    trackingNumber: bodyTrackingNumber,
    labelUrl: bodyLabelUrl,
    qrCodeUrl: bodyQrCodeUrl,
    returnInstructions: bodyReturnInstructions,
  } = body as typeof body & {
    carrier?: string;
    trackingNumber?: string;
    labelUrl?: string;
    qrCodeUrl?: string;
    returnInstructions?: string;
  };

  // Shared context for extracted handlers. Built once per request.
  const handlerCtx: ReturnHandlerContext = {
    id,
    returnCase,
    shop,
    admin: admin as never,
    shopDomain: session.shop,
    sessionEmail,
    isTerminal,
    elapsed,
    logShopifyReturnEvent,
  };
  const handlerBody = body as ReturnActionBody;

  if (actionType === "update_status" && newStatus)
    return await handleUpdateStatus(handlerCtx, handlerBody);

  if (actionType === "add_note") return await handleAddNote(handlerCtx, handlerBody);

  if (actionType === "save_notes_for_customer")
    return await handleSaveNotesForCustomer(handlerCtx, handlerBody);

  if (actionType === "approve") return await handleApprove(handlerCtx, handlerBody);

  if (actionType === "retry_fynd_sync") return await handleRetryFyndSync(handlerCtx, handlerBody);

  /* v8 ignore start - thin dispatcher delegating to extracted handlers (covered in handler-level tests) */
  if (actionType === "refresh_fynd_details")
    return await handleRefreshFyndDetails(handlerCtx, handlerBody);
  /* v8 ignore stop */

  if (actionType === "reject") return await handleReject(handlerCtx, handlerBody);

  /* v8 ignore start - thin dispatcher delegating to extracted handlers (covered in handler-level tests) */
  if (actionType === "process_refund") return await handleProcessRefund(handlerCtx, handlerBody);

  if (actionType === "process_exchange")
    return await handleProcessExchange(handlerCtx, handlerBody);

  if (actionType === "process_replacement")
    return await handleProcessReplacement(handlerCtx, handlerBody);
  /* v8 ignore stop */

  if (actionType === "update_label") return await handleUpdateLabel(handlerCtx, handlerBody);

  if (actionType === "update_instructions")
    return await handleUpdateInstructions(handlerCtx, handlerBody);

  // ── Approve customer cancellation request ──
  if (actionType === "approve_cancellation")
    return await handleApproveCancellation(handlerCtx, handlerBody);

  // ── Decline customer cancellation request ──
  if (actionType === "decline_cancellation")
    return await handleDeclineCancellation(handlerCtx, handlerBody);

  if (actionType === "cancel_order") return await handleCancelOrder(handlerCtx, handlerBody);

  if (actionType === "edit_details") return await handleEditDetails(handlerCtx, handlerBody);

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
