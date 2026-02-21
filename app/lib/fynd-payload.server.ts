/**
 * Normalize and extract display-friendly fields from Fynd order/shipment payload.
 * Handles various response shapes: array, { items }, { shipments }, single object.
 */

export type FyndDisplayField = { label: string; value: string; key?: string };

/** Known Fynd payload key variants -> display label */
const LABEL_MAP: Record<string, string> = {
  order_id: "Fynd Order ID",
  orderId: "Fynd Order ID",
  shipment_id: "Fynd Shipment ID",
  shipmentId: "Shipment ID",
  identifier: "Shipment identifier",
  id: "ID",
  _id: "ID",
  marketplaceInvoiceNumber: "Fynd Invoice number",
  marketplace_invoice_number: "Fynd Invoice number",
  invoice_number: "Invoice number",
  invoiceNumber: "Invoice number",
  invoice_id: "Invoice ID",
  invoiceId: "Invoice ID",
  invoice: "Invoice",
  awbNumber: "Forward AWB / Tracking number",
  awb_no: "Forward AWB / Tracking number",
  awb: "AWB",
  traking_no: "Tracking number",
  tracking_no: "Tracking number",
  dp_name: "CP Name (Courier partner)",
  dp: "Delivery partner",
  courierName: "CP Name (Courier partner)",
  courier_name: "CP Name (Courier partner)",
  cp_name: "CP Name (Courier partner)",
  courierCode: "Courier code",
  courier_code: "Courier code",
  logistics_partner: "Logistics partner",
  track_url: "Tracking URL",
  trackUrl: "Tracking URL",
  tracking_url: "Tracking URL",
  shipment_status: "Shipment status",
  orderStatus: "Order status",
  status: "Status",
  fulfilling_store: "Fulfilling store",
  fulfilling_store_name: "Fulfilling store",
  fulfilling_company: "Fulfilling company",
  total_bags: "Total bags",
  bags: "Bags",
  shipment_created_at: "Shipment created at",
  shipment_created_ts: "Shipment created (ts)",
  orderDate: "Order date",
  modifiedDate: "Modified date",
  marketplaceOrderId: "Marketplace order ID",
  marketplaceReturnId: "Marketplace return ID",
  forwardId: "Forward shipment ID",
  fulfillmentType: "Fulfillment type",
  paymentType: "Payment type",
  fulfillment_option: "Fulfillment option",
  ordering_source: "Ordering source",
  ordering_channel: "Ordering channel",
  channel: "Channel",
  display_name: "Display name",
  promise: "Promise",
  need_help_url: "Support URL",
};

function valueToString(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueToString).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function collectFields(obj: Record<string, unknown>, prefix = ""): FyndDisplayField[] {
  const out: FyndDisplayField[] = [];
  const seen = new Set<string>();

  const push = (key: string, label: string, val: unknown) => {
    const value = valueToString(val);
    if (value === "—" && (val == null || val === "")) return;
    const k = (prefix ? `${prefix}.` : "") + key;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ label, value, key: k });
    }
  };

  for (const [key, val] of Object.entries(obj)) {
    const label = LABEL_MAP[key] ?? key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim();
    if (key === "tracking_details" || key === "size_info" || key === "currency_info") continue;
    if (key === "meta" && val != null && typeof val === "object") {
      const meta = val as Record<string, unknown>;
      if (meta.cp_name != null) push("cp_name", "CP Name (Courier partner)", meta.cp_name);
      if (meta.awb_no != null || meta.awb != null) push("awb", "Forward AWB", meta.awb_no ?? meta.awb);
      if (meta.invoice_id != null || meta.invoice_number != null) push("invoice_id", "Invoice ID", meta.invoice_id ?? meta.invoice_number);
      continue;
    }
    if (val != null && Array.isArray(val)) {
      if (key === "bags") push(key, label, `${val.length} bag(s)`);
      else push(key, label, val);
      continue;
    }
    if (val != null && typeof val === "object") {
      const nested = val as Record<string, unknown>;
      if (nested.title !== undefined || nested.name !== undefined || nested.value !== undefined || "currency_code" in nested) {
        push(key, label, nested.title ?? nested.name ?? nested.value ?? nested.currency_code ?? JSON.stringify(nested));
      } else if (Object.keys(nested).length <= 8) {
        out.push(...collectFields(nested, prefix ? `${prefix}.${key}` : key));
      } else {
        push(key, label, JSON.stringify(nested));
      }
    } else {
      push(key, label, val);
    }
  }
  return out;
}

/** Normalize raw Fynd API response to array of shipment-like objects */
export function normalizeFyndPayload(payload: unknown): unknown[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.shipments)) return o.shipments;
  if (typeof o === "object" && Object.keys(o).length > 0) return [o];
  return [];
}

export type TrackingInfoFromFynd = {
  trackingUrl?: string | null;
  logisticsPartner?: string | null;
  fyndStatus?: string | null;
  awbNo?: string | null;
};

