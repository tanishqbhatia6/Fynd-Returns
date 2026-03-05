export type AdminGraphQL = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

const API_VERSION = "2026-01";

/** Create Admin GraphQL client from shop domain and access token (e.g. for webhooks/background jobs) */
export function createAdminClient(shopDomain: string, accessToken: string): AdminGraphQL {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: options?.variables ?? {} }),
      });
    },
  };
}

const ORDERS_QUERY = `#graphql
  query getOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        processedAt
        closedAt
        cancelledAt
        email
        phone
        totalPriceSet { shopMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        discountCodes
        note
        shippingAddress { address1 address2 city province provinceCode country countryCode zip firstName lastName name company phone }
        billingAddress { address1 address2 city province provinceCode country countryCode zip firstName lastName name company phone }
        customAttributes { key value }
        fulfillments(first: 10) {
          id
          status
          createdAt
          updatedAt
          deliveredAt
          displayStatus
          estimatedDeliveryAt
          inTransitAt
          totalQuantity
          location { id name }
          trackingInfo(first: 5) {
            number
            url
            company
          }
        }
        lineItems(first: 50) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
            originalTotalSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
            image { url }
          }
        }
      }
    }
  }
`;

const ORDERS_BY_NAME_QUERY = `#graphql
  query getOrdersByName($query: String!) {
    orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        processedAt
        closedAt
        cancelledAt
        email
        phone
        totalPriceSet { shopMoney { amount currencyCode } }
        totalDiscountsSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        discountCodes
        note
        shippingAddress { address1 address2 city province provinceCode country countryCode zip firstName lastName name company phone }
        billingAddress { address1 address2 city province provinceCode country countryCode zip firstName lastName name company phone }
        customAttributes { key value }
        fulfillments(first: 10) {
          id
          status
          createdAt
          updatedAt
          deliveredAt
          displayStatus
          estimatedDeliveryAt
          inTransitAt
          totalQuantity
          location { id name }
          trackingInfo(first: 5) {
            number
            url
            company
          }
        }
        lineItems(first: 50) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
            originalTotalSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
            image { url }
            variant { product { tags, productType } }
          }
        }
      }
    }
  }
`;

const ORDERS_BY_CUSTOMER_QUERY = `#graphql
  query getOrdersByCustomer($query: String!) {
    orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        processedAt
        closedAt
        cancelledAt
        email
        totalPriceSet { shopMoney { amount currencyCode } }
        subtotalPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { address1 address2 city province provinceCode country countryCode zip firstName lastName name company phone }
        fulfillments(first: 10) {
          id
          status
          createdAt
          updatedAt
          deliveredAt
          displayStatus
          estimatedDeliveryAt
          inTransitAt
          totalQuantity
          location { id name }
          trackingInfo(first: 5) {
            number
            url
            company
          }
        }
        lineItems(first: 5) {
          nodes {
            id
            title
            variantTitle
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            image { url }
          }
        }
      }
    }
  }
`;

const REFUND_MUTATION = `#graphql
  mutation refundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        createdAt
        note
        totalRefundedSet {
          presentmentMoney { amount currencyCode }
          shopMoney { amount currencyCode }
        }
      }
      userErrors { field message }
    }
  }
`;

export type MailingAddressDisplay = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
  zip?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
};

export type OrderLineItemForDisplay = {
  id: string;
  title: string;
  variantTitle?: string | null;
  sku: string | null;
  quantity: number;
  price?: string | null;
  discountedPrice?: string | null;
  originalTotal?: string | null;
  discountedTotal?: string | null;
  imageUrl?: string | null;
  productTags?: string[];
  productType?: string | null;
};

export type ShopifyFulfillment = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  deliveredAt?: string | null;
  displayStatus?: string | null;
  estimatedDeliveryAt?: string | null;
  inTransitAt?: string | null;
  totalQuantity?: number | null;
  location?: { id: string; name: string } | null;
  trackingInfo: Array<{
    number?: string | null;
    url?: string | null;
    company?: string | null;
  }>;
};

