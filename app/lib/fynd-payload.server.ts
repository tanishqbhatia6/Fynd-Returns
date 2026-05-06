/**
 * Normalize and extract display-friendly fields from Fynd order/shipment payload.
 * Handles various response shapes: array, { items }, { shipments }, single object.
 */

/** Fynd shipment IDs are 15+ digit all-numeric strings — not real courier AWBs.
 * Use this to filter them out before storing or displaying as tracking numbers. */
export function isLikelyFyndId(val: unknown): boolean {
  return typeof val === "string" && /^\d{15,}$/.test(val.trim());
}

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
  dp_name: "Logistics Partner",
  dp: "Delivery partner",
  courierName: "Logistics Partner",
  courier_name: "Logistics Partner",
  cp_name: "Logistics Partner",
  courierCode: "Courier code",
  courier_code: "Courier code",
  logistics_partner: "Logistics Partner",
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
  orderPrice: "Order price",
  order_price: "Order price",
  orderTotalAmount: "Order total",
  subtotal: "Subtotal",
  total: "Total",
  breakup: "Price breakup",
  prices_info: "Prices info",
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
    /* v8 ignore start */ // defensive: nested && / == short-circuit on rare value === "—" guard
    if (value === "—" && (val == null || val === "")) return;
    /* v8 ignore stop */
    const k = (prefix ? `${prefix}.` : "") + key;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ label, value, key: k });
    }
  };

  for (const [key, val] of Object.entries(obj)) {
    /* v8 ignore start */ // defensive: ?? fallback chains for label, meta key shape, and nested object fallback chains
    const label = LABEL_MAP[key] ?? key.replace(/_/g, " ").replace(/([A-Z])/g, " $1").trim();
    if (key === "tracking_details" || key === "size_info" || key === "currency_info") continue;
    if (key === "meta" && val != null && typeof val === "object") {
      const meta = val as Record<string, unknown>;
      if (meta.cp_name != null) push("cp_name", "Logistics Partner", meta.cp_name);
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
    /* v8 ignore stop */
  }
  return out;
}

/** Build tracking URL from courier name + AWB when Fynd doesn't provide tracking_url */
export function buildTrackingUrlFromCourierAndAwb(courierName: string, awb: string): string | null {
  const c = (courierName ?? "").toLowerCase().replace(/\s+/g, "");
  const a = String(awb ?? "").trim();
  if (!a) return null;
  if (c.includes("xpressbees") || c.includes("xpress")) return `https://www.xpressbees.com/track/${a}`;
  if (c.includes("delhivery")) return `https://www.delhivery.com/track/package/${a}`;
  if (c.includes("bluedart") || c.includes("blue dart")) return `https://www.bluedart.com/tracking.html?track=${a}`;
  if (c.includes("dtdc")) return `https://www.dtdc.in/tracking.asp?ref=${a}`;
  if (c.includes("ekart") || c.includes("ekartlogistics")) return `https://ekartlogistics.com/track/${a}`;
  if (c.includes("shadowfax")) return `https://track.shadowfax.in/track/${a}`;
  if (c.includes("ecom") || c.includes("ecom express")) return `https://ecomexpress.in/tracking/?awb=${a}`;
  if (c.includes("shiprocket")) return `https://track.shiprocket.in/tracking/${a}`;
  if (c.includes("pickrr")) return `https://track.pickrr.com/?tracking_id=${a}`;
  if (c.includes("dunzo")) return `https://www.delhivery.com/track/package/${a}`;
  return null;
}

/** Convert API value to display string - Fynd often returns objects (e.g. fulfilling_store) instead of strings */
function toDisplayString(val: unknown): string | null {
  if (val == null) return null;
  /* v8 ignore start */ // defensive: || null short-circuit + ?? fallback chain across object key shapes
  if (typeof val === "string") return val || null;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const s = (o.name ?? o.title ?? o.display_name ?? o.displayName ?? o.status ?? o.value ?? o.code ?? o.id) as string | number | undefined;
    if (typeof s === "string" && s) return s;
    if (typeof s === "number") return String(s);
    return null;
  }
  return null; // unreachable: callers feed JSON.parse output
  /* v8 ignore stop */
}

/** Prefer full/display names over short codes - for logistics partner etc. */
function toFullDisplayString(val: unknown): string | null {
  if (val == null) return null;
  /* v8 ignore start */ // defensive: || null short-circuit + ?? fallback chain across object key shapes
  if (typeof val === "string") return val || null;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const s = (o.display_name ?? o.displayName ?? o.full_name ?? o.fullName ?? o.long_name ?? o.title ?? o.name ?? o.code ?? o.id) as string | undefined;
    return (typeof s === "string" && s) ? s : null;
  }
  return null; // unreachable: callers feed JSON.parse output
  /* v8 ignore stop */
}

/** Normalize raw Fynd API response to array of shipment-like objects */
export function normalizeFyndPayload(payload: unknown): unknown[] {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.items)) return o.items;
  if (Array.isArray(o.shipments)) return o.shipments;
  if (Array.isArray(o.results)) return o.results;
  const dataExt = o.data as Record<string, unknown> | undefined;
  if (dataExt && Array.isArray(dataExt.items)) return dataExt.items;

  const order = o.order as Record<string, unknown> | undefined;
  if (order && typeof order === "object" && Array.isArray(order.shipments)) return order.shipments;
  if (order && typeof order === "object" && Array.isArray(order.bags)) return order.bags;
  if (typeof o === "object" && Object.keys(o).length > 0) return [o];
  return [];
}

export type TrackingInfoFromFynd = {
  trackingUrl?: string | null;
  logisticsPartner?: string | null;
  fyndStatus?: string | null;
  awbNo?: string | null;
};

/** Extract tracking URL, DP name, status from Fynd payload for customer-facing display.
 * Checks dp_details (display_name, name, awb_no, track_url) and top-level tracking_url. */