/** Extract tracking URL, DP name, status from Fynd payload for customer-facing display */
export function getTrackingInfoFromFyndPayload(fyndPayloadJson: string | null | undefined): TrackingInfoFromFynd | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    const trackUrl = first.track_url ?? first.trackUrl ?? first.tracking_url;
    const dp = first.dp_name ?? first.dp ?? first.courierName ?? first.courier_name ?? first.logistics_partner;
    const status = first.shipment_status ?? first.orderStatus ?? first.status;
    const statusTitle = status && typeof status === "object" && status !== null && "title" in status
      ? (status as { title?: string }).title
      : status;
    const awb = first.awb_no ?? first.awbNumber ?? first.awb;
    const awbStr = Array.isArray(awb) ? awb[0] : awb;
    return {
      trackingUrl: typeof trackUrl === "string" ? trackUrl : null,
      logisticsPartner: typeof dp === "string" ? dp : (dp && typeof dp === "object" && "name" in dp ? String((dp as { name?: string }).name) : null),
      fyndStatus: typeof statusTitle === "string" ? statusTitle : (typeof status === "string" ? status : null),
      awbNo: typeof awbStr === "string" ? awbStr : null,
    };
  } catch {
    return null;
  }
}

/** Extract display fields from a single shipment-like object */
export function getFyndShipmentDisplayFields(shipment: unknown): FyndDisplayField[] {
  if (shipment == null || typeof shipment !== "object") return [];
  return collectFields(shipment as Record<string, unknown>);
}

export type FyndPayloadInfo = {
  shipments: Array<{ index: number; fields: FyndDisplayField[]; raw: Record<string, unknown> }>;
  rawJson: string;
};

/** Parse fyndPayloadJson and return structured display info */
export function parseFyndPayloadForDisplay(fyndPayloadJson: string | null | undefined): FyndPayloadInfo | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const shipments = list.map((item, index) => {
      const raw = (typeof item === "object" && item != null ? item : {}) as Record<string, unknown>;
      return {
        index: index + 1,
        fields: getFyndShipmentDisplayFields(item),
        raw,
      };
    });
    return {
      shipments,
      rawJson: fyndPayloadJson,
    };
  } catch {
    return null;
  }
}

/** Structured Fynd Order details for the tab */
export type FyndOrderDetailsTab = {
  fyndOrderId: string | null;
  shipments: Array<{
    shipmentId: string;
    cpName: string | null;
    forwardAwb: string | null;
    invoiceNumber: string | null;
    invoiceId: string | null;
    fulfillmentStore: string | null;
    fulfillmentOptions: string | null;
    shipmentStatus: string | null;
    items: Array<{ sku?: string; title?: string; quantity?: number; identifier?: string }>;
  }>;
};

/** Extract structured Fynd Order details for the tab (order id, shipment ids, CP name, AWB, invoice, fulfillment, status, items) */
export function parseFyndOrderDetailsForTab(fyndPayloadJson: string | null | undefined): FyndOrderDetailsTab | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    const fyndOrderId = first
      ? String(first.order_id ?? first.orderId ?? first.id ?? first.channel_order_id ?? first.affiliate_order_id ?? "")
      : null;
    const shipments = list.map((item) => {
      const raw = (typeof item === "object" && item != null ? item : {}) as Record<string, unknown>;
      const meta = (raw.meta as Record<string, unknown>) ?? {};
      const awb = raw.awbNumber ?? raw.awb_no ?? raw.awb ?? meta.awb_no ?? meta.awb;
      const awbStr = Array.isArray(awb) ? (awb[0] as string) : (awb as string);
      const cpName = (raw.courierName ?? raw.courier_name ?? raw.dp_name ?? raw.dp ?? meta.cp_name ?? meta.courier_name) as string | null;
      const invNum = (raw.invoice_number ?? raw.invoiceNumber ?? raw.marketplaceInvoiceNumber ?? meta.invoice_number) as string | null;
      const invId = (raw.invoice_id ?? raw.invoiceId ?? meta.invoice_id) as string | null;
      const fulfillStore = (raw.fulfilling_store ?? raw.fulfilling_store_name ?? raw.fulfilling_company) as string | null;
      const fulfillOpts = [
        raw.ordering_source,
        raw.ordering_channel ?? raw.orderingChannel,
        raw.channel,
        raw.fulfillmentType ?? raw.fulfillment_type,
      ].filter(Boolean).join(" · ") || null;
      const status = (raw.shipment_status ?? raw.orderStatus ?? raw.status) as string | null;
      const statusTitle = status && typeof status === "object" && status !== null && "title" in (status as object)
        ? (status as { title?: string }).title
        : status;
      const orderItems = (raw.orderItems ?? raw.order_items ?? raw.items ?? []) as Array<Record<string, unknown>>;
      const items = orderItems.map((oi) => ({
        sku: (oi.sku ?? oi.identifier ?? oi.seller_identifier) as string | undefined,
        title: (oi.title ?? oi.product_title) as string | undefined,
        quantity: (oi.quantity ?? oi.qty) as number | undefined,
        identifier: (oi.identifier ?? oi.seller_identifier) as string | undefined,
      }));
      return {
        shipmentId: String(raw.id ?? raw.shipment_id ?? raw.shipmentId ?? raw.channel_shipment_id ?? "—"),
        cpName: cpName ?? null,
        forwardAwb: awbStr ?? null,
        invoiceNumber: invNum ?? null,
        invoiceId: invId ?? null,
        fulfillmentStore: fulfillStore ?? null,
        fulfillmentOptions: fulfillOpts ?? null,
        shipmentStatus: (statusTitle ?? status) ?? null,
        items,
      };
    });
    return { fyndOrderId: fyndOrderId || null, shipments };
  } catch {
    return null;
  }
}
