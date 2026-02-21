import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRefund, fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { sendRejectionNotification } from "../lib/notification.server";

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

  let body: { action: string; status?: string; note?: string; refund?: boolean; rejectionReason?: string };
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
    if (rejectionReasonVal !== null && rejectionReasonVal !== undefined) body.rejectionReason = rejectionReasonVal;
  }

  const { action: actionType, status: newStatus, note, refund: doRefund, rejectionReason } = body;

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
    const settingsForApprove = shopWithSettings?.settings as (typeof shopWithSettings.settings) & { fyndApiType?: string | null } | undefined;
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
          fyndError = fyndResult.error;
          console.warn("[Approve] Fynd create return failed:", fyndResult.error);
        }
      } catch (err) {
        fyndError = err instanceof Error ? err.message : String(err);
        console.warn("[Approve] Fynd error:", err);
      }
    } else if (!fyndClientResult.ok) {
      fyndError = fyndClientResult.error;
    } else {
      fyndError = "Fynd return creation requires Platform API (Company ID + Client ID/Secret). You have Storefront configured. Switch in Settings → Integrations.";
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
    const settingsRetry = shopWithSettings?.settings as (typeof shopWithSettings.settings) & { fyndApiType?: string | null } | undefined;
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
    if (fyndResult.success && fyndResult.fyndReturnId) {
      let payloadJson: string | null = null;
      try {
        payloadJson = fyndResult.fyndPayload != null ? JSON.stringify(fyndResult.fyndPayload) : null;
      } catch {
        payloadJson = null;
      }
      await prisma.returnCase.update({
        where: { id },
        data: {
          fyndReturnId: fyndResult.fyndReturnId,
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
          }),
        },
      });
      throw redirect(`/app/returns/${id}?fyndSuccess=1`);
    }
    const errMsg = fyndResult.error ?? "Unknown Fynd error";
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
    const settings = shopWithSettings?.settings as (typeof shopWithSettings.settings) & { fyndApiType?: string | null } | undefined;
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
      const payload = searchRes;
      const payloadJson = payload != null ? JSON.stringify(payload) : null;
      const fyndOrderId = searchRes.orderId ?? searchRes.shipmentId ?? null;
      await prisma.returnCase.update({
        where: { id },
        data: { fyndPayloadJson: payloadJson ?? undefined, ...(fyndOrderId && { fyndOrderId }) },
      });
      throw redirect(`/app/returns/${id}?fyndRefresh=1`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
    const shopWithSettings = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { settings: true },
    });
    const notifyRejected = shopWithSettings?.settings?.notificationRejected ?? true;
    if (notifyRejected && returnCase.customerEmailNorm) {
      try {
        await sendRejectionNotification({
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
      let lineItemIds = (returnCase.items ?? [])
        .map((i) => i.shopifyLineItemId)
        .filter((x): x is string => !!x && x !== "manual");

      const isGid = orderIdForRefund?.startsWith("gid://");
      const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
      if (!isGid && !isNumericId) {
        const { fetchOrderByOrderNumber } = await import("../lib/shopify-admin.server");
        const orderNumber = (returnCase.shopifyOrderName ?? orderIdForRefund ?? "").replace(/^#/, "").trim();
        const orderByNumber = orderNumber ? await fetchOrderByOrderNumber(admin, orderNumber) : null;
        if (orderByNumber?.id) {
          orderIdForRefund = orderByNumber.id;
          if (lineItemIds.length === 0 && orderByNumber.lineItems?.length) {
            lineItemIds = orderByNumber.lineItems.map((li) => li.id);
          }
        }
      }

      if (!orderIdForRefund) {
        return Response.json({ error: "Could not determine Shopify order. Check that the return has a valid order." }, { status: 400 });
      }

      if (lineItemIds.length === 0) {
        const order = await fetchOrder(admin, orderIdForRefund);
        if (order?.lineItems?.length) {
          lineItemIds = order.lineItems.map((li) => li.id);
        }
      }

      const result = await createRefund(admin, orderIdForRefund, lineItemIds, note || returnCase.adminNotes || undefined);
      if (!result.success) {
        return Response.json({ error: result.error ?? "Refund failed" }, { status: 400 });
      }
      await prisma.returnCase.update({
        where: { id },
        data: { refundStatus: "refunded", adminNotes: note || returnCase.adminNotes },
      });
      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "admin",
          eventType: "refund_processed",
          payloadJson: JSON.stringify({ note: "Refund created in Shopify" }),
        },
      });
      throw redirect(`/app/returns/${id}`);
    } catch (err) {
      if (err instanceof Response) throw err;
      const message = err instanceof Error ? err.message : "Refund could not be processed. Please try again or process the refund manually in Shopify Admin.";
      console.error("[process_refund] Error:", err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
