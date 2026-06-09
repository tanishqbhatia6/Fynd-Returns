import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  parseReturnIdConfig,
  buildReturnRequestId,
  formatReturnRequestId,
} from "../lib/return-request-id";
import { nextReturnIdCounter } from "../lib/return-id-counter.server";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { normalizeSourceChannel } from "../lib/source-channel.server";
import { evaluateAutoApproveRules, parseAutoApproveRules } from "../lib/auto-approve.server";
import {
  fetchOrderByFyndAffiliateId,
  fetchOrderByOrderNumber,
  withRestCredentials,
} from "../lib/shopify-admin.server";
import shopify from "../shopify.server";
import { appLogger } from "../lib/observability/logger.server";

/**
 * Admin API: Create a return on behalf of a customer.
 *
 * POST /api/admin/create-return
 *
 * When adminOverride is true, all eligibility checks (return window,
 * fulfillment gate, Fynd gate, blocklist, product restrictions) are skipped.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();

  // --- Required fields ---
  const shopifyOrderNameRaw = (body.shopifyOrderName as string | undefined)?.trim();
  if (!shopifyOrderNameRaw) {
    return Response.json({ error: "shopifyOrderName is required" }, { status: 400 });
  }
  const shopifyOrderName = shopifyOrderNameRaw.startsWith("#")
    ? shopifyOrderNameRaw
    : `#${shopifyOrderNameRaw}`;

  const items = body.items as
    | Array<{
        lineItemId: string;
        qty: number;
        reasonCode?: string;
        notes?: string;
        condition?: string;
        sku?: string;
        fyndShipmentId?: string;
        fyndBagId?: string;
        fyndArticleId?: string;
        fyndAffiliateLineId?: string;
        fyndSellerIdentifier?: string;
        fyndItemId?: string;
        fyndQuantityAvailable?: number;
        fyndPriceEffective?: string;
        fyndSize?: string;
        fyndLineNumber?: number;
      }>
    | undefined;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return Response.json(
      { error: "items is required and must be a non-empty array" },
      { status: 400 },
    );
  }

  // --- Optional fields ---
  const customerEmail = (body.customerEmail as string | undefined)?.trim().toLowerCase() || null;
  const customerPhone =
    (body.customerPhone as string | undefined)?.trim().replace(/[^\d+]/g, "") || null;
  const customerName = (body.customerName as string | undefined)?.trim() || null;
  const customerCity = (body.customerCity as string | undefined)?.trim() || null;
  const customerCountry = (body.customerCountry as string | undefined)?.trim() || null;
  const customerAddress1 =
    (body.customerAddress1 as string | undefined)?.trim().slice(0, 500) || null;
  const customerAddress2 =
    (body.customerAddress2 as string | undefined)?.trim().slice(0, 500) || null;
  const customerProvince =
    (body.customerProvince as string | undefined)?.trim().slice(0, 100) || null;
  const customerZip = (body.customerZip as string | undefined)?.trim().slice(0, 20) || null;
  const customerLandmark =
    (body.customerLandmark as string | undefined)?.trim().slice(0, 500) || null;

  /* v8 ignore start - defensive fallback for missing resolutionType */
  const resolutionType = (body.resolutionType as string | undefined) || "refund";
  /* v8 ignore stop */
  if (!["refund", "exchange", "store_credit", "replacement"].includes(resolutionType)) {
    return Response.json({ error: "Invalid resolutionType" }, { status: 400 });
  }
  /* v8 ignore start - defensive optional chain on optional exchange preference */
  const exchangePreference =
    resolutionType === "exchange"
      ? (body.exchangePreference as string | undefined)?.trim().slice(0, 500) || null
      : null;
  /* v8 ignore stop */

  const orderId = (body.orderId as string | undefined)?.trim() || null;
  const crmTicketId = (body.crmTicketId as string | undefined)?.trim() || null;
  const crmNotes = (body.crmNotes as string | undefined)?.trim() || null;
  const createdByStaff = (body.createdByStaff as string | undefined)?.trim() || null;
  const adminOverride = body.adminOverride === true;
  const currencyCode =
    (body.currency as string | undefined)?.trim().toUpperCase().slice(0, 10) || null;
  const orderCreatedAt = body.orderCreatedAt ? new Date(body.orderCreatedAt as string) : null;

  const lineItemsWithPrice =
    (body.lineItemsWithPrice as
      | Array<{
          id: string;
          title?: string;
          variantTitle?: string;
          price?: string | number;
          imageUrl?: string;
          sku?: string;
          quantity?: number;
        }>
      | undefined) ?? [];

  // --- Shop lookup ---
  const shopRecord = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });
  if (!shopRecord) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const settings = shopRecord.settings;

  // Quantity and duplicate-return validation is not an eligibility preference;
  // it protects inventory/refund correctness and must run even with adminOverride.
  const requestedQtyByLineItem = new Map<string, number>();
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      return Response.json(
        {
          error: `Invalid quantity for line item ${item.lineItemId}: must be a positive integer.`,
        },
        { status: 400 },
      );
    }
    requestedQtyByLineItem.set(
      item.lineItemId,
      (requestedQtyByLineItem.get(item.lineItemId) ?? 0) + item.qty,
    );
  }

  const requestedBagIds = items
    .map((item) => item.fyndBagId)
    .filter((id): id is string => Boolean(id));
  if (requestedBagIds.length > 0) {
    const existingBagReturn = await prisma.returnItem.findFirst({
      where: {
        fyndBagId: { in: requestedBagIds },
        returnCase: {
          shopId: shopRecord.id,
          status: { notIn: ["rejected", "cancelled"] },
        },
      },
      select: { fyndBagId: true, title: true },
    });
    if (existingBagReturn) {
      return Response.json(
        {
          error: `This article has already been returned${
            existingBagReturn.title ? `: ${existingBagReturn.title}` : ""
          }.`,
          fyndBagId: existingBagReturn.fyndBagId,
        },
        { status: 409 },
      );
    }
  }

  const orderedQtyByLineItem = new Map<string, number>();
  for (const li of lineItemsWithPrice) {
    if (typeof li.quantity === "number" && Number.isFinite(li.quantity)) {
      orderedQtyByLineItem.set(li.id, li.quantity);
    }
  }
  if (orderedQtyByLineItem.size > 0) {
    for (const [lineItemId, requestedQty] of requestedQtyByLineItem) {
      const orderedQty = orderedQtyByLineItem.get(lineItemId);
      if (typeof orderedQty === "number" && requestedQty > orderedQty) {
        return Response.json(
          {
            error: `Return quantity (${requestedQty}) exceeds the ordered quantity (${orderedQty}) for line item ${lineItemId}.`,
            lineItemId,
          },
          { status: 400 },
        );
      }
    }

    const existingLineReturns = await prisma.returnItem.findMany({
      where: {
        shopifyLineItemId: { in: [...requestedQtyByLineItem.keys()] },
        returnCase: {
          shopId: shopRecord.id,
          shopifyOrderName,
          status: { notIn: ["rejected", "cancelled"] },
        },
      },
      select: { shopifyLineItemId: true, qty: true, title: true },
    });
    const returnedQtyByLineItem = new Map<string, number>();
    for (const existing of existingLineReturns) {
      returnedQtyByLineItem.set(
        existing.shopifyLineItemId,
        (returnedQtyByLineItem.get(existing.shopifyLineItemId) ?? 0) + existing.qty,
      );
    }
    for (const [lineItemId, requestedQty] of requestedQtyByLineItem) {
      const orderedQty = orderedQtyByLineItem.get(lineItemId);
      if (!orderedQty) continue;
      const alreadyReturned = returnedQtyByLineItem.get(lineItemId) ?? 0;
      if (alreadyReturned + requestedQty > orderedQty) {
        const liInfo = lineItemsWithPrice.find((li) => li.id === lineItemId);
        return Response.json(
          {
            error: `Return quantity exceeds available for "${
              liInfo?.title ?? lineItemId
            }". ${alreadyReturned} already in return, ${requestedQty} requested, but only ${orderedQty} ordered.`,
            lineItemId,
          },
          { status: 409 },
        );
      }
    }
  }

  // --- Eligibility checks (skipped when adminOverride is true) ---
  if (!adminOverride) {
    // Blocklist check
    if (settings?.blocklistEnabled && settings.id) {
      const blockChecks: { type: string; value: string }[] = [];
      if (customerEmail) blockChecks.push({ type: "email", value: customerEmail });
      if (customerPhone) blockChecks.push({ type: "phone", value: customerPhone });
      blockChecks.push({ type: "order_name", value: shopifyOrderName.toLowerCase() });

      /* v8 ignore start - defensive guard; order_name is always pushed so length > 0 */
      if (blockChecks.length > 0) {
        /* v8 ignore stop */
        const blocked = await prisma.blocklistEntry.findFirst({
          where: {
            settingsId: settings.id,
            OR: blockChecks.map((c) => ({ type: c.type, value: c.value })),
          },
        });
        if (blocked) {
          return Response.json(
            { error: "This customer or order is blocked from creating returns." },
            { status: 403 },
          );
        }
      }
    }

    // Per-item eligibility validation. Quantity and duplicate-return guards run above
    // regardless of adminOverride because they protect inventory/refund correctness.
    for (const item of items) {
      const liInfo = lineItemsWithPrice.find((l) => l.id === item.lineItemId);
      const price = liInfo?.price != null ? Number(liInfo.price) : undefined;
      const eligibility = checkReturnEligibility(settings, {
        orderDate: orderCreatedAt ?? undefined,
        productPrice: price,
        customerCountry: customerCountry ?? undefined,
        customerProvince: customerProvince ?? undefined,
      });

      if (!eligibility.eligible) {
        return Response.json(
          /* v8 ignore start - defensive fallback when reason is missing */
          { error: eligibility.reason || "Return not eligible", lineItemId: item.lineItemId },
          /* v8 ignore stop */
          { status: 400 },
        );
      }
    }
  }

  // --- Resolve Shopify order ID ---
  let shopifyOrderId = orderId || "";
  // If orderId is not a Shopify GID, try to resolve it
  if (shopifyOrderId && !shopifyOrderId.startsWith("gid://")) {
    try {
      const shopSession = await prisma.session.findFirst({ where: { shop: shopDomain } });
      const { admin: rawAdmin } = await shopify.unauthenticated.admin(shopDomain);
      /* v8 ignore start - defensive optional chain on shopSession */
      const admin = withRestCredentials(rawAdmin, shopDomain, shopSession?.accessToken ?? "");
      /* v8 ignore stop */
      const orderNameClean = shopifyOrderName.replace(/^#/, "").trim();
      /* v8 ignore start - defensive fallback chain when first lookup fails */
      const resolved =
        (await fetchOrderByFyndAffiliateId(admin, orderNameClean).catch(() => null)) ??
        (await fetchOrderByOrderNumber(admin, orderNameClean).catch(() => null));
      if (resolved?.id?.startsWith("gid://")) {
        shopifyOrderId = resolved.id;
      }
      /* v8 ignore stop */
    } catch {
      /* non-fatal — proceed with what we have */
    }
  }

  // --- Determine status (auto-approve check) ---
  let initialStatus = "pending";
  if (settings?.autoApproveEnabled) {
    const autoRules = parseAutoApproveRules(settings.autoApproveRulesJson);
    if (autoRules.length > 0) {
      const firstReasonCode = items[0]?.reasonCode;
      const allTags = lineItemsWithPrice.flatMap((li) => {
        const liAny = li as Record<string, unknown>;
        return Array.isArray(liAny.productTags) ? (liAny.productTags as string[]) : [];
      });
      let customerReturnCount: number | undefined;
      if (customerEmail) {
        customerReturnCount = await prisma.returnCase.count({
          where: { shopId: shopRecord.id, customerEmailNorm: customerEmail },
        });
      }
      const ruleResult = evaluateAutoApproveRules(autoRules, {
        returnReason: firstReasonCode,
        productTags: allTags.length > 0 ? allTags : undefined,
        customerEmail: customerEmail ?? undefined,
        customerReturnCount,
      });
      initialStatus = ruleResult === "manual_review" ? "initiated" : "approved";
    } else {
      initialStatus = "approved";
    }
  }

  // --- Create ReturnCase + ReturnItems + ReturnEvent in a transaction ---
  try {
    const returnCase = await prisma.$transaction(async (tx) => {
      const rc = await tx.returnCase.create({
        data: {
          shopId: shopRecord.id,
          shopifyOrderId,
          shopifyOrderName,
          customerEmailNorm: customerEmail,
          customerPhoneNorm: customerPhone,
          customerName,
          customerCity,
          customerCountry,
          customerAddress1,
          customerAddress2,
          customerProvince,
          customerZip,
          customerLandmark,
          currency: currencyCode,
          status: initialStatus,
          resolutionType,
          exchangePreference,
          createdByChannel: "admin",
          sourceChannel: normalizeSourceChannel((body.sourceChannel as string | undefined) ?? null),
          createdByStaff,
          crmTicketId,
          crmNotes,
          orderProcessedAt: orderCreatedAt,
          fyndShipmentId: (() => {
            const shipIds = items.map((it) => it.fyndShipmentId).filter(Boolean) as string[];
            if (shipIds.length === 0) return null;
            const unique = [...new Set(shipIds)];
            return unique.length === 1 ? unique[0] : shipIds[0];
          })(),
          items: {
            create: items.map((item) => {
              const liInfo = lineItemsWithPrice.find((l) => l.id === item.lineItemId);
              return {
                shopifyLineItemId: item.lineItemId,
                title: liInfo?.title || null,
                variantTitle: liInfo?.variantTitle || null,
                sku: item.sku || liInfo?.sku || null,
                price: liInfo?.price != null ? String(liInfo.price) : null,
                imageUrl: liInfo?.imageUrl || null,
                /* v8 ignore start - defensive nullish fallback (qty validated upstream) */
                qty: item.qty ?? 1,
                /* v8 ignore stop */
                reasonCode: item.reasonCode || null,
                notes: item.notes || null,
                condition: item.condition || null,
                fyndShipmentId: item.fyndShipmentId || null,
                fyndBagId: item.fyndBagId || null,
                fyndArticleId: item.fyndArticleId || null,
                fyndAffiliateLineId: item.fyndAffiliateLineId || null,
                fyndSellerIdentifier: item.fyndSellerIdentifier || null,
                fyndItemId: item.fyndItemId || null,
                fyndQuantityAvailable: item.fyndQuantityAvailable ?? null,
                fyndPriceEffective: item.fyndPriceEffective || null,
                fyndSize: item.fyndSize || null,
                fyndLineNumber: item.fyndLineNumber ?? null,
              };
            }),
          },
        },
        include: { items: true },
      });

      // Generate user-friendly return request number using shop config
      const idConfig = parseReturnIdConfig(settings?.returnIdConfigJson as string | null);
      let counter: number | undefined;
      if (idConfig.bodyMode === "sequential" || idConfig.bodyMode === "date_sequential") {
        counter = await nextReturnIdCounter(settings!.id);
      }
      const returnRequestNo = buildReturnRequestId(idConfig, rc.id, counter);
      await tx.returnCase.update({
        where: { id: rc.id },
        data: { returnRequestNo },
      });

      // Create event
      await tx.returnEvent.create({
        data: {
          returnCaseId: rc.id,
          source: "admin",
          eventType: "initiated",
          payloadJson: JSON.stringify({
            adminOverride,
            createdByStaff,
            crmTicketId: crmTicketId || undefined,
            itemCount: items.length,
          }),
        },
      });

      return { ...rc, returnRequestNo };
    });

    return Response.json({
      success: true,
      returnCase: {
        id: returnCase.id,
        returnRequestNo: returnCase.returnRequestNo,
        status: returnCase.status,
        shopifyOrderName: returnCase.shopifyOrderName,
        resolutionType: returnCase.resolutionType,
        createdByChannel: returnCase.createdByChannel,
        createdByStaff: returnCase.createdByStaff,
        crmTicketId: returnCase.crmTicketId,
        itemCount: returnCase.items.length,
        createdAt: returnCase.createdAt,
      },
    });
  } catch (err) {
    appLogger.error({ err, shopDomain }, "Admin create-return failed");
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create return" },
      { status: 500 },
    );
  }
};
