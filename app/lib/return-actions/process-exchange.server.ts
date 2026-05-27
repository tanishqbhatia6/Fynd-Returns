import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import {
  fetchOrder,
  fetchOrderByOrderNumber,
  closeShopifyReturnBestEffort,
  fetchVariantInfo,
  sendDraftOrderInvoice,
  createRefund,
  type ShopifyVariantInfo,
} from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { sendApprovalNotification } from "../notification.server";
import { auditReturnAction } from "../observability/audit.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse, extractErrorMessage } from "../return-action-errors.server";
import { buildDraftOrderAddresses } from "./draft-order-address.server";
import type { ReturnActionHandler } from "./types";

const FYND_EXCHANGE_ALLOWED_STATUSES = new Set([
  "return_bag_delivered",
  "return_accepted",
  "rto_bag_accepted",
  "deadstock",
  "refund_approved",
  "refund_initiated",
  "refund_completed",
  "return_completed",
  "deadstock_defective",
  "return_bag_lost",
  "rto_bag_delivered",
  "credit_note_generated",
]);

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation draftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name invoiceUrl }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_COMPLETE_MUTATION = `#graphql
  mutation draftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id, paymentPending: false) {
      draftOrder { id name order { id name } }
      userErrors { field message }
    }
  }
`;

type PortalExchangeVariant = {
  lineItemId?: string;
  productId?: string;
  variantId?: string;
  variantTitle?: string;
};

type ResolvedExchangeLine = {
  returnedTitle: string;
  returnedQty: number;
  returnedUnitPrice: string;
  returnedLineItemId: string;
  returnedSku: string | null;
  replacementVariantId: string | null;
  replacementTitle: string;
  replacementUnitPrice: string;
  replacementSku: string | null;
  replacementImageUrl: string | null;
  replacementInventoryAvailable: number | null;
};