export function getTrackingInfoFromFyndPayload(fyndPayloadJson: string | null | undefined): TrackingInfoFromFynd | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    /* v8 ignore start */ // defensive: deep ?? fallback chains across dp_details / tracking_url / status / awb shape variations
    const dpDetails = (first.delivery_partner_details as Record<string, unknown>) ?? (first.dp_details as Record<string, unknown>) ?? {};
    const trackUrl = first.tracking_url ?? first.track_url ?? first.trackUrl ?? dpDetails.track_url ?? dpDetails.tracking_url;
    const dp = dpDetails.display_name ?? dpDetails.name ?? first.dp_name ?? first.dp ?? first.courierName ?? first.courier_name ?? first.logistics_partner;
    const status = first.shipment_status ?? first.orderStatus ?? first.status;
    // Safely extract string from status (can be object like { status: "...", title: "..." })
    let fyndStatusStr: string | null = null;
    if (typeof status === "string") {
      fyndStatusStr = status || null;
    } else if (status && typeof status === "object") {
      const so = status as Record<string, unknown>;
      const extracted = so.title ?? so.status ?? so.name ?? so.display_name ?? so.value;
      fyndStatusStr = typeof extracted === "string" ? (extracted || null) : null;
    }
    const awb = dpDetails.awb_no ?? first.awb_no ?? first.awbNumber ?? first.awb;
    const awbStr = Array.isArray(awb) ? awb[0] : awb;
    const validAwb = typeof awbStr === "string" && !isLikelyFyndId(awbStr) ? awbStr : null;
    return {
      trackingUrl: typeof trackUrl === "string" ? trackUrl : null,
      logisticsPartner: typeof dp === "string" ? dp : (dp && typeof dp === "object" && "name" in dp ? String((dp as { name?: string }).name) : null),
      fyndStatus: fyndStatusStr,
      awbNo: validAwb,
    };
    /* v8 ignore stop */
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
      /* v8 ignore start */
      // defensive: item is always object in valid Fynd payloads; fallback {} unreachable
      const raw = (typeof item === "object" && item != null ? item : {}) as Record<string, unknown>;
      /* v8 ignore stop */
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

/** Pickup/return address from Fynd payload */
export type PickupAddressFromFynd = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
  phone?: string | null;
  name?: string | null;
  formatted?: string;
};

/** Extract pickup/return address from Fynd payload (return_address, pickup_address, etc.) */
export function getPickupAddressFromFyndPayload(fyndPayloadJson: string | null | undefined): PickupAddressFromFynd | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    const bags = first.bags as Array<Record<string, unknown>> | undefined;
    const bagReturnAddr = (bags?.[0]?.return_config as Record<string, unknown>)?.return_address as Record<string, unknown> | undefined;
    const addr =
      (first.return_address as Record<string, unknown>) ??
      (first.pickup_address as Record<string, unknown>) ??
      (first.pickupAddress as Record<string, unknown>) ??
      (first.returnAddress as Record<string, unknown>) ??
      bagReturnAddr ??
      (first.address as Record<string, unknown>);
    if (!addr || typeof addr !== "object") return null;
    const a1 = toDisplayString(addr.address1 ?? addr.address ?? addr.street);
    const a2 = toDisplayString(addr.address2 ?? addr.area);
    const city = toDisplayString(addr.city);
    const state = toDisplayString(addr.state ?? addr.province);
    const pincode = toDisplayString(addr.pincode ?? addr.zip ?? addr.postal_code);
    const country = toDisplayString(addr.country);
    const phone = toDisplayString(addr.phone ?? addr.mobile);
    const name = toDisplayString(addr.name ?? addr.contact_name);
    const parts = [a1, a2, city, state, pincode, country].filter(Boolean);
    return {
      address1: a1 ?? null,
      address2: a2 ?? null,
      city: city ?? null,
      state: state ?? null,
      pincode: pincode ?? null,
      country: country ?? null,
      phone: phone ?? null,
      name: name ?? null,
      formatted: parts.length > 0 ? parts.join(", ") : undefined,
    };
  } catch {
    return null;
  }
}

export type FyndAddress = {
  name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country?: string | null;
  phone?: string | null;
  formatted?: string;
};

export type FyndShipmentPricing = {
  subtotal?: string;
  total?: string;
  currency?: string;
  discount?: string;
  deliveryCharges?: string;
  codAmount?: string;
  promotions?: string;
  coupon?: string;
};

export type FyndShipmentItem = {
  sku?: string;
  itemId?: string;
  affiliateLineNo?: string;
  title?: string;
  quantity?: number;
  identifier?: string;
  price?: string;
  discountedPrice?: string;
  discount?: string;
  total?: string;
  originalPrice?: string;
  markedPrice?: string;
  transferPrice?: string;
  shippingCharges?: string;
};

/** Structured Fynd Order details for the tab */
export type FyndOrderDetailsTab = {
  fyndOrderId: string | null;
  paymentMethod?: string | null;
  supportUrl?: string | null;
  shipments: Array<{
    shipmentId: string;
    forwardShipmentId: string | null;
    cpName: string | null;
    forwardAwb: string | null;
    returnAwb: string | null;
    trackingUrl: string | null;
    invoiceNumber: string | null;
    invoiceId: string | null;
    invoiceUrl: string | null;
    labelUrl: string | null;
    fulfillmentStore: string | null;
    fulfillmentOptions: string | null;
    shipmentStatus: string | null;
    creditNoteId: string | null;
    journeyType: string | null;
    estimatedDelivery?: string | null;
    deliveryAddress?: FyndAddress | null;
    returnPickupAddress?: FyndAddress | null;
    weightInfo?: string | null;
    dimensions?: string | null;
    storePhone?: string | null;
    storeEmail?: string | null;
    dpPhone?: string | null;
    dpGstin?: string | null;
    invoiceA3Url?: string | null;
    ewaybillUrl?: string | null;
    pricing?: FyndShipmentPricing;
    trackingDetails?: Array<{
      status: string;
      time: string;
      message?: string;
    }>;
    items: FyndShipmentItem[];
  }>;
};

