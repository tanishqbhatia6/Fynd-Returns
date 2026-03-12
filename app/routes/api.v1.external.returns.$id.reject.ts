import type { ActionFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import { createAdminClient, closeShopifyReturnBestEffort } from "../lib/shopify-admin.server";
import prisma from "../db.server";

const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST");
  }

  const rl = checkRateLimit(request, "external.returns.reject");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "write_returns");
  if (!auth.ok) return auth.response;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Return ID is required");

  let body: { rejectionReason?: string; note?: string } = {};
  try { body = await request.json(); } catch { /* empty */ }

  if (!body.rejectionReason || !body.rejectionReason.trim()) {
    return apiError(400, "BAD_REQUEST", "rejectionReason is required");
  }
  if (body.rejectionReason.length > 500) {
    return apiError(400, "BAD_REQUEST", "rejectionReason must be 500 characters or less");
  }

  try {
    const returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: auth.shopId },
    });
    if (!returnCase) return apiError(404, "NOT_FOUND", `Return with ID ${id} not found`);

    if (TERMINAL_STATUSES.includes(returnCase.status.toLowerCase())) {
      return apiError(400, "INVALID_STATE", `Return is already ${returnCase.status}`);
    }

    const updateData: Record<string, unknown> = {
      status: "rejected",
      rejectionReason: body.rejectionReason.trim(),
    };
    if (body.note) updateData.adminNotes = [returnCase.adminNotes, body.note].filter(Boolean).join("\n");

    const updated = await prisma.returnCase.update({
      where: { id },
      data: updateData as any,
    });

    await prisma.returnEvent.create({
      data: {
        returnCaseId: id,
        source: "external_api",
        eventType: "rejected",
        payloadJson: JSON.stringify({ rejectionReason: body.rejectionReason, apiKeyId: auth.keyId }),
      },
    });

    // Decline the Shopify return (best-effort)
    const session = await prisma.session.findFirst({
      where: { shop: auth.shopDomain, isOnline: false },
      orderBy: { expires: "desc" },
    });
    if (session?.accessToken) {
      const admin = createAdminClient(auth.shopDomain, session.accessToken);
      await closeShopifyReturnBestEffort(admin, returnCase, {
        action: "decline",
        declineReason: body.rejectionReason!.trim(),
        logEvent: async (evt) => {
          await prisma.returnEvent.create({ data: { returnCaseId: id, source: "external_api", ...evt } }).catch(() => {});
        },
      });
    }

    dispatchWebhookEvent(auth.shopId, "return.rejected", {
      returnId: id,
      returnRequestNo: updated.returnRequestNo,
      status: "rejected",
      rejectionReason: body.rejectionReason,
      shopifyOrderName: updated.shopifyOrderName,
    });

    return apiSuccess({
      id,
      status: "rejected",
      message: "Return rejected successfully",
    });
  } catch (err) {
    console.error("[external.returns.reject]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to reject return");
  }
};