export type OrderForPortal = {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
  email?: string | null;
  phone?: string | null;
  totalPrice?: string;
  currencyCode?: string;
  totalDiscounts?: string;
  subtotalPrice?: string;
  discountCodes?: string[];
  affiliateOrderId?: string | null;
  lineItems: OrderLineItemForDisplay[];
  shippingAddress?: MailingAddressDisplay | null;
  billingAddress?: MailingAddressDisplay | null;
  shippingCountry?: string | null;
  shippingProvince?: string | null;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  fulfillments?: ShopifyFulfillment[];
};

export class OrderAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "PCDA" | "NOT_FOUND" = "PCDA"
  ) {
    super(message);
    this.name = "OrderAccessError";
  }
}

export async function fetchOrderByOrderNumber(
  admin: AdminGraphQL,
  orderNumber: string
): Promise<OrderForPortal | null> {
  const clean = orderNumber.replace(/^#/, "").trim();
  if (!clean) return null;
  const query = /^\d+$/.test(clean) ? `name:#${clean}` : `name:${clean}`;
  const res = await admin.graphql(ORDERS_BY_NAME_QUERY, { variables: { query } });
  const json = (await res.json()) as {
    data?: { orders?: { nodes?: Array<unknown> } };
    errors?: Array<{ message?: string }>;
  };
  const errMsg = json.errors?.[0]?.message ?? "";
  if (errMsg.includes("not approved") || errMsg.includes("Order object") || errMsg.includes("protected")) {
    throw new OrderAccessError(errMsg, "PCDA");
  }
  if (json.errors?.length) {
    throw new OrderAccessError(errMsg || "Order access failed", "PCDA");
  }
  const node = json.data?.orders?.nodes?.[0];
  if (!node || typeof node !== "object" || !("name" in node)) return null;
  const o = node as {
    id: string;
    name: string;
    createdAt: string;
    processedAt?: string | null;
    closedAt?: string | null;
    cancelledAt?: string | null;
    email?: string | null;
    phone?: string | null;
    totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
    totalDiscountsSet?: { shopMoney?: { amount?: string } };
    subtotalPriceSet?: { shopMoney?: { amount?: string } };
    displayFinancialStatus?: string;
    displayFulfillmentStatus?: string;
    discountCodes?: string[];
    note?: string | null;
    customAttributes?: Array<{ key: string; value: string }>;
    shippingAddress?: MailingAddressDisplay;
    billingAddress?: MailingAddressDisplay;
    fulfillments?: Array<{
      id: string;
      status: string;
      createdAt: string;
      updatedAt?: string | null;
      deliveredAt?: string | null;
      displayStatus?: string | null;
      estimatedDeliveryAt?: string | null;
      inTransitAt?: string | null;
      totalQuantity?: number | null;
      location?: { id: string; name: string } | null;
      trackingInfo?: Array<{
        number?: string | null;
        url?: string | null;
        company?: string | null;
      }>;
    }>;
    lineItems?: {
      nodes?: Array<{
        id: string;
        title: string;
        variantTitle?: string | null;
        sku: string | null;
        quantity: number;
        originalUnitPriceSet?: { shopMoney?: { amount?: string } };
        discountedUnitPriceSet?: { shopMoney?: { amount?: string } };
        originalTotalSet?: { shopMoney?: { amount?: string } };
        discountedTotalSet?: { shopMoney?: { amount?: string } };
        image?: { url?: string } | null;
        variant?: { product?: { tags?: string[]; productType?: string } };
      }>;
    };
  };
  const affiliateOrderId = extractAffiliateOrderId(o.customAttributes);
  const lineItems: OrderLineItemForDisplay[] = (o.lineItems?.nodes ?? []).map((li) => ({
    id: li.id,
    title: li.title,
    variantTitle: li.variantTitle ?? null,
    sku: li.sku ?? null,
    quantity: li.quantity,
    price: li.originalUnitPriceSet?.shopMoney?.amount ?? null,
    discountedPrice: li.discountedUnitPriceSet?.shopMoney?.amount ?? null,
    originalTotal: li.originalTotalSet?.shopMoney?.amount ?? null,
    discountedTotal: li.discountedTotalSet?.shopMoney?.amount ?? null,
    imageUrl: li.image?.url ?? null,
    productTags: li.variant?.product?.tags ?? [],
    productType: li.variant?.product?.productType ?? null,
  }));
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    email: o.email ?? null,
    phone: o.phone ?? null,
    totalPrice: o.totalPriceSet?.shopMoney?.amount,
    currencyCode: o.totalPriceSet?.shopMoney?.currencyCode ?? undefined,
    totalDiscounts: o.totalDiscountsSet?.shopMoney?.amount,
    subtotalPrice: o.subtotalPriceSet?.shopMoney?.amount,
    discountCodes: o.discountCodes ?? undefined,
    affiliateOrderId: affiliateOrderId ?? undefined,
    lineItems,
    shippingAddress: o.shippingAddress ?? null,
    billingAddress: o.billingAddress ?? null,
    shippingCountry: o.shippingAddress?.countryCode ?? null,
    shippingProvince: o.shippingAddress?.provinceCode ?? null,
    displayFinancialStatus: o.displayFinancialStatus ?? undefined,
    displayFulfillmentStatus: o.displayFulfillmentStatus ?? undefined,
    processedAt: o.processedAt ?? null,
    closedAt: o.closedAt ?? null,
    cancelledAt: o.cancelledAt ?? null,
    fulfillments: (o.fulfillments ?? []).map((f) => ({
      id: f.id,
      status: f.status,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt ?? null,
      deliveredAt: f.deliveredAt ?? null,
      displayStatus: f.displayStatus ?? null,
      estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
      inTransitAt: f.inTransitAt ?? null,
      totalQuantity: f.totalQuantity ?? null,
      location: f.location ? { id: f.location.id, name: f.location.name } : null,
      trackingInfo: (f.trackingInfo ?? []).map((ti) => ({
        number: ti.number ?? null,
        url: ti.url ?? null,
        company: ti.company ?? null,
      })),
    })),
  };
}