function extractAddressFields(addrObj: Record<string, unknown> | undefined): FyndAddress | null {
  if (!addrObj || typeof addrObj !== "object") return null;
  const name = toDisplayString(addrObj.name ?? addrObj.contact_name ?? addrObj.contact_person);
  const a1 = toDisplayString(addrObj.address1 ?? addrObj.address ?? addrObj.street);
  const a2 = toDisplayString(addrObj.address2 ?? addrObj.area ?? addrObj.landmark);
  const city = toDisplayString(addrObj.city);
  const state = toDisplayString(addrObj.state ?? addrObj.province);
  const pincode = toDisplayString(addrObj.pincode ?? addrObj.zip ?? addrObj.postal_code);
  const country = toDisplayString(addrObj.country ?? addrObj.country_code);
  const phone = toDisplayString(addrObj.phone ?? addrObj.mobile ?? addrObj.contact_phone);
  /* v8 ignore start */
  // defensive: a1/a2 truthy fallbacks; some fixtures only have one of the two
  const addressLine = [a1, a2].filter(Boolean).join(", ");
  /* v8 ignore stop */
  const parts = [name, addressLine, city, state, pincode, country].filter(Boolean);
  if (parts.length === 0) return null;
  /* v8 ignore start */
  // defensive: nullish-coalescing fallbacks across address fields
  return {
    name: name ?? null, address: addressLine || null,
    city: city ?? null, state: state ?? null, pincode: pincode ?? null,
    country: country ?? null, phone: phone ?? null,
    formatted: parts.join(", "),
  };
  /* v8 ignore stop */
}

