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
        paymentGatewayNames
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

const ORDER_FIELDS_FRAGMENT = `
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
  paymentGatewayNames
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
`;

const ORDERS_BY_NAME_QUERY = `#graphql
  query getOrdersByName($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        ${ORDER_FIELDS_FRAGMENT}
      }
    }
  }
`;

const ORDER_BY_IDENTIFIER_QUERY = `#graphql
  query getOrderByIdentifier($id: ID!) {
    orderByIdentifier(identifier: { id: $id }) {
      ${ORDER_FIELDS_FRAGMENT}
    }
  }
`;

const ORDER_BY_NAME_IDENTIFIER_QUERY = `#graphql
  query getOrderByNameIdentifier($name: String!) {
    orderByIdentifier(identifier: { name: $name }) {
      ${ORDER_FIELDS_FRAGMENT}
    }
  }
`;

/* All multi-order queries now use fetchOrdersByFilter() with inline GQL */

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
  paymentGatewayNames?: string[];
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

/**
 * Direct O(1) lookup by Shopify GID using orderByIdentifier.
 * Faster than search when we already have the GID (e.g. from DB cache).
 */
export async function fetchOrderByGid(
  admin: AdminGraphQL,
  gid: string
): Promise<OrderForPortal | null> {
  if (!gid || !gid.startsWith("gid://")) return null;
  try {
    const res = await admin.graphql(ORDER_BY_IDENTIFIER_QUERY, { variables: { id: gid } });
    const json = (await res.json()) as {
      data?: { orderByIdentifier?: Record<string, unknown> | null };
      errors?: Array<{ message?: string }>;
    };
    const errMsg = json.errors?.[0]?.message ?? "";
    if (errMsg.includes("not approved") || errMsg.includes("Order object") || errMsg.includes("protected")) {
      throw new OrderAccessError(errMsg, "PCDA");
    }
    if (json.errors?.length) return null;
    const node = json.data?.orderByIdentifier;
    if (!node || !("name" in node)) return null;
    return parseOrderNode(node);
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
    return null;
  }
}

/**
 * Exact O(1) lookup by Shopify order name using orderByIdentifier.
 * Unlike orders(query: "name:...") which does fuzzy/token matching,
 * this returns ONLY the order with the exact name — no false positives.
 */
export async function fetchOrderByExactName(
  admin: AdminGraphQL,
  name: string
): Promise<OrderForPortal | null> {
  if (!name) return null;
  try {
    const res = await admin.graphql(ORDER_BY_NAME_IDENTIFIER_QUERY, { variables: { name } });
    const json = (await res.json()) as {
      data?: { orderByIdentifier?: Record<string, unknown> | null };
      errors?: Array<{ message?: string }>;
    };
    const errMsg = json.errors?.[0]?.message ?? "";
    if (errMsg.includes("not approved") || errMsg.includes("Order object") || errMsg.includes("protected")) {
      throw new OrderAccessError(errMsg, "PCDA");
    }
    if (json.errors?.length) return null;
    const node = json.data?.orderByIdentifier;
    if (!node || !("name" in node)) return null;
    return parseOrderNode(node);
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
    return null;
  }
}

/**
 * Search Shopify orders by query string. When `exactName` is provided,
 * fetches up to 25 candidates and returns only the one whose `name`
 * matches exactly (case-insensitive, ignoring leading #). This prevents
 * Shopify's substring/prefix matching from returning the wrong order.
 */
