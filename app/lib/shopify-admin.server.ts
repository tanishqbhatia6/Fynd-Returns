export type AdminGraphQL = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
  /** Optional REST credentials for exact name lookups (set by callers who have session info) */
  _rest?: { shopDomain: string; accessToken: string };
};

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
  legacyResourceId
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

/** Paginated orders without search filter — use when search is unreliable (e.g. Fynd order names). */
const ORDERS_PAGINATED_QUERY = `#graphql
  query getOrdersPaginated($first: Int!, $after: String) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true, after: $after) {
      nodes {
        id
        name
      }
      pageInfo {
        endCursor
        hasNextPage
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

/**
 * Minimal query that fetches ONLY order id, name, and line items.
 * Does NOT request any PCDA-protected fields (email, phone, addresses).
 * Safe to use even without Protected Customer Data Access approval.
 */
const ORDER_LINE_ITEMS_ONLY_QUERY = `#graphql
  query getOrderLineItemsOnly($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        lineItems(first: 50) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const ORDER_LINE_ITEMS_BY_NAME_QUERY = `#graphql
  query getOrderLineItemsByName($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        lineItems(first: 50) {
          nodes {
            id
            title
            variantTitle
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            discountedUnitPriceSet { shopMoney { amount } }
          }
        }
      }
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
  legacyResourceId?: string;
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
 * Exact order lookup via Shopify REST API:
 *   GET /admin/api/2026-01/orders.json?status=any&name=#FYNDSHOPIFYX14122
 * (name is URL-encoded, e.g. name=%23FYNDSHOPIFYX14122)
 */
/**
 * Search Shopify orders by query string. When `exactName` is provided,
 * fetches up to 50 candidates and returns only the one whose `name`
 * matches exactly (case-insensitive, ignoring leading #). This prevents
 * Shopify's fuzzy/token matching from returning the wrong order.
 */
async function searchOrders(
  admin: AdminGraphQL,
  query: string,
  throwOnError = true,
  exactName?: string
): Promise<unknown | null> {
  const limit = exactName ? 50 : 1;
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
  if (nodes.length === 0) {
    console.log(`[searchOrders] query="${query}" returned 0 results`);
    return null;
  }

  if (exactName) {
    const norm = exactName.replace(/^#/, "").toLowerCase();
    const candidateNames = nodes.map((n) => typeof n.name === "string" ? n.name : "?");
    console.log(`[searchOrders] query="${query}" exactName="${exactName}" got ${nodes.length} candidates: [${candidateNames.slice(0, 10).join(", ")}]`);
    const match = nodes.find((n) => {
      const name = typeof n.name === "string" ? n.name.replace(/^#/, "").toLowerCase() : "";
      return name === norm;
    });
    if (!match) {
      console.log(`[searchOrders] no exact match for "${norm}" among candidates`);
    }
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
 * 1. orderByIdentifier — O(1) direct GID lookup when a GID is provided
 * 2. GraphQL name: filter — exact name lookup using orders(first: 1, query: "name:#<order>")
 * 3. Pagination scan — recent orders without search filter (safety net)
 * 4. metafields.$app.fynd_order_id — lookup by stored Fynd order id
 * 5. source_identifier — lookup by external/source identifier
 */
/**
 * Look up a Shopify order by exact name via the REST Admin API.
 * REST API's `name` parameter is an EXACT match filter (unlike GraphQL search
 * which tokenizes/parses the query string). This is the most reliable way to
 * find orders with non-standard names like #FYNDSHOPIFYX14126.
 *
 * Returns the order GID if found, or null.
 */
async function restOrderLookupByName(
  shopDomain: string,
  accessToken: string,
  orderName: string
): Promise<string | null> {
  const clean = orderName.replace(/^#/, "").trim();
  if (!clean) return null;

  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  // Try with # prefix (standard Shopify name format) and without
  for (const nameQuery of [`#${clean}`, clean]) {
    try {
      const url = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(nameQuery)}&fields=id,name&limit=5`;
      const res = await fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) {
        console.warn(`[REST order lookup] ${res.status} for name="${nameQuery}"`);
        continue;
      }
      const data = (await res.json()) as { orders?: Array<{ id?: number; name?: string }> };
      const orders = data?.orders ?? [];
      // Exact match on name (case-insensitive, ignoring leading #)
      const norm = clean.toLowerCase();
      const match = orders.find((o) => {
        const n = (o.name ?? "").replace(/^#/, "").toLowerCase();
        return n === norm;
      });
      if (match?.id) {
        console.log(`[REST order lookup] Found order ${match.name} (ID: ${match.id}) via REST name="${nameQuery}"`);
        return `gid://shopify/Order/${match.id}`;
      }
    } catch (err) {
      console.warn(`[REST order lookup] Error for name="${nameQuery}":`, err);
    }
  }
  return null;
}

