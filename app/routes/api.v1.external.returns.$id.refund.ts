import type { ActionFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError, checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import {
  createRefund,
  createAdminClient,
  closeShopifyReturnBestEffort,
  type RefundMethodConfig,
} from "../lib/shopify-admin.server";
import { externalApiLogger } from "../lib/observability/logger.server";
import prisma from "../db.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST");
  }

  const rl = await checkRateLimit(request, "external.returns.refund");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "write_returns");
  if (!auth.ok) return auth.response;

  const perKey = await checkPerKeyRateLimit(
    request,
    "external.returns.refund",
    auth.keyId ?? "anon",
  );
  if (perKey) return perKey;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Return ID is required");

  let body: { refundMethod?: string; locationId?: string; note?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* empty */
  }

  // Whitelist refundMethod. Shopify App Store policy restricts refunds to
  // Shopify's refundCreate / storeCreditRefund — `discount_code` is
  // explicitly NOT a valid refund method. Callers still passing it get a
  // clear 400 rather than silent fall-through.
  if (body.refundMethod !== undefined) {
    const VALID_REFUND_METHODS = new Set(["original", "store_credit", "both"]);
    if (!VALID_REFUND_METHODS.has(body.refundMethod)) {
      return apiError(
        400,
        "BAD_REQUEST",
        `Invalid refundMethod. Must be one of: ${[...VALID_REFUND_METHODS].join(", ")}. ` +
          `Note: discount_code is no longer supported as a refund method.`,
      );
    }
  }

  try {
    const returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: auth.shopId },
      include: { items: true },
    });
    if (!returnCase) return apiError(404, "NOT_FOUND", `Return with ID ${id} not found`);

    if (returnCase.status.toLowerCase() !== "approved") {
      return apiError(
        400,
        "INVALID_STATE",
        `Return must be approved before refunding (current: ${returnCase.status})`,
      );
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

    // Legacy stored setting may still be `discount_code` on some shops —
    // coerce to `original` before reaching createRefund() so the request
    // still succeeds instead of erroring on an invalid method. Fresh
    // callers hit the whitelist above before reaching this point.
    const safeMethod = refundMethod === "discount_code" ? "original" : refundMethod;

    // Standard refund (original, store_credit, both)
    const refundMethodConfig: RefundMethodConfig = {
      method: safeMethod as RefundMethodConfig["method"],
    };

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
        payloadJson: JSON.stringify({ method: safeMethod, apiKeyId: auth.keyId }),
      },
    });
    // Close the Shopify return after standard refund
    await closeShopifyReturnBestEffort(admin, returnCase, {
      logEvent: async (evt) => {
        await prisma.returnEvent
          .create({ data: { returnCaseId: id, source: "external_api", ...evt } })
          .catch(() => {});
      },
    });

    dispatchWebhookEvent(auth.shopId, "return.refunded", {
      returnId: id,
      returnRequestNo: returnCase.returnRequestNo,
      method: safeMethod,
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
        method: safeMethod,
      },
      message: "Refund processed successfully",
    });
  } catch (err) {
    externalApiLogger.error(
      {
        endpoint: "external.returns.refund",
        shopId: auth.shopId,
        keyId: auth.keyId,
        returnId: id,
        err,
      },
      "External return refund failed",
    );
    return apiError(500, "INTERNAL_ERROR", "Failed to process refund");
  }
};
