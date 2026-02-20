/**
 * Fynd return creation - creates return on Fynd when admin approves
 */
import type { FyndPlatformClient } from "./fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

export type CreateFyndReturnResult = {
  success: boolean;
  fyndReturnId?: string;
  fyndReturnNo?: string;
  error?: string;
};

/** Map Shopify order name to Fynd order ID - Fynd may use same format when channel is configured */
function toFyndOrderId(shopifyOrderName: string): string {
  return shopifyOrderName.replace(/^#/, "").trim();
}

/**
 * Create return on Fynd by calling updateShipmentStatus with return_initiated.
 * Uses Shopify order name as Fynd order ID (channel config must map them).
 */
export async function createReturnOnFynd(
  client: FyndPlatformClient,
  returnCase: ReturnCase & { items: ReturnItem[] },
  defaultReasonId = 122,
  defaultReasonText = "Other"
): Promise<CreateFyndReturnResult> {
  if (returnCase.shopifyOrderId?.startsWith("manual:")) {
    return { success: false, error: "Manual returns cannot be synced to Fynd" };
  }

  const fyndOrderId = toFyndOrderId(returnCase.shopifyOrderName);
  if (!fyndOrderId) {
    return { success: false, error: "Invalid order ID" };
  }

  try {
    const shipmentsRes = await client.getShipments(fyndOrderId);
    const shipments = Array.isArray(shipmentsRes)
      ? shipmentsRes
      : (shipmentsRes as { items?: unknown[] })?.items ?? (shipmentsRes as { shipments?: unknown[] })?.shipments ?? [];

    const shipment = Array.isArray(shipments) ? shipments[0] : null;
    if (!shipment || typeof shipment !== "object") {
      return { success: false, error: "Order not found in Fynd or no shipments" };
    }

    const shipmentId = (shipment as { id?: string; identifier?: string; _id?: string }).id
      ?? (shipment as { identifier?: string }).identifier
      ?? (shipment as { _id?: string })._id;
    if (!shipmentId) {
      return { success: false, error: "Could not determine Fynd shipment ID" };
    }

    // Build products and reasons from return items (Fynd payload format)
    const products: Array<{ line_number: number; quantity: number; identifier: string }> = [];
    const reasonProducts: Array<{
      filters: Array<{ identifier: string; line_number: number; quantity: number }>;
      data: { reason_id: number; reason_text: string };
    }> = [];

    const items = returnCase.items ?? [];
    items.forEach((item, idx) => {
      const sku = item.sku || item.shopifyLineItemId;
      if (sku && item.shopifyLineItemId !== "manual") {
        const lineNum = idx + 1;
        products.push({ line_number: lineNum, quantity: item.qty, identifier: sku });
        reasonProducts.push({
          filters: [{ identifier: sku, line_number: lineNum, quantity: item.qty }],
          data: {
            reason_id: defaultReasonId,
            reason_text: item.reasonCode || defaultReasonText,
          },
        });
      }
    });

    if (products.length === 0) {
      products.push({ line_number: 1, quantity: 1, identifier: "default" });
      reasonProducts.push({
        filters: [{ identifier: "default", line_number: 1, quantity: 1 }],
        data: { reason_id: defaultReasonId, reason_text: defaultReasonText },
      });
    }

    const payload = {
      statuses: [
        {
          shipments: [
            {
              identifier: String(shipmentId),
              products,
              reasons: { products: reasonProducts },
            },
          ],
          status: "return_initiated",
        },
      ],
      task: false,
      force_transition: false,
      lock_after_transition: false,
      unlock_before_transition: false,
    };

    const result = await client.updateShipmentStatus(fyndOrderId, payload);

    const res = result as { return_id?: string; return_no?: string; id?: string; returnId?: string } | null;
    const fyndReturnId = res?.return_id ?? res?.id ?? res?.returnId;
    const fyndReturnNo = res?.return_no;

    return {
      success: true,
      fyndReturnId: fyndReturnId ? String(fyndReturnId) : undefined,
      fyndReturnNo: fyndReturnNo ? String(fyndReturnNo) : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