/** Attach REST credentials to an admin client so fetchOrderByOrderNumber can use REST fallback */
export function withRestCredentials(admin: AdminGraphQL, shopDomain: string, accessToken: string): AdminGraphQL {
  return { ...admin, _rest: { shopDomain, accessToken } };
}

/**
 * Raw-fetch GraphQL search that bypasses the Shopify SDK entirely.
 * The SDK's admin.graphql() wraps responses through multiple layers
 * (@shopify/graphql-client → @shopify/shopify-api → @shopify/shopify-app-react-router)
 * which can interfere with search results. This raw fetch is proven to work via curl.
 */
async function rawGraphQLSearch(
  shopDomain: string,
  accessToken: string,
  queryString: string,
  exactName?: string
): Promise<OrderForPortal | null> {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const limit = exactName ? 50 : 1;
  const gqlQuery = `query searchOrders($q: String!, $first: Int!) {
    orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS_FRAGMENT} }
    }
  }`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query: gqlQuery, variables: { q: queryString, first: limit } }),
  });
  if (!res.ok) {
    console.warn(`[rawGraphQLSearch] HTTP ${res.status} for query="${queryString}"`);
    return null;
  }
  const json = (await res.json()) as {
    data?: { orders?: { nodes?: Array<Record<string, unknown>> } };
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) {
    console.warn(`[rawGraphQLSearch] GraphQL errors for query="${queryString}":`, json.errors[0]?.message);
    return null;
  }
  const nodes = json.data?.orders?.nodes ?? [];
  if (nodes.length === 0) return null;

  if (exactName) {
    const norm = exactName.replace(/^#/, "").toLowerCase();
    const match = nodes.find((n) => {
      const name = typeof n.name === "string" ? n.name.replace(/^#/, "").toLowerCase() : "";
      return name === norm;
    });
    if (!match) return null;
    return parseOrderNode(match);
  }
  return parseOrderNode(nodes[0]);
}

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

  // Strategy 1 (PRIMARY — raw fetch, bypasses SDK wrapping issues):
  const hasRestCreds = !!(admin._rest?.accessToken);
  console.log(`[fetchOrderByOrderNumber] clean="${clean}" hasRestCreds=${hasRestCreds} shopDomain=${admin._rest?.shopDomain ?? "none"}`);
  if (hasRestCreds) {
    const { shopDomain, accessToken } = admin._rest!;
    // name:#ORDER is the proven working format; try it first, then without #
    for (const q of [`name:#${clean}`, `name:${clean}`]) {
      try {
        const order = await rawGraphQLSearch(shopDomain, accessToken, q, clean);
        if (order) {
          console.log(`[fetchOrderByOrderNumber] Found via raw fetch: query="${q}" → ${order.id}`);
          return order;
        }
      } catch (err) {
        console.warn(`[fetchOrderByOrderNumber] Raw search failed for query="${q}":`, err);
      }
    }
    // REST API exact name match (single call, fast)
    try {
      const gid = await restOrderLookupByName(shopDomain, accessToken, clean);
      if (gid) {
        console.log(`[fetchOrderByOrderNumber] Found via REST API: ${gid}`);
        return fetchOrderByGid(admin, gid);
      }
    } catch (err) {
      console.warn("[fetchOrderByOrderNumber] REST lookup error:", err);
    }
  } else {
    console.warn(`[fetchOrderByOrderNumber] No REST credentials — skipping raw fetch. accessToken present: ${!!admin._rest?.accessToken}, _rest present: ${!!admin._rest}`);
  }

  // Strategy 2 (FALLBACK — SDK's admin.graphql(), for cases without REST credentials):
  for (const q of [`name:#${clean}`, `name:${clean}`]) {
    try {
      console.log(`[fetchOrderByOrderNumber] Strategy 2 (SDK): trying query="${q}"`);
      const node = await searchOrders(admin, q, false, clean);
      if (node) {
        console.log(`[fetchOrderByOrderNumber] Found via SDK: query="${q}"`);
        return parseOrderNode(node);
      }
    } catch (err) {
      if (err instanceof OrderAccessError) throw err;
      console.warn(`[fetchOrderByOrderNumber] Strategy 2 failed for query="${q}":`, err);
    }
  }

  // For pure numeric order names, no further strategies needed
  if (/^\d+$/.test(clean)) return null;

  // Strategy 3: metafield search (single API call)
  try {
    const node = await searchOrders(admin, `metafields.$app.fynd_order_id:"${clean}"`, false);
    if (node) return parseOrderNode(node);
  } catch (err) {
    if (err instanceof OrderAccessError) throw err;
  }

  return null;
}

