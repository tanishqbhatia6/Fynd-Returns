import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRefund, createDiscountCodeRefund, fetchOrder, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, withRestCredentials, type RefundMethodConfig } from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { sendRejectionNotification, sendApprovalNotification, sendRefundNotification, sendCustomerNoteNotification } from "../lib/notification.server";
import { extractShippingDetailsFromFyndPayload } from "../lib/fynd-payload.server";

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
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const id = params.id;
  if (!id) return Response.json({ error: "Return ID required" }, { status: 400 });

  const { session, admin: rawAdmin } = await authenticate.admin(request);
  // Attach REST credentials so order lookups can fall back to REST API (exact name match)
  const admin = withRestCredentials(rawAdmin, session.shop, session.accessToken ?? "");
  const sessionEmail = (session as unknown as { email?: string | null }).email ?? null;
  const shopWithSettings = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
  if (!shopWithSettings) return Response.json({ error: "Shop not found" }, { status: 404 });
  const shop = shopWithSettings;

  const returnCase = await prisma.returnCase.findFirst({
    where: { id, shopId: shop.id },
    include: { items: true },
  });
  if (!returnCase) return Response.json({ error: "Return not found" }, { status: 404 });

  const isTerminal = TERMINAL_STATUSES.includes(returnCase.status.toLowerCase());

  let body: { action: string; status?: string; note?: string; notesForCustomer?: string; refund?: boolean; rejectionReason?: string; locationId?: string; refundMethod?: string; storeCreditPct?: number; bonusAmount?: number; resolutionType?: string; exchangeItems?: Array<{ variantId: string; quantity: number }> };
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

  const { action: actionType, status: newStatus, note, notesForCustomer, refund: doRefund, rejectionReason, locationId: requestedLocationId, refundMethod: bodyRefundMethod, storeCreditPct: bodyStoreCreditPct, bonusAmount: bodyBonusAmount, resolutionType: bodyResolutionType, exchangeItems: bodyExchangeItems } = body;
  const { carrier: bodyCarrier, trackingNumber: bodyTrackingNumber, labelUrl: bodyLabelUrl, qrCodeUrl: bodyQrCodeUrl, returnInstructions: bodyReturnInstructions } = body as typeof body & { carrier?: string; trackingNumber?: string; labelUrl?: string; qrCodeUrl?: string; returnInstructions?: string };

  if (actionType === "update_status" && newStatus) {
    const validStatuses = ["pending", "processing", "in progress", "approved", "rejected", "completed", "cancelled", "initiated"];
    if (!validStatuses.includes(newStatus.toLowerCase())) {
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
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "add_note") {
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
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "save_notes_for_customer") {
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
      }).catch((e) => console.warn("[save_notes_for_customer] Notification failed:", e));
    }
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "approve") {
    if (isTerminal) {
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
          console.warn("[Approve] Consolidation notification failed:", err);
        }
      }
      throw redirect(`/app/returns/${id}?consolidationQueued=1`);
    }

    if (isGreenReturn) {
      console.log(`[Approve] Green return ${id} — skipping Fynd sync (no shipment needed)`);
    } else {
      const fyndClientResult = settingsForApprove
        ? await createFyndClientOrError(settingsForApprove, { requirePlatform: true })
        : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations and connect Fynd with Platform API to create returns on Fynd." };
      if (fyndClientResult.ok && "getShipments" in fyndClientResult.client) {
        const fyndClient = fyndClientResult.client;
        let affiliateOrderId: string | null = null;
        if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
          const order = returnCase.shopifyOrderId
            ? await fetchOrder(admin, returnCase.shopifyOrderId)
            : await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim());
          affiliateOrderId = order?.affiliateOrderId ?? null;
        }
        try {
          const fyndResult = await createReturnOnFynd(fyndClient, returnCase, {
            affiliateOrderId,
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
          if (fyndResult.success && fyndResult.fyndReturnId) {
            fyndReturnId = fyndResult.fyndReturnId;
            fyndReturnNo = fyndResult.fyndReturnNo ?? null;
            fyndOrderId = fyndResult.fyndOrderId ?? null;
            fyndShipmentId = fyndResult.fyndShipmentId ?? null;
            try {
              fyndPayloadJson = fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
            } catch {
              fyndPayloadJson = null;
            }
          } else if (fyndResult.error) {
            fyndError = enrichFyndError(fyndResult.error);
            console.warn("[Approve] Fynd create return failed:", fyndResult.error);
          }
        } catch (err) {
          fyndError = enrichFyndError(err instanceof Error ? err.message : String(err));
          console.warn("[Approve] Fynd error:", err);
        }
      } else if (!fyndClientResult.ok) {
        fyndError = fyndClientResult.error;
      } else {
        fyndError = "Fynd return creation requires Platform API (Company ID + Client ID/Secret). Configure in Settings → Integrations.";
      }
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
        if (shippingInfo.trackingNumber) autoShippingData.forwardAwb = shippingInfo.trackingNumber;
      }
    }

    await prisma.returnCase.update({
      where: { id },
      data: {
        status: "approved",
        resolutionType: resolvedType,
        adminNotes: note || returnCase.adminNotes,
        // Track Fynd sync lifecycle: processing = synced to Fynd, awaiting logistics assignment (AWB etc.)
        fyndSyncStatus: fyndReturnId ? "processing" : (fyndError ? "failed" : undefined),
        ...(fyndReturnId && { fyndReturnId }),
        ...(fyndReturnNo && { fyndReturnNo }),
        ...(fyndOrderId && { fyndOrderId }),
        ...(fyndShipmentId && { fyndShipmentId }),
        ...(fyndPayloadJson != null && { fyndPayloadJson }),
        ...autoShippingData,
      },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: id,
        source: "admin",
        eventType: "approved",
        payloadJson: JSON.stringify({
          note: note || null,
          resolutionType: resolvedType,
          fyndReturnId: fyndReturnId || null,
          fyndReturnNo: fyndReturnNo || null,
          adminEmail: sessionEmail,
        }),
      },
    });

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
        console.warn("[Approve] Notification failed:", err);
      }
    }
    const redirectUrl = fyndError
      ? `/app/returns/${id}?fyndError=${encodeURIComponent(fyndError)}`
      : fyndReturnId
        ? `/app/returns/${id}?fyndProcessing=1`
        : `/app/returns/${id}`;
    throw redirect(redirectUrl);
  }

  if (actionType === "retry_fynd_sync") {
    if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
      return Response.json({ error: "Return must be approved first" }, { status: 400 });
    }
    if (returnCase.fyndReturnId) {
      throw redirect(`/app/returns/${id}?fyndSuccess=already_synced`);
    }
    const settingsRetry = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
    const fyndRetryResult = settingsRetry
      ? await createFyndClientOrError(settingsRetry, { requirePlatform: true })
      : { ok: false as const, error: "Fynd is not configured. Configure Fynd with Platform API in Settings → Integrations." };
    if (!fyndRetryResult.ok) {
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(fyndRetryResult.error)}`);
    }
    const fyndClient = fyndRetryResult.client;
    if (!("getShipments" in fyndClient)) {
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("Sync to Fynd requires Platform API. Switch to Platform in Settings → Integrations.")}`);
    }
    let affiliateOrderId: string | null = null;
    if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
      const order = returnCase.shopifyOrderId
        ? await fetchOrder(admin, returnCase.shopifyOrderId)
        : await fetchOrderByOrderNumber(admin, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim());
      affiliateOrderId = order?.affiliateOrderId ?? null;
    }
    const fyndResult = await createReturnOnFynd(fyndClient, returnCase, {
      affiliateOrderId,
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
        },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "fynd_sync",
          payloadJson: JSON.stringify({
            fyndReturnId: fyndResult.fyndReturnId,
            fyndReturnNo: fyndResult.fyndReturnNo ?? null,
            alreadyExists: fyndResult.alreadyExists ?? false,
            adminEmail: sessionEmail,
          }),
        },
      });
      const successParam = fyndResult.alreadyExists ? "already_exists" : "1";
      throw redirect(`/app/returns/${id}?fyndSuccess=${successParam}`);
    }
    const rawErr = fyndResult.error?.trim();
    const errMsg = enrichFyndError(
      rawErr || (fyndResult.success ? "Sync completed but Fynd did not return a return ID. Check Fynd dashboard." : "Unknown Fynd error")
    );
    throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(errMsg)}`);
  }

  if (actionType === "refresh_fynd_details") {
    const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
    if (!externalOrderId || returnCase.shopifyOrderId?.startsWith("manual:")) {
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("No order number. Refresh from Fynd requires a valid order number.")}`);
    }
    const settings = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
    const fyndResult = settings
      ? await createFyndClientOrError(settings, { requirePlatform: true })
      : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations." };
    if (!fyndResult.ok) {
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(fyndResult.error)}`);
    }
    const fyndClient = fyndResult.client;
    if (!("searchShipmentsByExternalOrderId" in fyndClient)) {
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("Refresh from Fynd requires Platform API. Configure in Settings → Integrations.")}`);
    }
    try {
      const searchRes = await fyndClient.searchShipmentsByExternalOrderId(externalOrderId, {
        searchType: "external_order_id",
        groupEntity: "shipments",
        pageNo: 1,
        pageSize: 10,
        fulfillmentType: "FULFILLMENT",
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
      await prisma.returnCase.update({
        where: { id },
        data: { fyndPayloadJson: payloadJson ?? undefined, ...(fyndOrderId && { fyndOrderId }) },
      });
      throw redirect(`/app/returns/${id}?fyndRefresh=1`);
    } catch (err) {
      // Re-throw redirect Responses (they're not errors)
      if (isRedirectResponse(err)) throw err;
      if (err instanceof Response) throw err;
      const rawMsg = await extractErrorMessage(err);
      const msg = enrichFyndError(rawMsg);
      throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(msg)}`);
    }
  }

  if (actionType === "reject") {
    if (isTerminal) {
      return Response.json({ error: `Cannot reject: return is already ${returnCase.status}` }, { status: 400 });
    }
    const reason = (rejectionReason ?? "").trim();
    if (!reason) {
      return Response.json({ error: "Rejection reason is required. Please provide a reason to show the customer." }, { status: 400 });
    }
    if (reason.length > 500) {
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
        console.warn("[Reject] Notification failed:", err);
      }
    }
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "process_refund") {
    try {
      if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
        return Response.json({ error: "Return must be approved before processing refund" }, { status: 400 });
      }
      if (returnCase.refundStatus === "refunded") {
        return Response.json({ error: "Refund has already been processed" }, { status: 400 });
      }
      if (returnCase.shopifyOrderId?.startsWith("manual:")) {
        const orderName = returnCase.shopifyOrderName ?? returnCase.shopifyOrderId?.replace(/^manual:/, "") ?? "—";
        return Response.json({
          error: `This is a manual return request. Process the refund in Shopify Admin for order ${orderName}.`,
        }, { status: 400 });
      }

      let orderIdForRefund = returnCase.shopifyOrderId;
      let lineItemsForRefund: Array<{ id: string; quantity: number }> = (returnCase.items ?? [])
        .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
        .map((i) => ({ id: i.shopifyLineItemId, quantity: i.qty }));

      // Helper: persist resolved Shopify order back to DB + fill line items
      const applyResolvedOrder = async (shopifyOrder: { id: string; name?: string; lineItems?: Array<{ id: string; quantity: number }> }) => {
        orderIdForRefund = shopifyOrder.id;
        const updates: Record<string, string> = { shopifyOrderId: shopifyOrder.id };
        if (shopifyOrder.name && !returnCase.shopifyOrderName) updates.shopifyOrderName = shopifyOrder.name;
        await prisma.returnCase.update({ where: { id }, data: updates }).catch(() => { /* non-fatal */ });
        if (lineItemsForRefund.length === 0 && shopifyOrder.lineItems?.length) {
          lineItemsForRefund = shopifyOrder.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
        }
      };

      const isGid = orderIdForRefund?.startsWith("gid://");
      const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
      if (!isGid && !isNumericId && orderIdForRefund && !orderIdForRefund.startsWith("manual:")) {
        // shopifyOrderId is not a valid Shopify GID/numeric — resolve it
        // Strip fynd: prefix if present (marks Fynd internal IDs that need resolution)
        let resolved = false;

        // Strategy 1: Try shopifyOrderName directly (may contain affiliate_order_id)
        if (!resolved && returnCase.shopifyOrderName) {
          const order = await fetchOrderByFyndAffiliateId(admin, returnCase.shopifyOrderName).catch((err) => {
            console.warn(`[refund] Strategy 1 (shopifyOrderName="${returnCase.shopifyOrderName}") failed:`, err?.message ?? err);
            return null;
          });
          if (order?.id) { await applyResolvedOrder(order); resolved = true; }
        }

        // Strategy 2: Try shopifyOrderId as a Fynd affiliate_order_id (strip Fynd/fynd: prefixes)
        if (!resolved) {
          const cleanedOrderId = (orderIdForRefund ?? "").replace(/^fynd:/, "");
          const order = await fetchOrderByFyndAffiliateId(admin, cleanedOrderId).catch((err) => {
            console.warn(`[refund] Strategy 2 (cleanedOrderId="${cleanedOrderId}") failed:`, err?.message ?? err);
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
                console.warn(`[refund] Strategy 3 (candidate="${cleaned}") failed:`, err?.message ?? err);
                return null;
              });
              if (shopifyOrder?.id) {
                await applyResolvedOrder(shopifyOrder);
                resolved = true;
                break;
              }
            }
          } catch (err) {
            console.warn("[refund] Strategy 3 (payload extraction) failed:", err);
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
        return Response.json({ error: msg }, { status: 400 });
      }

      if (lineItemsForRefund.length === 0) {
        const order = orderIdForRefund ? await fetchOrder(admin, orderIdForRefund).catch(() => null) : null;
        if (order?.lineItems?.length) {
          lineItemsForRefund = order.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
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
            console.warn("[process_refund] Discount code notification failed:", err);
          }
        }
        throw redirect(`/app/returns/${id}`);
      }

      // Validate storeCreditPct when method is "both"
      if (bodyRefundMethod === "both") {
        const pct = Number(bodyStoreCreditPct ?? shop.settings?.refundStoreCreditPct ?? 50);
        if (isNaN(pct) || pct < 5 || pct > 95) {
          return Response.json({ error: "Store credit percentage must be between 5 and 95." }, { status: 400 });
        }
      }

      let refundMethodCfg: RefundMethodConfig | null = null;
      if (bodyRefundMethod && ["original", "store_credit", "both"].includes(bodyRefundMethod)) {
        refundMethodCfg = { method: bodyRefundMethod as "original" | "store_credit" | "both", storeCreditPct: bodyStoreCreditPct };
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
        return Response.json({ error: msg }, { status: 400 });
      }
      const refundDetails = {
        refundId: result.refundId ?? null,
        amount: result.refundAmount ?? null,
        currency: result.refundCurrency ?? null,
        createdAt: result.refundCreatedAt ?? new Date().toISOString(),
        method: result.refundMethod ?? "original",
        source: "admin",
        locationId: requestedLocationId ?? null,
        ...(bonusAmount > 0 ? { bonusCreditAmount: bonusAmount.toFixed(2) } : {}),
        ...(isGreenReturn ? { greenReturn: true } : {}),
      };
      await prisma.returnCase.update({
        where: { id },
        data: {
          refundStatus: "refunded",
          refundJson: JSON.stringify(refundDetails),
          status: "completed",
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

      if (returnCase.customerEmailNorm) {
        try {
          await sendRefundNotification({
            shopDomain: session.shop,
            to: returnCase.customerEmailNorm,
            orderName: returnCase.shopifyOrderName || "your order",
            shopName: session.shop?.replace(".myshopify.com", ""),
          });
        } catch (err) {
          console.warn("[process_refund] Notification failed:", err);
        }
      }
      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err)) throw err;
      if (err instanceof Response) throw err;
      const rawMessage = await extractErrorMessage(err);
      const message = rawMessage || "Refund could not be processed. Please try again or process the refund manually in Shopify Admin.";
      console.error("[process_refund] Error:", err);
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
        console.error("[process_refund] Failed to log refund_failed event:", logErr);
      }
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (actionType === "process_exchange") {
    try {
      if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
        return Response.json({ error: "Return must be approved before processing exchange" }, { status: 400 });
      }
      if (returnCase.exchangeOrderId) {
        return Response.json({ error: "Exchange order has already been created" }, { status: 400 });
      }
      if (returnCase.shopifyOrderId?.startsWith("manual:")) {
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
        return Response.json({ error: "Could not fetch original order to create exchange" }, { status: 400 });
      }

      const customerEmail = order.email;
      if (!customerEmail) {
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
      };

      const userErrors = draftJson.data?.draftOrderCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        const errMsg = userErrors.map((e) => e.message).join("; ");
        return Response.json({ error: `Failed to create exchange draft order: ${errMsg}` }, { status: 400 });
      }

      const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;
      if (!draftOrder?.id) {
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
          console.warn("[process_exchange] Notification failed:", err);
        }
      }

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err)) throw err;
      if (err instanceof Response) throw err;
      const rawMessage = await extractErrorMessage(err);
      const message = rawMessage || "Exchange could not be processed. Please try again.";
      console.error("[process_exchange] Error:", err);
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
        console.error("[process_exchange] Failed to log exchange_failed event:", logErr);
      }
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (actionType === "update_label") {
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
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "update_instructions") {
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
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "cancel_order") {
    try {
      const cancelReason = ((body as { cancelReason?: string }).cancelReason ?? "OTHER").toUpperCase();
      const validReasons = ["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"];
      if (!validReasons.includes(cancelReason)) {
        return Response.json({ error: `Invalid cancel reason: ${cancelReason}` }, { status: 400 });
      }
      const doRefundCancel = (body as { refund?: boolean }).refund !== false;
      const doRestock = (body as { restock?: boolean }).restock !== false;

      if (!returnCase.shopifyOrderId || returnCase.shopifyOrderId.startsWith("manual:")) {
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

      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (isRedirectResponse(err)) throw err;
      if (err instanceof Response) throw err;
      const rawMessage = await extractErrorMessage(err);
      const message = rawMessage || "Order cancellation failed. Please try again or cancel manually in Shopify Admin.";
      console.error("[cancel_order] Error:", err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (actionType === "edit_details") {
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
    throw redirect(`/app/returns/${id}`);
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
