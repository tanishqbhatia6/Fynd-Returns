/**
 * Fynd return creation - creates return on Fynd when admin approves
 */
import type { FyndPlatformClient } from "./fynd.server";
import type { ReturnCase, ReturnItem } from "@prisma/client";

export type CreateFyndReturnResult = {
  success: boolean;
  fyndReturnId?: string;
  fyndReturnNo?: string;
  fyndOrderId?: string;
  fyndShipmentId?: string;
  /** Full Fynd shipments response (array or { items/shipments }) for invoice, AWB, DP, etc. */
  fyndPayload?: unknown;
  error?: string;
  /** True when return already exists on Fynd (Invalid State Transition) - payload contains fetched details */
  alreadyExists?: boolean;
};

/** Map Shopify order name to Fynd order ID - used as fallback when affiliate_order_id is not available */
function toFyndOrderIdFallback(shopifyOrderName: string): string {
  return shopifyOrderName.replace(/^#/, "").trim();
}

/**
 * Create return on Fynd by calling updateShipmentStatus with return_initiated.
 * Fynd APIs expect affiliate_order_id (from order customAttributes), NOT Shopify order name.
 * Pass affiliateOrderId when available; otherwise falls back to shopifyOrderName (may fail for Fynd integrations).
 */
export async function createReturnOnFynd(
  client: FyndPlatformClient | import("./fynd-fdk.server").FyndPlatformClientFDK,
  returnCase: ReturnCase & { items: ReturnItem[] },
  options?: {
    affiliateOrderId?: string | null;
    defaultReasonId?: number;
    defaultReasonText?: string;
    pickupAddress?: {
      address1?: string | null;
      address2?: string | null;
      city?: string | null;
      province?: string | null;
      zip?: string | null;
      country?: string | null;
      landmark?: string | null;
      name?: string | null;
      phone?: string | null;
    } | null;
  }
): Promise<CreateFyndReturnResult> {
  if (returnCase.shopifyOrderId?.startsWith("manual:")) {
    return { success: false, error: "Manual returns cannot be synced to Fynd" };
  }

  const defaultReasonId = options?.defaultReasonId ?? 122;
  const defaultReasonText = options?.defaultReasonText ?? "Other";

  const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
  const looksExternal = (id: string) => /^FY[A-Z0-9]{10,}/i.test(id.trim());
  const affiliateOrderId = options?.affiliateOrderId?.trim() || null;
  const storedFyndOrderId = (returnCase as { fyndOrderId?: string | null }).fyndOrderId?.trim() || null;

  let fyndOrderId = affiliateOrderId || storedFyndOrderId || (externalOrderId ? toFyndOrderIdFallback(returnCase.shopifyOrderName) : null);
  if (!fyndOrderId?.trim()) {
    return { success: false, error: "Invalid order ID" };
  }

  try {
    let shipmentsRes: unknown;
    let searchRes: { items?: unknown[]; shipments?: unknown[]; orderId?: string; shipmentId?: string } | null = null;
    // Prefer affiliateOrderId for search when set (Fynd stores this as external_order_id); else use externalOrderId or fyndOrderId
    const searchValue = affiliateOrderId || externalOrderId || fyndOrderId;
    // Use external_order_id when: affiliateOrderId is explicitly set (Shopify metadata), or value doesn't look like Fynd order ID (FYMP...)
    const looksLikeFyndOrderId = (id: string) => /^FYMP[A-Z0-9]{10,}/i.test((id || "").trim());
    const isAffiliateOrderId = (options?.affiliateOrderId?.trim() || null) === (searchValue?.trim() || null);
    const searchType = isAffiliateOrderId || !looksLikeFyndOrderId(searchValue || "") ? "external_order_id" : "order_id";

    if (searchValue && "searchShipmentsByExternalOrderId" in client) {
      searchRes = await (client as FyndPlatformClient).searchShipmentsByExternalOrderId(searchValue, {
        searchType,
        pageSize: 10,
      });
      const resolved = searchRes.orderId ?? searchRes.shipmentId;
      if (resolved) {
        fyndOrderId = resolved;
      }
    }

    try {
      shipmentsRes = await client.getShipments(fyndOrderId);
    } catch (getErr) {
      const msg = getErr instanceof Error ? getErr.message : String(getErr);
      if ((msg.includes("404") || msg.includes("Not Found") || msg.includes("not found")) && searchRes) {
        const items = searchRes.items ?? searchRes.shipments ?? [];
        if (Array.isArray(items) && items.length > 0) {
          shipmentsRes = items.map((it: unknown) => {
            const o = it && typeof it === "object" ? it as Record<string, unknown> : {};
            const sid = String(o.shipment_id ?? o.shipmentId ?? o.id ?? "");
            return { ...o, id: sid, identifier: sid };
          });
        } else {
          throw getErr;
        }
      } else {
        throw getErr;
      }
    }
    const shipments = Array.isArray(shipmentsRes)
      ? shipmentsRes
      : (shipmentsRes as { items?: unknown[] })?.items
      ?? (shipmentsRes as { shipments?: unknown[] })?.shipments
      ?? (shipmentsRes as { bags?: unknown[] })?.bags
      ?? [];

    const shipment = Array.isArray(shipments) ? shipments[0] : null;
    const fullPayload = shipmentsRes != null ? shipmentsRes : undefined;
    if (!shipment || typeof shipment !== "object") {
      return { success: false, error: "Order not found in Fynd or no shipments" };
    }

    const s = shipment as Record<string, unknown>;
    const toStr = (v: unknown) => (v != null ? String(v).trim() : "");
    let shipmentId =
      toStr(s.shipment_id ?? s.shipmentId ?? s.channel_shipment_id ?? s.id ?? s.identifier ?? s._id) || null;
    if (!shipmentId && searchRes?.shipmentId) {
      shipmentId = String(searchRes.shipmentId).trim() || null;
    }
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

    let result: unknown;
    try {
      result = await client.updateShipmentStatus(fyndOrderId, payload);
    } catch (updateErr) {
      const updateMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      if ((updateMsg.includes("404") || updateMsg.includes("Not Found")) && shipmentId && shipmentId !== fyndOrderId) {
        try {
          result = await client.updateShipmentStatus(String(shipmentId), payload);
        } catch {
          throw updateErr;
        }
      } else {
        throw updateErr;
      }
    }

    const res = result as Record<string, unknown> | null;
    // Top-level return ID (some Fynd responses)
    let fyndReturnId =
      (res?.return_id ?? res?.id ?? res?.returnId) != null ? String(res?.return_id ?? res?.id ?? res?.returnId) : null;
    const fyndReturnNo = res?.return_no != null ? String(res.return_no) : undefined;

    // status-internal returns nested: statuses[0].shipments[0].{ status, message, final_state, identifier }
    if (Array.isArray(res?.statuses) && res.statuses.length > 0) {
      const firstStatus = res.statuses[0] as Record<string, unknown>;
      const shipments = firstStatus?.shipments as Array<Record<string, unknown>> | undefined;
      const firstShip = Array.isArray(shipments) ? shipments[0] : null;
      const shipStatus = firstShip?.status;
      if (shipStatus !== 200 && shipStatus !== undefined) {
        const msg = (firstShip?.message ?? firstShip?.error ?? `Fynd API returned status ${shipStatus}`) as string;
        const isAlreadyReturnInitiated =
          /Invalid State Transition.*return_initiated|return_initiated.*already|already.*return/i.test(msg);
        if (isAlreadyReturnInitiated && fullPayload) {
          return {
            success: true,
            alreadyExists: true,
            fyndReturnId: shipmentId ? String(shipmentId) : undefined,
            fyndOrderId,
            fyndShipmentId: shipmentId ? String(shipmentId) : undefined,
            fyndPayload: fullPayload,
          };
        }
        return { success: false, error: msg };
      }
      if (shipStatus === 200 && !fyndReturnId) {
        const finalState = firstShip?.final_state as Record<string, unknown> | undefined;
        fyndReturnId =
          (finalState?.shipment_id ?? finalState?.return_id ?? firstShip?.identifier) != null
            ? String(finalState?.shipment_id ?? finalState?.return_id ?? firstShip?.identifier)
            : null;
      }
    }

    return {
      success: true,
      fyndReturnId: fyndReturnId ?? undefined,
      fyndReturnNo,
      fyndOrderId,
      fyndShipmentId: shipmentId ? String(shipmentId) : undefined,
      fyndPayload: fullPayload,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