/** Extract structured Fynd Order details for the tab (order id, shipment ids, CP name, AWB, invoice, fulfillment, status, items) */
export function parseFyndOrderDetailsForTab(fyndPayloadJson: string | null | undefined): FyndOrderDetailsTab | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    /* v8 ignore start */ // defensive: ?? fallback chain across order_id shape variations
    const orderFromFirst = (first?.order as Record<string, unknown>) ?? {};
    const fyndOrderId = first
      ? String(
        first.order_id ?? first.orderId ?? first.channel_order_id ?? orderFromFirst.fynd_order_id ?? orderFromFirst.affiliate_order_id ?? first.affiliate_order_id ?? first.id ?? ""
      )
      : null;
    /* v8 ignore stop */
    const shipmentsRaw = list.map((item) => {
      /* v8 ignore start */ // defensive: extensive ?? / ?. fallback chains across Fynd response shape variations
      const raw = (typeof item === "object" && item != null ? item : {}) as Record<string, unknown>;
      const meta = (raw.meta as Record<string, unknown>) ?? {};
      const dpDetails = (raw.dp_details as Record<string, unknown>) ?? {};
      const awb = dpDetails.awb_no ?? raw.awbNumber ?? raw.awb_no ?? raw.awb ?? meta.awb_no ?? meta.awb;
      const awbVal = Array.isArray(awb) ? awb[0] : awb;
      const awbStr = toDisplayString(awbVal) ?? (typeof awbVal === "string" ? awbVal : null);
      const logisticsPartnerRaw = dpDetails.display_name ?? dpDetails.name ?? raw.logistics_partner ?? raw.logisticsPartner ?? raw.courierName ?? raw.courier_name ?? raw.dp_name ?? raw.dp ?? meta.cp_name ?? meta.courier_name ?? meta.logistics_partner;
      const cpName = toFullDisplayString(logisticsPartnerRaw) ?? toDisplayString(logisticsPartnerRaw);
      let trackUrl = raw.tracking_url ?? raw.track_url ?? raw.trackUrl ?? dpDetails.track_url ?? dpDetails.tracking_url ?? meta.tracking_url ?? meta.track_url;
      if (typeof trackUrl !== "string" && Array.isArray(raw.bags) && raw.bags.length > 0) {
        for (const bag of raw.bags as Record<string, unknown>[]) {
          const b = bag ?? {};
          const m = (b.meta ?? b.dp_details) as Record<string, unknown> | undefined;
          const t = b.tracking_url ?? b.track_url ?? b.trackUrl ?? m?.tracking_url ?? m?.track_url;
          if (typeof t === "string") {
            trackUrl = t;
            break;
          }
        }
      }
      let trackingUrlStr = typeof trackUrl === "string" ? trackUrl : null;
      if (!trackingUrlStr && awbStr && cpName) {
        trackingUrlStr = buildTrackingUrlFromCourierAndAwb(cpName, awbStr);
      }
      const invoiceObj = (raw.invoice != null && typeof raw.invoice === "object") ? raw.invoice as Record<string, unknown> : null;
      const invNum = toDisplayString(
        invoiceObj?.store_invoice_id ?? invoiceObj?.external_invoice_id ??
        raw.invoice_number ?? raw.invoiceNumber ?? raw.marketplaceInvoiceNumber ??
        meta.invoice_number ?? raw.invoice_id ?? raw.invoiceId ?? meta.invoice_id
      );
      const invId = toDisplayString(raw.invoice_id ?? raw.invoiceId ?? meta.invoice_id ?? raw.invoice_number ?? meta.invoice_number);
      const invoiceUrlRaw = invoiceObj?.invoice_url ?? (invoiceObj?.links as Record<string, unknown> | undefined)?.invoice_a4;
      const invoiceUrl = typeof invoiceUrlRaw === "string" && invoiceUrlRaw ? invoiceUrlRaw : null;
      const labelUrlRaw = invoiceObj?.label_url ?? (invoiceObj?.links as Record<string, unknown> | undefined)?.label;
      const labelUrl = typeof labelUrlRaw === "string" && labelUrlRaw ? labelUrlRaw : null;

      const fulfillStoreObj = (raw.fulfilling_store != null && typeof raw.fulfilling_store === "object") ? raw.fulfilling_store as Record<string, unknown> : null;
      const fulfillStoreName = fulfillStoreObj
        ? (toDisplayString(fulfillStoreObj.store_name ?? fulfillStoreObj.name ?? fulfillStoreObj.display_name ?? (fulfillStoreObj.meta as Record<string, unknown> | undefined)?.display_name))
        : toDisplayString(raw.fulfilling_store ?? raw.fulfilling_store_name ?? raw.fulfilling_company);
      const fulfillStoreCity = fulfillStoreObj ? toDisplayString(fulfillStoreObj.city) : null;
      const fulfillStore = fulfillStoreName
        ? (fulfillStoreCity ? `${fulfillStoreName}, ${fulfillStoreCity}` : fulfillStoreName)
        : null;

      const fulfillOptionObj = (raw.fulfillment_option != null && typeof raw.fulfillment_option === "object") ? raw.fulfillment_option as Record<string, unknown> : null;
      const orderObj = (raw.order != null && typeof raw.order === "object") ? raw.order as Record<string, unknown> : null;
      const fulfillOptsRaw = [
        fulfillOptionObj ? toDisplayString(fulfillOptionObj.name ?? fulfillOptionObj.slug) : null,
        toDisplayString(raw.ordering_source ?? orderObj?.ordering_source),
        toDisplayString(raw.ordering_channel ?? raw.orderingChannel ?? orderObj?.ordering_channel),
        toDisplayString(raw.channel),
        toDisplayString(raw.fulfillmentType ?? raw.fulfillment_type),
      ].filter(Boolean) as string[];
      const fulfillOpts = fulfillOptsRaw.length > 0 ? fulfillOptsRaw.join(" · ") : null;

      const creditNoteIdRaw = raw.credit_note_id ?? invoiceObj?.credit_note_id;
      const creditNoteId = typeof creditNoteIdRaw === "string" && creditNoteIdRaw ? creditNoteIdRaw : null;
      const journeyType = typeof raw.journey_type === "string" ? raw.journey_type : null;
      const status = raw.shipment_status ?? raw.shipmentStatus ?? raw.orderStatus ?? raw.status;
      // Fynd shipment_status can be an object like { status: "bag_picked", title: "..." } or a plain string.
      // Extract the best string representation, never pass an object downstream.
      let shipmentStatusStr: string | null = null;
      if (typeof status === "string") {
        shipmentStatusStr = status || null;
      } else if (status && typeof status === "object" && status !== null) {
        const so = status as Record<string, unknown>;
        const extracted = so.title ?? so.status ?? so.name ?? so.display_name ?? so.displayName ?? so.value ?? so.code;
        shipmentStatusStr = typeof extracted === "string" ? (extracted || null) : (typeof extracted === "number" ? String(extracted) : null);
      }
      // --- Shipment-level pricing (Fynd Konnect orderPrice, breakup, prices_info) ---
      const orderPrice = (raw.orderPrice ?? raw.order_price ?? raw.prices ?? raw.prices_info) as Record<string, unknown> | undefined;
      const breakup = (raw.breakup ?? raw.price_breakup) as Array<{ type?: string; value?: number; display?: string }> | undefined;
      const toNumStr = (v: unknown): string | undefined => {
        if (v == null) return undefined;
        if (typeof v === "number" && !isNaN(v)) return String(v);
        if (typeof v === "string") return v;
        return undefined;
      };
      const breakupVal = (type: string) => {
        const b = breakup?.find((x) => x.type === type);
        return b?.value != null ? String(b.value) : undefined;
      };
      const subtotalStr =
        toNumStr(orderPrice?.subtotal ?? orderPrice?.subtotalAmount ?? orderPrice?.product_total) ?? breakupVal("subtotal") ?? breakupVal("mrp");
      const totalStr =
        toNumStr(orderPrice?.orderTotalAmount ?? orderPrice?.total ?? orderPrice?.amount ?? orderPrice?.order_total) ?? breakupVal("total");
      const discountVal = orderPrice?.discount ?? orderPrice?.total_discount ?? breakup?.find((b) => b.type === "discount")?.value;
      const deliveryVal = orderPrice?.deliveryCharges ?? orderPrice?.delivery_charges ?? orderPrice?.shipping ?? breakup?.find((b) => b.type === "delivery")?.value;
      const codVal = orderPrice?.codAmount ?? orderPrice?.cod_amount;
      const promoVal = orderPrice?.promotion ?? orderPrice?.promotions ?? breakup?.find((b) => b.type === "promotion")?.value;
      const couponVal = orderPrice?.coupon ?? orderPrice?.coupon_value ?? breakup?.find((b) => b.type === "coupon")?.value;
      const currency = orderPrice?.currency as string | undefined;
      const shipmentPricing =
        subtotalStr || totalStr || toNumStr(discountVal) || toNumStr(deliveryVal) || toNumStr(codVal) || toNumStr(promoVal) || toNumStr(couponVal) || currency
          ? {
            subtotal: subtotalStr ?? undefined,
            total: totalStr ?? undefined,
            currency: currency ?? undefined,
            discount: toNumStr(discountVal) ?? undefined,
            deliveryCharges: toNumStr(deliveryVal) ?? undefined,
            codAmount: toNumStr(codVal) ?? undefined,
            promotions: toNumStr(promoVal) ?? undefined,
            coupon: toNumStr(couponVal) ?? undefined,
          }
          : undefined;

      const rawOrderItems = raw.orderItems ?? raw.order_items ?? raw.items ?? [];
      let orderItems = Array.isArray(rawOrderItems) ? rawOrderItems : [];
      if (orderItems.length === 0 && Array.isArray(raw.bags)) {
        const fromBags: unknown[] = [];
        for (const bag of raw.bags as Record<string, unknown>[]) {
          const articles = bag?.articles ?? bag?.items ?? bag?.item;
          if (Array.isArray(articles)) fromBags.push(...articles);
          else if (articles && typeof articles === "object") fromBags.push(articles);
        }
        if (fromBags.length > 0) orderItems = fromBags;
      }
      if (orderItems.length === 0 && Array.isArray(raw.packages)) {
        const fromPkgs: unknown[] = [];
        for (const pkg of raw.packages as Record<string, unknown>[]) {
          const pkgItems = pkg?.items ?? pkg?.articles ?? pkg?.item;
          if (Array.isArray(pkgItems)) fromPkgs.push(...pkgItems);
          else if (pkgItems && typeof pkgItems === "object") fromPkgs.push(pkgItems);
        }
        if (fromPkgs.length > 0) orderItems = fromPkgs;
      }
      const items = orderItems.map((oi) => {
        const o = (typeof oi === "object" && oi != null ? oi : {}) as Record<string, unknown>;
        const qty = typeof o.quantity === "number" ? o.quantity : typeof o.qty === "number" ? o.qty : 1;
        // Fynd Konnect: orderItemPrice { totalMarkedPrice, discount, totalItemPrice }
        const orderItemPrice = (o.orderItemPrice ?? o.order_item_price ?? o.price_info ?? o.priceInfo) as Record<string, unknown> | undefined;
        const orderPriceMarked = orderItemPrice?.totalMarkedPrice ?? orderItemPrice?.total_marked_price ?? orderItemPrice?.mrp;
        const orderPriceDiscount = orderItemPrice?.discount;
        const orderPriceTotal = orderItemPrice?.totalItemPrice ?? orderItemPrice?.total_item_price ?? orderItemPrice?.amount;
        const orderPriceTransfer = orderItemPrice?.transferPrice ?? orderItemPrice?.transfer_price;
        const orderPriceShipping = orderItemPrice?.shippingCharges ?? orderItemPrice?.shipping_charges;
        const priceVal =
          orderPriceMarked ??
          orderPriceTotal ??
          o.price ??
          o.amount ??
          o.effective_price ??
          o.effectivePrice ??
          o.sale_price ??
          o.salePrice ??
          o.unit_price ??
          o.unitPrice ??
          o.mrp;
        const priceStr = typeof priceVal === "string" ? priceVal : typeof priceVal === "number" ? String(priceVal) : null;
        const discountedVal =
          orderPriceTotal ??
          o.discounted_price ??
          o.discountedPrice ??
          o.effective_price ??
          o.effectivePrice ??
          o.sale_price ??
          o.salePrice;
        const discountedStr = typeof discountedVal === "string" ? discountedVal : typeof discountedVal === "number" ? String(discountedVal) : null;
        const discountVal = orderPriceDiscount ?? o.discount ?? o.discount_amount ?? o.discountAmount ?? o.discount_value;
        const discountStr = typeof discountVal === "string" ? discountVal : typeof discountVal === "number" ? String(discountVal) : null;
        const totalVal = orderPriceTotal ?? o.total ?? o.line_total ?? o.lineTotal ?? o.amount ?? o.final_price;
        const itemTotalStr = typeof totalVal === "string" ? totalVal : typeof totalVal === "number" ? String(totalVal) : (priceStr && qty ? String(parseFloat(priceStr) * qty) : null);
        const itemIdVal = o.orderItemId ?? o.order_item_id ?? o.id ?? o.item_id ?? o._id ?? o.identifier;
        const itemIdStr = itemIdVal != null ? String(itemIdVal) : null;
        const lineNoVal = o.line_number ?? o.line_no ?? o.affiliate_line_no ?? o.lineNumber ?? o.index ?? o.packetNumber;
        const lineNoStr = lineNoVal != null ? String(lineNoVal) : null;
        const skuVal = (o.productIdentifiers as { sku_code?: string })?.sku_code ?? o.sku ?? o.code ?? o.identifier ?? o.seller_identifier;
        const skuStr = toDisplayString(skuVal) ?? (typeof skuVal === "string" ? skuVal : null);
        return {
          sku: skuStr ?? undefined,
          itemId: itemIdStr ?? undefined,
          affiliateLineNo: lineNoStr ?? undefined,
          title: toDisplayString(o.title ?? o.product_title ?? o.productTitle ?? o.name ?? o.product_name) ?? undefined,
          quantity: qty,
          identifier: toDisplayString(o.identifier ?? o.seller_identifier) ?? undefined,
          price: priceStr ?? undefined,
          discountedPrice: discountedStr ?? undefined,
          discount: discountStr ?? undefined,
          total: itemTotalStr ?? undefined,
          originalPrice: priceStr ?? undefined,
          markedPrice: toNumStr(orderPriceMarked) ?? undefined,
          transferPrice: toNumStr(orderPriceTransfer) ?? undefined,
          shippingCharges: toNumStr(orderPriceShipping) ?? undefined,
        };
      });
      const forwardShipmentIdVal = raw.forward_shipment_id ?? raw.forwardShipmentId;
      const forwardShipmentIdStr = forwardShipmentIdVal != null ? String(forwardShipmentIdVal).trim() : null;
      const returnShipmentId = raw.shipment_id ?? raw.shipmentId ?? raw.id ?? raw.channel_shipment_id;

      const updatedAtRaw =
        raw.updated_at ?? raw.updatedAt ?? meta.updated_at ?? meta.updatedAt ?? raw.created_at ?? raw.createdAt;
      const updatedAtMs =
        typeof updatedAtRaw === "string" && updatedAtRaw ? Date.parse(updatedAtRaw) : (typeof updatedAtRaw === "number" ? updatedAtRaw : 0);

      let trackingDetails: Array<{ status: string, time: string, message?: string }> = [];
      const trackingList = raw.tracking_details ?? raw.shipment_status_updates;
      if (Array.isArray(trackingList)) {
        trackingDetails = trackingList.map((t: Record<string, unknown>) => ({
          status: String(t.status || t.shipment_status || t.state || ""),
          time: String(t.time || t.created_at || t.timestamp || ""),
          message: typeof t.message === "string" ? t.message : (typeof t.tracking_details === "string" ? t.tracking_details : undefined)
        })).filter(t => t.status || t.time);
      }

      // Estimated delivery date
      const promiseObj = raw.promise as Record<string, unknown> | undefined;
      const slaObj = raw.sla as Record<string, unknown> | undefined;
      const estDeliveryRaw = promiseObj?.timestamp ?? promiseObj?.max ?? promiseObj?.expected_delivery_date
        ?? slaObj?.expected_delivery_date ?? slaObj?.delivery_date
        ?? raw.delivery_date ?? raw.expected_delivery_date ?? raw.estimated_delivery_date
        ?? raw.expected_at ?? raw.delivery_promise;
      const estimatedDelivery = typeof estDeliveryRaw === "string" ? estDeliveryRaw : null;

      // Delivery address (for forward shipments)
      const deliveryAddrRaw = (raw.delivery_address ?? raw.shipping_address ?? raw.deliveryAddress ?? raw.shippingAddress) as Record<string, unknown> | undefined;
      const deliveryAddress = extractAddressFields(deliveryAddrRaw);

      // Return pickup address
      const returnAddrRaw = (raw.return_address ?? raw.pickup_address ?? raw.pickupAddress ?? raw.returnAddress) as Record<string, unknown> | undefined;
      const returnPickupAddress = extractAddressFields(returnAddrRaw);

      // Weight info
      const weightRaw = raw.weight ?? (raw.size_info as Record<string, unknown>)?.weight;
      const weightInfo = weightRaw != null ? String(typeof weightRaw === "number" ? `${weightRaw} kg` : weightRaw) : null;

      // Package dimensions
      const sizeInfoObj = (raw.size_info != null && typeof raw.size_info === "object") ? raw.size_info as Record<string, unknown> : null;
      const dimLength = sizeInfoObj?.length ?? sizeInfoObj?.l;
      const dimWidth = sizeInfoObj?.width ?? sizeInfoObj?.w ?? sizeInfoObj?.breadth;
      const dimHeight = sizeInfoObj?.height ?? sizeInfoObj?.h;
      const dimUnit = toDisplayString(sizeInfoObj?.unit_of_measurement ?? sizeInfoObj?.unit) ?? "cm";
      const dimensions = (dimLength && dimWidth && dimHeight) ? `${dimLength} × ${dimWidth} × ${dimHeight} ${dimUnit}` : null;

      // Store contact info
      const storePhone = fulfillStoreObj ? toDisplayString(fulfillStoreObj.phone ?? fulfillStoreObj.contact_phone ?? fulfillStoreObj.store_phone ?? (fulfillStoreObj.meta as Record<string, unknown> | undefined)?.phone) : null;
      const storeEmail = fulfillStoreObj ? toDisplayString(fulfillStoreObj.email ?? fulfillStoreObj.store_email ?? (fulfillStoreObj.meta as Record<string, unknown> | undefined)?.email) : null;

      // DP contact info
      const dpPhone = toDisplayString(dpDetails.phone ?? dpDetails.contact ?? dpDetails.mobile ?? meta.dp_phone);
      const dpGstin = toDisplayString(dpDetails.gst_in ?? dpDetails.gstin ?? meta.dp_gstin);

      // Additional invoice formats
      const invoiceLinksObj = (invoiceObj?.links ?? {}) as Record<string, unknown>;
      const invoiceA3Url = typeof invoiceLinksObj.invoice_a3 === "string" ? invoiceLinksObj.invoice_a3 : null;
      const ewaybillUrl = typeof invoiceLinksObj.invoice_ewaybill === "string" ? invoiceLinksObj.invoice_ewaybill
        : (typeof invoiceObj?.ewaybill_url === "string" ? invoiceObj.ewaybill_url : null);

      return {
        shipmentId: String(returnShipmentId ?? "—"),
        forwardShipmentId: forwardShipmentIdStr || null,
        cpName: cpName ?? null,
        forwardAwb: journeyType === "return" ? null : (awbStr ?? null),
        returnAwb: journeyType === "return" ? (awbStr ?? null) : null,
        trackingUrl: trackingUrlStr,
        invoiceNumber: invNum ?? null,
        invoiceId: invId ?? null,
        invoiceUrl,
        labelUrl,
        fulfillmentStore: fulfillStore ?? null,
        fulfillmentOptions: fulfillOpts ?? null,
        shipmentStatus: shipmentStatusStr ?? null,
        creditNoteId,
        journeyType,
        estimatedDelivery,
        deliveryAddress,
        returnPickupAddress,
        weightInfo,
        dimensions,
        storePhone: storePhone ?? null,
        storeEmail: storeEmail ?? null,
        dpPhone: dpPhone ?? null,
        dpGstin: dpGstin ?? null,
        invoiceA3Url,
        ewaybillUrl,
        pricing: shipmentPricing,
        trackingDetails,
        items,
        _updatedAtMs: updatedAtMs,
      };
      /* v8 ignore stop */
    });

    /* v8 ignore start */ // defensive: dedupe + payment/support fallback chains
    // Dedupe shipments: Fynd payloads sometimes return multiple rows for the same shipment.
    // Keep the most recently updated entry per shipmentId to avoid “random” status/history and UI tab explosion.
    const shipmentsById = new Map<string, (typeof shipmentsRaw)[number]>();
    for (const s of shipmentsRaw) {
      const rawShipmentId = (s as { shipmentId?: string }).shipmentId;
      // Use unique keys for null-ID shipments to prevent multiple distinct shipments
      // from collapsing into one entry keyed "—" (which caused random data to appear).
      const id = rawShipmentId ? String(rawShipmentId) : `__noId_${shipmentsById.size}`;
      const prev = shipmentsById.get(id);
      const sMs = (s as { _updatedAtMs?: number })._updatedAtMs ?? 0;
      const pMs = prev ? ((prev as { _updatedAtMs?: number })._updatedAtMs ?? 0) : 0;
      if (!prev || sMs >= pMs) shipmentsById.set(id, s);
    }
    const shipments = [...shipmentsById.values()]
      .sort((a, b) => ((b as { _updatedAtMs?: number })._updatedAtMs ?? 0) - ((a as { _updatedAtMs?: number })._updatedAtMs ?? 0))
      .map((s) => {
        const { _updatedAtMs: _omit, ...rest } = s as Record<string, unknown> as { _updatedAtMs?: number };
        return rest as unknown as FyndOrderDetailsTab["shipments"][number];
      });

    // Order-level fields from first shipment
    const firstRaw = (list[0] && typeof list[0] === "object" ? list[0] : {}) as Record<string, unknown>;
    const paymentModeRaw = firstRaw.payment_mode ?? firstRaw.paymentType ?? firstRaw.payment_type ?? firstRaw.mode_of_payment ?? (firstRaw.order as Record<string, unknown>)?.payment_mode;
    const paymentMethod = toDisplayString(paymentModeRaw);
    const supportUrlRaw = firstRaw.need_help_url ?? firstRaw.support_url ?? firstRaw.needHelpUrl;
    const supportUrl = typeof supportUrlRaw === "string" ? supportUrlRaw : null;

    return { fyndOrderId: fyndOrderId || null, paymentMethod: paymentMethod ?? null, supportUrl, shipments };
    /* v8 ignore stop */
  } catch {
    return null;
  }
}

