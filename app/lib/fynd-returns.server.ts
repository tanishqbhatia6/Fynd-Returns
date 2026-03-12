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

/** Detect if a string looks like a Fynd numeric shipment ID (NOT a Fynd order ID like FYMP...) */
function looksLikeShipmentId(id: string): boolean {
  const trimmed = (id || "").trim();
  // Pure numeric IDs with 15+ digits are shipment IDs, not order IDs
  // Fynd order IDs start with FYMP, FY, or are shorter numeric IDs
  return /^\d{15,}$/.test(trimmed);
}

/** Build products + reasons arrays from return items for Fynd payload */
function buildProductsPayload(
  items: ReturnItem[],
  targetShipId: string | null,
  defaultReasonId: number,
  defaultReasonText: string,
) {
  const products: Array<{ line_number: number; quantity: number; identifier: string }> = [];
  const reasonProducts: Array<{
    filters: Array<{ identifier: string; line_number: number; quantity: number }>;
    data: { reason_id: number; reason_text: string };
  }> = [];

  const allItems = items ?? [];
  const hasShipmentContext = targetShipId && allItems.some(it => it.fyndShipmentId);
  const filtered = hasShipmentContext
    ? allItems.filter(it => !it.fyndShipmentId || it.fyndShipmentId === targetShipId)
    : allItems;

  filtered.forEach((item, idx) => {
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

  return { products, reasonProducts };
}

/**
 * Create return on Fynd by calling updateShipmentStatus with return_initiated.
 *
 * Flow:
 * 1. FAST PATH: If we already have a known shipment ID (targetShipmentId) and items,
 *    skip the shipment lookup and go directly to updateShipmentStatus.
 *    This handles retries where the shipment was found previously.
 *
 * 2. SEARCH PATH: Search Fynd by external_order_id or order_id to find shipments.
 *    Use the search results to identify the correct shipment.
 *
 * 3. DIRECT LOOKUP: Call getShipments() with the Fynd order ID to get shipment details.
 *    This requires a valid Fynd order ID (FYMP... format), NOT a shipment ID.
 *
 * 4. UPDATE: Call updateShipmentStatus with the shipment identifier + items to
 *    trigger return_initiated status. The endpoint is /shipment/status-internal
 *    and uses the shipment identifier from the payload (NOT the orderId parameter).
 */
export async function createReturnOnFynd(
  client: FyndPlatformClient | import("./fynd-fdk.server").FyndPlatformClientFDK,
  returnCase: ReturnCase & { items: ReturnItem[] },
  options?: {
    affiliateOrderId?: string | null;
    targetShipmentId?: string | null;
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
  const targetShipId = options?.targetShipmentId?.trim() || null;

  const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
  const affiliateOrderId = options?.affiliateOrderId?.trim() || null;
  const storedFyndOrderId = (returnCase as { fyndOrderId?: string | null }).fyndOrderId?.trim() || null;

  // ─── FAST PATH ───
  // If we have a known shipment ID from a previous attempt AND items to return,
  // skip the expensive shipment lookup and go directly to updateShipmentStatus.
  // updateShipmentStatus uses the shipment identifier from the payload body —
  // the _orderId parameter is unused (PUT /shipment/status-internal).
  if (targetShipId && (returnCase.items ?? []).some(it => (it.sku || it.shopifyLineItemId) && it.shopifyLineItemId !== "manual")) {
    console.log(`[createReturnOnFynd] FAST PATH: Using known shipmentId=${targetShipId} for order=${externalOrderId}`);
    try {
      return await executeReturnUpdate(client, targetShipId, externalOrderId || targetShipId, returnCase, options, defaultReasonId, defaultReasonText);
    } catch (fastErr) {
      const fastMsg = fastErr instanceof Error ? fastErr.message : String(fastErr);
      // If the fast path fails with "Invalid State Transition", the return already exists
      if (/Invalid State Transition.*return_initiated|return_initiated.*already|already.*return/i.test(fastMsg)) {
        return {
          success: true,
          alreadyExists: true,
          fyndReturnId: targetShipId,
          fyndOrderId: storedFyndOrderId || externalOrderId || undefined,
          fyndShipmentId: targetShipId,
        };
      }
      // For other errors, fall through to the full search path
      console.warn(`[createReturnOnFynd] Fast path failed (${fastMsg}), falling through to search path`);
    }
  }

  // ─── FULL SEARCH PATH ───
  // Resolve a valid Fynd order ID. Never use a stored value that looks like a shipment ID.
  let fyndOrderId = affiliateOrderId
    || (storedFyndOrderId && !looksLikeShipmentId(storedFyndOrderId) ? storedFyndOrderId : null)
    || (externalOrderId ? toFyndOrderIdFallback(returnCase.shopifyOrderName) : null);

  if (!fyndOrderId?.trim()) {
    return { success: false, error: "Invalid order ID" };
  }

  try {
    let shipmentsRes: unknown;
    let searchRes: { items?: unknown[]; shipments?: unknown[]; orderId?: string; shipmentId?: string } | null = null;

    // Search Fynd by external_order_id (or order_id for FYMP... IDs)
    const searchValue = affiliateOrderId || externalOrderId || fyndOrderId;
    const looksLikeFyndOrderIdFn = (id: string) => /^FYMP[A-Z0-9]{10,}/i.test((id || "").trim());
    const isAffiliateOrderIdMatch = (options?.affiliateOrderId?.trim() || null) === (searchValue?.trim() || null);
    const searchType = isAffiliateOrderIdMatch || !looksLikeFyndOrderIdFn(searchValue || "") ? "external_order_id" : "order_id";

    if (searchValue && "searchShipmentsByExternalOrderId" in client) {
      searchRes = await (client as FyndPlatformClient).searchShipmentsByExternalOrderId(searchValue, {
        searchType,
        pageSize: 10,
      });

      // ONLY use orderId for fyndOrderId — never use shipmentId as order_id
      if (searchRes.orderId && !looksLikeShipmentId(searchRes.orderId)) {
        fyndOrderId = searchRes.orderId;
      }

      // If first search found nothing, retry with fyndOrderId as search value (still external_order_id type)
      const firstSearchItems = searchRes?.items ?? searchRes?.shipments ?? [];
      if ((!Array.isArray(firstSearchItems) || firstSearchItems.length === 0) && fyndOrderId !== searchValue) {
        // Retry with the resolved fyndOrderId (may differ from externalOrderId)
        try {
          const altSearchRes = await (client as FyndPlatformClient).searchShipmentsByExternalOrderId(fyndOrderId, {
            searchType: "external_order_id",
            pageSize: 10,
          });
          const altItems = altSearchRes?.items ?? altSearchRes?.shipments ?? [];
          if (Array.isArray(altItems) && altItems.length > 0) {
            searchRes = altSearchRes;
            if (altSearchRes.orderId && !looksLikeShipmentId(altSearchRes.orderId)) {
              fyndOrderId = altSearchRes.orderId;
            }
          }
        } catch { /* non-fatal */ }
      }
    }

    // Extract search items for fallback use
    const searchItems = searchRes?.items ?? searchRes?.shipments ?? [];
    const hasSearchItems = Array.isArray(searchItems) && searchItems.length > 0;
    const searchOnlyHasShipmentId = searchRes && !searchRes.orderId && searchRes.shipmentId;

    if (searchOnlyHasShipmentId && hasSearchItems) {
      // Search found items but no order ID — use search results directly
      shipmentsRes = searchItems.map((it: unknown) => {
        const o = it && typeof it === "object" ? it as Record<string, unknown> : {};
        const sid = String(o.shipment_id ?? o.shipmentId ?? o.id ?? "");
        return { ...o, id: sid, identifier: sid };
      });
    } else {
      try {
        shipmentsRes = await client.getShipments(fyndOrderId);
      } catch (getErr) {
        const msg = getErr instanceof Error ? getErr.message : String(getErr);
        const isNotFound = msg.includes("404") || msg.includes("Not Found") || msg.includes("not found") || msg.includes("No records found");

        if (isNotFound && hasSearchItems) {
          // getShipments failed but search had results — use them
          shipmentsRes = searchItems.map((it: unknown) => {
            const o = it && typeof it === "object" ? it as Record<string, unknown> : {};
            const sid = String(o.shipment_id ?? o.shipmentId ?? o.id ?? "");
            return { ...o, id: sid, identifier: sid };
          });
        } else if (isNotFound && targetShipId) {
          // getShipments failed, search had no results, but we have a known shipment ID
          // Construct a minimal shipment object and proceed
          console.log(`[createReturnOnFynd] getShipments failed, using known shipmentId=${targetShipId} as fallback`);
          shipmentsRes = [{ id: targetShipId, shipment_id: targetShipId, identifier: targetShipId }];
        } else {
          throw getErr;
        }
      }
    }

    const shipments = Array.isArray(shipmentsRes)
      ? shipmentsRes
      : (shipmentsRes as { items?: unknown[] })?.items
      ?? (shipmentsRes as { shipments?: unknown[] })?.shipments
      ?? (shipmentsRes as { bags?: unknown[] })?.bags
      ?? [];

    // Select the target shipment: prefer targetShipmentId match, fallback to first
    let shipment: unknown = null;
    if (targetShipId && Array.isArray(shipments)) {
      shipment = shipments.find((s: unknown) => {
        const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
        return String(o.shipment_id ?? o.shipmentId ?? o.id ?? o.identifier ?? "").trim() === targetShipId;
      }) ?? null;
    }
    if (!shipment) {
      shipment = Array.isArray(shipments) ? shipments[0] : null;
    }
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

    // Build and send the return update
    return await executeReturnUpdate(client, shipmentId, fyndOrderId, returnCase, options, defaultReasonId, defaultReasonText, fullPayload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Execute the actual return update: build payload + call updateShipmentStatus.
 * Shared by both the fast path and the full search path.
 */
async function executeReturnUpdate(
  client: FyndPlatformClient | import("./fynd-fdk.server").FyndPlatformClientFDK,
  shipmentId: string,
  fyndOrderId: string,
  returnCase: ReturnCase & { items: ReturnItem[] },
  options: Parameters<typeof createReturnOnFynd>[2],
  defaultReasonId: number,
  defaultReasonText: string,
  fullPayload?: unknown,
): Promise<CreateFyndReturnResult> {
  const targetShipId = options?.targetShipmentId?.trim() || null;
  const { products, reasonProducts } = buildProductsPayload(
    returnCase.items ?? [],
    targetShipId,
    defaultReasonId,
    defaultReasonText,
  );

  // Build delivery_address from pickupAddress option if provided
  const pa = options?.pickupAddress;
  const deliveryAddress = pa && (pa.address1 || pa.city || pa.zip) ? {
    address: [pa.address1, pa.address2].filter(Boolean).join(", "),
    address1: pa.address1 || undefined,
    address2: pa.address2 || undefined,
    city: pa.city || undefined,
    state: pa.province || undefined,
    pincode: pa.zip || undefined,
    country: pa.country || undefined,
    landmark: pa.landmark || undefined,
    name: pa.name || undefined,
    phone: pa.phone || undefined,
  } : undefined;

  const payload = {
    statuses: [
      {
        shipments: [
          {
            identifier: String(shipmentId),
            products,
            reasons: { products: reasonProducts },
            ...(deliveryAddress ? { delivery_address: deliveryAddress } : {}),
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
      if (isAlreadyReturnInitiated) {
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
}