async function searchOrders(
  admin: AdminGraphQL,
  query: string,
  throwOnError = true,
  exactName?: string
): Promise<unknown | null> {
  const limit = exactName ? 25 : 1;
  const res = await admin.graphql(ORDERS_BY_NAME_QUERY, { variables: { query, first: limit } });
  const json = (await res.json()) as {
    data?: { orders?: { nodes?: Array<Record<string, unknown>> } };
    errors?: Array<{ message?: string }>;
  };
  const errMsg = json.errors?.[0]?.message ?? "";
  if (errMsg.includes("not approved") || errMsg.includes("Order object") || errMsg.includes("protected")) {
    throw new OrderAccessError(errMsg, "PCDA");
  }
  if (json.errors?.length) {
    if (!throwOnError) return null;
    throw new OrderAccessError(errMsg || "Order access failed", "PCDA");
  }
  const nodes = json.data?.orders?.nodes ?? [];
  if (nodes.length === 0) return null;

  if (exactName) {
    const norm = exactName.replace(/^#/, "").toLowerCase();
    const match = nodes.find((n) => {
      const name = typeof n.name === "string" ? n.name.replace(/^#/, "").toLowerCase() : "";
      return name === norm;
    });
    return match && typeof match === "object" && "name" in match ? match : null;
  }

  const found = nodes[0];
  return (found && typeof found === "object" && "name" in found) ? found : null;
}

/**
 * Look up a Shopify order by number/identifier. Uses the official Shopify
 * Admin GraphQL filters documented at:
 * https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
 *
 * Strategy (in order of priority):
 * 1. orderByIdentifier — O(1) direct GID lookup
 * 2. name: — standard Shopify order name filter
 * 3. source_identifier: — third-party/external order IDs (Fynd, POS, etc.)
 * 4. confirmation_number: — alternate customer-facing order identifier
 * 5. tag: — tagged orders
 */
export async function fetchOrderByOrderNumber(
  admin: AdminGraphQL,
  orderNumber: string
): Promise<OrderForPortal | null> {
  const clean = orderNumber.replace(/^#/, "").trim();
  if (!clean) return null;

  // Direct GID lookup via orderByIdentifier
  if (clean.startsWith("gid://shopify/Order/")) {
    return fetchOrderByGid(admin, clean);
  }

  // Strategy 1: orderByIdentifier with exact name — deterministic O(1).
  // Unlike orders(query: "name:...") which does fuzzy token matching,
  // orderByIdentifier returns ONLY the order with the exact name.
  try {
    const result = await fetchOrderByExactName(admin, `#${clean}`);
    if (result) return result;
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
  }
  try {
    const result = await fetchOrderByExactName(admin, clean);
    if (result) return result;
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
  }

  // For pure numeric order names, no further strategies needed
  if (/^\d+$/.test(clean)) return null;

  // Strategy 2: metafield search — indexed, O(1), works at any scale.
  try {
    const node = await searchOrders(admin, `metafields.$app.fynd_order_id:"${clean}"`, false);
    if (node) return parseOrderNode(node);
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
  }

  // Strategy 3: source_identifier: — for third-party order IDs
  try {
    const node = await searchOrders(admin, `source_identifier:${clean}`, false, clean);
    if (node) return parseOrderNode(node);
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
  }

  return null;
}

type RawOrderNode = {
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
  paymentGatewayNames?: string[];
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

function parseOrderNode(node: unknown): OrderForPortal {
  const o = node as RawOrderNode;
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
    paymentGatewayNames: o.paymentGatewayNames ?? [],
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

/**
 * Search Shopify orders using any documented filter from the orders query.
 * Uses the full ORDER_FIELDS_FRAGMENT and parseOrderNode for consistency.
 *
 * Supported filters (from Shopify docs):
 *   email:, name:, source_identifier:, confirmation_number:, tag:, sku:,
 *   financial_status:, fulfillment_status:, customer_id:, etc.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/latest/queries/orders
 */
export async function fetchOrdersByFilter(
  admin: AdminGraphQL,
  queryFilter: string,
  limit = 50
): Promise<OrderForPortal[]> {
  const q = queryFilter.trim();
  if (!q) return [];
  const gqlQuery = `#graphql
    query getOrdersByFilter($query: String!, $first: Int!) {
      orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          ${ORDER_FIELDS_FRAGMENT}
        }
      }
    }
  `;
  try {
    const res = await admin.graphql(gqlQuery, { variables: { query: q, first: limit } });
    const json = (await res.json()) as {
      data?: { orders?: { nodes?: Array<unknown> } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      console.warn("[fetchOrdersByFilter] GraphQL errors:", json.errors.map((e) => e.message).join(", "));
      return [];
    }
    return (json.data?.orders?.nodes ?? [])
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && "name" in n)
      .map(parseOrderNode);
  } catch (err) {
    console.error("[fetchOrdersByFilter] Error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function fetchOrdersByCustomer(
  admin: AdminGraphQL,
  email: string
): Promise<OrderSummaryForPortal[]> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return [];
  return fetchOrdersByFilter(admin, `email:${trimmed}`);
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
    paymentGatewayNames?: string[];
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
    paymentGatewayNames: order.paymentGatewayNames ?? [],
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
  bonusAmount?: string;
};

export type RefundMethodConfig = {
  method: "original" | "store_credit" | "both" | "discount_code";
  storeCreditPct?: number;
};

const DISCOUNT_CODE_CREATE_MUTATION = `#graphql
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            codes(first: 1) { nodes { code } }
          }
        }
      }
      userErrors { field message }
    }
  }
`;

export type DiscountCodeRefundResult = {
  success: boolean;
  error?: string;
  discountCode?: string;
  discountValue?: string;
  discountCurrency?: string;
};

export async function createDiscountCodeRefund(
  admin: AdminGraphQL,
  opts: {
    orderId: string;
    lineItems: Array<{ id: string; quantity: number }>;
    returnRequestNo: string;
    prefix?: string;
    expiryDays?: number;
    note?: string;
  },
): Promise<DiscountCodeRefundResult> {
  try {
    const gid = opts.orderId.startsWith("gid://") ? opts.orderId : `gid://shopify/Order/${opts.orderId}`;
    const prefix = (opts.prefix || "RETURN").toUpperCase();
    const expiryDays = opts.expiryDays ?? 90;
    const code = `${prefix}-${opts.returnRequestNo}`;

    const suggestRes = await admin.graphql(SUGGEST_REFUND_QUERY, {
      variables: {
        orderId: gid,
        refundLineItems: opts.lineItems.map((item) => ({
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
          };
        };
      };
    };
    const totalAmount = parseFloat(suggestJson.data?.order?.suggestedRefund?.amountSet?.shopMoney?.amount ?? "0");
    const currency = suggestJson.data?.order?.suggestedRefund?.amountSet?.shopMoney?.currencyCode ?? "USD";

    if (totalAmount <= 0) {
      return { success: false, error: "Could not determine refund amount for discount code." };
    }

    const startsAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

    const discountInput = {
      title: `Return refund ${code}`,
      code,
      startsAt,
      endsAt,
      usageLimit: 1,
      customerSelection: { all: true },
      customerGets: {
        value: { discountAmount: { amount: totalAmount.toFixed(2), appliesOnEachItem: false } },
        items: { all: true },
      },
    };

    const res = await admin.graphql(DISCOUNT_CODE_CREATE_MUTATION, {
      variables: { basicCodeDiscount: discountInput },
    });
    const json = (await res.json()) as {
      data?: {
        discountCodeBasicCreate?: {
          codeDiscountNode?: {
            id?: string;
            codeDiscount?: { codes?: { nodes?: Array<{ code?: string }> } };
          };
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    const gqlErrors = json.errors ?? [];
    if (gqlErrors.length > 0) {
      return { success: false, error: gqlErrors.map((e) => e.message ?? "GraphQL error").join(", ") };
    }

    const userErrors = json.data?.discountCodeBasicCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { success: false, error: userErrors.map((e) => e.message).join(", ") };
    }

    const createdCode = json.data?.discountCodeBasicCreate?.codeDiscountNode?.codeDiscount?.codes?.nodes?.[0]?.code ?? code;

    return {
      success: true,
      discountCode: createdCode,
      discountValue: totalAmount.toFixed(2),
      discountCurrency: currency,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create discount code";
    return { success: false, error: msg };
  }
}

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
  options?: { bonusAmount?: number; skipLocation?: boolean },
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

    const skipLocation = options?.skipLocation === true;
    let restockLocationId = locationId;
    if (!skipLocation && !restockLocationId) {
      restockLocationId = await fetchPrimaryLocationId(admin);
    }

    const refundLineItems = normalized.map((item) => ({
      lineItemId: item.id.startsWith("gid://") ? item.id : `gid://shopify/LineItem/${item.id}`,
      quantity: item.quantity,
      restockType: skipLocation ? ("NO_RESTOCK" as string) : ("RETURN" as string),
      ...(!skipLocation && restockLocationId ? { locationId: restockLocationId } : {}),
    }));

    const method = refundMethodConfig?.method ?? "original";
    const storeCreditPct = refundMethodConfig?.storeCreditPct ?? 100;

    const refundInput: Record<string, unknown> = {
      orderId: gid,
      note: note || "Return processed via Fynd Returns",
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

      const bonusAmount = options?.bonusAmount ?? 0;

      if (totalAmount > 0) {
        if (method === "store_credit") {
          const storeCreditTotal = Math.round((totalAmount + bonusAmount) * 100) / 100;
          refundInput.transactions = [];
          refundInput.refundMethods = [{
            storeCreditRefund: {
              amount: { amount: storeCreditTotal.toFixed(2), currencyCode: currency },
            },
          }];
        } else if (method === "both") {
          const scAmount = Math.round((totalAmount * (storeCreditPct / 100) + bonusAmount) * 100) / 100;
          const origAmount = Math.round((totalAmount - (totalAmount * (storeCreditPct / 100))) * 100) / 100;

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

/* ── Bulk order info for customer enrichment ── */

const CUSTOMER_ORDERS_QUERY = `#graphql
  query customerOrders($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        email
        phone
        createdAt
        totalPriceSet { shopMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount currencyCode } }
        displayFinancialStatus
        customer {
          id
          firstName
          lastName
          email
          phone
          numberOfOrders
          amountSpent { amount currencyCode }
          defaultAddress {
            address1
            city
            province
            country
            zip
            phone
          }
        }
        shippingAddress { firstName lastName name phone city province country countryCode }
        refunds(first: 20) {
          id
          createdAt
          note
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }
`;

export type CustomerOrderInfo = {
  orderId: string;
  orderName: string;
  email: string | null;
  phone: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerCity: string | null;
  customerCountry: string | null;
  totalOrderAmount: number;
  totalRefundedAmount: number;
  refundCurrency: string;
  financialStatus: string | null;
  lifetimeOrderCount: number | null;
  lifetimeSpent: number | null;
  refunds: Array<{ id: string; amount: number; currency: string; createdAt: string; note: string | null }>;
};

export async function fetchOrdersForCustomer(
  admin: AdminGraphQL,
  email: string,
  maxOrders = 50,
): Promise<CustomerOrderInfo[]> {
  try {
    const res = await admin.graphql(CUSTOMER_ORDERS_QUERY, {
      variables: { query: `email:${email}`, first: Math.min(maxOrders, 50) },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: {
        orders?: {
          nodes?: Array<{
            id?: string;
            name?: string;
            email?: string | null;
            phone?: string | null;
            createdAt?: string;
            totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
            currentTotalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
            totalRefundedSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
            displayFinancialStatus?: string | null;
            customer?: {
              id?: string;
              firstName?: string | null;
              lastName?: string | null;
              email?: string | null;
              phone?: string | null;
              numberOfOrders?: string | null;
              amountSpent?: { amount?: string; currencyCode?: string } | null;
              defaultAddress?: {
                address1?: string | null;
                city?: string | null;
                province?: string | null;
                country?: string | null;
                zip?: string | null;
                phone?: string | null;
              } | null;
            } | null;
            shippingAddress?: {
              firstName?: string | null;
              lastName?: string | null;
              name?: string | null;
              phone?: string | null;
              city?: string | null;
              province?: string | null;
              country?: string | null;
              countryCode?: string | null;
            } | null;
            refunds?: Array<{
              id?: string;
              createdAt?: string;
              note?: string | null;
              totalRefundedSet?: { shopMoney?: { amount?: string; currencyCode?: string } };
            }>;
          }>;
        };
      };
    };

    const nodes = json.data?.orders?.nodes ?? [];
    return nodes.map((n) => {
      const cust = n.customer;
      const ship = n.shippingAddress;
      const custName = [cust?.firstName, cust?.lastName].filter(Boolean).join(" ") || ship?.name || null;
      const custPhone = cust?.phone || cust?.defaultAddress?.phone || ship?.phone || n.phone || null;
      const custCity = cust?.defaultAddress?.city || ship?.city || null;
      const custCountry = cust?.defaultAddress?.country || ship?.country || null;
      const refundedMoney = n.totalRefundedSet?.shopMoney;
      const orderMoney = n.totalPriceSet?.shopMoney;

      return {
        orderId: n.id ?? "",
        orderName: n.name ?? "",
        email: n.email ?? cust?.email ?? null,
        phone: n.phone ?? null,
        customerName: custName,
        customerPhone: custPhone,
        customerCity: custCity,
        customerCountry: custCountry,
        totalOrderAmount: parseFloat(orderMoney?.amount ?? "0") || 0,
        totalRefundedAmount: parseFloat(refundedMoney?.amount ?? "0") || 0,
        refundCurrency: refundedMoney?.currencyCode ?? orderMoney?.currencyCode ?? "USD",
        financialStatus: n.displayFinancialStatus ?? null,
        lifetimeOrderCount: cust?.numberOfOrders ? parseInt(cust.numberOfOrders, 10) : null,
        lifetimeSpent: cust?.amountSpent?.amount ? parseFloat(cust.amountSpent.amount) : null,
        refunds: (n.refunds ?? []).map((r) => ({
          id: r.id ?? "",
          amount: parseFloat(r.totalRefundedSet?.shopMoney?.amount ?? "0") || 0,
          currency: r.totalRefundedSet?.shopMoney?.currencyCode ?? "USD",
          createdAt: r.createdAt ?? "",
          note: r.note ?? null,
        })),
      };
    });
  } catch (err) {
    console.error("fetchOrdersForCustomer error:", err);
    return [];
  }
}