export type OrderSummaryLineItem = {
  id: string;
  title: string;
  variantTitle?: string | null;
  quantity: number;
  price?: string | null;
  imageUrl?: string | null;
};

export type OrderSummaryForPortal = {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string | null;
  closedAt?: string | null;
  cancelledAt?: string | null;
  email?: string | null;
  totalPrice?: string;
  subtotalPrice?: string;
  totalDiscounts?: string;
  currencyCode?: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  lineItems?: OrderSummaryLineItem[];
  shippingAddress?: MailingAddressDisplay | null;
  fulfillments?: ShopifyFulfillment[];
};

export async function fetchOrdersByCustomer(
  admin: AdminGraphQL,
  email: string
): Promise<OrderSummaryForPortal[]> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return [];
  const query = `email:${trimmed}`;
  try {
    const res = await admin.graphql(ORDERS_BY_CUSTOMER_QUERY, { variables: { query } });
    const json = (await res.json()) as {
      data?: {
        orders?: {
          nodes?: Array<{
            id: string;
            name: string;
            createdAt: string;
            processedAt?: string | null;
            closedAt?: string | null;
            cancelledAt?: string | null;
            email?: string | null;
            totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
            subtotalPriceSet?: { shopMoney?: { amount?: string } };
            totalDiscountsSet?: { shopMoney?: { amount?: string } };
            displayFinancialStatus?: string;
            displayFulfillmentStatus?: string;
            shippingAddress?: MailingAddressDisplay;
            fulfillments?: Array<{
              id: string;
              status: string;
              createdAt: string;
              updatedAt?: string | null;
              deliveredAt?: string | null;
              displayStatus?: string | null;
              estimatedDeliveryAt?: string | null;
              inTransitAt?: string | null;
              totalQuantity?: number | null;
              location?: { id: string; name: string } | null;
              trackingInfo?: Array<{
                number?: string | null;
                url?: string | null;
                company?: string | null;
              }>;
            }>;
            lineItems?: {
              nodes?: Array<{
                id: string;
                title: string;
                variantTitle?: string | null;
                quantity: number;
                originalUnitPriceSet?: { shopMoney?: { amount?: string } };
                image?: { url?: string } | null;
              }>;
            };
          }>
        }
      };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      console.warn("[fetchOrdersByCustomer] GraphQL errors:", json.errors.map((e) => e.message).join(", "));
      return [];
    }
    const nodes = json.data?.orders?.nodes ?? [];
    return nodes.map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      processedAt: o.processedAt ?? null,
      closedAt: o.closedAt ?? null,
      cancelledAt: o.cancelledAt ?? null,
      email: o.email ?? null,
      totalPrice: o.totalPriceSet?.shopMoney?.amount,
      subtotalPrice: o.subtotalPriceSet?.shopMoney?.amount,
      totalDiscounts: o.totalDiscountsSet?.shopMoney?.amount,
      currencyCode: o.totalPriceSet?.shopMoney?.currencyCode ?? undefined,
      displayFinancialStatus: o.displayFinancialStatus ?? undefined,
      displayFulfillmentStatus: o.displayFulfillmentStatus ?? undefined,
      shippingAddress: o.shippingAddress ?? null,
      fulfillments: (o.fulfillments ?? []).map((f) => ({
        id: f.id,
        status: f.status,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt ?? null,
        deliveredAt: f.deliveredAt ?? null,
        displayStatus: f.displayStatus ?? null,
        estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
        inTransitAt: f.inTransitAt ?? null,
        totalQuantity: f.totalQuantity ?? null,
        location: f.location ? { id: f.location.id, name: f.location.name } : null,
        trackingInfo: (f.trackingInfo ?? []).map((ti) => ({
          number: ti.number ?? null,
          url: ti.url ?? null,
          company: ti.company ?? null,
        })),
      })),
      lineItems: (o.lineItems?.nodes ?? []).map((li) => ({
        id: li.id,
        title: li.title,
        variantTitle: li.variantTitle ?? null,
        quantity: li.quantity,
        price: li.originalUnitPriceSet?.shopMoney?.amount ?? null,
        imageUrl: li.image?.url ?? null,
      })),
    }));
  } catch (err) {
    console.error("[fetchOrdersByCustomer] Error:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Extract Fynd affiliate_order_id from order customAttributes. Fynd APIs expect affiliate_order_id, not Shopify order name. */
const AFFILIATE_ORDER_ID_KEYS = [
  "affiliate_order_id",
  "_affiliate_order_id",
  "fynd_affiliate_order_id",
  "fynd_order_id",
  "_fynd_order_id",
  "fyndOrderId",
  "affiliateOrderId",
];

export function extractAffiliateOrderId(
  customAttributes: Array<{ key: string; value: string }> | null | undefined
): string | null {
  if (!customAttributes?.length) return null;
  const keyMap = new Map(customAttributes.map((a) => [a.key.toLowerCase(), a.value?.trim()]));
  for (const k of AFFILIATE_ORDER_ID_KEYS) {
    const v = keyMap.get(k.toLowerCase());
    if (v && v.length > 0) return v;
  }
  return null;
}

export async function fetchOrder(
  admin: AdminGraphQL,
  orderId: string
): Promise<OrderForPortal | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const res = await admin.graphql(ORDERS_QUERY, { variables: { ids: [gid] } });
  const json = (await res.json()) as { data?: { nodes?: Array<unknown> } };
  const node = json.data?.nodes?.[0];
  if (!node || typeof node !== "object" || !("name" in node)) return null;
  const order = node as {
    id: string;
    name: string;
    createdAt?: string;
    processedAt?: string | null;
    closedAt?: string | null;
    cancelledAt?: string | null;
    email?: string | null;
    phone?: string | null;
    totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
    totalDiscountsSet?: { shopMoney?: { amount?: string } };
    subtotalPriceSet?: { shopMoney?: { amount?: string } };
    displayFinancialStatus?: string;
    displayFulfillmentStatus?: string;
    discountCodes?: string[];
    customAttributes?: Array<{ key: string; value: string }>;
    shippingAddress?: MailingAddressDisplay;
    billingAddress?: MailingAddressDisplay;
    fulfillments?: Array<{
      id: string;
      status: string;
      createdAt: string;
      updatedAt?: string | null;
      deliveredAt?: string | null;
      displayStatus?: string | null;
      estimatedDeliveryAt?: string | null;
      inTransitAt?: string | null;
      totalQuantity?: number | null;
      location?: { id: string; name: string } | null;
      trackingInfo?: Array<{
        number?: string | null;
        url?: string | null;
        company?: string | null;
      }>;
    }>;
    lineItems?: {
      nodes?: Array<{
        id: string;
        title: string;
        variantTitle?: string | null;
        sku: string | null;
        quantity: number;
        originalUnitPriceSet?: { shopMoney?: { amount?: string } };
        discountedUnitPriceSet?: { shopMoney?: { amount?: string } };
        originalTotalSet?: { shopMoney?: { amount?: string } };
        discountedTotalSet?: { shopMoney?: { amount?: string } };
        image?: { url?: string } | null;
      }>;
    };
  };
  const affiliateOrderId = extractAffiliateOrderId(order.customAttributes);
  const lineItems: OrderLineItemForDisplay[] = (order.lineItems?.nodes ?? []).map((li) => ({
    id: li.id,
    title: li.title,
    variantTitle: li.variantTitle ?? null,
    sku: li.sku ?? null,
    quantity: li.quantity,
    price: li.originalUnitPriceSet?.shopMoney?.amount ?? null,
    discountedPrice: li.discountedUnitPriceSet?.shopMoney?.amount ?? null,
    originalTotal: li.originalTotalSet?.shopMoney?.amount ?? null,
    discountedTotal: li.discountedTotalSet?.shopMoney?.amount ?? null,
    imageUrl: li.image?.url ?? null,
  }));
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt ?? "",
    email: order.email ?? null,
    phone: order.phone ?? null,
    totalPrice: order.totalPriceSet?.shopMoney?.amount,
    currencyCode: order.totalPriceSet?.shopMoney?.currencyCode ?? undefined,
    totalDiscounts: order.totalDiscountsSet?.shopMoney?.amount,
    subtotalPrice: order.subtotalPriceSet?.shopMoney?.amount,
    discountCodes: order.discountCodes ?? undefined,
    lineItems,
    affiliateOrderId: affiliateOrderId ?? undefined,
    shippingAddress: order.shippingAddress ?? null,
    billingAddress: order.billingAddress ?? null,
    shippingCountry: order.shippingAddress?.countryCode ?? null,
    shippingProvince: order.shippingAddress?.provinceCode ?? null,
    displayFinancialStatus: order.displayFinancialStatus ?? undefined,
    displayFulfillmentStatus: order.displayFulfillmentStatus ?? undefined,
    processedAt: order.processedAt ?? null,
    closedAt: order.closedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    fulfillments: (order.fulfillments ?? []).map((f) => ({
      id: f.id,
      status: f.status,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt ?? null,
      deliveredAt: f.deliveredAt ?? null,
      displayStatus: f.displayStatus ?? null,
      estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
      inTransitAt: f.inTransitAt ?? null,
      totalQuantity: f.totalQuantity ?? null,
      trackingInfo: (f.trackingInfo ?? []).map((ti) => ({
        number: ti.number ?? null,
        url: ti.url ?? null,
        company: ti.company ?? null,
      })),
    })),
  };
}

