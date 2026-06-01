import type {
  ItemSelection,
  MediaPayload,
  OrderResponse,
  PortalBootstrap,
  PortalConfig,
  PortalLineItem,
  PortalShipmentItem,
} from "./types";

const fallbackLabels: Record<string, string> = {
  "portal.heading": "Returns and order tracking",
  "portal.subheading": "Look up an order, track a return, or start a new request in a few steps.",
  "portal.policyBanner": "Returns accepted within {days} days of delivery.",
  "portal.tab.trackOrder": "Track order",
  "portal.tab.trackReturn": "Track return",
  "portal.tab.createReturn": "Create return",
  "portal.lookup.submit": "Look up",
  "portal.lookup.searching": "Searching...",
  "portal.lookup.orderNumber": "Order number",
  "portal.lookup.returnRequestId": "Return request ID",
  "portal.lookup.returnNumber": "Return number",
  "portal.lookup.forwardAwb": "Forward AWB",
  "portal.lookup.returnAwb": "Return AWB",
  "portal.lookup.emailAddress": "Email address",
  "portal.lookup.phoneNumber": "Phone number",
  "portal.lookup.placeholderOrder": "e.g. #1001 or 1001",
  "portal.lookup.placeholderEmail": "you@example.com",
  "portal.lookup.placeholderPhone": "+91 9876543210",
  "portal.lookup.placeholderAwb": "Tracking number",
  "portal.results.orders": "Your orders",
  "portal.results.returns": "Your returns",
  "portal.results.noResults": "No results found",
  "portal.results.noResultsDesc": "Check the details and try again.",
  "portal.create.startTitle": "Start a return",
  "portal.create.startDesc": "Enter your order number to select eligible items.",
  "portal.create.findOrder": "Find order",
  "portal.create.submit": "Submit return",
  "portal.create.manualSubmit": "Submit manually",
  "portal.create.successTitle": "Return submitted",
  "portal.create.successNextSteps": "The store will review your request and share updates.",
  "portal.common.back": "Back",
  "portal.common.copy": "Copy",
  "portal.common.copied": "Copied",
  "portal.common.loading": "Loading...",
  "portal.common.item": "Item",
  "portal.error.pleaseEnter": "Please enter your {field}",
  "portal.error.lookupFailed": "Lookup failed. Please try again.",
  "portal.error.selectOneItem": "Select at least one item.",
  "portal.error.failedToSubmit": "Failed to submit. Please try again.",
};

export function t(bootstrap: PortalBootstrap, key: string, replacements?: Record<string, string | number>) {
  let value = bootstrap.labels[key] || fallbackLabels[key] || key;
  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}

export function parseJsonScript<T>(id: string, fallback: T): T {
  const el = document.getElementById(id);
  const text = el?.textContent?.trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function readBootstrap(): PortalBootstrap {
  const root = document.getElementById("return-portal-root");
  const configRaw = parseJsonScript<PortalConfig>("rpm-portal-config", {});
  const config: Required<PortalConfig> = {
    showOrderTracking: configRaw.showOrderTracking ?? true,
    showReturnTracking: configRaw.showReturnTracking ?? true,
    showCreateReturnTab: configRaw.showCreateReturnTab ?? true,
    defaultTab: configRaw.defaultTab ?? "return",
    allowMediaUploads: configRaw.allowMediaUploads ?? true,
    allowReturnCancellation: configRaw.allowReturnCancellation ?? true,
  };

  const returnReasons = parseJsonScript<unknown>("rpm-return-reasons", []);
  const normalizedReasons = Array.isArray(returnReasons) ? returnReasons.map(String) : ["Other"];

  return {
    appUrl: root?.dataset.appUrl || window.location.origin,
    shop: root?.dataset.shop || "",
    returnWindowDays: Number(root?.dataset.returnWindow || 30) || 30,
    returnPolicy: document.getElementById("rpm-return-policy")?.textContent || "",
    returnReasons: normalizedReasons.length ? normalizedReasons : ["Other"],
    returnReasonsByCategory: parseJsonScript<Record<string, string[]>>(
      "rpm-return-reasons-by-category",
      {},
    ),
    config,
    labels: window.__RPM_LABELS__ || {},
    locale: window.__RPM_LOCALE__ || document.documentElement.lang || "en",
    currency: window.__RPM_CURRENCY__ || "USD",
    timezone: window.__RPM_TIMEZONE__ || "UTC",
    features: window.__RPM_FEATURES__ || {},
    csrfToken: window.__RPM_PORTAL_CSRF__,
    authToken: window.__RPM_AUTH_TOKEN__,
    brandLogoUrl: root?.dataset.brandLogoUrl || "",
  };
}

export function formatMoney(value: unknown, currency: string, locale?: string) {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  if (!Number.isFinite(num)) return "";
  try {
    return new Intl.NumberFormat(locale || undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: num % 1 === 0 ? 0 : 2,
    }).format(num);
  } catch {
    return `${currency || ""} ${num.toFixed(num % 1 === 0 ? 0 : 2)}`.trim();
  }
}

