import type { ActionFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { apiSuccess, apiError, checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { dispatchWebhookEvent } from "../lib/webhook-dispatch.server";
import prisma from "../db.server";

const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return apiError(405, "METHOD_NOT_ALLOWED", "Use POST");
  }

  const rl = await checkRateLimit(request, "external.returns.approve");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const auth = await authenticateApiKey(request, "write_returns");
  if (!auth.ok) return auth.response;

  // Per-API-key fairness — see api.v1.external.returns.ts for the pattern.
  const perKey = await checkPerKeyRateLimit(request, "external.returns.approve", auth.keyId ?? "anon");
  if (perKey) return perKey;

  const id = params.id;
  if (!id) return apiError(400, "BAD_REQUEST", "Return ID is required");

  let body: { note?: string; resolutionType?: string } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  try {
    const returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: auth.shopId },
    });
    if (!returnCase) return apiError(404, "NOT_FOUND", `Return with ID ${id} not found`);

    if (TERMINAL_STATUSES.includes(returnCase.status.toLowerCase())) {
      return apiError(400, "INVALID_STATE", `Return is already ${returnCase.status}`);
    }

    const VALID_RESOLUTION_TYPES = new Set(["refund", "exchange", "store_credit", "replacement"]);
    const updateData: Record<string, unknown> = { status: "approved" };
    if (body.resolutionType) {
      if (!VALID_RESOLUTION_TYPES.has(body.resolutionType)) {
        return apiError(400, "BAD_REQUEST", `Invalid resolutionType. Must be one of: ${[...VALID_RESOLUTION_TYPES].join(", ")}`);
      }
      updateData.resolutionType = body.resolutionType;
    }
    if (body.note) updateData.adminNotes = [returnCase.adminNotes, body.note].filter(Boolean).join("\n");

    const updated = await prisma.returnCase.update({
      where: { id },
      data: updateData as any,
    });

    await prisma.returnEvent.create({
      data: {
        returnCaseId: id,
        source: "external_api",
        eventType: "approved",
        payloadJson: JSON.stringify({ note: body.note, apiKeyId: auth.keyId }),
      },
    });

    dispatchWebhookEvent(auth.shopId, "return.approved", {
      returnId: id,
      returnRequestNo: updated.returnRequestNo,
      status: "approved",
      shopifyOrderName: updated.shopifyOrderName,
    });

    return apiSuccess({
      id,
      status: "approved",
      message: "Return approved successfully",
    });
  } catch (err) {
    console.error("[external.returns.approve]", err);
    return apiError(500, "INTERNAL_ERROR", "Failed to approve return");
  }
};