const ALL_LOCATIONS_QUERY = `#graphql
  query {
    locations(first: 50, sortKey: NAME) {
      nodes { id name isActive }
    }
  }
`;

export type ShopLocation = { id: string; name: string; isActive: boolean };

export async function fetchAllLocations(admin: AdminGraphQL): Promise<ShopLocation[]> {
  try {
    const res = await admin.graphql(ALL_LOCATIONS_QUERY);
    const json = (await res.json()) as {
      data?: { locations?: { nodes?: Array<{ id: string; name: string; isActive?: boolean }> } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      console.error("[fetchAllLocations] GraphQL errors:", json.errors.map(e => e.message).join(", "),
        "— Ensure the app has the 'read_locations' scope.");
    }
    const nodes = json.data?.locations?.nodes ?? [];
    if (nodes.length === 0) {
      console.warn("[fetchAllLocations] No locations returned. Check 'read_locations' scope is granted.");
    }
    return nodes.map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive !== false,
    }));
  } catch (err) {
    console.error("[fetchAllLocations] Failed:", err);
    return [];
  }
}

export async function fetchPrimaryLocationId(admin: AdminGraphQL): Promise<string | null> {
  const locations = await fetchAllLocations(admin);
  return locations[0]?.id ?? null;
}

export type RefundResult = {
  success: boolean;
  error?: string;
  refundId?: string;
  refundAmount?: string;
  refundCurrency?: string;
  refundCreatedAt?: string;
  refundMethod?: string;
};