export function formatDate(value: unknown, bootstrap: PortalBootstrap) {
  if (!value) return "Not available";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "Not available";
  try {
    return new Intl.DateTimeFormat(bootstrap.locale || undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: bootstrap.timezone || undefined,
    }).format(date);
  } catch {
    return date.toLocaleDateString();
  }
}

export function humanize(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "Pending";
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusTone(status: unknown): "ok" | "info" | "warn" | "danger" | "" {
  const s = String(status ?? "").toLowerCase();
  if (/(delivered|completed|approved|refunded|accepted|done|success)/.test(s)) return "ok";
  if (/(rejected|declined|cancelled|failed|error)/.test(s)) return "danger";
  if (/(pending|review|processing|initiated|confirmed|assigned)/.test(s)) return "warn";
  if (/(transit|shipped|pickup|picked|out)/.test(s)) return "info";
  return "";
}

export function getReasonsForItem(bootstrap: PortalBootstrap, productType?: string | null) {
  if (productType && bootstrap.returnReasonsByCategory[productType]?.length) {
    return bootstrap.returnReasonsByCategory[productType];
  }
  return bootstrap.returnReasons.length ? bootstrap.returnReasons : ["Other"];
}

export function normalizeItems(data: OrderResponse): ItemSelection[] {
  const rows: ItemSelection[] = [];
  const order = data.order;
  const availability = data.lineItemAvailability || {};
  const itemEligibility = data.itemEligibility || {};

  const shipments = Array.isArray(data.shipments) ? data.shipments : [];
  const hasShipmentRows = shipments.length > 0;

  if (hasShipmentRows) {
    for (const shipment of shipments) {
      for (const item of shipment.items || []) {
        rows.push(toSelection(item, data, `${shipment.shipmentId || "shipment"}:${item.bagId || item.id}`, {
          shipmentId: shipment.shipmentId,
          shipmentEligible: shipment.eligible,
          shipmentReason: shipment.eligibilityReason,
        }));
      }
    }
  }

  if (rows.length === 0) {
    for (const item of order?.lineItems || []) {
      rows.push(toSelection(item, data, item.id));
    }
  }

  const displayRows = hasShipmentRows ? clubShipmentRows(rows, availability) : rows;

  return displayRows.map((row) => {
    const available = availability[row.lineItemId]?.availableQty;
    const eligible = itemEligibility[row.lineItemId];
    const availableQty = typeof available === "number" ? Math.max(0, available) : row.availableQty;
    const disabled =
      row.disabled ||
      availableQty <= 0 ||
      eligible?.eligible === false ||
      availability[row.lineItemId]?.alreadyInReturn === true;
    const alreadyInReturn = availability[row.lineItemId]?.alreadyInReturn === true;
    return {
      ...row,
      availableQty,
      disabled,
      disabledReason:
        row.disabledReason ||
        (alreadyInReturn ? "Return already in progress for this item." : undefined) ||
        eligible?.reason ||
        (availableQty <= 0 ? "Already returned or unavailable" : undefined),
    };
  });
}

function clubShipmentRows(
  rows: ItemSelection[],
  availability: OrderResponse["lineItemAvailability"],
): ItemSelection[] {
  const grouped = new Map<string, ItemSelection[]>();
  const order: string[] = [];

  for (const row of rows) {
    const key = row.lineItemId || row.rowKey;
    if (!grouped.has(key)) {
      grouped.set(key, []);
      order.push(key);
    }
    grouped.get(key)!.push(row);
  }

  return order.map((key) => {
    const group = grouped.get(key)!;
    if (group.length === 1) {
      const row = group[0];
      return {
        ...row,
        rowKey: `line:${row.lineItemId}`,
        fyndShipmentId: undefined,
        fyndBagId: undefined,
        fyndArticleId: undefined,
        fyndAffiliateLineId: undefined,
        fyndSellerIdentifier: undefined,
        fyndItemId: undefined,
        fyndQuantityAvailable: undefined,
        fyndPriceEffective: undefined,
        fyndSize: undefined,
        fyndLineNumber: undefined,
      };
    }

    const base = group[0];
    const lineAvailability = availability?.[base.lineItemId];
    const eligibleRows = group.filter((row) => !row.disabled);
    const eligibleQty = eligibleRows.reduce((sum, row) => sum + Math.max(0, row.availableQty || 0), 0);
    const orderedQty = lineAvailability?.orderedQty ?? group.reduce((sum, row) => sum + Math.max(0, row.orderedQty || 0), 0);
    const availableQty =
      typeof lineAvailability?.availableQty === "number"
        ? Math.min(Math.max(0, lineAvailability.availableQty), eligibleQty || lineAvailability.availableQty)
        : eligibleQty;
    const allDisabled = group.every((row) => row.disabled);

    return {
      ...base,
      rowKey: `line:${base.lineItemId}`,
      orderedQty: Math.max(1, orderedQty || base.orderedQty || 1),
      availableQty: Math.max(0, availableQty),
      disabled: allDisabled,
      disabledReason: allDisabled ? group.find((row) => row.disabledReason)?.disabledReason : undefined,
      fyndShipmentId: undefined,
      fyndBagId: undefined,
      fyndArticleId: undefined,
      fyndAffiliateLineId: undefined,
      fyndSellerIdentifier: undefined,
      fyndItemId: undefined,
      fyndQuantityAvailable: undefined,
      fyndPriceEffective: undefined,
      fyndSize: undefined,
      fyndLineNumber: undefined,
    };
  });
}

function toSelection(
  item: PortalLineItem | PortalShipmentItem,
  data: OrderResponse,
  rowKey: string,
  meta?: { shipmentId?: string; shipmentEligible?: boolean; shipmentReason?: string },
): ItemSelection {
  const shipmentItem = item as PortalShipmentItem;
  const availability = data.lineItemAvailability?.[item.id];
  const orderedQty = Number(item.quantity || availability?.orderedQty || 1) || 1;
  const availableQty =
    Number(shipmentItem.fyndQuantityAvailable ?? availability?.availableQty ?? orderedQty) || orderedQty;

  return {
    rowKey,
    lineItemId: item.id,
    title: item.title || "Item",
    variantTitle: item.variantTitle,
    sku: item.sku,
    imageUrl: item.imageUrl,
    productId: item.productId,
    productTags: item.productTags || [],
    productType: item.productType,
    price: item.price ?? item.discountedPrice,
    orderedQty,
    availableQty: Math.max(0, availableQty),
    disabled: meta?.shipmentEligible === false,
    disabledReason: meta?.shipmentReason,
    fyndShipmentId: meta?.shipmentId,
    fyndBagId: shipmentItem.bagId ?? undefined,
    fyndArticleId: shipmentItem.fyndArticleId ?? undefined,
    fyndAffiliateLineId: shipmentItem.fyndAffiliateLineId ?? undefined,
    fyndSellerIdentifier: shipmentItem.fyndSellerIdentifier ?? undefined,
    fyndItemId: shipmentItem.fyndItemId ?? undefined,
    fyndQuantityAvailable: shipmentItem.fyndQuantityAvailable ?? undefined,
    fyndPriceEffective: shipmentItem.fyndPriceEffective ?? undefined,
    fyndSize: shipmentItem.fyndSize ?? undefined,
    fyndLineNumber: shipmentItem.fyndLineNumber ?? undefined,
  };
}

export async function filesToMediaPayload(files: File[]): Promise<MediaPayload[]> {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<MediaPayload>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            resolve({
              name: file.name,
              mimeType: file.type,
              size: file.size,
              dataUrl: String(reader.result || ""),
            });
          };
          reader.onerror = () => reject(new Error("Unable to read file"));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function validateMedia(files: File[]) {
  const errors: string[] = [];
  const allowedImages = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  const allowedVideos = ["video/mp4", "video/webm", "video/quicktime"];
  for (const file of files) {
    const isImage = allowedImages.includes(file.type);
    const isVideo = allowedVideos.includes(file.type);
    if (!isImage && !isVideo) errors.push(`${file.name} is not a supported file type.`);
    if (isImage && file.size > 5 * 1024 * 1024) errors.push(`${file.name} exceeds 5MB.`);
    if (isVideo && file.size > 50 * 1024 * 1024) errors.push(`${file.name} exceeds 50MB.`);
  }
  return errors;
}

export function latestDeliveredAt(order?: { fulfillments?: Array<{ deliveredAt?: string | null }> }) {
  const delivered = (order?.fulfillments || [])
    .map((f) => f.deliveredAt)
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  return delivered[delivered.length - 1] || undefined;
}
