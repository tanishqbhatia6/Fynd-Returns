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

const RETURN_ALLOWED_FYND_STATUSES = new Set([
  "delivery_done",
  "delivered",
  "bag_delivered",
  "handed_over_to_customer",
  "return_initiated",
  "return_dp_assigned",
  "return_bag_picked",
  "return_bag_in_transit",
  "return_bag_out_for_delivery",
  "return_bag_delivered",
  "return_bag_not_received",
  "return_pre_qc",
  "return_accepted",
  "return_completed",
  "credit_note_generated",
  "refund_done",
  "refund_completed",
]);

function normalizeFyndStatus(status: string | null | undefined): string {
  return String(status ?? "")
    .toLowerCase()
    .replace(/[\s_]+/g, "_")
    .trim();
}

function isFyndShipmentEligible(
  status: string | null | undefined,
  allowedStatuses: string[],
): boolean {
  const normalized = normalizeFyndStatus(status);
  if (RETURN_ALLOWED_FYND_STATUSES.has(normalized)) return true;
  return allowedStatuses.some((allowed) => {
    const normalizedAllowed = normalizeFyndStatus(allowed);
    return normalized === normalizedAllowed || normalized.includes(normalizedAllowed);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (value == null) return null;
  const out = String(value).trim();
  return out || null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function unwrapFyndShipmentPayload(raw: unknown): Record<string, unknown> | null {
  const root = typeof raw === "string" ? JSON.parse(raw) : raw;
  const obj = asRecord(root);
  const payload = asRecord(obj.payload);
  const shipment = asRecord(payload.shipment ?? obj.shipment ?? obj);
  return Object.keys(shipment).length > 0 ? shipment : null;
}

export function shipmentSnapshotsFromFyndPayload(
  rawPayload: unknown,
  options: { allowedStatuses?: string[] } = {},
): ShipmentSnapshot[] {
  let shipment: Record<string, unknown> | null = null;
  try {
    shipment = unwrapFyndShipmentPayload(rawPayload);
  } catch {
    return [];
  }
  if (!shipment) return [];

  const statusObj = asRecord(shipment.shipment_status);
  const shipmentId =
    str(shipment.shipment_id) ||
    str(statusObj.shipment_id) ||
    str(asRecord(shipment.affiliate_details).affiliate_shipment_id);
  if (!shipmentId) return [];

  const status =
    str(shipment.current_shipment_status) ||
    str(shipment.status) ||
    str(statusObj.current_shipment_status) ||
    str(statusObj.status);
  const eligible = isFyndShipmentEligible(status, options.allowedStatuses ?? []);
  const items: ShipmentSnapshot["items"] = [];

  for (const rawBag of asArray(shipment.bags)) {
    const bag = asRecord(rawBag);
    const article = asRecord(bag.article);
    const item = asRecord(bag.item);
    const affiliateBagDetails = asRecord(bag.affiliate_bag_details);
    const affiliateMeta = asRecord(affiliateBagDetails.affiliate_meta);
    const bagMeta = asRecord(bag.meta);
    const bagAffiliateMeta = asRecord(bagMeta.affiliate_meta);
    const firstBreakup = asRecord(asArray(bag.financial_breakup)[0]);
    const identifiers = asRecord(firstBreakup.identifiers);
    const prices = asRecord(bag.prices);

    const bagId = str(bag.bag_id) || str(affiliateBagDetails.affiliate_bag_id) || str(bag.id);
    if (!bagId) continue;

    const affiliateLineId =
      str(affiliateMeta.affiliate_line_id) ||
      str(bagAffiliateMeta.affiliate_line_id) ||
      str(affiliateBagDetails.affiliate_line_id) ||
      str(bag.affiliate_line_id);
    const sellerIdentifier =
      str(article.seller_identifier) ||
      str(identifiers.sku_code) ||
      str(affiliateMeta.affiliate_sku) ||
      str(item.code);
    const quantity = num(bag.quantity) ?? num(firstBreakup.total_units) ?? 1;

    items.push({
      id: affiliateLineId ? `gid://shopify/LineItem/${affiliateLineId}` : bagId,
      bagId,
      sku: sellerIdentifier,
      quantity,
      fyndArticleId:
        str(article._id) || str(article.uid) || str(article.article_id) || str(article.id),
      fyndAffiliateLineId: affiliateLineId,
      fyndSellerIdentifier: sellerIdentifier,
      fyndItemId: str(item.id) || str(item.item_id) || str(item._id),
      fyndPriceEffective: str(prices.price_effective) || str(firstBreakup.price_effective),
      fyndSize: str(article.size) || str(bag.size) || str(item.size),
      fyndLineNumber: num(bag.line_number) ?? num(article.line_number),
      fyndQuantityAvailable: quantity,
    });
  }

  return [{ shipmentId, eligible, items }];
}

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