/**
 * Extract Shopify order number variants from a Fynd affiliate_order_id.
 *
 * Fynd prefixes affiliate_order_ids like:
 *   FYNDSHOPIFYX14126 → Shopify order #14126 (or #X14126)
 *   FYNDSHOPIFY14126  → Shopify order #14126
 *   #FYNDSHOPIFYX14126 → same with # prefix
 *
 * Returns an array of candidate order names to search, most specific first.
 */
export function extractShopifyOrderNumberVariants(affiliateOrderId: string | null | undefined): string[] {
  if (!affiliateOrderId) return [];
  const clean = affiliateOrderId.replace(/^#/, "").trim();
  if (!clean) return [];

  const variants: string[] = [];
  // Always try the full value first
  variants.push(clean);

  // Strip common Fynd prefixes: FYNDSHOPIFY, FYND_SHOPIFY_, FYND-SHOPIFY-, etc.
  const prefixPatterns = [
    /^FYNDSHOPIFY/i,
    /^FYND[_-]?SHOPIFY[_-]?/i,
    /^FYND[_-]?/i,
  ];

  for (const pattern of prefixPatterns) {
    if (pattern.test(clean)) {
      const stripped = clean.replace(pattern, "").trim();
      if (stripped && stripped !== clean) {
        variants.push(stripped);
        // If stripped starts with a letter prefix (X, O, etc.) followed by numbers, also try just the numbers
        const numMatch = stripped.match(/^[A-Za-z](\d+)$/);
        if (numMatch) {
          variants.push(numMatch[1]);
        }
      }
    }
  }

  // If the entire value looks like a pure number, it's already a Shopify order number
  // (no prefix stripping needed, already included)

  // Deduplicate while preserving order
  return [...new Set(variants)];
}

/**
 * Try to find a Shopify order from a Fynd affiliate_order_id by trying multiple
 * variants (with Fynd prefixes stripped).
 */
export async function fetchOrderByFyndAffiliateId(
  admin: AdminGraphQL,
  affiliateOrderId: string
): Promise<OrderForPortal | null> {
  const variants = extractShopifyOrderNumberVariants(affiliateOrderId);
  const startTime = Date.now();
  const TIMEOUT_MS = 8000; // give up after 8 seconds
  for (const variant of variants) {
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.warn(`[fetchOrderByFyndAffiliateId] Timed out after ${TIMEOUT_MS}ms, tried variants: ${variants.join(", ")}`);
      return null;
    }
    try {
      const order = await fetchOrderByOrderNumber(admin, variant);
      if (order) return order;
    } catch (err) {
      if (err instanceof OrderAccessError) throw err;
      // Continue trying other variants
    }
  }
  return null;
}

