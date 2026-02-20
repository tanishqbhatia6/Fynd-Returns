import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { checkReturnEligibility } from "../lib/return-rules.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";

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
    const items = body.items as Array<{ lineItemId: string; qty: number; reasonCode?: string }> | undefined;
    const manualMode = body.manual === true;
    const manualItemDescription = (body.manualItemDescription as string | undefined)?.trim();

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
      }
      itemsToCreate = items.map((it) => ({ lineItemId: it.lineItemId, qty: it.qty, reasonCode: it.reasonCode }));
    }

    const existing = await prisma.returnCase.findFirst({
      where: {
        shopId: shopRecord.id,
        shopifyOrderId: effectiveOrderId,
        status: { in: NON_TERMINAL_STATUSES },
      },
    });
    if (existing) {
      return withCors(
        Response.json({
          error: "A return request for this order is already pending. Please wait for approval or rejection.",
        }, { status: 409 }),
        request
      );
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

      const lineItemsWithPrice = (body.lineItemsWithPrice ?? []) as Array<{
        id: string;
        price?: string;
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

    const returnCase = await prisma.returnCase.create({
      data: {
        shopId: shopRecord.id,
        shopifyOrderId: effectiveOrderId,
        shopifyOrderName,
        customerEmailNorm: customerEmail || null,
        status,
        items: {
          create: itemsToCreate.map((it) => ({
            shopifyLineItemId: it.lineItemId,
            qty: it.qty,
            reasonCode: it.reasonCode || null,
            notes: it.notes || null,
          })),
        },
      },
      include: { items: true },
    });

    await prisma.returnEvent.create({
      data: {
        returnCaseId: returnCase.id,
        source: "portal",
        eventType: status === "approved" ? "auto_approved" : "initiated",
        payloadJson: JSON.stringify({
          customerEmail: customerEmail || null,
          itemCount: itemsToCreate.length,
          manual: manualMode,
        }),
      },
    });

    return withCors(
      Response.json({
        success: true,
        returnId: returnCase.id,
        status: returnCase.status,
        message:
          status === "approved"
            ? "Return approved. Refund will be processed by the store."
            : "Return request submitted. You will be notified once it is reviewed.",
      }),
      request
    );
  } catch (err) {
    console.error("Portal create return:", err);
    return withCors(
      Response.json({ error: err instanceof Error ? err.message : "Failed to create return" }, { status: 500 }),
      request
    );
  }
};
