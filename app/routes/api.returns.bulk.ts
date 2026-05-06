import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { sendApprovalNotification, sendRejectionNotification } from "../lib/notification.server";

const TERMINAL_STATUSES = ["approved", "rejected", "completed", "cancelled"];
const MAX_BULK_IDS = 100;

interface BulkRequestBody {
  action: "bulk_approve" | "bulk_reject" | "bulk_change_resolution";
  returnIds: string[];
  rejectionReason?: string;
  resolutionType?: string;
}

interface BulkResultItem {
  id: string;
  success: boolean;
  error?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  let body: BulkRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action: actionType, returnIds, rejectionReason } = body;

  if (
    !actionType ||
    !["bulk_approve", "bulk_reject", "bulk_change_resolution"].includes(actionType)
  ) {
    return Response.json(
      { error: "Invalid action. Must be bulk_approve, bulk_reject, or bulk_change_resolution." },
      { status: 400 },
    );
  }

  const VALID_RESOLUTION_TYPES = ["refund", "exchange", "store_credit", "replacement"];
  if (actionType === "bulk_change_resolution") {
    if (!body.resolutionType || !VALID_RESOLUTION_TYPES.includes(body.resolutionType)) {
      return Response.json(
        { error: `resolutionType must be one of: ${VALID_RESOLUTION_TYPES.join(", ")}` },
        { status: 400 },
      );
    }
  }

  if (!Array.isArray(returnIds) || returnIds.length === 0) {
    return Response.json({ error: "returnIds must be a non-empty array" }, { status: 400 });
  }

  if (returnIds.length > MAX_BULK_IDS) {
    return Response.json(
      { error: `Cannot process more than ${MAX_BULK_IDS} returns at once` },
      { status: 400 },
    );
  }

  if (actionType === "bulk_reject") {
    const reason = (rejectionReason ?? "").trim();
    if (!reason) {
      return Response.json({ error: "Rejection reason is required" }, { status: 400 });
    }
    if (reason.length > 500) {
      return Response.json(
        { error: "Rejection reason is too long (max 500 characters)" },
        { status: 400 },
      );
    }
  }

  const returnCases = await prisma.returnCase.findMany({
    where: {
      id: { in: returnIds },
      shopId: shop.id,
    },
  });

  const foundIds = new Set(returnCases.map((r) => r.id));
  const missingIds = returnIds.filter((id) => !foundIds.has(id));

  if (missingIds.length === returnIds.length) {
    return Response.json(
      { error: "None of the provided return IDs belong to this shop" },
      { status: 404 },
    );
  }

  const results: BulkResultItem[] = [];

  if (actionType === "bulk_approve") {
    // Optional resolutionType for bulk approve (default refund). Previously bulk
    // approve silently defaulted resolutionType to whatever the row already had,
    // so a merchant who wanted to bulk-approve as "exchange" had no way to
    // express that (P1 finding).
    const bulkResolutionType: string =
      body.resolutionType && VALID_RESOLUTION_TYPES.includes(body.resolutionType)
        ? body.resolutionType
        : "refund";

    for (const rc of returnCases) {
      if (TERMINAL_STATUSES.includes(rc.status.toLowerCase())) {
        results.push({
          id: rc.id,
          success: false,
          error: `Cannot approve: return is already ${rc.status}`,
        });
        continue;
      }

      try {
        // Idempotent transition — same pattern as the single-row approve.
        const upd = await prisma.returnCase.updateMany({
          where: {
            id: rc.id,
            status: { in: ["pending", "initiated", "processing", "in progress"] },
          },
          data: { status: "approved", resolutionType: bulkResolutionType },
        });
        if (upd.count === 0) {
          results.push({ id: rc.id, success: true, error: "Already approved" });
          continue;
        }
        await prisma.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "admin",
            eventType: "approved",
            payloadJson: JSON.stringify({
              note: "Bulk approved",
              bulk: true,
            }),
          },
        });

        if (rc.customerEmailNorm) {
          try {
            await sendApprovalNotification({
              shopDomain: session.shop,
              to: rc.customerEmailNorm,
              /* v8 ignore start - defensive fallback for missing order name */
              orderName: rc.shopifyOrderName || "your order",
              /* v8 ignore stop */
              notes: "Your return has been approved.",
              shopName: session.shop?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            console.warn(`[BulkApprove] Notification failed for ${rc.id}:`, err);
          }
        }

        results.push({ id: rc.id, success: true });
      } catch (err) {
        console.error(`[BulkApprove] Failed for ${rc.id}:`, err);
        results.push({
          id: rc.id,
          success: false,
          /* v8 ignore start - defensive Error narrowing in catch */
          error: err instanceof Error ? err.message : "Unknown error",
          /* v8 ignore stop */
        });
      }
    }
  }

  if (actionType === "bulk_reject") {
    /* v8 ignore start - defensive nullish coalescing on already-validated reason */
    const reason = (rejectionReason ?? "").trim();
    /* v8 ignore stop */
    for (const rc of returnCases) {
      if (TERMINAL_STATUSES.includes(rc.status.toLowerCase())) {
        results.push({
          id: rc.id,
          success: false,
          error: `Cannot reject: return is already ${rc.status}`,
        });
        continue;
      }

      try {
        await prisma.returnCase.update({
          where: { id: rc.id },
          data: {
            status: "rejected",
            rejectionReason: reason,
          },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "admin",
            eventType: "rejected",
            payloadJson: JSON.stringify({
              rejectionReason: reason,
              bulk: true,
            }),
          },
        });

        if (rc.customerEmailNorm) {
          try {
            await sendRejectionNotification({
              shopDomain: session.shop,
              to: rc.customerEmailNorm,
              /* v8 ignore start - defensive fallback for missing order name */
              orderName: rc.shopifyOrderName || "your order",
              /* v8 ignore stop */
              rejectionReason: reason,
              shopName: session.shop?.replace(".myshopify.com", ""),
            });
          } catch (err) {
            console.warn(`[BulkReject] Notification failed for ${rc.id}:`, err);
          }
        }

        results.push({ id: rc.id, success: true });
      } catch (err) {
        console.error(`[BulkReject] Failed for ${rc.id}:`, err);
        results.push({
          id: rc.id,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }

  if (actionType === "bulk_change_resolution") {
    const newResType = body.resolutionType!;
    for (const rc of returnCases) {
      if (["rejected", "cancelled"].includes(rc.status.toLowerCase())) {
        results.push({
          id: rc.id,
          success: false,
          error: `Cannot change resolution: return is ${rc.status}`,
        });
        continue;
      }
      try {
        await prisma.returnCase.update({
          where: { id: rc.id },
          data: { resolutionType: newResType },
        });
        await prisma.returnEvent.create({
          data: {
            returnCaseId: rc.id,
            source: "admin",
            eventType: "resolution_changed",
            payloadJson: JSON.stringify({
              resolutionType: newResType,
              previousType: rc.resolutionType,
              bulk: true,
            }),
          },
        });
        results.push({ id: rc.id, success: true });
      } catch (err) {
        console.error(`[BulkResolution] Failed for ${rc.id}:`, err);
        /* v8 ignore start - defensive Error narrowing in catch */
        results.push({
          id: rc.id,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
        /* v8 ignore stop */
      }
    }
  }

  for (const id of missingIds) {
    results.push({
      id,
      success: false,
      error: "Return not found or does not belong to this shop",
    });
  }

  const successCount = results.filter((r) => r.success).length;
  const errorCount = results.filter((r) => !r.success).length;

  return Response.json({
    successCount,
    errorCount,
    results,
  });
};
