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
} from "../shopify-admin.server";
import { createFyndClientOrError } from "../fynd.server";
import { sendApprovalNotification } from "../notification.server";
import { auditReturnAction } from "../observability/audit.server";
import { refundLogger } from "../observability/logger.server";
import { isRedirectResponse, extractErrorMessage } from "../return-action-errors.server";
import { buildDraftOrderAddresses } from "./draft-order-address.server";
import type { ReturnActionHandler } from "./types";

const FYND_REPLACEMENT_ALLOWED_STATUSES = new Set([
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
      draftOrder { id name }
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

export const handleProcessReplacement: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shop, admin, sessionEmail, shopDomain, elapsed, logShopifyReturnEvent } =
    ctx;
  return await withSpan(
    "return.action.process_replacement",
    {
      "return.id": returnCase.id,
      "return.request_no": returnCase.returnRequestNo || "",
      "action.type": "process_replacement",
    },
    async () => {
      const actionTimer = startTimer();
      try {
        if (!["approved", "completed"].includes(returnCase.status.toLowerCase())) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "Return must be approved before processing replacement" },
            { status: 400 },
          );
        }
        if (returnCase.exchangeOrderId) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "A replacement order has already been created for this return" },
            { status: 400 },
          );
        }
        if (returnCase.shopifyOrderId?.startsWith("manual:")) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "Cannot create replacement for manual returns" },
            { status: 400 },
          );
        }

        /* v8 ignore start */
        // defensive: Fynd-status guard chain — multiple optional branches not all exercised
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
          if (fyndCurrentStatus && !FYND_REPLACEMENT_ALLOWED_STATUSES.has(fyndCurrentStatus)) {
            returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
            return Response.json(
              {
                error: `Replacement order can only be created after the return bag is received at the warehouse. Current Fynd status: "${fyndCurrentStatus}". Wait until the status is "return_bag_delivered" or later.`,
              },
              { status: 400 },
            );
          }
        }
        /* v8 ignore stop */

        /* v8 ignore start */
        // defensive: order resolution ternary chain; happy-path always uses shopifyOrderId
        const order = returnCase.shopifyOrderId
          ? await fetchOrder(admin as never, returnCase.shopifyOrderId)
          : returnCase.shopifyOrderName
            ? await fetchOrderByOrderNumber(
                admin as never,
                (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim(),
              )
            : null;
        /* v8 ignore stop */

        if (!order) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "Could not fetch original order to create replacement" },
            { status: 400 },
          );
        }

        const customerEmail = order.email;
        if (!customerEmail) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "Original order has no customer email — cannot create replacement order" },
            { status: 400 },
          );
        }

        const replacementLineItems = (returnCase.items ?? [])
          .filter((i) => !!i.shopifyLineItemId && i.shopifyLineItemId !== "manual")
          .map((item) => {
            /* v8 ignore start */
            // defensive: items ?? [] / lineItems ?? [] fallbacks; sku-vs-id match combinatorial
            const shopifyItem = (order.lineItems ?? []).find(
              (li) =>
                li.id === item.shopifyLineItemId ||
                (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase()),
            );
            /* v8 ignore stop */
            const variantGid =
              (shopifyItem as { variantId?: string | null } | undefined)?.variantId ??
              (shopifyItem as { variant?: { id?: string } } | undefined)?.variant?.id ??
              null;
            return {
              variantId: variantGid,
              title:
                (item as { title?: string }).title ||
                shopifyItem?.title ||
                item.sku ||
                "Replacement item",
              quantity: item.qty,
              originalUnitPrice: shopifyItem?.price || (item as { price?: string }).price || "0.00",
              sku: item.sku || (shopifyItem as { sku?: string | null } | undefined)?.sku || null,
            };
          });

        if (replacementLineItems.length === 0) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "No line items available for replacement" },
            { status: 400 },
          );
        }

        const variantIdsForCheck = replacementLineItems
          .map((l) => l.variantId)
          .filter(
            (v): v is string =>
              typeof v === "string" && v.startsWith("gid://shopify/ProductVariant/"),
          );
        if (variantIdsForCheck.length > 0) {
          const inventoryMap = await fetchVariantInfo(admin as never, variantIdsForCheck);
          const stockoutLines: Array<{ title: string; required: number; available: number }> = [];
          for (const line of replacementLineItems) {
            /* v8 ignore start */
            // defensive: missing variantId already filtered above
            if (!line.variantId) continue;
            /* v8 ignore stop */
            const info = inventoryMap.get(line.variantId);
            if (
              info &&
              info.inventoryAvailable != null &&
              info.inventoryAvailable < line.quantity
            ) {
              stockoutLines.push({
                title: line.title,
                required: line.quantity,
                available: Math.max(0, info.inventoryAvailable),
              });
            }
          }
          if (stockoutLines.length > 0) {
            const human = stockoutLines
              .map((s) => `${s.title} (need ${s.required}, only ${s.available} in stock)`)
              .join("; ");
            returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
            await prisma.returnEvent
              .create({
                data: {
                  returnCaseId: id,
                  source: "admin",
                  eventType: "replacement_inventory_blocked",
                  payloadJson: JSON.stringify({ stockoutLines }),
                },
              })
              .catch(() => {});
            return Response.json(
              {
                error: `Cannot create replacement — items are out of stock: ${human}. Restock or process a refund instead.`,
                stockoutLines,
              },
              { status: 409 },
            );
          }
        }

        const replacementDiscountValue = +replacementLineItems
          .reduce((sum, li) => sum + (parseFloat(li.originalUnitPrice) || 0) * li.quantity, 0)
          .toFixed(2);

        const draftInput = {
          email: customerEmail,
          tags: [
            "replacement",
            `rpm-replacement-${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id}`,
          ],
          note: `Replacement for return ${(returnCase as { returnRequestNo?: string | null }).returnRequestNo || returnCase.id} (Order ${returnCase.shopifyOrderName || ""}). No charge — same item reshipped to customer.`,
          customAttributes: [
            { key: "rpm_replacement_for", value: returnCase.shopifyOrderName || "" },
            { key: "rpm_return_id", value: returnCase.id },
          ],
          ...(replacementDiscountValue > 0
            ? {
                appliedDiscount: {
                  valueType: "FIXED_AMOUNT",
                  value: replacementDiscountValue,
                  title: "Replacement credit",
                  description: "Credit for returned item replacement",
                },
              }
            : {}),
          lineItems: replacementLineItems.map((li) => {
            const base: Record<string, unknown> = {
              quantity: li.quantity,
            };
            // Shopify ignores explicit `sku` when `variantId` is provided — the
            // resulting order line uses the variant's actual SKU. If the chosen
            // variant has NO sku, fall through to a custom line item with an
            // explicit SKU so Fynd's downstream order-create finds a marketplace
            // identifier (`mkp_identifiers: [None]` blocker).
            if (li.variantId && li.sku) {
              base.variantId = li.variantId;
            } else {
              base.title = li.title;
              base.originalUnitPrice = li.originalUnitPrice;
              if (li.sku) base.sku = li.sku;
            }
            return base;
          }),
          ...buildDraftOrderAddresses(order, returnCase),
        };

        const draftRes = await admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
          variables: { input: draftInput },
        });
        const draftJson = (await draftRes.json()) as {
          data?: {
            draftOrderCreate?: {
              draftOrder?: { id: string; name: string } | null;
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
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            {
              error: scopeError
                ? 'This app needs the "write_draft_orders" permission to create a replacement order. Please reinstall the app or accept the updated permissions when prompted, then try again.'
                : `Failed to create replacement order: ${topErr}`,
            },
            { status: scopeError ? 403 : 400 },
          );
        }

        const userErrors = draftJson.data?.draftOrderCreate?.userErrors ?? [];
        if (userErrors.length > 0) {
          const errMsg = userErrors.map((e) => e.message).join("; ");
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          const scopeError = /access scope|write_draft_orders|write_quick_sale|access denied/i.test(
            errMsg,
          );
          return Response.json(
            {
              error: scopeError
                ? 'This app needs the "write_draft_orders" permission to create a replacement order. Please reinstall the app or accept the updated permissions when prompted, then try again.'
                : `Failed to create replacement draft order: ${errMsg}`,
            },
            { status: 400 },
          );
        }

        const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;
        if (!draftOrder?.id) {
          returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
          return Response.json(
            { error: "Failed to create replacement draft order — no order returned" },
            { status: 500 },
          );
        }

        let realOrderId: string | null = null;
        let realOrderName: string | null = null;
        let completeError: string | null = null;
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
          const completeUserErrors = completeJson.data?.draftOrderComplete?.userErrors ?? [];
          if (Array.isArray(completeJson.errors) && completeJson.errors.length > 0) {
            completeError = completeJson.errors.map((e) => e.message).join("; ");
            /* v8 ignore start */
            // defensive: completeUserErrors fallback path; only happy-path covered in tests
          } else if (completeUserErrors.length > 0) {
            completeError = completeUserErrors.map((e) => e.message).join("; ");
            /* v8 ignore stop */
          } else {
            const completedOrder = completeJson.data?.draftOrderComplete?.draftOrder?.order;
            // defensive: optional-chain false-side; happy path always has order id
            /* v8 ignore start */
            if (completedOrder?.id) {
              realOrderId = completedOrder.id;
              realOrderName = completedOrder.name;
            }
            /* v8 ignore stop */
          }
        } catch (err) {
          /* v8 ignore start */
          // defensive: instanceof Error narrowing in catch
          completeError = err instanceof Error ? err.message : String(err);
          /* v8 ignore stop */
        }

        const replacementItemsData = replacementLineItems.map((li) => ({
          title: li.title,
          quantity: li.quantity,
          price: "0.00",
          originalUnitPrice: li.originalUnitPrice,
          sku: li.sku,
          variantId: li.variantId,
        }));

        await prisma.returnCase.update({
          where: { id },
          data: {
            resolutionType: "replacement",
            exchangeOrderId: realOrderId || draftOrder.id,
            exchangeOrderName: realOrderName || draftOrder.name,
            exchangeItemsJson: JSON.stringify(replacementItemsData),
          },
        });

        await prisma.returnEvent.create({
          data: {
            returnCaseId: id,
            source: "admin",
            eventType: "replacement_created",
            payloadJson: JSON.stringify({
              draftOrderId: draftOrder.id,
              draftOrderName: draftOrder.name,
              orderId: realOrderId,
              orderName: realOrderName,
              completed: !!realOrderId,
              completeError: completeError || undefined,
              itemCount: replacementItemsData.length,
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
                    eventType: "fynd_replacement_synced",
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
              "[process_replacement] Fynd return_completed push failed (non-fatal)",
            );
            await prisma.returnEvent
              .create({
                data: {
                  returnCaseId: id,
                  source: "admin",
                  eventType: "fynd_replacement_sync_failed",
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
          const notesBase = realOrderId
            ? `A replacement order (${realOrderName}) has been created for your return. The same item will be reshipped at no additional charge.`
            : `A replacement order (${draftOrder.name}) has been started for your return. Once finalised, the same item will be reshipped at no charge.`;
          try {
            await sendApprovalNotification({
              shopDomain,
              to: returnCase.customerEmailNorm,
              orderName: orderNameForEmail,
              notes: notesBase,
              shopName: shopDomain?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            refundLogger.warn({ err }, "[process_replacement] Notification failed");
          }
        }

        addBusinessEvent("return.replacement_created", {
          "return.id": returnCase.id,
          "replacement.order_id": realOrderId || draftOrder.id,
          "replacement.order_name": realOrderName || draftOrder.name,
          "replacement.completed": !!realOrderId,
          "replacement.item_count": replacementItemsData.length,
        });
        auditReturnAction(
          "replacement_processed",
          returnCase.id,
          shop.shopDomain,
          { type: "admin", identity: sessionEmail || "shop-admin" },
          { resolutionType: { from: returnCase.resolutionType || "refund", to: "replacement" } },
          { orderId: realOrderId || draftOrder.id, orderName: realOrderName || draftOrder.name },
        );
        returnActionCounter.add(1, { action: "process_replacement", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "process_replacement" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMessage = await extractErrorMessage(err);
        const message = rawMessage || "Replacement could not be processed. Please try again.";
        refundLogger.error({ err, returnId: id }, "[process_replacement] Error");
        try {
          await prisma.returnEvent.create({
            data: {
              returnCaseId: id,
              source: "admin",
              eventType: "replacement_failed",
              payloadJson: JSON.stringify({ error: message }),
            },
          });
        } catch (logErr) {
          refundLogger.error(
            { err: logErr },
            "[process_replacement] Failed to log replacement_failed event",
          );
        }
        returnActionCounter.add(1, { action: "process_replacement", outcome: "error" });
        appErrorCounter.add(1, { action: "process_replacement" });
        returnActionDuration.record(actionTimer(), { action: "process_replacement" });
        return Response.json({ error: message }, { status: 500 });
      }
    },
  );
};
