/**
 * Bag distribution — turns a customer's line-level return request
 * (`{lineItemId, qty: N}`) into N or fewer per-bag ReturnItems by
 * picking eligible Fynd bags for that line item.
 *
 * Why this exists
 * ---------------
 * One Shopify order can be split into multiple Fynd shipments. One
 * shipment can hold multiple line items, each potentially in multiple
 * bags. So "I want to return 3 of line item A" can map to:
 *   - one bag holding 3 of A (rare)
 *   - three bags of 1 each from one shipment
 *   - two bags from shipment 1 + one bag from shipment 2
 *   - any other combination that sums to 3
 *
 * The portal used to ask the customer to tick individual bag
 * checkboxes — wrong abstraction; the customer doesn't think in
 * Fynd bags. Now the portal sends `{lineItemId, qty}` and this module
 * picks bags. The output is shaped exactly like a `ReturnItem` create
 * payload so api.portal.create-return.ts can drop it into the items
 * array verbatim.
 *
 * Selection rules
 * ---------------
 * 1. Only ELIGIBLE shipments are considered (eligible: true on the
 *    Fynd-shipment shape from api.portal.order.ts). Non-delivered
 *    or RTO-only shipments are excluded.
 * 2. Bags whose remaining-returnable-qty is 0 are excluded (already
 *    in another return / cancelled).
 * 3. Greedy: walk shipments in order, then bags in order, taking
 *    `min(remaining, bag.fyndQuantityAvailable)` per bag until the
 *    requested qty is satisfied.
 * 4. Each output entry carries the bag's full Fynd metadata
 *    (shipmentId, bagId, seller identifier, lineNumber, articleId,
 *    etc.) so downstream sync can send the Fynd transition API the
 *    seller identifier + line_number pair while still scoping our app
 *    state by bag.
 *
 * Pure module — no Prisma, no I/O. Caller owns the data fetch and
 * passes a ShipmentSnapshot[] alongside the request. Easy to unit-test.
 */

export interface BagSnapshot {
  shipmentId: string;
  shipmentEligible: boolean;
  bagId: string;
  /** SKU used as a fallback when bagId can't be resolved on Fynd's side. */
  sku: string | null;
  /** Maximum units of this bag that are still returnable (already-in-return
   *  / already-cancelled units subtracted by the caller). */
  remainingQty: number;
  fyndArticleId: string | null;
  fyndAffiliateLineId: string | null;
  fyndSellerIdentifier: string | null;
  fyndItemId: string | null;
  fyndPriceEffective: string | null;
  fyndSize: string | null;
  fyndLineNumber: number | null;
}

export interface DistributionInputItem {
  /** Shopify LineItem GID (gid://shopify/LineItem/N) */
  lineItemId: string;
  /** Customer-requested qty for this line. */
  qty: number;
  reasonCode?: string;
  condition?: string;
  /** Reason notes carried per item (line-level — applied to every bag). */
  notes?: string;
}

/**
 * Per-line index of bags. The caller builds this once from the order
 * snapshot and reuses it across multiple input items.
 */
export type BagIndexByLine = Map<string, BagSnapshot[]>;

export interface DistributedReturnItem {
  lineItemId: string;
  qty: number;
  reasonCode?: string;
  condition?: string;
  notes?: string;
  fyndShipmentId?: string;
  fyndBagId?: string;
  /** The bag's per-bag remaining capacity. createReturnOnFynd uses this
   *  to cap the per-bag qty in its sync payload. */
  fyndQuantityAvailable?: number;
  fyndArticleId?: string;
  fyndAffiliateLineId?: string;
  fyndSellerIdentifier?: string;
  fyndItemId?: string;
  fyndPriceEffective?: string;
  fyndSize?: string;
  fyndLineNumber?: number;
}

export interface DistributionResult {
  /** Successfully-allocated per-bag items, ready to drop into the
   *  ReturnItem create payload. */
  items: DistributedReturnItem[];
  /** Per-input-line shortfall map: how many units couldn't be allocated.
   *  An empty map means every customer request was fully satisfied. */
  unsatisfied: Map<string, number>;
}

/**
 * Distribute a customer's line-level return requests across the
 * eligible Fynd bags. Mutates the provided BagIndexByLine in-place
 * (decrements `remainingQty`) so callers can run the function multiple
 * times against the same snapshot to detect over-claim.
 */