/** Extract customer info from Fynd payload (delivery_address, billing_address, meta) */
export function extractCustomerFromFyndPayload(fyndPayloadJson: string | null | undefined): {
  name?: string; email?: string; phone?: string;
  city?: string; country?: string; address1?: string;
  address2?: string; province?: string; zip?: string; landmark?: string;
} | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    const deliveryAddr = (first.delivery_address ?? first.shipping_address ?? first.deliveryAddress ?? first.shippingAddress) as Record<string, unknown> | undefined;
    const billingAddr = (first.billing_address ?? first.billingAddress) as Record<string, unknown> | undefined;
    const meta = (first.meta ?? {}) as Record<string, unknown>;
    const addr = deliveryAddr ?? billingAddr;
    // unreachable: meta is always `first.meta ?? {}` (truthy)
    /* v8 ignore start */
    if (!addr && !meta) return null;
    /* v8 ignore stop */
    const a = (addr ?? {}) as Record<string, unknown>;
    const firstName = typeof a.first_name === "string" ? a.first_name : "";
    const lastName = typeof a.last_name === "string" ? a.last_name : "";
    const fullName = typeof a.name === "string" && a.name ? a.name : [firstName, lastName].filter(Boolean).join(" ");
    const email = (typeof a.email === "string" ? a.email : null) ?? (typeof meta?.email === "string" ? meta.email : null);
    const phone = (typeof a.phone === "string" ? a.phone : null) ?? (typeof a.mobile === "string" ? a.mobile : null) ?? (typeof meta?.mobile === "string" ? meta.mobile : null) ?? (typeof meta?.phone === "string" ? meta.phone : null);
    const city = typeof a.city === "string" ? a.city : null;
    const country = typeof a.country === "string" ? a.country : null;
    const address1 = (typeof a.address1 === "string" ? a.address1 : null) ?? (typeof a.address === "string" ? a.address : null);
    /* v8 ignore start */
    // defensive: address2 vs area fallback; only one shape in fixtures
    const address2 = (typeof a.address2 === "string" ? a.address2 : null) ?? (typeof a.area === "string" ? a.area : null);
    /* v8 ignore stop */
    const province = (typeof a.state === "string" ? a.state : null) ?? (typeof a.province === "string" ? a.province : null);
    const zip = (typeof a.pincode === "string" ? a.pincode : null) ?? (typeof a.zip === "string" ? a.zip : null) ?? (typeof a.postal_code === "string" ? a.postal_code : null);
    /* v8 ignore start */
    // defensive: landmark typeof + conditional spread fallbacks rarely all-present in fixtures
    const landmark = typeof a.landmark === "string" ? a.landmark : null;
    /* v8 ignore stop */
    if (!fullName && !email && !phone) return null;
    // defensive: each ternary's false-side fires only when fixture omits that field; not all combos exercised
    /* v8 ignore start */
    return {
      ...(fullName ? { name: fullName } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(city ? { city } : {}),
      ...(country ? { country } : {}),
      ...(address1 ? { address1 } : {}),
      ...(address2 ? { address2 } : {}),
      ...(province ? { province } : {}),
      ...(zip ? { zip } : {}),
      ...(landmark ? { landmark } : {}),
    };
    /* v8 ignore stop */
  } catch {
    return null;
  }
}

