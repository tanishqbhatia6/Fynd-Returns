import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import shopify from "../shopify.server";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { createFyndClientOrError } from "../lib/fynd.server";
import { createReturnOnFynd } from "../lib/fynd-returns.server";
import { fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { sendNewReturnNotification } from "../lib/notification.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";

const NON_TERMINAL_STATUSES = ["initiated", "pending", "processing", "in progress"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }

  const rl = checkRateLimit(request, "portal.create-return");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const body = await request.json();
    const shop = body.shop as string | undefined;
    const orderId = body.orderId as string | undefined;
    const shopifyOrderNameRaw = (body.shopifyOrderName as string | undefined)?.trim();
    const shopifyOrderName = shopifyOrderNameRaw?.startsWith("#")
      ? shopifyOrderNameRaw
      : shopifyOrderNameRaw
        ? `#${shopifyOrderNameRaw}`
        : undefined;
    const customerEmail = (body.customerEmail as string | undefined)?.trim().toLowerCase();
    const customerPhone = (body.customerPhone as string | undefined)?.trim().replace(/[^\d+]/g, '') || null;
    const customerName = (body.customerName as string | undefined)?.trim() || null;
    const items = body.items as Array<{ lineItemId: string; qty: number; reasonCode?: string }> | undefined;
    const manualMode = body.manual === true;
    const manualItemDescription = (body.manualItemDescription as string | undefined)?.trim();
    const customerNotes = (body.customerNotes as string | undefined)?.trim();

    if (!shop || !shopifyOrderName) {
      return withCors(
        Response.json({ error: "Shop and order number are required" }, { status: 400 }),
        request
      );
    }
    const orderNameClean = shopifyOrderName.replace(/^#/, "").trim();
    if (!orderNameClean || orderNameClean.length > 64) {
      return withCors(
        Response.json({ error: "Invalid order number" }, { status: 400 }),
        request
      );
    }
    if (!manualMode && !orderId) {
      return withCors(
        Response.json({ error: "orderId is required for automatic mode" }, { status: 400 }),
        request
      );
    }

    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
    if (!shopRecord) {
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    const settings = shopRecord.settings;
    const returnWindowDays = settings?.returnWindowDays ?? 30;

    const effectiveOrderId = manualMode ? `manual:${shopifyOrderName}` : orderId!;
    let itemsToCreate: Array<{ lineItemId: string; qty: number; reasonCode?: string; notes?: string }>;
    let lineItemsWithPrice: Array<{
      id: string;
      title?: string;
      variantTitle?: string;
      price?: string;
      imageUrl?: string;
      productTags?: string[];
    }> = [];

    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (manualMode) {
      if (!customerEmail) {
        return withCors(
          Response.json({ error: "Email is required for manual return requests" }, { status: 400 }),
          request
        );
      }
      if (!EMAIL_REGEX.test(customerEmail)) {
        return withCors(
          Response.json({ error: "Please enter a valid email address" }, { status: 400 }),
          request
        );
      }
      if (!manualItemDescription || manualItemDescription.length < 3) {
        return withCors(
          Response.json({ error: "Please describe the item(s) you want to return (at least 3 characters)" }, { status: 400 }),
          request
        );
      }
      if (manualItemDescription.length > 2000) {
        return withCors(
          Response.json({ error: "Item description is too long" }, { status: 400 }),
          request
        );
      }
      itemsToCreate = [{ lineItemId: "manual", qty: 1, reasonCode: body.reasonCode || "Other", notes: manualItemDescription }];

      // Best-effort fulfillment check for manual returns
      try {
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        const manualOrderLookup = await fetchOrderByOrderNumber(admin, orderNameClean);
        if (manualOrderLookup) {
          const manualFulfill = (manualOrderLookup.displayFulfillmentStatus ?? "").toUpperCase();
          const manualFinancial = (manualOrderLookup.displayFinancialStatus ?? "").toUpperCase();
          if (manualFulfill === "UNFULFILLED" || manualFulfill === "" || manualFulfill === "SCHEDULED" || manualFulfill === "ON_HOLD") {
            return withCors(
              Response.json({
                error: "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
              }, { status: 400 }),
              request
            );
          }
          if (manualFinancial === "REFUNDED" || manualFinancial === "VOIDED") {
            return withCors(
              Response.json({
                error: "This order has already been refunded and is not eligible for a return.",
              }, { status: 400 }),
              request
            );
          }
        }
      } catch {
        // If lookup fails (e.g., PCDA, session not found), allow manual submission — admin will review
      }
    } else {
      if (!items || !Array.isArray(items) || items.length === 0) {
        return withCors(
          Response.json({ error: "At least one item must be selected for return" }, { status: 400 }),
          request
        );
      }
      for (const it of items) {
        if (!it?.lineItemId || typeof it.qty !== "number" || it.qty < 1) {
          return withCors(
            Response.json({ error: "Each item must have lineItemId and qty >= 1" }, { status: 400 }),
            request
          );
        }
        if (it.qty > 999) {
          return withCors(
            Response.json({ error: "Item quantity exceeds maximum allowed" }, { status: 400 }),
            request
          );
        }
      }
      if (items.length > 100) {
        return withCors(
          Response.json({ error: "Too many items in return request" }, { status: 400 }),
          request
        );
      }
      itemsToCreate = items.map((it) => ({
        lineItemId: String(it.lineItemId).slice(0, 256),
        qty: Math.min(Math.max(1, Math.floor(it.qty)), 999),
        reasonCode: it.reasonCode ? String(it.reasonCode).slice(0, 256) : undefined,
      }));
    }

    // Race-safe duplicate check: will be re-checked inside transaction
    const existingPreCheck = await prisma.returnCase.findFirst({
      where: {
        shopId: shopRecord.id,
        shopifyOrderId: effectiveOrderId,
        status: { in: NON_TERMINAL_STATUSES },
      },
    });
    if (existingPreCheck) {
      return withCors(
        Response.json({
          error: "A return request for this order is already pending. Please wait for approval or rejection.",
        }, { status: 409 }),
        request
      );
    }

    // Server-side fulfillment status validation (non-manual mode)
    if (!manualMode && orderId) {
      try {
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        const liveOrder = await fetchOrder(admin, orderId);
        if (liveOrder) {
          const fulfillStatus = (liveOrder.displayFulfillmentStatus ?? "").toUpperCase();
          const finStatus = (liveOrder.displayFinancialStatus ?? "").toUpperCase();

          if (fulfillStatus === "UNFULFILLED" || fulfillStatus === "" || fulfillStatus === "SCHEDULED" || fulfillStatus === "ON_HOLD") {
            return withCors(
              Response.json({
                error: "This order has not been fulfilled yet. Returns can only be created for orders that have been shipped and delivered.",
              }, { status: 400 }),
              request
            );
          }
          if (finStatus === "REFUNDED" || finStatus === "VOIDED") {
            return withCors(
              Response.json({
                error: "This order has already been refunded and is not eligible for a return.",
              }, { status: 400 }),
              request
            );
          }
        }
      } catch (fulfillErr) {
        console.warn("[Portal create-return] Fulfillment status check failed:", fulfillErr);
        // If we can't verify, fall through — the order lookup would have already blocked in the portal
      }
    }

    if (!manualMode) {
      const orderCreatedAt = body.orderCreatedAt as string | undefined;
      const orderDate = orderCreatedAt ? new Date(orderCreatedAt) : new Date();
      const windowEnd = new Date(orderDate);
      windowEnd.setDate(windowEnd.getDate() + returnWindowDays);
      if (new Date() > windowEnd) {
        return withCors(
          Response.json({
            error: `Return window has expired. Returns are accepted within ${returnWindowDays} days of order date.`,
          }, { status: 400 }),
          request
        );
      }

      lineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
        id: string;
        title?: string;
        variantTitle?: string;
        price?: string;
        imageUrl?: string;
        productTags?: string[];
      }>;
      const validLineIds = new Set(lineItemsWithPrice.map((l) => l.id));
      for (const sel of itemsToCreate) {
        if (sel.lineItemId === "manual") continue;
        if (!validLineIds.has(sel.lineItemId)) {
          return withCors(
            Response.json({ error: "Invalid line item selected. Please refresh and try again." }, { status: 400 }),
            request
          );
        }
        const li = lineItemsWithPrice.find((l) => l.id === sel.lineItemId);
        const price = li?.price ? parseFloat(li.price) : undefined;
        const tags = li?.productTags ?? [];
        const eligibility = checkReturnEligibility(settings, {
          orderDate: orderCreatedAt ? new Date(orderCreatedAt) : new Date(),
          productPrice: price,
          productTags: tags.length ? tags : undefined,
          customerCountry: body.shippingCountry,
          customerProvince: body.shippingProvince,
        });
        if (!eligibility.eligible) {
          return withCors(
            Response.json({ error: eligibility.reason ?? "Item not eligible for return" }, { status: 400 }),
            request
          );
        }
      }
    }

    const status = settings?.autoApproveEnabled ? "approved" : "initiated";

    // Atomic transaction: re-check for duplicates + create return + event in one go
    let returnCase: Awaited<ReturnType<typeof prisma.returnCase.create>> & { returnRequestNo?: string | null };
    try {
      returnCase = await prisma.$transaction(async (tx) => {
        // Re-check inside transaction to prevent race conditions
        const dup = await tx.returnCase.findFirst({
          where: {
            shopId: shopRecord.id,
            shopifyOrderId: effectiveOrderId,
            status: { in: NON_TERMINAL_STATUSES },
          },
        });
        if (dup) {
          throw new Error("DUPLICATE_RETURN");
        }

        const rc = await tx.returnCase.create({
          data: {
            shopId: shopRecord.id,
            shopifyOrderId: effectiveOrderId,
            shopifyOrderName,
            customerEmailNorm: customerEmail || null,
            customerPhoneNorm: customerPhone || null,
            customerNotes: customerNotes || null,
            status,
            fyndSyncStatus: settings?.autoApproveEnabled ? "pending" : null,
            items: {
              create: itemsToCreate.map((it) => {
                const liInfo = lineItemsWithPrice?.find((l) => l.id === it.lineItemId);
                return {
                  shopifyLineItemId: it.lineItemId,
                  title: liInfo?.title || it.notes || null,
                  variantTitle: liInfo?.variantTitle || null,
                  sku: null,
                  price: liInfo?.price || null,
                  imageUrl: liInfo?.imageUrl || null,
                  qty: it.qty,
                  reasonCode: it.reasonCode || null,
                  notes: it.notes || null,
                };
              }),
            },
          },
          include: { items: true },
        });

        const returnRequestNo = formatReturnRequestId(rc.id);
        await tx.returnCase.update({
          where: { id: rc.id },
          data: { returnRequestNo },
        });

        await tx.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "portal",
            eventType: status === "approved" ? "auto_approved" : "initiated",
            payloadJson: JSON.stringify({
              customerEmail: customerEmail || null,
              customerPhone: customerPhone || null,
              customerName: customerName || null,
              itemCount: itemsToCreate.length,
              manual: manualMode,
            }),
          },
        });

        return { ...rc, returnRequestNo };
      });
    } catch (txErr) {
      if (txErr instanceof Error && txErr.message === "DUPLICATE_RETURN") {
        return withCors(
          Response.json({
            error: "A return request for this order is already pending. Please wait for approval or rejection.",
          }, { status: 409 }),
          request
        );
      }
      throw txErr;
    }

    if (settings?.notificationNewReturn !== false) {
      const shopOwnerSessions = await prisma.session.findMany({
        where: { shop: shopDomain, isOnline: false },
        select: { email: true },
        take: 1,
      });
      const ownerEmail = shopOwnerSessions[0]?.email;
      if (ownerEmail) {
        try {
          await sendNewReturnNotification({
            to: ownerEmail,
            orderName: shopifyOrderName,
            customerEmail: customerEmail || undefined,
            itemCount: itemsToCreate.length,
            returnRequestId: returnCase.returnRequestNo ?? "",
            shopName: shopDomain.replace(".myshopify.com", ""),
          });
        } catch (notifyErr) {
          console.warn("[Portal create-return] New return notification failed:", notifyErr);
        }
      }
    }

    // When auto-approved, sync to Fynd so webhook can match returns
    if (status === "approved" && !manualMode && orderId) {
      try {
        const { admin } = await shopify.unauthenticated.admin(shopDomain);
        const order = await fetchOrder(admin, orderId);
        const affiliateOrderId = order?.affiliateOrderId ?? null;
        const fyndSettings = shopRecord.settings as Parameters<typeof createFyndClientOrError>[0] | null;
        const fyndResult = fyndSettings
          ? await createFyndClientOrError(fyndSettings, { requirePlatform: true })
          : { ok: false as const, error: "Fynd not configured" };
        if (fyndResult.ok && "getShipments" in fyndResult.client) {
          // Re-fetch with items for Fynd sync
          const rcWithItems = await prisma.returnCase.findUnique({
            where: { id: returnCase.id },
            include: { items: true },
          });
          if (!rcWithItems) throw new Error("Return case not found after creation");
          const fyndSync = await createReturnOnFynd(fyndResult.client, rcWithItems, { affiliateOrderId });
          if (fyndSync.success && (fyndSync.fyndReturnId ?? fyndSync.fyndShipmentId ?? fyndSync.alreadyExists)) {
            await prisma.returnCase.update({
              where: { id: returnCase.id },
              data: {
                fyndSyncStatus: "synced",
                fyndSyncError: null,
                ...(fyndSync.fyndReturnId && { fyndReturnId: fyndSync.fyndReturnId }),
                ...(fyndSync.fyndReturnNo && { fyndReturnNo: fyndSync.fyndReturnNo }),
                ...(fyndSync.fyndOrderId && { fyndOrderId: fyndSync.fyndOrderId }),
                ...(fyndSync.fyndShipmentId && { fyndShipmentId: fyndSync.fyndShipmentId }),
                ...(fyndSync.fyndPayload != null && {
                  fyndPayloadJson: JSON.stringify(fyndSync.fyndPayload),
                }),
              },
            });
            await prisma.returnEvent.create({
              data: {
                returnCaseId: returnCase.id,
                source: "portal",
                eventType: "fynd_sync",
                payloadJson: JSON.stringify({
                  fyndReturnId: fyndSync.fyndReturnId,
                  fyndShipmentId: fyndSync.fyndShipmentId,
                  alreadyExists: fyndSync.alreadyExists ?? false,
                }),
              },
            });
          }
        }
      } catch (fyndErr) {
        const errMsg = fyndErr instanceof Error ? fyndErr.message : String(fyndErr);
        console.warn("[Portal create-return] Fynd sync failed:", errMsg);
        // Schedule automatic retry instead of requiring manual admin intervention
        try {
          const { scheduleRetry } = await import("../lib/fynd-retry.server");
          await scheduleRetry(returnCase.id, errMsg);
        } catch { /* Non-fatal */ }
      }
    }

    const itemSummaries = itemsToCreate.map((it) => {
      if (it.lineItemId === "manual") {
        return { title: it.notes ?? "Manual return", qty: it.qty };
      }
      const li = lineItemsWithPrice.find((l) => l.id === it.lineItemId);
      return { title: li?.title ?? "Item", qty: it.qty };
    });

    const nextSteps =
      status === "approved"
        ? "Your return has been approved. The store will process your refund."
        : "The store will review your request. You'll receive an email once it's approved or if more information is needed.";

    return withCors(
      Response.json({
        success: true,
        returnId: returnCase.id,
        returnRequestId: formatReturnRequestId(returnCase.id),
        status: returnCase.status,
        message:
          status === "approved"
            ? "Return approved. Refund will be processed by the store."
            : "Return request submitted. You will be notified once it is reviewed.",
        summary: {
          orderName: shopifyOrderName,
          itemsCount: itemsToCreate.length,
          items: itemSummaries,
          status: returnCase.status,
          createdAt: returnCase.createdAt,
          nextSteps,
        },
      }),
      request
    );
  } catch (err) {
    console.error("Portal create return:", err);
    // Only expose safe, customer-facing error messages — never internal details
    const SAFE_PATTERNS = [
      /order has not been fulfilled/i,
      /already been refunded/i,
      /at least one item/i,
      /return window/i,
      /not eligible/i,
      /already pending/i,
      /required/i,
      /invalid.*email/i,
      /expired/i,
    ];
    const errMsg = err instanceof Error ? err.message : "";
    const isSafe = SAFE_PATTERNS.some((p) => p.test(errMsg));
    return withCors(
      Response.json({
        error: isSafe ? errMsg : "Something went wrong. Please try again later.",
      }, { status: 500 }),
      request
    );
  }
};
