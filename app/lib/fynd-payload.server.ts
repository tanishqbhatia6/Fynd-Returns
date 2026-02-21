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
  }
  return out;
}

/** Build tracking URL from courier name + AWB when Fynd doesn't provide tracking_url */
function buildTrackingUrlFromCourierAndAwb(courierName: string, awb: string): string | null {
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
  if (typeof val === "string") return val || null;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const s = (o.name ?? o.title ?? o.display_name ?? o.displayName ?? o.code ?? o.id) as string | undefined;
    return (typeof s === "string" && s) ? s : null;
  }
  return null;
}

/** Prefer full/display names over short codes - for logistics partner etc. */
function toFullDisplayString(val: unknown): string | null {
  if (val == null) return null;
  if (typeof val === "string") return val || null;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    const s = (o.display_name ?? o.displayName ?? o.full_name ?? o.fullName ?? o.long_name ?? o.title ?? o.name ?? o.code ?? o.id) as string | undefined;
    return (typeof s === "string" && s) ? s : null;
  }
  return null;
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

/** Extract tracking URL, DP name, status from Fynd payload for customer-facing display.
 * Checks dp_details (display_name, name, awb_no, track_url) and top-level tracking_url. */
export function getTrackingInfoFromFyndPayload(fyndPayloadJson: string | null | undefined): TrackingInfoFromFynd | null {
  if (!fyndPayloadJson || typeof fyndPayloadJson !== "string") return null;
  try {
    const payload = JSON.parse(fyndPayloadJson) as unknown;
    const list = normalizeFyndPayload(payload);
    const first = list[0] as Record<string, unknown> | undefined;
    if (!first || typeof first !== "object") return null;
    const dpDetails = (first.dp_details as Record<string, unknown>) ?? {};
    const trackUrl = first.tracking_url ?? first.track_url ?? first.trackUrl ?? dpDetails.track_url ?? dpDetails.tracking_url;
    const dp = dpDetails.display_name ?? dpDetails.name ?? first.dp_name ?? first.dp ?? first.courierName ?? first.courier_name ?? first.logistics_partner;
    const status = first.shipment_status ?? first.orderStatus ?? first.status;
    const statusTitle = status && typeof status === "object" && status !== null && "title" in status
      ? (status as { title?: string }).title
      : status;
    const awb = dpDetails.awb_no ?? first.awb_no ?? first.awbNumber ?? first.awb;
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
    const addr =
      (first.return_address as Record<string, unknown>) ??
      (first.pickup_address as Record<string, unknown>) ??
      (first.pickupAddress as Record<string, unknown>) ??
      (first.returnAddress as Record<string, unknown>) ??
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

/** Structured Fynd Order details for the tab */
export type FyndOrderDetailsTab = {
  fyndOrderId: string | null;
  shipments: Array<{
    shipmentId: string;
    cpName: string | null;
    forwardAwb: string | null;
    trackingUrl: string | null;
    invoiceNumber: string | null;
    invoiceId: string | null;
    fulfillmentStore: string | null;
    fulfillmentOptions: string | null;
    shipmentStatus: string | null;
    items: Array<{
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
    }>;
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
      const invNum = toDisplayString(raw.invoice_number ?? raw.invoiceNumber ?? raw.marketplaceInvoiceNumber ?? meta.invoice_number ?? raw.invoice_id ?? raw.invoiceId ?? meta.invoice_id);
      const invId = toDisplayString(raw.invoice_id ?? raw.invoiceId ?? meta.invoice_id ?? raw.invoice_number ?? meta.invoice_number);
      const fulfillStore = toDisplayString(raw.fulfilling_store ?? raw.fulfilling_store_name ?? raw.fulfilling_company);
      const fulfillOptsRaw = [
        raw.ordering_source,
        raw.ordering_channel ?? raw.orderingChannel,
        raw.channel,
        raw.fulfillmentType ?? raw.fulfillment_type,
      ].map(toDisplayString).filter(Boolean);
      const fulfillOpts = fulfillOptsRaw.length > 0 ? fulfillOptsRaw.join(" · ") : null;
      const status = raw.shipment_status ?? raw.orderStatus ?? raw.status;
      const statusTitle = status && typeof status === "object" && status !== null && "title" in (status as object)
        ? (status as { title?: string }).title
        : status;
      const shipmentStatusStr = toDisplayString(statusTitle ?? status);
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
        const priceVal = o.price ?? o.amount ?? o.effective_price ?? o.effectivePrice ?? o.sale_price ?? o.salePrice ?? o.unit_price ?? o.unitPrice ?? o.mrp;
        const priceStr = typeof priceVal === "string" ? priceVal : typeof priceVal === "number" ? String(priceVal) : null;
        const discountedVal = o.discounted_price ?? o.discountedPrice ?? o.effective_price ?? o.effectivePrice ?? o.sale_price ?? o.salePrice;
        const discountedStr = typeof discountedVal === "string" ? discountedVal : typeof discountedVal === "number" ? String(discountedVal) : null;
        const discountVal = o.discount ?? o.discount_amount ?? o.discountAmount ?? o.discount_value;
        const discountStr = typeof discountVal === "string" ? discountVal : typeof discountVal === "number" ? String(discountVal) : null;
        const totalVal = o.total ?? o.line_total ?? o.lineTotal ?? o.amount ?? o.final_price;
        const totalStr = typeof totalVal === "string" ? totalVal : typeof totalVal === "number" ? String(totalVal) : (priceStr && qty ? String(parseFloat(priceStr) * qty) : null);
        const itemIdVal = o.id ?? o.item_id ?? o._id ?? o.identifier;
        const itemIdStr = itemIdVal != null ? String(itemIdVal) : null;
        const lineNoVal = o.line_number ?? o.line_no ?? o.affiliate_line_no ?? o.lineNumber ?? o.index;
        const lineNoStr = lineNoVal != null ? String(lineNoVal) : null;
        const skuVal = o.sku ?? o.code ?? o.identifier ?? o.seller_identifier;
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
          total: totalStr ?? undefined,
          originalPrice: priceStr ?? undefined,
        };
      });
      return {
        shipmentId: String(raw.id ?? raw.shipment_id ?? raw.shipmentId ?? raw.channel_shipment_id ?? "—"),
        cpName: cpName ?? null,
        forwardAwb: awbStr ?? null,
        trackingUrl: trackingUrlStr,
        invoiceNumber: invNum ?? null,
        invoiceId: invId ?? null,
        fulfillmentStore: fulfillStore ?? null,
        fulfillmentOptions: fulfillOpts ?? null,
        shipmentStatus: shipmentStatusStr ?? null,
        items,
      };
    });
    return { fyndOrderId: fyndOrderId || null, shipments };
  } catch {
    return null;
  }
}
