import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRefund, fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { sendRejectionNotification, sendApprovalNotification, sendRefundNotification } from "../lib/notification.server";

function enrichFyndError(msg: string): string {
  if (!msg) return msg;
  const is403 = /403|forbidden/i.test(msg);
  const hasGuidance = /company\/orders|scopes|Fynd Partners|Settings.*Integrations|Test Platform/i.test(msg);
  if (is403 && !hasGuidance) {
    return `${msg} — Sync uses the same OAuth flow as Test Platform. If Test Platform passes in Settings → Integrations but sync still fails, the write endpoint may require additional permissions—contact Fynd support.`;
  }
  return msg;
}

function isRedirectResponse(err: unknown): boolean {
  if (err instanceof Response) {
    return err.status >= 300 && err.status < 400;
  }
  return false;
}

async function extractErrorMessage(err: unknown): Promise<string> {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "ok" in err && typeof (err as Response).json === "function") {
    const res = err as Response;
    try {
      const j = await res.json().catch(() => ({}));
      const msg = (j as { error?: string; message?: string })?.error ?? (j as { error?: string; message?: string })?.message;
      if (typeof msg === "string" && msg.trim()) return msg;
    } catch {
      /* ignore */
    }
    return `Request failed (${res.status}). Please check Fynd configuration and try again.`;
  }
  const s = String(err);
  if (s === "[object Response]" || s === "[object Object]") return "Request failed. Please check Fynd configuration and try again.";
  return s;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const id = params.id;
  if (!id) return Response.json({ error: "Return ID required" }, { status: 400 });

  const { session, admin } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const returnCase = await prisma.returnCase.findFirst({
    where: { id, shopId: shop.id },
    include: { items: true },
  });
  if (!returnCase) return Response.json({ error: "Return not found" }, { status: 404 });

  const terminalStatuses = ["approved", "rejected", "completed", "cancelled"];
  const isTerminal = terminalStatuses.includes(returnCase.status.toLowerCase());

  let body: { action: string; status?: string; note?: string; notesForCustomer?: string; refund?: boolean; rejectionReason?: string; locationId?: string };
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
  }

  const { action: actionType, status: newStatus, note, notesForCustomer, refund: doRefund, rejectionReason, locationId: requestedLocationId } = body;

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
        payloadJson: JSON.stringify({ from: returnCase.status, to: newStatus, note }),
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
        payloadJson: note ? JSON.stringify({ note }) : null,
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
        payloadJson: notesForCustomer ? JSON.stringify({ notesForCustomer }) : null,
      },
    });
    throw redirect(`/app/returns/${id}`);
  }

  if (actionType === "approve") {
    if (isTerminal) {
      return Response.json({ error: `Cannot approve: return is already ${returnCase.status}` }, { status: 400 });
    }
    let fyndReturnId: string | null = null;
    let fyndReturnNo: string | null = null;
    let fyndError: string | null = null;
    const shopWithSettings = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { settings: true },
    });
    const settingsForApprove = shopWithSettings?.settings as NonNullable<typeof shopWithSettings>["settings"] & { fyndApiType?: string | null } | undefined;
    const fyndClientResult = settingsForApprove
      ? await createFyndClientOrError(settingsForApprove, { requirePlatform: true })
      : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations and connect Fynd with Platform API to create returns on Fynd." };
    let fyndOrderId: string | null = null;
    let fyndShipmentId: string | null = null;
    let fyndPayloadJson: string | null = null;
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
        const fyndResult = await createReturnOnFynd(fyndClient, returnCase, { affiliateOrderId });
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
    await prisma.returnCase.update({
      where: { id },
      data: {
        status: "approved",
        adminNotes: note || returnCase.adminNotes,
        ...(fyndReturnId && { fyndReturnId }),
        ...(fyndReturnNo && { fyndReturnNo }),
        ...(fyndOrderId && { fyndOrderId }),
        ...(fyndShipmentId && { fyndShipmentId }),
        ...(fyndPayloadJson != null && { fyndPayloadJson }),
      },
    });
    await prisma.returnEvent.create({
      data: {
        returnCaseId: id,
        source: "admin",
        eventType: "approved",
        payloadJson: JSON.stringify({
          note: note || null,
          fyndReturnId: fyndReturnId || null,
          fyndReturnNo: fyndReturnNo || null,
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
    const shopWithSettings = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { settings: true },
    });
    const settingsRetry = shopWithSettings?.settings as NonNullable<typeof shopWithSettings>["settings"] & { fyndApiType?: string | null } | undefined;
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
    const fyndResult = await createReturnOnFynd(fyndClient, returnCase, { affiliateOrderId });
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
    const shopWithSettings = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { settings: true },
    });
    const settings = shopWithSettings?.settings as NonNullable<typeof shopWithSettings>["settings"] & { fyndApiType?: string | null } | undefined;
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
        payloadJson: JSON.stringify({ rejectionReason: reason, note: note || null }),
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

      const isGid = orderIdForRefund?.startsWith("gid://");
      const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
      if (!isGid && !isNumericId) {
        const orderNumber = (returnCase.shopifyOrderName ?? orderIdForRefund ?? "").replace(/^#/, "").trim();
        const orderByNumber = orderNumber ? await fetchOrderByOrderNumber(admin, orderNumber) : null;
        if (orderByNumber?.id) {
          orderIdForRefund = orderByNumber.id;
          if (lineItemsForRefund.length === 0 && orderByNumber.lineItems?.length) {
            lineItemsForRefund = orderByNumber.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
          }
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
        const order = await fetchOrder(admin, orderIdForRefund);
        if (order?.lineItems?.length) {
          lineItemsForRefund = order.lineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
        }
      }

      const result = await createRefund(admin, orderIdForRefund, lineItemsForRefund, note || returnCase.adminNotes || undefined, requestedLocationId || undefined);
      if (!result.success) {
        const msg = result.error ?? "Refund failed due to an unknown Shopify error. Check Shopify Admin.";
        await createFailedEvent(msg);
        return Response.json({ error: msg }, { status: 400 });
      }
      const refundDetails = {
        refundId: result.refundId ?? null,
        amount: result.refundAmount ?? null,
        currency: result.refundCurrency ?? null,
        createdAt: result.refundCreatedAt ?? new Date().toISOString(),
        method: "original_payment_method",
        source: "admin",
        locationId: requestedLocationId ?? null,
      };
      await prisma.returnCase.update({
        where: { id },
        data: {
          refundStatus: "refunded",
          refundJson: JSON.stringify(refundDetails),
          status: "completed",
          adminNotes: note || returnCase.adminNotes,
        },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "refund_processed",
          payloadJson: JSON.stringify({ ...refundDetails, note: "Refund created in Shopify" }),
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

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