export type RefundMethodConfig = {
  method: "original" | "store_credit" | "both";
  storeCreditPct?: number;
};

type RefundJson = {
  data?: {
    refundCreate?: {
      refund?: {
        id?: string;
        createdAt?: string;
        note?: string;
        totalRefundedSet?: {
          presentmentMoney?: { amount?: string; currencyCode?: string };
          shopMoney?: { amount?: string; currencyCode?: string };
        };
      };
      userErrors?: Array<{ field?: string; message: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

const SUGGEST_REFUND_QUERY = `#graphql
  query suggestRefund($orderId: ID!, $refundLineItems: [RefundLineItemInput!]!) {
    order(id: $orderId) {
      suggestedRefund(refundLineItems: $refundLineItems) {
        amountSet { shopMoney { amount currencyCode } }
        subtotalSet { shopMoney { amount currencyCode } }
        suggestedTransactions { gateway parentTransaction { id } amountSet { shopMoney { amount currencyCode } } kind }
      }
    }
  }
`;

function parseRefundResponse(json: RefundJson): RefundResult {
  const gqlErrors = json.errors ?? [];
  if (gqlErrors.length > 0) {
    return { success: false, error: gqlErrors.map((e) => e.message ?? "GraphQL error").join(", ") };
  }
  const userErrors = json.data?.refundCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { success: false, error: userErrors.map((e) => e.message).join(", ") };
  }
  const refund = json.data?.refundCreate?.refund;
  const money = refund?.totalRefundedSet?.presentmentMoney ?? refund?.totalRefundedSet?.shopMoney;
  return {
    success: true,
    refundId: refund?.id ?? undefined,
    refundAmount: money?.amount ?? undefined,
    refundCurrency: money?.currencyCode ?? undefined,
    refundCreatedAt: refund?.createdAt ?? undefined,
  };
}

export async function createRefund(
  admin: AdminGraphQL,
  orderId: string,
  lineItems: Array<{ id: string; quantity: number }> | string[],
  note?: string,
  locationId?: string | null,
  refundMethodConfig?: RefundMethodConfig | null,
): Promise<RefundResult> {
  try {
    const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
    const normalized = lineItems.map((item) => {
      if (typeof item === "string") return { id: item, quantity: 1 };
      return item;
    });

    if (normalized.length === 0) {
      return { success: false, error: "No line items specified for refund. Please select items to refund." };
    }

    let restockLocationId = locationId;
    if (!restockLocationId) {
      restockLocationId = await fetchPrimaryLocationId(admin);
    }

    const refundLineItems = normalized.map((item) => ({
      lineItemId: item.id.startsWith("gid://") ? item.id : `gid://shopify/LineItem/${item.id}`,
      quantity: item.quantity,
      restockType: "RETURN" as string,
      ...(restockLocationId ? { locationId: restockLocationId } : {}),
    }));

    const method = refundMethodConfig?.method ?? "original";
    const storeCreditPct = refundMethodConfig?.storeCreditPct ?? 100;

    const refundInput: Record<string, unknown> = {
      orderId: gid,
      note: note || "Return processed via Return Pro Max",
      refundLineItems,
    };

    if (method === "store_credit" || method === "both") {
      const suggestRes = await admin.graphql(SUGGEST_REFUND_QUERY, {
        variables: {
          orderId: gid,
          refundLineItems: normalized.map((item) => ({
            lineItemId: item.id.startsWith("gid://") ? item.id : `gid://shopify/LineItem/${item.id}`,
            quantity: item.quantity,
          })),
        },
      });
      const suggestJson = (await suggestRes.json()) as {
        data?: {
          order?: {
            suggestedRefund?: {
              amountSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
              suggestedTransactions?: Array<{
                gateway?: string;
                parentTransaction?: { id?: string };
                amountSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
                kind?: string;
              }>;
            };
          };
        };
      };

      const suggested = suggestJson.data?.order?.suggestedRefund;
      const totalAmount = parseFloat(suggested?.amountSet?.shopMoney?.amount ?? "0");
      const currency = suggested?.amountSet?.shopMoney?.currencyCode ?? "INR";

      if (totalAmount > 0) {
        if (method === "store_credit") {
          refundInput.transactions = [];
          refundInput.refundMethods = [{
            storeCreditRefund: {
              amount: { amount: totalAmount.toFixed(2), currencyCode: currency },
            },
          }];
        } else if (method === "both") {
          const scAmount = Math.round(totalAmount * (storeCreditPct / 100) * 100) / 100;
          const origAmount = Math.round((totalAmount - scAmount) * 100) / 100;

          if (origAmount > 0 && suggested?.suggestedTransactions?.length) {
            const txn = suggested.suggestedTransactions[0];
            refundInput.transactions = [{
              orderId: gid,
              kind: "REFUND",
              gateway: txn.gateway ?? "manual",
              amount: origAmount.toFixed(2),
              ...(txn.parentTransaction?.id ? { parentId: txn.parentTransaction.id } : {}),
            }];
          } else {
            refundInput.transactions = [];
          }

          if (scAmount > 0) {
            refundInput.refundMethods = [{
              storeCreditRefund: {
                amount: { amount: scAmount.toFixed(2), currencyCode: currency },
              },
            }];
          }
        }
      } else {
        if (suggested?.suggestedTransactions?.length) {
          refundInput.transactions = suggested.suggestedTransactions.map((t) => ({
            orderId: gid,
            kind: "REFUND",
            gateway: t.gateway ?? "manual",
            amount: parseFloat(t.amountSet?.shopMoney?.amount ?? "0").toFixed(2),
            ...(t.parentTransaction?.id ? { parentId: t.parentTransaction.id } : {}),
          }));
        }
      }
    } else {
      const suggestRes = await admin.graphql(SUGGEST_REFUND_QUERY, {
        variables: {
          orderId: gid,
          refundLineItems: normalized.map((item) => ({
            lineItemId: item.id.startsWith("gid://") ? item.id : `gid://shopify/LineItem/${item.id}`,
            quantity: item.quantity,
          })),
        },
      });
      const suggestJson = (await suggestRes.json()) as {
        data?: {
          order?: {
            suggestedRefund?: {
              suggestedTransactions?: Array<{
                gateway?: string;
                parentTransaction?: { id?: string };
                amountSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
                kind?: string;
              }>;
            };
          };
        };
      };
      const suggested = suggestJson.data?.order?.suggestedRefund;
      if (suggested?.suggestedTransactions?.length) {
        refundInput.transactions = suggested.suggestedTransactions.map((t) => ({
          orderId: gid,
          kind: "REFUND",
          gateway: t.gateway ?? "manual",
          amount: parseFloat(t.amountSet?.shopMoney?.amount ?? "0").toFixed(2),
          ...(t.parentTransaction?.id ? { parentId: t.parentTransaction.id } : {}),
        }));
      }
    }

    const res = await admin.graphql(REFUND_MUTATION, { variables: { input: refundInput } });
    let json: RefundJson;
    try { json = (await res.json()) as RefundJson; } catch {
      return { success: false, error: "Invalid response from Shopify. Please try again." };
    }

    if (!res.ok) {
      return { success: false, error: `Shopify API error (${res.status}). Please try again or refund manually in Shopify Admin.` };
    }

    const result = parseRefundResponse(json);
    if (!result.success) {
      const isLocationError = /location|restock/i.test(result.error ?? "");
      if (isLocationError) {
        const noRestockInput: Record<string, unknown> = {
          ...refundInput,
          refundLineItems: normalized.map((item) => ({
            lineItemId: item.id.startsWith("gid://") ? item.id : `gid://shopify/LineItem/${item.id}`,
            quantity: item.quantity,
            restockType: "NO_RESTOCK",
          })),
        };
        const retryRes = await admin.graphql(REFUND_MUTATION, { variables: { input: noRestockInput } });
        let retryJson: RefundJson;
        try { retryJson = (await retryRes.json()) as RefundJson; } catch {
          return { success: false, error: "Retry without restock failed." };
        }
        const retryResult = parseRefundResponse(retryJson);
        if (retryResult.success) retryResult.refundMethod = method;
        return retryResult;
      }
      return result;
    }

    result.refundMethod = method;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Refund request failed";
    return { success: false, error: msg };
  }
}