type RawOrderNode = {
  id: string;
  legacyResourceId?: string;
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
    legacyResourceId: o.legacyResourceId ?? o.id.replace(/^gid:\/\/shopify\/Order\//, ""),
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

/**
 * Fetch ONLY order line items — no customer data, no addresses, no email/phone.
 * This query is PCDA-safe: it works even without Protected Customer Data Access approval.
 * Used as the primary strategy for refund line-item resolution.
 */
export async function fetchOrderLineItemsOnly(
  admin: AdminGraphQL,
  orderId: string
): Promise<{ id: string; name: string; lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }> } | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

  // Strategy 1: Direct GID lookup via nodes()
  try {
    const res = await admin.graphql(ORDER_LINE_ITEMS_ONLY_QUERY, { variables: { ids: [gid] } });
    const json = (await res.json()) as { data?: { nodes?: Array<Record<string, unknown>> }; errors?: Array<{ message?: string }> };
    if (json.errors?.length) {
      console.warn(`[fetchOrderLineItemsOnly] GID query errors:`, json.errors[0]?.message);
    }
    const node = json.data?.nodes?.[0] as { id?: string; name?: string; lineItems?: { nodes?: Array<{ id: string; title: string; sku?: string | null; quantity: number }> } } | undefined;
    if (node?.id && node?.lineItems?.nodes?.length) {
      return {
        id: node.id,
        name: node.name ?? "",
        lineItems: node.lineItems.nodes.map((li) => ({ id: li.id, title: li.title, sku: li.sku ?? null, quantity: li.quantity })),
      };
    }
  } catch (err) {
    console.warn(`[fetchOrderLineItemsOnly] GID query failed for "${gid}":`, (err as Error)?.message ?? err);
  }

  return null;
}

/**
 * Fetch order line items by order name/number — PCDA-safe (no customer data fields).
 * Tries the name-based search query which avoids PCDA-protected fields.
 */