export function distributeBagAllocations(
  inputs: DistributionInputItem[],
  bagIndex: BagIndexByLine,
): DistributionResult {
  const out: DistributedReturnItem[] = [];
  const unsatisfied = new Map<string, number>();

  for (const input of inputs) {
    let remaining = Math.max(0, Math.floor(input.qty || 0));
    if (remaining <= 0) continue;

    const bags = bagIndex.get(input.lineItemId) ?? [];

    for (const bag of bags) {
      if (remaining <= 0) break;
      if (!bag.shipmentEligible) continue;
      if (bag.remainingQty <= 0) continue;

      const take = Math.min(remaining, bag.remainingQty);

      const item: DistributedReturnItem = {
        lineItemId: input.lineItemId,
        qty: take,
        reasonCode: input.reasonCode,
        condition: input.condition,
        notes: input.notes,
        fyndShipmentId: bag.shipmentId,
        fyndBagId: bag.bagId,
        fyndQuantityAvailable: bag.remainingQty,
        fyndArticleId: bag.fyndArticleId ?? undefined,
        fyndAffiliateLineId: bag.fyndAffiliateLineId ?? undefined,
        fyndSellerIdentifier: bag.fyndSellerIdentifier ?? undefined,
        fyndItemId: bag.fyndItemId ?? undefined,
        fyndPriceEffective: bag.fyndPriceEffective ?? undefined,
        fyndSize: bag.fyndSize ?? undefined,
        fyndLineNumber: bag.fyndLineNumber ?? undefined,
      };
      // Strip undefined fields so the resulting object is clean
      // (matches the shape Prisma's `items.create` expects without
      // forcing every optional field to null).
      for (const k of Object.keys(item) as Array<keyof DistributedReturnItem>) {
        if (item[k] === undefined) delete item[k];
      }
      out.push(item);

      bag.remainingQty -= take;
      remaining -= take;
    }

    if (remaining > 0) {
      unsatisfied.set(input.lineItemId, (unsatisfied.get(input.lineItemId) ?? 0) + remaining);
    }
  }

  return { items: out, unsatisfied };
}

/**
 * Build a BagIndexByLine from the api.portal.order.ts shipment snapshot.
 * Caller passes the same `_shipments[]` shape the portal receives so
 * this module doesn't need to know about Prisma or the Fynd API.
 *
 * Each shipment item carries a `bagId` and `id` (the Shopify line item
 * GID after resolution). We index by GID; if multiple bags share the
 * same line GID, they all go into the same bucket.
 */
export interface ShipmentSnapshot {
  shipmentId: string;
  eligible?: boolean;
  items: Array<{
    /** Shopify LineItem GID. */
    id: string;
    bagId: string;
    sku: string | null;
    /** Bag-local quantity (not the line total). */
    quantity: number;
    fyndArticleId: string | null;
    fyndAffiliateLineId: string | null;
    fyndSellerIdentifier: string | null;
    fyndItemId: string | null;
    fyndPriceEffective: string | null;
    fyndSize: string | null;
    fyndLineNumber: number | null;
    fyndQuantityAvailable: number | null;
  }>;
}

/**
 * Per-bag already-returned/already-cancelled qty map. Keyed by either
 * bagId or `<shipmentId>::<bagId>` — caller picks whichever fits their
 * source data. distributeBagAllocations needs the NET remaining, so
 * the caller subtracts these before calling buildBagIndex.
 */
export type BagReservedMap = Record<string, number>;

export function buildBagIndex(
  shipments: ShipmentSnapshot[],
  reserved: BagReservedMap = {},
): BagIndexByLine {
  const idx: BagIndexByLine = new Map();
  for (const ship of shipments) {
    const eligible = ship.eligible !== false; // default-true unless explicitly false
    for (const it of ship.items ?? []) {
      const reservedQty = reserved[`${ship.shipmentId}::${it.bagId}`] ?? reserved[it.bagId] ?? 0;
      const remainingQty = Math.max(0, (it.quantity ?? 0) - Math.max(0, reservedQty));
      const bag: BagSnapshot = {
        shipmentId: ship.shipmentId,
        shipmentEligible: eligible,
        bagId: it.bagId,
        sku: it.sku,
        remainingQty,
        fyndArticleId: it.fyndArticleId,
        fyndAffiliateLineId: it.fyndAffiliateLineId,
        fyndSellerIdentifier: it.fyndSellerIdentifier,
        fyndItemId: it.fyndItemId,
        fyndPriceEffective: it.fyndPriceEffective,
        fyndSize: it.fyndSize,
        fyndLineNumber: it.fyndLineNumber,
      };
      const arr = idx.get(it.id) ?? [];
      arr.push(bag);
      idx.set(it.id, arr);
    }
  }
  return idx;
}
