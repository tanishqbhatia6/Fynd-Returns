import type { ActionFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import { createRefund, createDiscountCodeRefund, createAdminClient, closeShopifyReturnBestEffort, type RefundMethodConfig } from "../lib/shopify-admin.server";
import prisma from "../db.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST");
  }

  const rl = checkRateLimit(request, "external.returns.refund");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "write_returns");
  if (!auth.ok) return auth.response;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Return ID is required");

  let body: { refundMethod?: string; locationId?: string; note?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }

  // Whitelist refundMethod — same defence as status enum on the list endpoint.
  // Avoids passing arbitrary strings into downstream refund logic and gives the
  // caller a clear error instead of silent fall-through (P2 finding).
  if (body.refundMethod !== undefined) {
    const VALID_REFUND_METHODS = new Set(["original", "store_credit", "both", "discount_code"]);
    if (!VALID_REFUND_METHODS.has(body.refundMethod)) {
      return apiError(400, "BAD_REQUEST", `Invalid refundMethod. Must be one of: ${[...VALID_REFUND_METHODS].join(", ")}`);
    }
  }

  try {
    const returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: auth.shopId },
      include: { items: true },
    });
    if (!returnCase) return apiError(404, "NOT_FOUND", `Return with ID ${id} not found`);

    if (returnCase.status.toLowerCase() !== "approved") {
      return apiError(400, "INVALID_STATE", `Return must be approved before refunding (current: ${returnCase.status})`);
    }
    if (returnCase.refundStatus === "refunded") {
      return apiError(400, "INVALID_STATE", "Return has already been refunded");
    }

    // Get shop settings for refund configuration
    const settings = await prisma.shopSettings.findUnique({ where: { shopId: auth.shopId } });
    const refundMethod = body.refundMethod || settings?.refundPaymentMethod || "original";

    // Get Shopify session for admin API access
    const session = await prisma.session.findFirst({
      where: { shop: auth.shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });
    if (!session?.accessToken) {
      return apiError(500, "INTERNAL_ERROR", "No valid Shopify session found for this shop");
    }

    const admin = createAdminClient(auth.shopDomain, session.accessToken);

    // Determine location
    const locationId = body.locationId || settings?.refundLocationId || null;

    // Build line items for refund
    const lineItems = returnCase.items.map((item) => ({
      id: item.shopifyLineItemId,
      quantity: item.qty,
    }));

    // Process discount code refund path
    if (refundMethod === "discount_code") {
      const result = await createDiscountCodeRefund(admin, {
        orderId: returnCase.shopifyOrderId,
        lineItems,
        returnRequestNo: returnCase.returnRequestNo || id,
        prefix: settings?.discountCodePrefix || "RETURN",
        expiryDays: settings?.discountCodeExpiryDays || 90,
      });

      if (!result.success) {
        return apiError(400, "BAD_REQUEST", result.error || "Failed to create discount code refund");
      }

      await prisma.returnCase.update({
        where: { id },
        data: {
          refundStatus: "refunded",
          refundJson: JSON.stringify(result),
          discountCode: result.discountCode,
          discountCodeValue: result.discountValue,
        },
      });

      await prisma.returnEvent.create({
        data: {
          returnCaseId: id,
          source: "external_api",
          eventType: "refunded",
          payloadJson: JSON.stringify({ method: "discount_code", apiKeyId: auth.keyId }),
        },
      });
      // Close the Shopify return after discount code refund
      await closeShopifyReturnBestEffort(admin, returnCase, {
        logEvent: async (evt) => {
          await prisma.returnEvent.create({ data: { returnCaseId: id, source: "external_api", ...evt } }).catch(() => {});
        },
      });

      dispatchWebhookEvent(auth.shopId, "return.refunded", {
        returnId: id,
        returnRequestNo: returnCase.returnRequestNo,
        method: "discount_code",
        amount: result.discountValue,
        currency: result.discountCurrency || returnCase.currency,
      });

      return apiSuccess({
        id,
        refundStatus: "refunded",
        refundDetails: {
          amount: result.discountValue,
          currency: result.discountCurrency || returnCase.currency,
          method: "discount_code",
          discountCode: result.discountCode,
        },
        message: "Refund processed successfully",
      });
    }

    // Standard refund (original, store_credit, both)
    const refundMethodConfig: RefundMethodConfig = { method: refundMethod as any };

    const result = await createRefund(
      admin,
      returnCase.shopifyOrderId,
      lineItems,
      body.note || undefined,
      locationId,
      refundMethodConfig,
    );

    if (!result.success) {
      return apiError(400, "BAD_REQUEST", result.error || "Refund failed");
    }

    await prisma.returnCase.update({
      where: { id },
      data: {
        refundStatus: "refunded",
        status: "completed",
        refundJson: JSON.stringify(result),
      },
    });

    await prisma.returnEvent.create({
      data: {
        returnCaseId: id,
        source: "external_api",
        eventType: "refunded",
        payloadJson: JSON.stringify({ method: refundMethod, apiKeyId: auth.keyId }),
      },
    });
    // Close the Shopify return after standard refund
    await closeShopifyReturnBestEffort(admin, returnCase, {
      logEvent: async (evt) => {
        await prisma.returnEvent.create({ data: { returnCaseId: id, source: "external_api", ...evt } }).catch(() => {});
      },
    });

    dispatchWebhookEvent(auth.shopId, "return.refunded", {
      returnId: id,
      returnRequestNo: returnCase.returnRequestNo,
      method: refundMethod,
      amount: result.refundAmount,
      currency: result.refundCurrency || returnCase.currency,
    });

    return apiSuccess({
      id,
      refundStatus: "refunded",
      refundDetails: {
        refundId: result.refundId,
        amount: result.refundAmount,
        currency: result.refundCurrency || returnCase.currency,
        method: refundMethod,
      },
      message: "Refund processed successfully",
    });
  } catch (err) {
    console.error("[external.returns.refund]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to process refund");
  }
};
