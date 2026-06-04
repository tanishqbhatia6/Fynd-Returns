export type PortalConfig = {
  showOrderTracking?: boolean;
  showReturnTracking?: boolean;
  showCreateReturnTab?: boolean;
  defaultTab?: string;
  allowMediaUploads?: boolean;
  allowReturnCancellation?: boolean;
};

export type PortalFeatures = {
  giftReturnsEnabled?: boolean;
  portalExchangeEnabled?: boolean;
  greenReturnsEnabled?: boolean;
  greenReturnsDonateEnabled?: boolean;
  greenReturnsDonateMessage?: string;
  channelPoliciesJson?: string;
};

export type PortalBootstrap = {
  appUrl: string;
  shop: string;
  returnWindowDays: number;
  returnPolicy: string;
  returnReasons: string[];
  returnReasonsByCategory: Record<string, string[]>;
  config: Required<PortalConfig>;
  labels: Record<string, string>;
  locale: string;
  currency: string;
  timezone: string;
  features: PortalFeatures;
  csrfToken?: string;
  authToken?: string;
  brandLogoUrl?: string;
};

export type LookupType =
  | "order_no"
  | "return_id"
  | "return_no"
  | "forward_awb"
  | "return_awb"
  | "email"
  | "mobile";

export type PortalOrder = {
  id?: string;
  name?: string;
  email?: string | null;
  phone?: string | null;
  createdAt?: string | null;
  processedAt?: string | null;
  cancelledAt?: string | null;
  currencyCode?: string | null;
  totalPrice?: string | number | null;
  subtotalPrice?: string | number | null;
  totalDiscounts?: string | number | null;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  lineItems?: PortalLineItem[];
  fulfillments?: Array<{
    status?: string | null;
    deliveredAt?: string | null;
    trackingInfo?: Array<{ number?: string | null; url?: string | null; company?: string | null }>;
  }>;
  shippingAddress?: PortalAddress | null;
  fyndData?: Record<string, unknown> | null;
  _needsFyndEnrich?: boolean;
};

export type PortalAddress = {
  firstName?: string | null;
  lastName?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  zip?: string | null;
  country?: string | null;
  countryCode?: string | null;
  phone?: string | null;
};

export type PortalLineItem = {
  id: string;
  title?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
  quantity?: number | null;
  price?: string | number | null;
  discountedPrice?: string | number | null;
  imageUrl?: string | null;
  productId?: string | null;
  productTags?: string[];
  productType?: string | null;
};

export type PortalReturn = {
  id: string;
  returnRequestNo?: string | null;
  returnRequestId?: string | null;
  shopifyOrderName?: string | null;
  status?: string | null;
  refundStatus?: string | null;
  resolutionType?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  returnAwb?: string | null;
  forwardAwb?: string | null;
  fyndCurrentStatus?: string | null;
  items?: Array<{
    id?: string;
    title?: string | null;
    sku?: string | null;
    qty?: number | null;
    quantity?: number | null;
    reasonCode?: string | null;
    imageUrl?: string | null;
  }>;
  events?: Array<{ id?: string; eventType?: string | null; message?: string | null; happenedAt?: string | null }>;
  returnJourney?: Array<{ status?: string | null; timestamp?: string | null; time?: string | null }>;
  returnLabel?: {
    carrier?: string | null;
    trackingNumber?: string | null;
    labelUrl?: string | null;
    qrCodeUrl?: string | null;
  } | null;
  cancellationRequestedAt?: string | null;
  _needsFyndEnrich?: boolean;
};

export type LookupResponse = {
  requiresOtp?: boolean;
  sessionId?: string;
  cooldownMs?: number;
  orders?: PortalOrder[];
  returns?: PortalReturn[];
  labels?: Record<string, string>;
  portalLanguage?: string;
  portalCsrfToken?: string;
  error?: string;
};

