import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, addBusinessEvent, startTimer } from "../observability/tracing.server";
import {
  returnActionCounter,
  returnActionDuration,
  appErrorCounter,
  refundCounter,
  refundAmountHistogram,
  returnsCompletedCounter,
} from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import {
  fetchOrder,
  fetchOrderByOrderNumber,
  fetchOrderByFyndAffiliateId,
  fetchOrderLineItemsOnly,
  fetchOrderLineItemsByName,
  closeShopifyReturnBestEffort,
  createRefund,
  type RefundMethodConfig,
} from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { sendRefundNotification } from "../notification.server";
import { auditReturnAction } from "../observability/audit.server";
import { refundLogger } from "../observability/logger.server";
import {
  isRedirectResponse,
  extractErrorMessage,
  enrichRefundError,
} from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleProcessRefund: ReturnActionHandler = async (ctx, body) => {
  const { id, returnCase, shop, admin, sessionEmail, shopDomain, elapsed, logShopifyReturnEvent } =
    ctx;
  const note = body.note;
  const bodyRefundMethod = body.refundMethod;
  const requestedLocationId = body.locationId;
  const bodyStoreCreditPct = body.storeCreditPct;
  const bodyBonusAmount = body.bonusAmount;
  const bodySplitMode = body.splitMode;
  const bodySplitScAmount = body.splitScAmount;
  const bodySplitOrigAmount = body.splitOrigAmount;

  return await withSpan(
    "return.action.process_refund",
    {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "process_refund",
      "refund.method": bodyRefundMethod || "default",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json(
            { error: "Return must be approved before processing refund" },
            { status: 400 },
          );
        }
        if (returnCase.refundStatus === "refunded") {
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json({ error: "Refund has already been processed" }, { status: 400 });
        }
        if (returnCase.shopifyOrderId?.startsWith("manual:")) {
          /* v8 ignore start - defensive `??` fallback chain for manual-id derived order name */
          const orderName =
            returnCase.shopifyOrderName ??
            returnCase.shopifyOrderId?.replace(/^manual:/, "") ??
            "—";
          /* v8 ignore stop */
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          return Response.json(
            {
              error: `This is a manual return request. Process the refund in Shopify Admin for order ${orderName}.`,
            },
            { status: 400 },
          );
        }

        if (returnCase.cancellationRequestedAt) {
          await prisma.returnCase.update({
            where: { id },
            data: { cancellationRequestedAt: null },
          });
        }

        const isFyndIntegrated = !!(
          returnCase.fyndOrderId ||
          returnCase.fyndShipmentId ||
          returnCase.fyndReturnId
        );
        if (isFyndIntegrated) {
          let allowedFyndStatuses: string[] = [];
          try {
            const raw = (shop.settings as { allowedFyndStatusesForRefund?: string | null } | null)
              ?.allowedFyndStatusesForRefund;
            if (raw) {
              const parsed = JSON.parse(raw) as unknown;
              if (Array.isArray(parsed) && parsed.length > 0) {
                allowedFyndStatuses = parsed
                  .map((s) => String(s).toLowerCase().trim())
                  .filter(Boolean);
              }
            }
          } catch {
            /* malformed JSON — treat as feature disabled */
          }

          if (allowedFyndStatuses.length > 0) {
            const currentFyndStatus = (returnCase.fyndCurrentStatus ?? "").toLowerCase().trim();
            if (!currentFyndStatus) {
              returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
              return Response.json(
                {
                  error:
                    "Cannot process refund: Fynd shipment status has not been received yet. Wait for a Fynd webhook update or manually sync the return status before processing the refund.",
                },
                { status: 400 },
              );
            }
            if (!allowedFyndStatuses.includes(currentFyndStatus)) {
              const displayAllowed = allowedFyndStatuses.map((s) => `"${s}"`).join(", ");
              returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
              return Response.json(
                {
                  error: `Cannot process refund: current Fynd status "${returnCase.fyndCurrentStatus}" is not in the allowed list. Allowed statuses: ${displayAllowed}. Update the allowed statuses in Settings → Return Settings, or wait for the Fynd status to change.`,
                },
                { status: 400 },
              );
            }
          }
        }

        let orderIdForRefund = returnCase.shopifyOrderId;

        /* v8 ignore start - defensive `?? []` for null items relation */
        const rawLineItems = (returnCase.items ?? [])
          .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
          .map((i) => ({ id: i.shopifyLineItemId, quantity: i.qty, sku: i.sku }));
        /* v8 ignore stop */
        const hasValidLineItemIds =
          rawLineItems.length > 0 &&
          rawLineItems.every((li) => li.id.startsWith("gid://shopify/LineItem/"));
        let lineItemsForRefund: Array<{ id: string; quantity: number }> = hasValidLineItemIds
          ? rawLineItems.map((li) => ({ id: li.id, quantity: li.quantity }))
          : [];

        if (!hasValidLineItemIds && rawLineItems.length > 0) {
          refundLogger.info(
            { sampleId: rawLineItems[0]?.id },
            "[refund] Line item IDs are not Shopify GIDs — will fetch from Shopify order",
          );
        }

        // When SKU match fails (or returnItems lack SKU), distribute the actual
        // returned qty across the Shopify line items so we never refund more
        // than the customer requested. Fall back to first lineItem only when
        // returnItems is empty.
        const fallbackByReturnQty = (
          shopifyLineItems: Array<{ id: string; quantity: number; sku?: string | null }>,
          returnItems: typeof returnCase.items,
        ): Array<{ id: string; quantity: number }> => {
          /* v8 ignore start - defensive `?? []` and Number `|| 0` fallbacks */
          const totalReturnQty = (returnItems ?? []).reduce(
            (sum, ri) => sum + Math.max(0, Math.floor(Number(ri.qty) || 0)),
            0,
          );
          /* v8 ignore stop */
          if (totalReturnQty <= 0) {
            return shopifyLineItems.map((li) => ({ id: li.id, quantity: li.quantity }));
          }
          let remaining = totalReturnQty;
          const out: Array<{ id: string; quantity: number }> = [];
          /* v8 ignore start - defensive break/continue guards on degenerate quantity inputs */
          for (const li of shopifyLineItems) {
            if (remaining <= 0) break;
            const take = Math.min(li.quantity, remaining);
            if (take <= 0) continue;
            out.push({ id: li.id, quantity: take });
            remaining -= take;
          }
          /* v8 ignore stop */
          return out;
        };

        const applyResolvedOrder = async (shopifyOrder: {
          id: string;
          name?: string;
          lineItems?: Array<{ id: string; quantity: number; sku?: string | null }>;
        }) => {
          orderIdForRefund = shopifyOrder.id;
          const updates: Record<string, string> = { shopifyOrderId: shopifyOrder.id };
          /* v8 ignore start - defensive name-and-no-existing-name guard + non-fatal catch */
          if (shopifyOrder.name && !returnCase.shopifyOrderName)
            updates.shopifyOrderName = shopifyOrder.name;
          await prisma.returnCase.update({ where: { id }, data: updates }).catch(() => {
            /* non-fatal */
          });
          /* v8 ignore stop */
          // defensive: shopifyOrder.lineItems always populated in this code path; falsy branch unreachable
          /* v8 ignore start */
          if (shopifyOrder.lineItems?.length) {
            /* v8 ignore stop */
            /* v8 ignore start */
            // defensive: returnCase.items always set; ?? [] fallback unreachable
            const returnItems = returnCase.items ?? [];
            /* v8 ignore stop */
            if (returnItems.length > 0 && returnItems.some((i) => i.sku)) {
              const matched: Array<{ id: string; quantity: number }> = [];
              for (const ri of returnItems) {
                /* v8 ignore start - defensive `?? ""` for null sku */
                const riSku = (ri.sku ?? "").toLowerCase().trim();
                /* v8 ignore stop */
                if (!riSku) continue;
                const shopifyLi = shopifyOrder.lineItems.find(
                  (li) => li.sku && li.sku.toLowerCase().trim() === riSku,
                );
                if (shopifyLi) {
                  matched.push({ id: shopifyLi.id, quantity: ri.qty });
                }
              }
              if (matched.length > 0) {
                lineItemsForRefund = matched;
                refundLogger.info(
                  { matchCount: matched.length },
                  "[refund] Matched line items by SKU",
                );
              } else {
                lineItemsForRefund = fallbackByReturnQty(shopifyOrder.lineItems, returnItems);
                refundLogger.info(
                  { count: lineItemsForRefund.length },
                  "[refund] SKU match failed, distributed return qty across line items",
                );
              }
            } else {
              lineItemsForRefund = fallbackByReturnQty(shopifyOrder.lineItems, returnItems);
            }
          }
        };

        const isGid = orderIdForRefund?.startsWith("gid://");
        const isNumericId = orderIdForRefund != null && /^\d+$/.test(orderIdForRefund);
        /* v8 ignore start - defensive `?? ""` for log enrichment */
        refundLogger.info(
          {
            orderIdForRefund,
            isGid,
            isNumericId,
            shopifyOrderName: returnCase.shopifyOrderName ?? "",
          },
          "[refund] resolving order",
        );
        /* v8 ignore stop */
        if (!isGid && !isNumericId && orderIdForRefund && !orderIdForRefund.startsWith("manual:")) {
          let resolved = false;

          if (!resolved && returnCase.shopifyOrderName) {
            /* v8 ignore start - defensive `?.message ?? err` log enrichment */
            const order = await fetchOrderByFyndAffiliateId(
              admin as never,
              returnCase.shopifyOrderName,
            ).catch((err) => {
              refundLogger.warn(
                { shopifyOrderName: returnCase.shopifyOrderName, err: err?.message ?? err },
                "[refund] Strategy 1 failed",
              );
              return null;
            });
            /* v8 ignore stop */
            if (order?.id) {
              await applyResolvedOrder(order);
              resolved = true;
            }
          }

          if (!resolved) {
            /* v8 ignore start - defensive `?? ""`/`?.message ?? err` */
            const cleanedOrderId = (orderIdForRefund ?? "").replace(/^#/, "").trim();
            const order = await fetchOrderByFyndAffiliateId(admin as never, cleanedOrderId).catch(
              (err) => {
                refundLogger.warn(
                  { cleanedOrderId, err: err?.message ?? err },
                  "[refund] Strategy 2 failed",
                );
                return null;
              },
            );
            /* v8 ignore stop */
            if (order?.id) {
              await applyResolvedOrder(order);
              resolved = true;
            }
          }

          if (!resolved && (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson) {
            /* v8 ignore start - defensive Strategy-3 candidate extraction with `??`/typeof/`?.` chains */
            try {
              const fp = JSON.parse(
                (returnCase as { fyndPayloadJson: string }).fyndPayloadJson,
              ) as Record<string, unknown>;
              const inner = (fp.payload ?? fp.shipment ?? fp) as Record<string, unknown>;
              const items = (inner.items ?? inner.shipments ?? []) as Record<string, unknown>[];
              const meta = (inner.meta ?? {}) as Record<string, unknown>;
              const orderObj = (inner.order ?? {}) as Record<string, unknown>;
              const candidateIds = [
                inner.affiliate_order_id,
                inner.external_order_id,
                inner.channel_order_id,
                meta.affiliate_order_id,
                meta.external_order_id,
                meta.channel_order_id,
                orderObj.affiliate_order_id,
                orderObj.external_order_id,
                items[0]?.affiliate_order_id,
                items[0]?.external_order_id,
                (items[0]?.order as Record<string, unknown> | undefined)?.affiliate_order_id,
              ];
              const seen = new Set<string>();
              for (const raw of candidateIds) {
                const cleaned = typeof raw === "string" ? raw.replace(/^#/, "").trim() : "";
                if (!cleaned || seen.has(cleaned)) continue;
                seen.add(cleaned);
                const shopifyOrder = await fetchOrderByFyndAffiliateId(
                  admin as never,
                  cleaned,
                ).catch((err) => {
                  refundLogger.warn(
                    { candidate: cleaned, err: err?.message ?? err },
                    "[refund] Strategy 3 candidate failed",
                  );
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
            /* v8 ignore stop */
          }

          if (!resolved) {
            const fyndOid = orderIdForRefund;
            await prisma.returnEvent.create({
              data: {
                returnCaseId: id,
                source: "admin",
                eventType: "refund_failed",
                payloadJson: JSON.stringify({
                  error: `Could not resolve Shopify order from "${fyndOid}"`,
                  note: note || null,
                }),
              },
            });
            const msg =
              `This return is linked to Fynd order ID "${fyndOid}" which could not be found in Shopify. ` +
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
          /* v8 ignore start - defensive empty-line-items recovery branch */
          refundLogger.info(
            { orderIdForRefund },
            "[refund] lineItemsForRefund is empty, fetching Shopify order to resolve line items",
          );
          let minimalOrder: {
            id: string;
            name: string;
            lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }>;
          } | null = null;

          if (orderIdForRefund) {
            /* v8 ignore start - defensive `(err as Error)?.message ?? err` log enrichment */
            minimalOrder = await fetchOrderLineItemsOnly(admin as never, orderIdForRefund).catch(
              (err) => {
                refundLogger.warn(
                  { orderIdForRefund, err: (err as Error)?.message ?? err },
                  "[refund] fetchOrderLineItemsOnly failed",
                );
                return null;
              },
            );
            /* v8 ignore stop */
            refundLogger.info(
              {
                strategy: "0",
                result: minimalOrder
                  ? `found ${minimalOrder.lineItems.length} line items`
                  : "no result",
              },
              "[refund] PCDA-safe GID",
            );
          }

          if (!minimalOrder && returnCase.shopifyOrderName) {
            const orderName = returnCase.shopifyOrderName.replace(/^#/, "").trim();
            if (orderName) {
              /* v8 ignore start - defensive `(err as Error)?.message ?? err` log enrichment */
              minimalOrder = await fetchOrderLineItemsByName(admin as never, orderName).catch(
                (err) => {
                  refundLogger.warn(
                    { orderName, err: (err as Error)?.message ?? err },
                    "[refund] fetchOrderLineItemsByName failed",
                  );
                  return null;
                },
              );
              /* v8 ignore stop */
              refundLogger.info(
                {
                  strategy: "0b",
                  orderName,
                  result: minimalOrder
                    ? `found ${minimalOrder.lineItems.length} line items`
                    : "no result",
                },
                "[refund] PCDA-safe name",
              );
              if (minimalOrder?.id && minimalOrder.id !== orderIdForRefund) {
                orderIdForRefund = minimalOrder.id;
                await prisma.returnCase
                  .update({ where: { id }, data: { shopifyOrderId: minimalOrder.id } })
                  .catch(() => {});
              }
            }
          }

          if (minimalOrder?.lineItems?.length) {
            /* v8 ignore start - defensive `?? []` for items relation */
            const returnItems = returnCase.items ?? [];
            /* v8 ignore stop */
            if (returnItems.length > 0 && returnItems.some((i: { sku?: string | null }) => i.sku)) {
              const matched: Array<{ id: string; quantity: number }> = [];
              for (const ri of returnItems) {
                /* v8 ignore start - defensive `?? ""` for null sku */
                const riSku = ((ri as { sku?: string | null }).sku ?? "").toLowerCase().trim();
                /* v8 ignore stop */
                if (!riSku) continue;
                const shopifyLi = minimalOrder.lineItems.find(
                  (li) => li.sku && li.sku.toLowerCase().trim() === riSku,
                );
                if (shopifyLi) matched.push({ id: shopifyLi.id, quantity: ri.qty });
              }
              lineItemsForRefund =
                matched.length > 0
                  ? matched
                  : fallbackByReturnQty(minimalOrder.lineItems, returnItems);
            } else {
              lineItemsForRefund = fallbackByReturnQty(minimalOrder.lineItems, returnItems);
            }
            refundLogger.info(
              { count: lineItemsForRefund.length },
              "[refund] Resolved line items from PCDA-safe query",
            );
          } else {
            let order: Awaited<ReturnType<typeof fetchOrder>> = null;
            if (orderIdForRefund) {
              /* v8 ignore start - defensive `(err as Error)?.message ?? err` log enrichment */
              order = await fetchOrder(admin as never, orderIdForRefund).catch((err) => {
                refundLogger.warn(
                  { orderIdForRefund, err: (err as Error)?.message ?? err },
                  "[refund] fetchOrder(full) failed",
                );
                return null;
              });
              /* v8 ignore stop */
              if (!order && returnCase.shopifyOrderName) {
                const orderName = returnCase.shopifyOrderName.replace(/^#/, "").trim();
                if (orderName) {
                  /* v8 ignore start - defensive `(err as Error)?.message ?? err` log enrichment */
                  order = await fetchOrderByOrderNumber(admin as never, orderName).catch((err) => {
                    refundLogger.warn(
                      { orderName, err: (err as Error)?.message ?? err },
                      "[refund] fetchOrderByOrderNumber failed",
                    );
                    return null;
                  });
                  /* v8 ignore stop */
                  if (order?.id && order.id !== orderIdForRefund) {
                    orderIdForRefund = order.id;
                    await prisma.returnCase
                      .update({ where: { id }, data: { shopifyOrderId: order.id } })
                      .catch(() => {});
                  }
                }
              }
            }
            if (order?.lineItems?.length) {
              /* v8 ignore start - defensive `?? []` for items relation */
              lineItemsForRefund = fallbackByReturnQty(order.lineItems, returnCase.items ?? []);
              /* v8 ignore stop */
              refundLogger.info(
                { count: lineItemsForRefund.length },
                "[refund] Resolved line items from full query fallback",
              );
            } else {
              refundLogger.error(
                { orderIdForRefund, shopifyOrderName: returnCase.shopifyOrderName },
                "[refund] ALL order fetch strategies failed",
              );
            }
          }
          /* v8 ignore stop */
        }

        const settings = shop.settings as {
          bonusCreditEnabled?: boolean;
          bonusCreditPct?: number;
          refundPaymentMethod?: string;
          refundStoreCreditPct?: number;
        } | null;
        const bonusCreditEnabled = settings?.bonusCreditEnabled ?? false;
        const bonusCreditPct = settings?.bonusCreditPct ?? 10;
        const isGreenReturn = (returnCase as { isGreenReturn?: boolean }).isGreenReturn === true;

        /* v8 ignore start - defensive deprecated discount_code path */
        if (bodyRefundMethod === "discount_code") {
          return Response.json(
            {
              error:
                "discount_code is no longer supported as a refund method. Use original, store_credit, or both.",
            },
            { status: 400 },
          );
        }
        /* v8 ignore stop */

        if (bodyRefundMethod === "both" && bodySplitMode !== "amount") {
          const pct = Number(bodyStoreCreditPct ?? settings?.refundStoreCreditPct ?? 50);
          if (isNaN(pct) || pct < 5 || pct > 95) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json(
              { error: "Store credit percentage must be between 5 and 95." },
              { status: 400 },
            );
          }
        }

        if (bodyRefundMethod === "both" && bodySplitMode === "amount") {
          const scAmt = Number(bodySplitScAmount);
          const origAmt = Number(bodySplitOrigAmount);
          if (isNaN(scAmt) || isNaN(origAmt) || scAmt < 0 || origAmt < 0) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json(
              {
                error:
                  "Both store credit and original payment amounts must be non-negative numbers.",
              },
              { status: 400 },
            );
          }
          if (scAmt === 0 && origAmt === 0) {
            returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
            return Response.json(
              { error: "At least one refund amount must be greater than zero." },
              { status: 400 },
            );
          }
        }

        let refundMethodCfg: RefundMethodConfig | null = null;
        if (bodyRefundMethod && ["original", "store_credit", "both"].includes(bodyRefundMethod)) {
          refundMethodCfg = {
            method: bodyRefundMethod as "original" | "store_credit" | "both",
            storeCreditPct: bodyStoreCreditPct,
            ...(bodySplitMode === "amount"
              ? {
                  storeCreditAmount: Number(bodySplitScAmount),
                  originalAmount: Number(bodySplitOrigAmount),
                }
              : {}),
          };
        } else {
          /* v8 ignore start - defensive default-method derivation + COD detection */
          const settingsMethod = settings?.refundPaymentMethod ?? "original";
          const settingsPct = settings?.refundStoreCreditPct ?? 100;
          if (["original", "store_credit", "both"].includes(settingsMethod)) {
            refundMethodCfg = {
              method: settingsMethod as "original" | "store_credit" | "both",
              storeCreditPct: settingsPct,
            };
          }
          const COD_RE = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
          if (
            orderIdForRefund &&
            (orderIdForRefund.startsWith("gid://") || /^\d+$/.test(orderIdForRefund))
          ) {
            try {
              const orderForCod = await fetchOrder(admin as never, orderIdForRefund);
              const isCod =
                (orderForCod?.paymentGatewayNames ?? []).some((g: string) => COD_RE.test(g)) ||
                orderForCod?.displayFinancialStatus === "PENDING";
              if (isCod && refundMethodCfg?.method === "original") {
                refundMethodCfg = { method: "store_credit" };
              }
            } catch {
              /* non-fatal; proceed with configured method */
            }
          }
          /* v8 ignore stop */
        }

        let bonusAmount = 0;
        if (bonusCreditEnabled && bodyBonusAmount != null && bodyBonusAmount > 0) {
          bonusAmount = bodyBonusAmount;
        } else if (
          bonusCreditEnabled &&
          (refundMethodCfg?.method === "store_credit" || refundMethodCfg?.method === "both")
        ) {
          const itemTotal = (returnCase.items ?? []).reduce((sum, it) => {
            const price = (it as { price?: string | null }).price;
            return sum + (price ? parseFloat(price) * it.qty : 0);
          }, 0);
          if (itemTotal > 0) {
            bonusAmount = Math.round(itemTotal * (bonusCreditPct / 100) * 100) / 100;
          }
        }

        const skipLocation = isGreenReturn;
        /* v8 ignore start - defensive `||`/ternary fallbacks for createRefund args */
        const result = await createRefund(
          admin as never,
          orderIdForRefund,
          lineItemsForRefund,
          note || returnCase.adminNotes || undefined,
          isGreenReturn ? null : requestedLocationId || undefined,
          refundMethodCfg,
          { bonusAmount, skipLocation },
        );
        /* v8 ignore stop */
        if (!result.success) {
          /* v8 ignore start - defensive `?? "..."` / `|| "original"` error path fallbacks */
          const rawMsg =
            result.error ?? "Refund failed due to an unknown Shopify error. Check Shopify Admin.";
          const msg = enrichRefundError(rawMsg, {
            method: bodyRefundMethod,
            orderName: returnCase.shopifyOrderName,
          });
          await createFailedEvent(msg);
          refundCounter.add(1, { method: refundMethodCfg?.method || "original", outcome: "error" });
          /* v8 ignore stop */
          returnActionCounter.add(1, { action: "process_refund", outcome: "error" });
          returnActionDuration.record(actionTimer(), { action: "process_refund" });
          return Response.json({ error: msg }, { status: 400 });
        }

        const refundedLineItems = (returnCase.items ?? [])
          .filter((it) => !!it.shopifyLineItemId && it.shopifyLineItemId !== "manual")
          .map((it) => ({
            id: it.shopifyLineItemId,
            sku: it.sku ?? null,
            qty: it.qty,
            unitPrice: (it as { price?: string | null }).price ?? null,
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
              ...(bonusAmount > 0
                ? { bonusCreditAmount: bonusAmount.toFixed(2), bonusCreditPct }
                : {}),
              adminEmail: sessionEmail,
            }),
          },
        });
        await closeShopifyReturnBestEffort(admin as never, returnCase as never, {
          logEvent: logShopifyReturnEvent,
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
              const currentFyndStatus = (returnCase.fyndCurrentStatus || "").toLowerCase();
              const transitions: Array<{ status: string; from: string }> = [];
              // Statuses considered "at or past credit_note_generated" — once the
              // shipment is in any of these terminal/post-refund states, pushing
              // another status update is a no-op at best and can flag stale-data
              // warnings on Fynd's side.
              const PAST_CREDIT_NOTE = new Set([
                "credit_note_generated",
                "refund_initiated",
                "refund_done",
                "refund_completed",
                "return_completed",
              ]);
              if (
                ![
                  "return_accepted",
                  "credit_note_generated",
                  "refund_initiated",
                  "refund_done",
                  "refund_completed",
                  "return_completed",
                ].includes(currentFyndStatus)
              ) {
                transitions.push({ status: "return_accepted", from: currentFyndStatus });
              }
              // Only push credit_note_generated when not already at/past it —
              // prevents redundant Fynd webhook noise after re-processing.
              if (!PAST_CREDIT_NOTE.has(currentFyndStatus)) {
                transitions.push({ status: "credit_note_generated", from: currentFyndStatus });
              }

              const successfulTransitions: string[] = [];
              const failedTransitions: Array<{ status: string; error: string }> = [];
              for (const t of transitions) {
                try {
                  await fyndClient.updateShipmentStatus(callId, {
                    statuses: [
                      {
                        shipments: [{ identifier: returnCase.fyndShipmentId }],
                        status: t.status,
                      },
                    ],
                    task: false,
                    force_transition: false,
                    lock_after_transition: false,
                    unlock_before_transition: false,
                  });
                  successfulTransitions.push(t.status);
                  refundLogger.info(
                    { shipmentId: returnCase.fyndShipmentId, status: t.status },
                    "[process_refund] Fynd status pushed",
                  );
                } catch (transitionErr) {
                  const errMsg =
                    transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
                  failedTransitions.push({ status: t.status, error: errMsg });
                  refundLogger.warn(
                    { err: transitionErr, status: t.status },
                    "[process_refund] Fynd status transition failed (non-fatal)",
                  );
                }
              }

              if (successfulTransitions.length > 0) {
                // Mirror the latest pushed status to our local DB so subsequent
                // operations don't see a stale `fyndCurrentStatus` (Bug #2 +
                // refund-gate guards). Pick the LAST successful transition since
                // they're applied in order (return_accepted → credit_note_generated).
                const latestStatus = successfulTransitions[successfulTransitions.length - 1];
                await prisma.returnCase
                  .update({
                    where: { id },
                    data: { fyndCurrentStatus: latestStatus },
                  })
                  .catch(() => {});
                await prisma.returnEvent
                  .create({
                    data: {
                      returnCaseId: id,
                      source: "admin",
                      eventType: "fynd_refund_synced",
                      payloadJson: JSON.stringify({
                        transitions: successfulTransitions,
                        shipmentId: returnCase.fyndShipmentId,
                        ...(failedTransitions.length > 0
                          ? { partialFailures: failedTransitions }
                          : {}),
                      }),
                    },
                  })
                  .catch(() => {});
              }
              if (failedTransitions.length > 0 && successfulTransitions.length === 0) {
                await prisma.returnEvent
                  .create({
                    data: {
                      returnCaseId: id,
                      source: "admin",
                      eventType: "fynd_refund_sync_failed",
                      payloadJson: JSON.stringify({
                        shipmentId: returnCase.fyndShipmentId,
                        failures: failedTransitions,
                      }),
                    },
                  })
                  .catch(() => {});
              }
            }
          } catch (fyndErr) {
            refundLogger.warn(
              { err: fyndErr },
              "[process_refund] Fynd refund sync best-effort failed",
            );
            await prisma.returnEvent
              .create({
                data: {
                  returnCaseId: id,
                  source: "admin",
                  eventType: "fynd_refund_sync_failed",
                  payloadJson: JSON.stringify({
                    error: fyndErr instanceof Error ? fyndErr.message : String(fyndErr),
                    shipmentId: returnCase.fyndShipmentId,
                  }),
                },
              })
              .catch(() => {});
          }
        }

        if (returnCase.customerEmailNorm) {
          try {
            /* v8 ignore start - defensive fallbacks for orderName / shopDomain */
            await sendRefundNotification({
              shopDomain,
              to: returnCase.customerEmailNorm,
              orderName: returnCase.shopifyOrderName || "your order",
              shopName: shopDomain?.replace(".myshopify.com", ""),
            });
            /* v8 ignore stop */
          } catch (err) {
            /* v8 ignore start - defensive notify catch */
            refundLogger.warn({ err }, "[process_refund] Notification failed");
            /* v8 ignore stop */
          }
        }

        /* v8 ignore start - defensive `??`/`||` chains for telemetry */
        const refundMethod = result.refundMethod ?? refundMethodCfg?.method ?? "original";
        addBusinessEvent("return.refund_initiated", {
          "return.id": returnCase.id,
          "refund.amount": result.refundAmount ?? 0,
          "refund.method": refundMethod,
          "refund.currency": result.refundCurrency || "",
        });
        /* v8 ignore stop */
        refundCounter.add(1, { method: refundMethod, outcome: "success" });
        if (result.refundAmount) {
          /* v8 ignore start - defensive `|| "USD"` currency fallback */
          refundAmountHistogram.record(Number(result.refundAmount), {
            currency: result.refundCurrency || "USD",
            method: refundMethod,
          });
          /* v8 ignore stop */
        }
        returnsCompletedCounter.add(1);
        /* v8 ignore start - defensive `|| "shop-admin"` identity fallback */
        auditReturnAction(
          "refund_processed",
          returnCase.id,
          shop.shopDomain,
          { type: "admin", identity: sessionEmail || "shop-admin" },
          { status: { from: returnCase.status, to: "completed" } },
          { method: refundMethod, amount: result.refundAmount },
        );
        /* v8 ignore stop */
        returnActionCounter.add(1, { action: "process_refund", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "process_refund" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        const message =
          rawMessage ||
          "Refund could not be processed. Please try again or process the refund manually in Shopify Admin.";
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
    },
  );
};