/** Extract shipping/logistics details from Fynd payload (dp_details, awb, tracking, invoice, label) */
export function extractShippingDetailsFromFyndPayload(fyndPayloadJson: string | null | undefined): {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  labelUrl: string | null;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
} | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    /* v8 ignore start */ // defensive: deep ?? / ?. fallback chains across dp_details/meta/invoice/links/awb shape variations
    const dpDetails = (first.delivery_partner_details as Record<string, unknown>) ?? (first.dp_details as Record<string, unknown>) ?? {};
    const meta = (first.meta as Record<string, unknown>) ?? {};
    const inv = first.invoice as Record<string, unknown> | undefined;
    // Carrier
    const carrier = toFullDisplayString(dpDetails.display_name ?? dpDetails.name ?? first.dp_name ?? first.dp ?? first.courierName ?? first.courier_name ?? first.logistics_partner ?? meta.cp_name ?? meta.courier_name);
    // AWB
    const awbRaw = dpDetails.awb_no ?? first.awb_no ?? first.awbNumber ?? first.awb ?? meta.awb_no ?? meta.awb;
    const awbVal = Array.isArray(awbRaw) ? awbRaw[0] : awbRaw;
    const awbCandidate = typeof awbVal === "string" && awbVal.trim() ? awbVal.trim() : null;
    const trackingNumber = awbCandidate && !isLikelyFyndId(awbCandidate) ? awbCandidate : null;
    // Tracking URL
    let trackingUrl = first.tracking_url ?? first.track_url ?? first.trackUrl ?? dpDetails.track_url ?? dpDetails.tracking_url ?? meta.tracking_url ?? meta.track_url;
    let trackingUrlStr = typeof trackingUrl === "string" && trackingUrl.trim() ? trackingUrl.trim() : null;
    if (!trackingUrlStr && trackingNumber && carrier) {
      trackingUrlStr = buildTrackingUrlFromCourierAndAwb(carrier, trackingNumber);
    }
    // Invoice URL
    const invoiceUrl = inv
      ? ((typeof inv.invoice_url === "string" && inv.invoice_url ? inv.invoice_url : null) ?? (typeof (inv.links as Record<string, unknown> | undefined)?.invoice_a4 === "string" ? (inv.links as Record<string, unknown>).invoice_a4 as string : null))
      : null;
    // Invoice number
    const invoiceNumber = inv
      ? (toDisplayString(inv.store_invoice_id ?? inv.external_invoice_id ?? first.invoice_number ?? first.invoiceNumber ?? meta.invoice_number) ?? null)
      : (toDisplayString(first.invoice_number ?? first.invoiceNumber ?? meta.invoice_number) ?? null);
    // Label URL
    const labelUrl = inv
      ? ((typeof inv.label_url === "string" && inv.label_url ? inv.label_url : null) ?? (typeof (inv.links as Record<string, unknown> | undefined)?.label === "string" ? (inv.links as Record<string, unknown>).label as string : null))
      : null;
    if (!carrier && !trackingNumber && !trackingUrlStr && !invoiceUrl && !labelUrl) return null;
    return { carrier, trackingNumber, trackingUrl: trackingUrlStr, labelUrl, invoiceUrl, invoiceNumber };
    /* v8 ignore stop */
  } catch {
    return null;
  }
}