export type OrderResponse = {
  order?: PortalOrder;
  existingReturns?: PortalReturn[];
  activeReturns?: PortalReturn[];
  previousReturns?: PortalReturn[];
  returnEligibility?: { eligible?: boolean; reason?: string | null };
  itemEligibility?: Record<string, { eligible?: boolean; reason?: string | null }>;
  returnDeadline?: string | null;
  daysRemaining?: number | null;
  returnFee?: { amount: number; currency: string } | null;
  estimatedRefundTotal?: number | string | null;
  lineItemEstimates?: Record<string, { amount?: number | string; currency?: string }>;
  returnOffers?: { enabled?: boolean; offers?: ReturnOffer[] };
  returnedQtyMap?: Record<string, number>;
  lineItemAvailability?: Record<
    string,
    { orderedQty?: number; returnedQty?: number; availableQty?: number; alreadyInReturn?: boolean }
  >;
  portalExchangeEnabled?: boolean;
  photoRequired?: boolean;
  shipments?: PortalShipment[] | null;
  shipmentReturnedQtyMap?: Record<string, Record<string, number>>;
  fyndShipmentStatus?: string | null;
  portalCsrfToken?: string;
  error?: string;
};

export type PortalShipment = {
  shipmentId?: string;
  shipmentStatus?: string;
  eligible?: boolean;
  eligibilityReason?: string;
  items?: PortalShipmentItem[];
};

export type PortalShipmentItem = PortalLineItem & {
  bagId?: string | null;
  fyndArticleId?: string | null;
  fyndAffiliateLineId?: string | null;
  fyndSellerIdentifier?: string | null;
  fyndItemId?: string | null;
  fyndQuantityAvailable?: number | null;
  fyndPriceEffective?: string | null;
  fyndSize?: string | null;
  fyndLineNumber?: number | null;
};

export type ReturnOffer = {
  reasonCode?: string;
  tag?: string;
  offerType: "discount_pct" | "discount_flat";
  offerValue: number;
  message: string;
};

export type ProductResponse = {
  products?: Array<{
    id: string;
    title: string;
    imageUrl?: string | null;
    variants?: Array<{ id: string; title?: string | null; available?: boolean; options?: Array<{ value?: string }> }>;
  }>;
  error?: string;
};

export type MediaPayload = {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
};

export type CreateReturnResponse = {
  success?: boolean;
  returnId?: string;
  returnRequestId?: string;
  status?: string;
  message?: string;
  offerAccepted?: boolean;
  discountCode?: string;
  offerMessage?: string;
  summary?: {
    orderName?: string;
    itemsCount?: number;
    items?: Array<{
      title?: string;
      variantTitle?: string | null;
      sku?: string | null;
      qty?: number;
      reasonCode?: string | null;
      price?: string | number | null;
      imageUrl?: string | null;
      fyndBagId?: string | null;
      fyndLineNumber?: number | null;
    }>;
    status?: string;
    createdAt?: string;
    nextSteps?: string;
  };
  error?: string;
};

export type ItemSelection = {
  rowKey: string;
  lineItemId: string;
  memberLineItems?: Array<{ lineItemId: string; availableQty: number }>;
  title: string;
  variantTitle?: string | null;
  sku?: string | null;
  imageUrl?: string | null;
  productId?: string | null;
  productTags: string[];
  productType?: string | null;
  price?: string | number | null;
  orderedQty: number;
  availableQty: number;
  disabled?: boolean;
  disabledReason?: string;
  fyndShipmentId?: string;
  fyndBagId?: string;
  fyndArticleId?: string | null;
  fyndAffiliateLineId?: string | null;
  fyndSellerIdentifier?: string | null;
  fyndItemId?: string | null;
  fyndQuantityAvailable?: number | null;
  fyndPriceEffective?: string | null;
  fyndSize?: string | null;
  fyndLineNumber?: number | null;
};

declare global {
  interface Window {
    __RPM_LABELS__?: Record<string, string>;
    __RPM_LOCALE__?: string;
    __RPM_CURRENCY__?: string;
    __RPM_TIMEZONE__?: string;
    __RPM_FEATURES__?: PortalFeatures;
    __RPM_PORTAL_CSRF__?: string;
    __RPM_AUTH_TOKEN__?: string;
  }
}
