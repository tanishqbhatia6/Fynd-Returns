import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { fetchOrderByOrderNumber } from "../shopify-admin.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse, extractErrorMessage } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

const VALID_CANCEL_REASONS = ["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"];

const ORDER_CANCEL_MUTATION = `#graphql
  mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
    orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
      orderCancelUserErrors { field message }
    }
  }
`;

export const handleCancelOrder: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, admin, sessionEmail, elapsed } = ctx;
  const note = body.note;
  return await withSpan("return.action.cancel_order", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "cancel_order",
  }, async () => {
    const actionTimer = startTimer();
    try {
      const cancelReason = ((body as { cancelReason?: string }).cancelReason ?? "OTHER").toUpperCase();
      if (!VALID_CANCEL_REASONS.includes(cancelReason)) {
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
            ? await fetchOrderByOrderNumber(admin as never, (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim())
            : null;
          if (!orderByName?.id) {
            returnActionCounter.add(1, { action: "cancel_order", outcome: "error" });
            return Response.json({ error: "Could not resolve Shopify order for cancellation" }, { status: 400 });
          }
          orderGid = orderByName.id;
        }
      }

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

      addBusinessEvent("return.order_cancelled", {
        "return.id": returnCase.id,
        "order.id": orderGid,
        "cancel.reason": cancelReason,
      });
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
};
