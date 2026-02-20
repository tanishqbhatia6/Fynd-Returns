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
    const shopifyOrderName = body.shopifyOrderName as string | undefined;
    const customerEmail = (body.customerEmail as string | undefined)?.trim().toLowerCase();
    const items = body.items as Array<{ lineItemId: string; qty: number; reasonCode?: string }> | undefined;

    if (!shop || !orderId || !shopifyOrderName) {
      return withCors(
        Response.json({ error: "shop, orderId, and shopifyOrderName are required" }, { status: 400 }),
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

    const existing = await prisma.returnCase.findFirst({
      where: {
        shopId: shopRecord.id,
        shopifyOrderId: orderId,
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
    for (const sel of items) {
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
        orderDate,
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

    const status = settings?.autoApproveEnabled ? "approved" : "initiated";

    const returnCase = await prisma.returnCase.create({
      data: {
        shopId: shopRecord.id,
        shopifyOrderId: orderId,
        shopifyOrderName,
        customerEmailNorm: customerEmail || null,
        status,
        items: {
          create: items.map((it) => ({
            shopifyLineItemId: it.lineItemId,
            qty: it.qty,
            reasonCode: it.reasonCode || null,
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
          itemCount: items.length,
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