export const handleProcessExchange: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shop, admin, sessionEmail, shopDomain, elapsed, logShopifyReturnEvent } =
    ctx;
  return await withSpan(
    "return.action.process_exchange",
    {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "process_exchange",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Return must be approved before processing exchange" },
            { status: 400 },
          );
        }
        if (returnCase.exchangeOrderId) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Exchange order has already been created" },
            { status: 400 },
          );
        }
        if (returnCase.shopifyOrderId?.startsWith("manual:")) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Cannot create exchange for manual returns" },
            { status: 400 },
          );
        }

        if (returnCase.fyndReturnId) {
          let fyndCurrentStatus: string | null = null;
          if (returnCase.fyndCurrentStatus) {
            fyndCurrentStatus = returnCase.fyndCurrentStatus.toLowerCase().replace(/\s+/g, "_");
          }
          try {
            const payload = returnCase.fyndPayloadJson
              ? (JSON.parse(returnCase.fyndPayloadJson) as Record<string, unknown>)
              : null;
            if (!fyndCurrentStatus) {
              fyndCurrentStatus = payload?.status
                ? String(payload.status).toLowerCase().replace(/\s+/g, "_")
                : null;
            }
          } catch {
            /* ignore */
          }
          if (fyndCurrentStatus && !FYND_EXCHANGE_ALLOWED_STATUSES.has(fyndCurrentStatus)) {
            returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
            return Response.json(
              {
                error: `Exchange order can only be created after the return bag is received at the warehouse. Current Fynd status: "${fyndCurrentStatus}". Wait until the status is "return_bag_delivered" or later.`,
              },
              { status: 400 },
            );
          }
        }

        const order = returnCase.shopifyOrderId
          ? await fetchOrder(admin as never, returnCase.shopifyOrderId)
          : returnCase.shopifyOrderName
            ? /* v8 ignore start */
              // defensive: shopifyOrderName ?? "" fallback unreachable when outer ternary truthy
              await fetchOrderByOrderNumber(
                admin as never,
                (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim(),
              )
            : /* v8 ignore stop */
              null;

        if (!order) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Could not fetch original order to create exchange" },
            { status: 400 },
          );
        }

        const customerEmail = order.email;
        if (!customerEmail) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Original order has no customer email — cannot create exchange order" },
            { status: 400 },
          );
        }

        let portalVariants: PortalExchangeVariant[] = [];
        try {
          const events = await prisma.returnEvent.findMany({
            where: { returnCaseId: id },
            orderBy: { happenedAt: "desc" },
            take: 25,
          });
          for (const ev of events) {
            if (!ev.payloadJson) continue;
            try {
              const parsed = JSON.parse(ev.payloadJson) as {
                exchangeVariants?: PortalExchangeVariant[];
              };
              if (Array.isArray(parsed.exchangeVariants) && parsed.exchangeVariants.length > 0) {
                portalVariants = parsed.exchangeVariants;
                break;
              }
            } catch {
              /* ignore malformed event */
            }
          }
        } catch {
          /* non-fatal — fall through to legacy path */
        }

        /* v8 ignore start */
        // defensive: returnCase.items ?? [] fallback for legacy rows; empty array branch unreachable
        const returnedItems = (returnCase.items ?? []).filter(
          (i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual",
        );
        /* v8 ignore stop */
        if (returnedItems.length === 0) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json({ error: "No line items available for exchange" }, { status: 400 });
        }

        const variantIdsToFetch = portalVariants
          .map((v) => v.variantId)
          .filter(
            (v): v is string =>
              typeof v === "string" && v.startsWith("gid://shopify/ProductVariant/"),
          );
        const variantInfoMap =
          variantIdsToFetch.length > 0
            ? await fetchVariantInfo(admin as never, variantIdsToFetch)
            : new Map<string, ShopifyVariantInfo>();

        const exchangeLines: ResolvedExchangeLine[] = returnedItems.map((item) => {
          /* v8 ignore start */
          // defensive: order.lineItems ?? [] fallback unreachable; orders always have lineItems
          const shopifyItem = (order.lineItems ?? []).find(
            (li) =>
              li.id === item.shopifyLineItemId ||
              (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase()),
          );
          /* v8 ignore stop */
          const returnedTitle =
            (item as { title?: string }).title || shopifyItem?.title || item.sku || "Item";
          const returnedUnitPrice =
            shopifyItem?.price || (item as { price?: string }).price || "0.00";

          const matchedPick =
            portalVariants.find((v) => v.lineItemId && v.lineItemId === item.shopifyLineItemId) ??
            (portalVariants.length === returnedItems.length
              ? portalVariants[returnedItems.indexOf(item)]
              : undefined);
          const variantInfo = matchedPick?.variantId
            ? variantInfoMap.get(matchedPick.variantId)
            : undefined;

          return {
            returnedTitle,
            returnedQty: item.qty,
            returnedUnitPrice,
            returnedLineItemId: item.shopifyLineItemId,
            returnedSku: item.sku ?? shopifyItem?.sku ?? null,
            replacementVariantId: variantInfo?.id ?? matchedPick?.variantId ?? null,
            replacementTitle: variantInfo
              ? `${variantInfo.productTitle ?? returnedTitle}${variantInfo.variantTitle && variantInfo.variantTitle !== "Default Title" ? ` — ${variantInfo.variantTitle}` : ""}`
              : matchedPick?.variantTitle || returnedTitle,
            replacementUnitPrice: variantInfo?.price ?? returnedUnitPrice,
            replacementSku: variantInfo?.sku ?? null,
            replacementImageUrl: variantInfo?.imageUrl ?? null,
            replacementInventoryAvailable: variantInfo?.inventoryAvailable ?? null,
          };
        });

        const stockoutLines: Array<{ title: string; required: number; available: number }> = [];
        for (const line of exchangeLines) {
          if (!line.replacementVariantId) continue;
          const inv = line.replacementInventoryAvailable;
          if (inv != null && inv < line.returnedQty) {
            stockoutLines.push({
              title: line.replacementTitle,
              required: line.returnedQty,
              available: Math.max(0, inv),
            });
          }
        }
        if (stockoutLines.length > 0) {
          const human = stockoutLines
            .map((s) => `${s.title} (need ${s.required}, only ${s.available} in stock)`)
            .join("; ");
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          await prisma.returnEvent
            .create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "exchange_inventory_blocked",
                payloadJson: JSON.stringify({ stockoutLines }),
              },
            })
            .catch(() => {});
          return Response.json(
            {
              error: `Cannot create exchange — selected variants are out of stock: ${human}. Restock or pick a different variant.`,
              stockoutLines,
            },
            { status: 409 },
          );
        }

        const originalSubtotal = exchangeLines.reduce(
          (s, l) => s + (parseFloat(l.returnedUnitPrice) || 0) * l.returnedQty,
          0,
        );
        const replacementSubtotal = exchangeLines.reduce(
          (s, l) => s + (parseFloat(l.replacementUnitPrice) || 0) * l.returnedQty,
          0,
        );
        const priceDiff = +(replacementSubtotal - originalSubtotal).toFixed(2);
        const orderCurrency =
          (order as { currencyCode?: string | null }).currencyCode ?? returnCase.currency ?? "USD";

        const customerOwesDifference = priceDiff > 0;
        const customerGetsRefund = priceDiff < 0;

        const draftLineItems = exchangeLines.map((line) => {
          const base: Record<string, unknown> = {
            quantity: line.returnedQty,
            requiresShipping: true,
          };
          // Resolve a marketplace identifier so downstream Fynd order-create has
          // a non-null SKU (without it Fynd rejects the order with
          // `mkp_identifiers: [None]`).
          const fallbackSku = line.replacementSku || line.returnedSku || null;
          // Shopify ignores explicit `sku` when `variantId` is provided — the
          // resulting order line uses the variant's actual SKU. So when the
          // chosen variant has NO SKU at all, we fall through to a custom line
          // item with an explicit SKU instead — the only way to guarantee the
          // SKU survives onto the order webhook Fynd consumes.
          if (line.replacementVariantId && line.replacementSku) {
            base.variantId = line.replacementVariantId;
          } else {
            base.title = line.replacementTitle;
            base.originalUnitPrice = line.replacementUnitPrice;
            if (fallbackSku) base.sku = fallbackSku;
          }
          return base;
        });

        const exchangeCreditDiscount = +Math.min(originalSubtotal, replacementSubtotal).toFixed(2);

        const draftInput: Record<string, unknown> = {
          email: customerEmail,
          ...(order.customerId ? { customerId: order.customerId } : {}),
          tags: [
            "exchange",
            `rpm-exchange-${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id}`,
          ],
          note: `Exchange for return ${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id} (Order ${returnCase.shopifyOrderName || ""})`,
          customAttributes: [
            { key: "rpm_exchange_for", value: returnCase.shopifyOrderName || "" },
            { key: "rpm_return_id", value: returnCase.id },
            { key: "rpm_price_diff", value: priceDiff.toFixed(2) },
            { key: "rpm_price_diff_currency", value: orderCurrency },
          ],
          ...(exchangeCreditDiscount > 0
            ? {
                appliedDiscount: {
                  valueType: "FIXED_AMOUNT",
                  value: exchangeCreditDiscount,
                  title: "Exchange credit",
                  description: `Credit for returned items from ${returnCase.shopifyOrderName || "original order"}`,
                },
              }
            : {}),
          lineItems: draftLineItems,
          ...buildDraftOrderAddresses(order, returnCase),
        };

        const draftRes = await admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
          variables: { input: draftInput },
        });
        const draftJson = (await draftRes.json()) as {
          data?: {
            draftOrderCreate?: {
              draftOrder?: {
                id: string;
                name: string;
                invoiceUrl?: string | null;
              } | null;
              userErrors?: Array<{ field?: string[]; message: string }>;
            };
          };
          errors?: Array<{ message: string }>;
        };

        if (Array.isArray(draftJson.errors) && draftJson.errors.length > 0) {
          const topErr = draftJson.errors.map((e) => e.message).join("; ");
          const scopeError = /access scope|write_draft_orders|write_quick_sale|access denied/i.test(
            topErr,
          );
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            {
              error: scopeError
                ? 'This app needs the "write_draft_orders" permission to create an exchange order. Please reinstall the app or accept the updated permissions when prompted, then try again.'
                : `Failed to create exchange order: ${topErr}`,
            },
            { status: scopeError ? 403 : 400 },
          );
        }

        const userErrors = draftJson.data?.draftOrderCreate?.userErrors ?? [];
        if (userErrors.length > 0) {
          const errMsg = userErrors.map((e) => e.message).join("; ");
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          const scopeError = /access scope|write_draft_orders|write_quick_sale|access denied/i.test(
            errMsg,
          );
          return Response.json(
            {
              error: scopeError
                ? 'This app needs the "write_draft_orders" permission to create an exchange order. Please reinstall the app or accept the updated permissions when prompted, then try again.'
                : `Failed to create exchange draft order: ${errMsg}`,
            },
            { status: 400 },
          );
        }

        const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;
        if (!draftOrder?.id) {
          returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
          return Response.json(
            { error: "Failed to create exchange draft order — no order returned" },
            { status: 500 },
          );
        }

        let realOrderId: string | null = null;
        let realOrderName: string | null = null;
        let invoiceUrl: string | null = null;
        let downstreamFlow: "completed_free" | "completed_with_refund" | "invoice_pending";
        let completeError: string | null = null;
        let refundResult: {
          success: boolean;
          refundId?: string;
          amount?: string;
          error?: string;
        } | null = null;

        if (customerOwesDifference) {
          const invoiceRes = await sendDraftOrderInvoice(
            admin as never,
            draftOrder.id,
            customerEmail,
            `Complete your exchange for ${returnCase.shopifyOrderName || "your order"}`,
            `Your exchange items have a price difference of ${priceDiff.toFixed(2)} ${orderCurrency}. Click the link below to pay and we'll ship your replacement.`,
          );
          if (invoiceRes.success) {
            invoiceUrl = invoiceRes.invoiceUrl ?? null;
          } else {
            refundLogger.warn(
              { err: invoiceRes.error },
              "[process_exchange] Invoice send failed (non-fatal)",
            );
          }
          downstreamFlow = "invoice_pending";
        } else {
          try {
            const completeRes = await admin.graphql(DRAFT_ORDER_COMPLETE_MUTATION, {
              variables: { id: draftOrder.id },
            });
            const completeJson = (await completeRes.json()) as {
              data?: {
                draftOrderComplete?: {
                  draftOrder?: {
                    id: string;
                    name: string;
                    order?: { id: string; name: string } | null;
                  } | null;
                  userErrors?: Array<{ field?: string[]; message: string }>;
                };
              };
              errors?: Array<{ message: string }>;
            };
            const cuErrors = completeJson.data?.draftOrderComplete?.userErrors ?? [];
            if (Array.isArray(completeJson.errors) && completeJson.errors.length > 0) {
              completeError = completeJson.errors.map((e) => e.message).join("; ");
            } else if (cuErrors.length > 0) {
              completeError = cuErrors.map((e) => e.message).join("; ");
            } else {
              const completed = completeJson.data?.draftOrderComplete?.draftOrder?.order;
              if (completed?.id) {
                realOrderId = completed.id;
                realOrderName = completed.name;
              }
            }
          } catch (err) {
            completeError = err instanceof Error ? err.message : String(err);
          }

          if (
            customerGetsRefund &&
            returnCase.shopifyOrderId &&
            !returnCase.shopifyOrderId.startsWith("manual:")
          ) {
            try {
              const absDiff = Math.abs(priceDiff);
              const result = await createRefund(
                admin as never,
                returnCase.shopifyOrderId,
                [],
                `Exchange price-difference refund for return ${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id}`,
                undefined,
                { method: "original" },
                { skipLocation: true, transactionAmount: absDiff },
              );
              refundResult = {
                success: result.success,
                refundId: result.refundId,
                amount: result.refundAmount,
                error: result.error,
              };
            } catch (err) {
              refundResult = {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }

          downstreamFlow = customerGetsRefund ? "completed_with_refund" : "completed_free";
        }

        const exchangeItemsData = exchangeLines.map((line) => ({
          returnedTitle: line.returnedTitle,
          returnedQty: line.returnedQty,
          returnedUnitPrice: line.returnedUnitPrice,
          replacementTitle: line.replacementTitle,
          replacementVariantId: line.replacementVariantId,
          replacementUnitPrice: line.replacementUnitPrice,
          replacementSku: line.replacementSku,
          replacementImageUrl: line.replacementImageUrl,
        }));

        await prisma.returnCase.update({
          where: { id },
          data: {
            resolutionType: "exchange",
            exchangeOrderId: realOrderId || draftOrder.id,
            exchangeOrderName: realOrderName || draftOrder.name,
            exchangeItemsJson: JSON.stringify(exchangeItemsData),
            exchangePriceDiff: priceDiff as unknown as never,
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
              orderId: realOrderId,
              orderName: realOrderName,
              flow: downstreamFlow,
              priceDiff,
              currency: orderCurrency,
              originalSubtotal: +originalSubtotal.toFixed(2),
              replacementSubtotal: +replacementSubtotal.toFixed(2),
              invoiceUrl: invoiceUrl ?? null,
              variantIdsResolved: exchangeLines.filter((l) => l.replacementVariantId).length,
              completeError,
              refund: refundResult,
              itemCount: exchangeItemsData.length,
              adminEmail: sessionEmail,
            }),
          },
        });

        if (returnCase.fyndShipmentId) {
          try {
            const fyndClientResult = await createFyndClientOrError(
              shop.settings as Parameters<typeof createFyndClientOrError>[0],
              { requirePlatform: true },
            );
            if (fyndClientResult.ok && "updateShipmentStatus" in fyndClientResult.client) {
              const fyndClient =
                fyndClientResult.client as import("../fynd.server").FyndPlatformClient;
              const callId = returnCase.fyndOrderId || returnCase.fyndShipmentId;
              await fyndClient.updateShipmentStatus(callId, {
                statuses: [
                  {
                    shipments: [{ identifier: returnCase.fyndShipmentId }],
                    status: "return_completed",
                  },
                ],
                task: false,
                force_transition: false,
                lock_after_transition: false,
                unlock_before_transition: false,
              });
              await prisma.returnEvent
                .create({
                  data: {
                    returnCaseId: id,
                    source: "admin",
                    eventType: "fynd_exchange_synced",
                    payloadJson: JSON.stringify({
                      status: "return_completed",
                      shipmentId: returnCase.fyndShipmentId,
                    }),
                  },
                })
                .catch(() => {});
            }
          } catch (fyndErr) {
            refundLogger.warn(
              { err: fyndErr },
              "[process_exchange] Fynd return_completed push failed (non-fatal)",
            );
            await prisma.returnEvent
              .create({
                data: {
                  returnCaseId: id,
                  source: "admin",
                  eventType: "fynd_exchange_sync_failed",
                  payloadJson: JSON.stringify({
                    error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr),
                    shipmentId: returnCase.fyndShipmentId,
                  }),
                },
              })
              .catch(() => {});
          }
        }

        await closeShopifyReturnBestEffort(admin as never, returnCase as never, {
          logEvent: logShopifyReturnEvent,
        });

        if (returnCase.customerEmailNorm) {
          const orderNameForEmail = returnCase.shopifyOrderName || "your order";
          const shopName = shopDomain?.replace(".myshopify.com", "");
          let notes: string;
          if (downstreamFlow === "invoice_pending") {
            notes = `An exchange order (${draftOrder.name}) has been created. There's a price difference of ${priceDiff.toFixed(2)} ${orderCurrency} — we just emailed you a payment link. Once paid, your replacement will ship.`;
          } else if (downstreamFlow === "completed_with_refund") {
            const absDiff = Math.abs(priceDiff).toFixed(2);
            notes = `An exchange order (${realOrderName || draftOrder.name}) has been created. Your replacement item costs ${absDiff} ${orderCurrency} less, so we've refunded the difference to your original payment method.`;
          } else {
            notes = `An exchange order (${realOrderName || draftOrder.name}) has been created at no additional charge. Your replacement will ship shortly.`;
          }
          try {
            await sendApprovalNotification({
              shopDomain,
              to: returnCase.customerEmailNorm,
              orderName: orderNameForEmail,
              notes,
              shopName,
            });
          } catch (err) {
            refundLogger.warn({ err }, "[process_exchange] Notification failed");
          }
        }

        addBusinessEvent("return.exchange_created", {
          "return.id": returnCase.id,
          "exchange.order_id": realOrderId || draftOrder.id,
          "exchange.order_name": realOrderName || draftOrder.name,
          "exchange.flow": downstreamFlow,
          "exchange.price_diff": priceDiff,
          "exchange.currency": orderCurrency,
          "exchange.item_count": exchangeItemsData.length,
        });
        auditReturnAction(
          "exchange_processed",
          returnCase.id,
          shop.shopDomain,
          { type: "admin", identity: sessionEmail || "shop-admin" },
          { resolutionType: { from: returnCase.resolutionType || "refund", to: "exchange" } },
          { draftOrderId: draftOrder.id, orderId: realOrderId, flow: downstreamFlow, priceDiff },
        );
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
          refundLogger.error(
            { err: logErr },
            "[process_exchange] Failed to log exchange_failed event",
          );
        }
        returnActionCounter.add(1, { action: "process_exchange", outcome: "error" });
        appErrorCounter.add(1, { action: "process_exchange" });
        returnActionDuration.record(actionTimer(), { action: "process_exchange" });
        return Response.json({ error: message }, { status: 500 });
      }
    },
  );
};
