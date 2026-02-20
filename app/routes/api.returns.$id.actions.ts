import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createRefund, fetchOrder } from "../lib/shopify-admin.server";
import { createFyndClient } from "../lib/fynd.server";
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
    const shopWithSettings = await prisma.shop.findUnique({
      where: { id: shop.id },
      include: { settings: true },
    });
    const fyndClient = shopWithSettings?.settings
      ? await createFyndClient(shopWithSettings.settings)
      : null;
    if (fyndClient && "getShipments" in fyndClient) {
      try {
        const fyndResult = await createReturnOnFynd(fyndClient, returnCase);
        if (fyndResult.success && fyndResult.fyndReturnId) {
          fyndReturnId = fyndResult.fyndReturnId;
          fyndReturnNo = fyndResult.fyndReturnNo ?? null;
        } else if (fyndResult.error) {
          console.warn("[Approve] Fynd create return failed:", fyndResult.error);
        }
      } catch (err) {
        console.warn("[Approve] Fynd error:", err);
      }
    }
    await prisma.returnCase.update({
      where: { id },
      data: {
        status: "approved",
        adminNotes: note || returnCase.adminNotes,
        ...(fyndReturnId && { fyndReturnId }),
        ...(fyndReturnNo && { fyndReturnNo }),
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
    throw redirect(`/app/returns/${id}`);
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
    let lineItemIds = (returnCase.items ?? [])
      .map((i) => i.shopifyLineItemId)
      .filter((x): x is string => !!x);
    if (lineItemIds.length === 0) {
      const order = await fetchOrder(admin, returnCase.shopifyOrderId);
      if (order?.lineItems?.length) {
        lineItemIds = order.lineItems.map((li) => li.id);
      }
    }
    const result = await createRefund(admin, returnCase.shopifyOrderId, lineItemIds, note || returnCase.adminNotes || undefined);
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
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