export async function fetchOrderLineItemsByName(
  admin: AdminGraphQL,
  orderName: string
): Promise<{ id: string; name: string; lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }> } | null> {
  const clean = orderName.replace(/^#/, "").trim();
  if (!clean) return null;

  for (const q of [`name:#${clean}`, `name:${clean}`]) {
    try {
      const res = await admin.graphql(ORDER_LINE_ITEMS_BY_NAME_QUERY, { variables: { query: q, first: 50 } });
      const json = (await res.json()) as {
        data?: { orders?: { nodes?: Array<{ id: string; name: string; lineItems?: { nodes?: Array<{ id: string; title: string; sku?: string | null; quantity: number }> } }> } };
        errors?: Array<{ message?: string }>;
      };
      if (json.errors?.length) {
        console.warn(`[fetchOrderLineItemsByName] query="${q}" errors:`, json.errors[0]?.message);
        continue;
      }
      const nodes = json.data?.orders?.nodes ?? [];
      // Find exact name match
      const norm = clean.toLowerCase();
      const match = nodes.find((n) => n.name.replace(/^#/, "").toLowerCase() === norm);
      if (match?.lineItems?.nodes?.length) {
        return {
          id: match.id,
          name: match.name,
          lineItems: match.lineItems.nodes.map((li) => ({ id: li.id, title: li.title, sku: li.sku ?? null, quantity: li.quantity })),
        };
      }
    } catch (err) {
      console.warn(`[fetchOrderLineItemsByName] query="${q}" failed:`, (err as Error)?.message ?? err);
    }
  }

  // Also try via raw REST + minimal GraphQL if REST creds are available
  if (admin._rest?.accessToken) {
    const { shopDomain, accessToken } = admin._rest;
    const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
    const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
    for (const q of [`name:#${clean}`, `name:${clean}`]) {
      try {
        const gqlQuery = `query searchOrdersMinimal($q: String!, $first: Int!) {
          orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
            nodes {
              id
              name
              lineItems(first: 50) {
                nodes { id title sku quantity }
              }
            }
          }
        }`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ query: gqlQuery, variables: { q, first: 50 } }),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { data?: { orders?: { nodes?: Array<{ id: string; name: string; lineItems?: { nodes?: Array<{ id: string; title: string; sku?: string | null; quantity: number }> } }> } } };
        const nodes = json.data?.orders?.nodes ?? [];
        const norm2 = clean.toLowerCase();
        const match = nodes.find((n) => n.name.replace(/^#/, "").toLowerCase() === norm2);
        if (match?.lineItems?.nodes?.length) {
          return {
            id: match.id,
            name: match.name,
            lineItems: match.lineItems.nodes.map((li) => ({ id: li.id, title: li.title, sku: li.sku ?? null, quantity: li.quantity })),
          };
        }
      } catch (err) {
        console.warn(`[fetchOrderLineItemsByName] raw fetch query="${q}" failed:`, (err as Error)?.message ?? err);
      }
    }
  }

  return null;
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
  storeCreditAmount?: number;
  originalAmount?: number;
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
          let scAmount: number;
          let origAmount: number;

          if (refundMethodConfig?.storeCreditAmount != null && refundMethodConfig?.originalAmount != null) {
            const requestedTotal = refundMethodConfig.storeCreditAmount + refundMethodConfig.originalAmount;
            if (requestedTotal > totalAmount + 0.01) {
              return {
                success: false,
                error: `Requested refund total (${requestedTotal.toFixed(2)}) exceeds Shopify's refundable amount (${totalAmount.toFixed(2)}). Please adjust the split amounts.`,
              };
            }
            scAmount = Math.round((refundMethodConfig.storeCreditAmount + bonusAmount) * 100) / 100;
            origAmount = Math.round(refundMethodConfig.originalAmount * 100) / 100;
          } else {
            scAmount = Math.round((totalAmount * (storeCreditPct / 100) + bonusAmount) * 100) / 100;
            origAmount = Math.round((totalAmount - (totalAmount * (storeCreditPct / 100))) * 100) / 100;
          }

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
        // totalAmount === 0: Shopify reports nothing to refund for this order.
        // For store_credit/both this means we cannot issue a credit — surface a clear error.
        if (method === "store_credit" || method === "both") {
          return {
            success: false,
            error: "Shopify reports $0 refundable amount for this order. This may be a COD order, a fully gift-card-paid order, or already partially refunded. Use the \"Discount code\" refund method instead, or process manually in Shopify Admin.",
          };
        }
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

    // Guard: if no transactions and no refundMethods set for store_credit/both, Shopify will reject.
    // This can happen when suggestedTransactions is empty for a $0 refund case.
    if ((method === "store_credit" || method === "both") &&
      refundInput.refundMethods == null &&
      (!Array.isArray(refundInput.transactions) || (refundInput.transactions as unknown[]).length === 0)) {
      return {
        success: false,
        error: "No refundable amount found for store credit. Use the \"Discount code\" refund method instead.",
      };
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
      result.refundMethod = method;
      return result;
    }

    result.refundMethod = method;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Refund request failed";
    return { success: false, error: msg };
  }
}

/* ── Shopify Return creation (returnCreate mutation) ── */

const RETURNABLE_FULFILLMENTS_QUERY = `#graphql
  query returnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      edges {
        node {
          returnableFulfillmentLineItems(first: 50) {
            edges {
              node {
                quantity
                fulfillmentLineItem {
                  id
                  lineItem {
                    id
                    sku
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const RETURN_CREATE_MUTATION = `#graphql
  mutation returnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/** Map free-text return reason to Shopify ReturnReason enum */
function mapReturnReason(reasonCode?: string | null): string {
  if (!reasonCode) return "OTHER";
  const lower = reasonCode.toLowerCase();
  if (/defective|broken|damaged|faulty|not.?working/i.test(lower)) return "DEFECTIVE";
  if (/wrong.*(product|item)|incorrect|not.*ordered|different/i.test(lower)) return "WRONG_PRODUCT";
  if (/too.*small|tight|narrow|short/i.test(lower)) return "SIZE_TOO_SMALL";
  if (/too.*large|big|loose|wide|long/i.test(lower)) return "SIZE_TOO_LARGE";
  if (/colou?r|shade/i.test(lower)) return "COLOR";
  if (/style|design|look|appearance/i.test(lower)) return "STYLE";
  if (/unwanted|not.*need|changed.*mind|don'?t.*want|no.*longer/i.test(lower)) return "UNWANTED";
  return "OTHER";
}

export type ShopifyReturnResult = {
  success: boolean;
  shopifyReturnId?: string;
  error?: string;
};

/**
 * Create a Shopify Return on an order using the returnCreate mutation.
 *
 * Flow:
 * 1. Query `returnableFulfillments` to get `fulfillmentLineItemId` for each item
 * 2. Map return items to fulfillment line items by lineItem GID or SKU
 * 3. Call `returnCreate` mutation
 *
 * Returns the Shopify Return GID on success.
 * Non-fatal: if this fails, the approval flow should continue.
 */
export async function createShopifyReturn(
  admin: AdminGraphQL,
  orderId: string,
  returnItems: Array<{
    shopifyLineItemId: string;
    qty: number;
    reasonCode?: string | null;
    notes?: string | null;
    sku?: string | null;
  }>,
  options?: { notifyCustomer?: boolean; requestedAt?: string },
): Promise<ShopifyReturnResult> {
  try {
    const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

    // Step 1: Query returnable fulfillments to get fulfillmentLineItemIds
    const fulfillmentsRes = await admin.graphql(RETURNABLE_FULFILLMENTS_QUERY, {
      variables: { orderId: orderGid },
    });
    const fulfillmentsJson = (await fulfillmentsRes.json()) as {
      data?: {
        returnableFulfillments?: {
          edges?: Array<{
            node?: {
              returnableFulfillmentLineItems?: {
                edges?: Array<{
                  node?: {
                    quantity: number;
                    fulfillmentLineItem?: {
                      id: string;
                      lineItem?: { id: string; sku?: string | null };
                    };
                  };
                }>;
              };
            };
          }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (fulfillmentsJson.errors?.length) {
      const errMsg = fulfillmentsJson.errors[0]?.message ?? "Unknown error";
      if (/access denied|not approved|protected/i.test(errMsg)) {
        return { success: false, error: `Shopify Return creation requires "write_returns" access scope. Error: ${errMsg}` };
      }
      return { success: false, error: `Failed to query returnable fulfillments: ${errMsg}` };
    }

    // Build maps: order lineItem GID → fulfillmentLineItem, and SKU → fulfillmentLineItem
    const fulfillmentLineItemMap = new Map<string, { fulfillmentLineItemId: string; maxQty: number }>();
    const skuMap = new Map<string, { fulfillmentLineItemId: string; maxQty: number }>();

    for (const edge of fulfillmentsJson.data?.returnableFulfillments?.edges ?? []) {
      for (const lineEdge of edge.node?.returnableFulfillmentLineItems?.edges ?? []) {
        const fli = lineEdge.node?.fulfillmentLineItem;
        if (!fli?.id) continue;
        const maxQty = lineEdge.node?.quantity ?? 0;

        if (fli.lineItem?.id) {
          fulfillmentLineItemMap.set(fli.lineItem.id, { fulfillmentLineItemId: fli.id, maxQty });
        }
        if (fli.lineItem?.sku) {
          const skuKey = fli.lineItem.sku.toLowerCase().trim();
          if (skuKey && !skuMap.has(skuKey)) {
            skuMap.set(skuKey, { fulfillmentLineItemId: fli.id, maxQty });
          }
        }
      }
    }

    if (fulfillmentLineItemMap.size === 0 && skuMap.size === 0) {
      return { success: false, error: "No returnable fulfillment line items found. The order may not be fulfilled yet, or all items have already been returned." };
    }

    console.log(`[createShopifyReturn] Found ${fulfillmentLineItemMap.size} fulfillment line items by GID, ${skuMap.size} by SKU`);

    // Step 2: Map return items to fulfillment line items
    const returnLineItems: Array<{
      fulfillmentLineItemId: string;
      quantity: number;
      returnReason: string;
      returnReasonNote?: string;
    }> = [];

    for (const item of returnItems) {
      let match: { fulfillmentLineItemId: string; maxQty: number } | undefined;

      // Primary: match by order lineItem GID
      if (item.shopifyLineItemId?.startsWith("gid://shopify/LineItem/")) {
        match = fulfillmentLineItemMap.get(item.shopifyLineItemId);
      }

      // Fallback: match by SKU
      if (!match && item.sku) {
        const skuKey = item.sku.toLowerCase().trim();
        match = skuMap.get(skuKey);
      }

      if (!match) {
        console.warn(`[createShopifyReturn] No fulfillment line item match for lineItemId="${item.shopifyLineItemId}" sku="${item.sku}" — skipping`);
        continue;
      }

      const qty = Math.min(item.qty, match.maxQty);
      if (qty <= 0) continue;

      const reason = mapReturnReason(item.reasonCode);
      returnLineItems.push({
        fulfillmentLineItemId: match.fulfillmentLineItemId,
        quantity: qty,
        returnReason: reason,
        ...(item.notes
          ? { returnReasonNote: item.notes.slice(0, 255) }
          : reason === "OTHER"
            ? { returnReasonNote: item.reasonCode || "Customer return request" }
            : {}),
      });
    }

    if (returnLineItems.length === 0) {
      return { success: false, error: "Could not match any return items to fulfilled line items. Items may not be fulfilled yet or have already been returned." };
    }

    console.log(`[createShopifyReturn] Creating Shopify return with ${returnLineItems.length} line items on order ${orderGid}`);

    // Step 3: Call returnCreate mutation
    const returnInput: Record<string, unknown> = {
      orderId: orderGid,
      returnLineItems,
      notifyCustomer: options?.notifyCustomer ?? false,
    };
    if (options?.requestedAt) {
      returnInput.requestedAt = options.requestedAt;
    }

    const createRes = await admin.graphql(RETURN_CREATE_MUTATION, {
      variables: { returnInput },
    });
    const createJson = (await createRes.json()) as {
      data?: {
        returnCreate?: {
          return?: { id: string } | null;
          userErrors?: Array<{ field?: string[]; message: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    if (createJson.errors?.length) {
      return { success: false, error: `Shopify API error: ${createJson.errors[0]?.message ?? "Unknown"}` };
    }

    const userErrors = createJson.data?.returnCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      const errMsg = userErrors.map((e) => e.message).join("; ");
      return { success: false, error: `Shopify Return creation failed: ${errMsg}` };
    }

    const returnId = createJson.data?.returnCreate?.return?.id;
    if (!returnId) {
      return { success: false, error: "Shopify Return was created but no ID was returned." };
    }

    console.log(`[createShopifyReturn] Successfully created Shopify return: ${returnId}`);
    return { success: true, shopifyReturnId: returnId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[createShopifyReturn] Error:", err);
    return { success: false, error: `Shopify Return creation error: ${msg}` };
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