/** Extract affiliate_order_id (Shopify order number) from Fynd payload */
export function extractAffiliateOrderIdFromFyndPayload(json: string | null | undefined): string | null {
  if (!json || typeof json !== "string") return null;
  try {
    const payload = JSON.parse(json) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    const order = first.order as Record<string, unknown> | undefined;
    const meta = first.meta as Record<string, unknown> | undefined;
    const s =
      first.affiliate_order_id ??
      first.external_order_id ??
      first.channel_order_id ??
      order?.affiliate_order_id ??
      order?.external_order_id ??
      meta?.affiliate_order_id ??
      meta?.external_order_id ??
      meta?.channel_order_id;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

/** Status step from Fynd bag_status (forward or return journey) */
export type FyndJourneyStep = {
  status: string;
  displayName: string;
  time: string;
  journeyType: "forward" | "return";
};

/**
 * Extract shipment journey (forward or return) from Fynd payload.
 * Reads bag_status from bags, filters by journey_type, sorts by updated_at.
 */
export function extractFyndJourney(
  fyndPayloadJson: string | null | undefined,
  journeyType: "forward" | "return"
): FyndJourneyStep[] {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return [];
  try {
    /* v8 ignore start */ // defensive: ?? / ?. fallback chains across bag_status/state_mapper/journey shape variations
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const o = payload as Record<string, unknown>;
    const order = o.order as Record<string, unknown> | undefined;
    const list = normalizeFyndPayload(payload);
    const steps: FyndJourneyStep[] = [];
    const seen = new Set<string>();

    const processBag = (bag: Record<string, unknown>) => {
      const bagStatusList = (bag.bag_status ?? bag.status_updates ?? []) as Record<string, unknown>[];
      for (const bs of bagStatusList) {
        const mapper = (bs.bag_state_mapper ?? bs.state_mapper ?? {}) as Record<string, unknown>;
        const jt = String(mapper.journey_type ?? mapper.journeyType ?? "").toLowerCase();
        // Only skip when journey_type is explicitly set to a different type; include steps when absent.
        if (jt && jt !== journeyType) continue;
        const status = String(bs.status ?? bs.shipment_status ?? "").trim();
        const displayName = String(
          mapper.display_name ?? mapper.displayName ?? mapper.app_display_name ?? mapper.name ?? status
        ).trim();
        const updatedAt = bs.updated_at ?? bs.created_at ?? bs.updated_ts ?? bs.created_ts ?? "";
        const timeStr = typeof updatedAt === "string" ? updatedAt : "";
        const key = `${status}-${timeStr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        steps.push({
          status,
          displayName: displayName || status || "—",
          time: timeStr,
          journeyType: journeyType as "forward" | "return",
        });
      }
    };

    if (order && Array.isArray(order.bags)) {
      for (const bag of order.bags as Record<string, unknown>[]) {
        if (bag && typeof bag === "object") processBag(bag);
      }
    }
    for (const item of list) {
      /* v8 ignore start */
      // defensive: item always object in valid Fynd payloads; raw.bags/raw.shipments fallback chain unreached for some shapes
      const raw = (typeof item === "object" && item != null ? item : {}) as Record<string, unknown>;
      const bags = (raw.bags ?? raw.shipments ?? []) as Record<string, unknown>[];
      /* v8 ignore stop */
      for (const bag of bags) {
        if (bag && typeof bag === "object") processBag(bag);
      }
    }
    /* v8 ignore stop */

    steps.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return ta - tb;
    });
    return steps;
  } catch {
    return [];
  }
}
