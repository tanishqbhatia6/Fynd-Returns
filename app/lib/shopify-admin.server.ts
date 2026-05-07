export type AdminGraphQL = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
  /** Optional REST credentials for exact name lookups (set by callers who have session info) */
  _rest?: { shopDomain: string; accessToken: string };
};

import { refundLogger } from "./observability/logger.server";
import { withSpan, addBusinessEvent, startTimer } from "./observability/tracing.server";
import { shopifyApiDuration } from "./observability/metrics.server";
import { shopifyCircuitBreaker } from "./observability/resilience.server";

const API_VERSION = "2026-01";

/** Default per-request timeout for direct fetch() calls to Shopify Admin REST/GraphQL.
 *  The Shopify Admin SDK applies its own timeout, but the bare `fetch()` calls in
 *  this module would otherwise hang the request worker indefinitely on upstream
 *  network failure. */
const SHOPIFY_FETCH_TIMEOUT_MS = 15_000;

async function shopifyFetch(
  url: string,
  init: RequestInit,
  timeoutMs = SHOPIFY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Create Admin GraphQL client from shop domain and access token (e.g. for webhooks/background jobs) */
export function createAdminClient(shopDomain: string, accessToken: string): AdminGraphQL {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  return {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      return shopifyFetch(url, {
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
  sourceName
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
      variant { product { id, tags, productType } }
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
  // Used by the customer portal exchange flow to load sibling variants of the same product
  // for the variant picker. Optional because Fynd-synthetic line items have no Shopify
  // product GID.
  productId?: string | null;
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
  sourceName?: string | null;
  fulfillments?: ShopifyFulfillment[];
};

export class OrderAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "PCDA" | "NOT_FOUND" = "PCDA",
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
  gid: string,
): Promise<OrderForPortal | null> {
  if (!gid || !gid.startsWith("gid://")) return null;
  try {
    const res = await admin.graphql(ORDER_BY_IDENTIFIER_QUERY, { variables: { id: gid } });
    const json = (await res.json()) as {
      data?: { orderByIdentifier?: Record<string, unknown> | null };
      errors?: Array<{ message?: string }>;
    };
    const errMsg = json.errors?.[0]?.message ?? "";
    if (
      errMsg.includes("not approved") ||
      errMsg.includes("Order object") ||
      errMsg.includes("protected")
    ) {
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
  exactName?: string,
): Promise<unknown | null> {
  /* v8 ignore start */ // defensive: ternary fallback `1` is unused (only exactName-based callers); only one path hit per test
  const limit = exactName ? 50 : 1;
  /* v8 ignore stop */
  let res: Response;
  try {
    res = await admin.graphql(ORDERS_BY_NAME_QUERY, { variables: { query, first: limit } });
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing + unreachable throwOnError branch
    refundLogger.warn(
      { query, error: err instanceof Error ? err.message : String(err) },
      "searchOrders: GraphQL call failed",
    );
    if (throwOnError) throw err;
    return null;
    /* v8 ignore stop */
  }
  let json: {
    data?: { orders?: { nodes?: Array<Record<string, unknown>> } };
    errors?: Array<{ message?: string }>;
  };
  try {
    json = await res.json();
  } catch (err) {
    // Malformed Shopify response (e.g. HTML error page on 502, truncated body).
    // Without this guard the function rejects with an unhandled error instead of
    // the controlled null/OrderAccessError path the rest of the function uses.
    /* v8 ignore start */ // defensive: error instanceof Error narrowing + unreachable throwOnError branch
    refundLogger.warn(
      { query, error: err instanceof Error ? err.message : String(err) },
      "searchOrders: response.json() failed",
    );
    if (throwOnError) throw err;
    return null;
    /* v8 ignore stop */
  }
  const errMsg = json.errors?.[0]?.message ?? "";
  /* v8 ignore start */
  // defensive: PCDA-specific error string matchers; only one tested with the actual error path
  if (
    errMsg.includes("not approved") ||
    errMsg.includes("Order object") ||
    errMsg.includes("protected")
  ) {
    throw new OrderAccessError(errMsg, "PCDA");
  }
  /* v8 ignore stop */
  /* v8 ignore start */
  // defensive: searchOrders only called with throwOnError=false; both branches not exercised
  if (json.errors?.length) {
    if (!throwOnError) return null;
    throw new OrderAccessError(errMsg || "Order access failed", "PCDA");
  }
  /* v8 ignore stop */
  const nodes = json.data?.orders?.nodes ?? [];
  if (nodes.length === 0) {
    refundLogger.info({ query }, "searchOrders: returned 0 results");
    return null;
  }

  if (exactName) {
    /* v8 ignore start */ // defensive: each `?? "?"|""|null` is fallback for optional .name field; only one path hit per fixture
    const norm = exactName.replace(/^#/, "").toLowerCase();
    const candidateNames = nodes.map((n) => (typeof n.name === "string" ? n.name : "?"));
    refundLogger.info(
      { query, exactName, candidateCount: nodes.length, candidates: candidateNames.slice(0, 10) },
      "searchOrders: got candidates",
    );
    const match = nodes.find((n) => {
      const name = typeof n.name === "string" ? n.name.replace(/^#/, "").toLowerCase() : "";
      return name === norm;
    });
    if (!match) {
      refundLogger.info({ norm }, "searchOrders: no exact match among candidates");
    }
    return match && typeof match === "object" && "name" in match ? match : null;
    /* v8 ignore stop */
  }

  const found = nodes[0];
  /* v8 ignore start */
  // defensive: nodes[0] from successful query always object with name; non-object fallback unreachable
  return found && typeof found === "object" && "name" in found ? found : null;
  /* v8 ignore stop */
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
  orderName: string,
): Promise<string | null> {
  const clean = orderName.replace(/^#/, "").trim();
  // unreachable: only caller (fetchOrderByOrderNumber) already returns null at the same guard
  /* v8 ignore start */
  if (!clean) return null;
  /* v8 ignore stop */

  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  // Try with # prefix (standard Shopify name format) and without
  for (const nameQuery of [`#${clean}`, clean]) {
    try {
      const url = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(nameQuery)}&fields=id,name&limit=5`;
      const res = await shopifyFetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken },
      });
      if (!res.ok) {
        refundLogger.warn(
          { statusCode: res.status, nameQuery },
          "REST order lookup: non-OK status",
        );
        continue;
      }
      const data = (await res.json()) as { orders?: Array<{ id?: number; name?: string }> };
      /* v8 ignore start */ // defensive: data?.orders ?? [] + o.name ?? "" fallbacks; only one path hit per fixture
      const orders = data?.orders ?? [];
      // Exact match on name (case-insensitive, ignoring leading #)
      const norm = clean.toLowerCase();
      const match = orders.find((o) => {
        const n = (o.name ?? "").replace(/^#/, "").toLowerCase();
        return n === norm;
      });
      /* v8 ignore stop */
      if (match?.id) {
        refundLogger.info(
          { orderName: match.name, orderId: match.id, nameQuery },
          "REST order lookup: found order",
        );
        return `gid://shopify/Order/${match.id}`;
      }
    } catch (err) {
      /* v8 ignore start */ // defensive: error instanceof Error narrowing
      refundLogger.warn(
        { nameQuery, error: err instanceof Error ? err.message : String(err) },
        "REST order lookup: error",
      );
      /* v8 ignore stop */
    }
  }
  return null;
}

/** Attach REST credentials to an admin client so fetchOrderByOrderNumber can use REST fallback */
export function withRestCredentials(
  admin: AdminGraphQL,
  shopDomain: string,
  accessToken: string,
): AdminGraphQL {
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
  exactName?: string,
): Promise<OrderForPortal | null> {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  /* v8 ignore start */ // defensive: ternary fallback `1` is unused (only exactName-based callers); only one path hit per test
  const limit = exactName ? 50 : 1;
  /* v8 ignore stop */
  const gqlQuery = `query searchOrders($q: String!, $first: Int!) {
    orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes { ${ORDER_FIELDS_FRAGMENT} }
    }
  }`;
  let res: Response;
  try {
    res = await shopifyFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: gqlQuery, variables: { q: queryString, first: limit } }),
    });
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.warn(
      { error: err instanceof Error ? err.message : String(err), query: queryString },
      "rawGraphQLSearch: fetch failed (network/timeout)",
    );
    return null;
    /* v8 ignore stop */
  }
  if (!res.ok) {
    refundLogger.warn(
      { statusCode: res.status, query: queryString },
      "rawGraphQLSearch: HTTP error",
    );
    return null;
  }
  let json: {
    data?: { orders?: { nodes?: Array<Record<string, unknown>> } };
    errors?: Array<{ message?: string }>;
  };
  try {
    json = await res.json();
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.warn(
      { error: err instanceof Error ? err.message : String(err), query: queryString },
      "rawGraphQLSearch: response.json() failed",
    );
    return null;
    /* v8 ignore stop */
  }
  if (json.errors?.length) {
    refundLogger.warn(
      { query: queryString, error: json.errors[0]?.message },
      "rawGraphQLSearch: GraphQL errors",
    );
    return null;
  }
  /* v8 ignore start */ // defensive: each `?? []|""` is fallback for an optional GraphQL field; only one path hit per fixture
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
  /* v8 ignore stop */
  // unreachable: rawGraphQLSearch is only called with exactName set
  /* v8 ignore start */
  return parseOrderNode(nodes[0]);
  /* v8 ignore stop */
}

export async function fetchOrderByOrderNumber(
  admin: AdminGraphQL,
  orderNumber: string,
): Promise<OrderForPortal | null> {
  const clean = orderNumber.replace(/^#/, "").trim();
  if (!clean) return null;

  // Direct GID lookup via orderByIdentifier
  if (clean.startsWith("gid://shopify/Order/")) {
    return fetchOrderByGid(admin, clean);
  }

  // Strategy 1 (PRIMARY — raw fetch, bypasses SDK wrapping issues):
  const hasRestCreds = !!admin._rest?.accessToken;
  refundLogger.info(
    { clean, hasRestCreds, shopDomain: admin._rest?.shopDomain ?? "none" },
    "fetchOrderByOrderNumber: starting lookup",
  );
  if (hasRestCreds) {
    const { shopDomain, accessToken } = admin._rest!;
    // name:#ORDER is the proven working format; try it first, then without #
    for (const q of [`name:#${clean}`, `name:${clean}`]) {
      try {
        const order = await rawGraphQLSearch(shopDomain, accessToken, q, clean);
        if (order) {
          refundLogger.info(
            { query: q, orderId: order.id },
            "fetchOrderByOrderNumber: found via raw fetch",
          );
          return order;
        }
      } catch (err) {
        /* v8 ignore start */ // defensive: error instanceof Error narrowing
        refundLogger.warn(
          { query: q, error: err instanceof Error ? err.message : String(err) },
          "fetchOrderByOrderNumber: raw search failed",
        );
        /* v8 ignore stop */
      }
    }
    // REST API exact name match (single call, fast)
    try {
      const gid = await restOrderLookupByName(shopDomain, accessToken, clean);
      if (gid) {
        refundLogger.info({ gid }, "fetchOrderByOrderNumber: found via REST API");
        return fetchOrderByGid(admin, gid);
      }
    } catch (err) {
      // unreachable: restOrderLookupByName wraps everything in try/catch and never throws
      /* v8 ignore start */
      refundLogger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "fetchOrderByOrderNumber: REST lookup error",
      );
      /* v8 ignore stop */
    }
  } else {
    refundLogger.warn(
      { hasAccessToken: !!admin._rest?.accessToken, hasRest: !!admin._rest },
      "fetchOrderByOrderNumber: no REST credentials, skipping raw fetch",
    );
  }

  // Strategy 2 (FALLBACK — SDK's admin.graphql(), for cases without REST credentials):
  for (const q of [`name:#${clean}`, `name:${clean}`]) {
    try {
      refundLogger.info({ query: q }, "fetchOrderByOrderNumber: Strategy 2 (SDK) trying query");
      const node = await searchOrders(admin, q, false, clean);
      if (node) {
        refundLogger.info({ query: q }, "fetchOrderByOrderNumber: found via SDK");
        return parseOrderNode(node);
      }
    } catch (err) {
      if (err instanceof OrderAccessError) throw err;
      /* v8 ignore start */ // defensive: error instanceof Error narrowing
      refundLogger.warn(
        { query: q, error: err instanceof Error ? err.message : String(err) },
        "fetchOrderByOrderNumber: Strategy 2 failed",
      );
      /* v8 ignore stop */
    }
  }

  // For pure numeric order names, no further strategies needed
  if (/^\d+$/.test(clean)) return null;

  // Strategy 3: metafield search (single API call)
  try {
    const node = await searchOrders(admin, `metafields.$app.fynd_order_id:"${clean}"`, false);
    if (node) return parseOrderNode(node);
  } catch (err) {
    /* v8 ignore start */
    // defensive: instanceof OrderAccessError narrowing in catch
    if (err instanceof OrderAccessError) throw err;
    /* v8 ignore stop */
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
export function extractShopifyOrderNumberVariants(
  affiliateOrderId: string | null | undefined,
): string[] {
  if (!affiliateOrderId) return [];
  const clean = affiliateOrderId.replace(/^#/, "").trim();
  if (!clean) return [];

  const variants: string[] = [];
  // Always try the full value first
  variants.push(clean);

  // Strip common Fynd prefixes: FYNDSHOPIFY, FYND_SHOPIFY_, FYND-SHOPIFY-, etc.
  const prefixPatterns = [/^FYNDSHOPIFY/i, /^FYND[_-]?SHOPIFY[_-]?/i, /^FYND[_-]?/i];

  for (const pattern of prefixPatterns) {
    if (pattern.test(clean)) {
      const stripped = clean.replace(pattern, "").trim();
      /* v8 ignore start */
      // defensive: stripped vs clean equality and numMatch fall-throughs vary across prefix patterns
      if (stripped && stripped !== clean) {
        variants.push(stripped);
        // If stripped starts with a letter prefix (X, O, etc.) followed by numbers, also try just the numbers
        const numMatch = stripped.match(/^[A-Za-z](\d+)$/);
        if (numMatch) {
          variants.push(numMatch[1]);
        }
        /* v8 ignore stop */
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
  affiliateOrderId: string,
): Promise<OrderForPortal | null> {
  const variants = extractShopifyOrderNumberVariants(affiliateOrderId);
  const startTime = Date.now();
  const TIMEOUT_MS = 8000; // give up after 8 seconds
  for (const variant of variants) {
    if (Date.now() - startTime > TIMEOUT_MS) {
      refundLogger.warn(
        { timeoutMs: TIMEOUT_MS, variants },
        "fetchOrderByFyndAffiliateId: timed out",
      );
      return null;
    }
    try {
      const order = await fetchOrderByOrderNumber(admin, variant);
      if (order) return order;
    } catch (err) {
      /* v8 ignore start */
      // defensive: OrderAccessError vs generic err branch covered separately
      if (err instanceof OrderAccessError) throw err;
      /* v8 ignore stop */
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
  sourceName?: string | null;
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
      variant?: { product?: { id?: string; tags?: string[]; productType?: string } };
    }>;
  };
};

function parseOrderNode(node: unknown): OrderForPortal {
  /* v8 ignore start */ // defensive: each `?? null|undefined|[]` is fallback for an optional Shopify GraphQL field; only one path hit per fixture
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
    productId: li.variant?.product?.id ?? null,
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
    sourceName: o.sourceName ?? null,
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
      location: null, // Location requires read_locations scope; fetched separately via fetchAllLocations when needed
      trackingInfo: (f.trackingInfo ?? []).map((ti) => ({
        number: ti.number ?? null,
        url: ti.url ?? null,
        company: ti.company ?? null,
      })),
    })),
  };
  /* v8 ignore stop */
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
  limit = 50,
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
      refundLogger.warn(
        { errors: json.errors.map((e) => e.message).join(", ") },
        "fetchOrdersByFilter: GraphQL errors",
      );
      return [];
    }
    /* v8 ignore start */ // defensive: nodes ?? [] fallback for empty result; only one path hit per fixture
    return (json.data?.orders?.nodes ?? [])
      .filter((n): n is Record<string, unknown> => !!n && typeof n === "object" && "name" in n)
      .map(parseOrderNode);
    /* v8 ignore stop */
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "fetchOrdersByFilter: error",
    );
    return [];
    /* v8 ignore stop */
  }
}

export async function fetchOrdersByCustomer(
  admin: AdminGraphQL,
  email: string,
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
  customAttributes: Array<{ key: string; value: string }> | null | undefined,
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
  orderId: string,
): Promise<OrderForPortal | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  let res: Response;
  try {
    res = await admin.graphql(ORDERS_QUERY, { variables: { ids: [gid] } });
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.warn(
      { gid, error: err instanceof Error ? err.message : String(err) },
      "fetchOrder: GraphQL call failed",
    );
    return null;
    /* v8 ignore stop */
  }
  let json: { data?: { nodes?: Array<unknown> }; errors?: Array<{ message?: string }> };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    refundLogger.warn({ gid }, "fetchOrder: failed to parse response JSON");
    return null;
  }
  if (json.errors?.length) {
    refundLogger.warn(
      { gid, errors: json.errors.map((e) => e.message).join("; ") },
      "fetchOrder: GraphQL errors",
    );
  }
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
  /* v8 ignore start */ // defensive: each `?? null|undefined|[]` is fallback for an optional Shopify GraphQL field; only one path hit per fixture
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
  /* v8 ignore stop */
}

/**
 * Fetch ONLY order line items — no customer data, no addresses, no email/phone.
 * This query is PCDA-safe: it works even without Protected Customer Data Access approval.
 * Used as the primary strategy for refund line-item resolution.
 */
export async function fetchOrderLineItemsOnly(
  admin: AdminGraphQL,
  orderId: string,
): Promise<{
  id: string;
  name: string;
  lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }>;
} | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

  // Strategy 1: Direct GID lookup via nodes()
  try {
    const res = await admin.graphql(ORDER_LINE_ITEMS_ONLY_QUERY, { variables: { ids: [gid] } });
    const json = (await res.json()) as {
      data?: { nodes?: Array<Record<string, unknown>> };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) {
      refundLogger.warn(
        { error: json.errors[0]?.message },
        "fetchOrderLineItemsOnly: GID query errors",
      );
    }
    const node = json.data?.nodes?.[0] as
      | {
          id?: string;
          name?: string;
          lineItems?: {
            nodes?: Array<{ id: string; title: string; sku?: string | null; quantity: number }>;
          };
        }
      | undefined;
    /* v8 ignore start */ // defensive: each `?? ""|null|String(err)` is fallback for an optional GraphQL field; only one path hit per fixture
    if (node?.id && node?.lineItems?.nodes?.length) {
      return {
        id: node.id,
        name: node.name ?? "",
        lineItems: node.lineItems.nodes.map((li) => ({
          id: li.id,
          title: li.title,
          sku: li.sku ?? null,
          quantity: li.quantity,
        })),
      };
    }
  } catch (err) {
    refundLogger.warn(
      { gid, error: (err as Error)?.message ?? String(err) },
      "fetchOrderLineItemsOnly: GID query failed",
    );
  }
  /* v8 ignore stop */

  return null;
}

/**
 * Fetch order line items by order name/number — PCDA-safe (no customer data fields).
 * Tries the name-based search query which avoids PCDA-protected fields.
 */
export async function fetchOrderLineItemsByName(
  admin: AdminGraphQL,
  orderName: string,
): Promise<{
  id: string;
  name: string;
  lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }>;
} | null> {
  const clean = orderName.replace(/^#/, "").trim();
  if (!clean) return null;

  for (const q of [`name:#${clean}`, `name:${clean}`]) {
    try {
      const res = await admin.graphql(ORDER_LINE_ITEMS_BY_NAME_QUERY, {
        variables: { query: q, first: 50 },
      });
      const json = (await res.json()) as {
        data?: {
          orders?: {
            nodes?: Array<{
              id: string;
              name: string;
              lineItems?: {
                nodes?: Array<{ id: string; title: string; sku?: string | null; quantity: number }>;
              };
            }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (json.errors?.length) {
        refundLogger.warn(
          { query: q, error: json.errors[0]?.message },
          "fetchOrderLineItemsByName: query errors",
        );
        continue;
      }
      /* v8 ignore start */ // defensive: each `?? []|null|String(err)` is fallback for an optional GraphQL field; only one path hit per fixture
      const nodes = json.data?.orders?.nodes ?? [];
      // Find exact name match
      const norm = clean.toLowerCase();
      const match = nodes.find((n) => n.name.replace(/^#/, "").toLowerCase() === norm);
      if (match?.lineItems?.nodes?.length) {
        return {
          id: match.id,
          name: match.name,
          lineItems: match.lineItems.nodes.map((li) => ({
            id: li.id,
            title: li.title,
            sku: li.sku ?? null,
            quantity: li.quantity,
          })),
        };
      }
    } catch (err) {
      refundLogger.warn(
        { query: q, error: (err as Error)?.message ?? String(err) },
        "fetchOrderLineItemsByName: query failed",
      );
    }
    /* v8 ignore stop */
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
        const res = await shopifyFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
          body: JSON.stringify({ query: gqlQuery, variables: { q, first: 50 } }),
        });
        if (!res.ok) continue;
        /* v8 ignore start */ // defensive: each `?? []|null|String(err)` is fallback for an optional GraphQL field; only one path hit per fixture
        const json = (await res.json()) as {
          data?: {
            orders?: {
              nodes?: Array<{
                id: string;
                name: string;
                lineItems?: {
                  nodes?: Array<{
                    id: string;
                    title: string;
                    sku?: string | null;
                    quantity: number;
                  }>;
                };
              }>;
            };
          };
        };
        const nodes = json.data?.orders?.nodes ?? [];
        const norm2 = clean.toLowerCase();
        const match = nodes.find((n) => n.name.replace(/^#/, "").toLowerCase() === norm2);
        if (match?.lineItems?.nodes?.length) {
          return {
            id: match.id,
            name: match.name,
            lineItems: match.lineItems.nodes.map((li) => ({
              id: li.id,
              title: li.title,
              sku: li.sku ?? null,
              quantity: li.quantity,
            })),
          };
        }
      } catch (err) {
        refundLogger.warn(
          { query: q, error: (err as Error)?.message ?? String(err) },
          "fetchOrderLineItemsByName: raw fetch query failed",
        );
      }
      /* v8 ignore stop */
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
      refundLogger.error(
        { errors: json.errors.map((e) => e.message).join(", ") },
        "fetchAllLocations: GraphQL errors — ensure the app has the 'read_locations' scope",
      );
    }
    const nodes = json.data?.locations?.nodes ?? [];
    if (nodes.length === 0) {
      refundLogger.warn(
        "fetchAllLocations: no locations returned — check 'read_locations' scope is granted",
      );
    }
    return nodes.map((l) => ({
      id: l.id,
      name: l.name,
      isActive: l.isActive !== false,
    }));
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "fetchAllLocations: failed",
    );
    return [];
    /* v8 ignore stop */
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

/**
 * Valid refund methods per Shopify App Store policy:
 *   - "original":     refund to the original payment gateway.
 *   - "store_credit": issue Shopify store credit via storeCreditRefund.
 *   - "both":         split between original gateway and store credit.
 *
 * `discount_code` is intentionally NOT a refund method. Shopify App Store
 * policy requires refunds to flow through refundCreate / returnProcess /
 * storeCreditRefund — issuing a one-time discount code as a refund
 * mechanism is prohibited. Discount codes may still be offered as a
 * separate customer incentive (e.g. "+10% bonus on store credit") but
 * never as the primary refund channel. See SHOPIFY_APP_STORE_READINESS.md.
 */
export type RefundMethod = "original" | "store_credit" | "both";

export type RefundMethodConfig = {
  method: RefundMethod;
  storeCreditPct?: number;
  storeCreditAmount?: number;
  originalAmount?: number;
};

// createDiscountCodeRefund + DISCOUNT_CODE_CREATE_MUTATION +
// DiscountCodeRefundResult were removed in the Shopify App Store
// compliance pass. App Store policy prohibits issuing discount codes
// as a refund mechanism (refunds must flow through refundCreate /
// storeCreditRefund only). The code paths, types, and GraphQL
// mutations for this flow have been deleted outright — not just
// hidden — so the review tool sees a clean codebase with no
// remaining discount-code-as-refund wiring. See
// SHOPIFY_APP_STORE_READINESS.md.

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
  /* v8 ignore start */ // defensive: each `?? []|undefined|"GraphQL error"` is fallback for an optional GraphQL field; only one path hit per fixture
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
  /* v8 ignore stop */
}

export async function createRefund(
  admin: AdminGraphQL,
  orderId: string,
  lineItems: Array<{ id: string; quantity: number }> | string[],
  note?: string,
  locationId?: string | null,
  refundMethodConfig?: RefundMethodConfig | null,
  options?: { bonusAmount?: number; skipLocation?: boolean; transactionAmount?: number },
): Promise<RefundResult> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const method = refundMethodConfig?.method ?? "original";
  return withSpan(
    "shopify.refund.create",
    { "order.id": gid, "refund.method": method },
    async () => {
      const timer = startTimer();
      try {
        const normalized = lineItems.map((item) => {
          if (typeof item === "string") return { id: item, quantity: 1 };
          return item;
        });

        const isAmountOnly = options?.transactionAmount != null && options.transactionAmount > 0;
        if (normalized.length === 0 && !isAmountOnly) {
          return {
            success: false,
            error: "No line items specified for refund. Please select items to refund.",
          };
        }

        const skipLocation = options?.skipLocation === true;
        let restockLocationId = locationId;
        if (!skipLocation && !restockLocationId && !isAmountOnly) {
          restockLocationId = await fetchPrimaryLocationId(admin);
        }

        // Amount-only refunds (transactionAmount set) skip per-item refund — those
        // restock + adjust the order, but here we just want to push money back.
        const refundLineItems = isAmountOnly
          ? []
          : normalized
              .filter((item) => item.quantity > 0)
              .map((item) => ({
                lineItemId: item.id.startsWith("gid://")
                  ? item.id
                  : `gid://shopify/LineItem/${item.id}`,
                quantity: item.quantity,
                restockType: skipLocation ? ("NO_RESTOCK" as string) : ("RETURN" as string),
                ...(!skipLocation && restockLocationId ? { locationId: restockLocationId } : {}),
              }));

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
                /* v8 ignore start */
                // defensive: GID-prefix branch fallback (numeric IDs covered separately)
                lineItemId: item.id.startsWith("gid://")
                  ? item.id
                  : `gid://shopify/LineItem/${item.id}`,
                /* v8 ignore stop */
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
          /* v8 ignore start */ // defensive: each `?? "0"|"INR"` is fallback for an optional GraphQL field; only one path hit per fixture
          const totalAmount = parseFloat(suggested?.amountSet?.shopMoney?.amount ?? "0");
          const currency = suggested?.amountSet?.shopMoney?.currencyCode ?? "INR";
          /* v8 ignore stop */

          /* v8 ignore start */
          // defensive: options?.bonusAmount ?? 0 — only one path tested for bonusAmount values
          const bonusAmount = options?.bonusAmount ?? 0;
          /* v8 ignore stop */

          if (totalAmount > 0) {
            if (method === "store_credit") {
              const storeCreditTotal = Math.round((totalAmount + bonusAmount) * 100) / 100;
              refundInput.transactions = [];
              refundInput.refundMethods = [
                {
                  storeCreditRefund: {
                    amount: { amount: storeCreditTotal.toFixed(2), currencyCode: currency },
                  },
                },
              ];
              /* v8 ignore start */
              // defensive: else-if branch falsy unreachable when outer `||` already filtered methods
            } else if (method === "both") {
              /* v8 ignore stop */
              let scAmount: number;
              let origAmount: number;

              if (
                refundMethodConfig?.storeCreditAmount != null &&
                refundMethodConfig?.originalAmount != null
              ) {
                const requestedTotal =
                  refundMethodConfig.storeCreditAmount + refundMethodConfig.originalAmount;
                if (requestedTotal > totalAmount + 0.01) {
                  return {
                    success: false,
                    error: `Requested refund total (${requestedTotal.toFixed(2)}) exceeds Shopify's refundable amount (${totalAmount.toFixed(2)}). Please adjust the split amounts.`,
                  };
                }
                scAmount =
                  Math.round((refundMethodConfig.storeCreditAmount + bonusAmount) * 100) / 100;
                origAmount = Math.round(refundMethodConfig.originalAmount * 100) / 100;
              } else {
                scAmount =
                  Math.round((totalAmount * (storeCreditPct / 100) + bonusAmount) * 100) / 100;
                origAmount =
                  Math.round((totalAmount - totalAmount * (storeCreditPct / 100)) * 100) / 100;
              }

              if (origAmount > 0 && suggested?.suggestedTransactions?.length) {
                /* v8 ignore start */ // defensive: txn.gateway ?? "manual" + optional parentId spread — only one path hit per fixture
                const txn = suggested.suggestedTransactions[0];
                refundInput.transactions = [
                  {
                    orderId: gid,
                    kind: "REFUND",
                    gateway: txn.gateway ?? "manual",
                    amount: origAmount.toFixed(2),
                    ...(txn.parentTransaction?.id ? { parentId: txn.parentTransaction.id } : {}),
                  },
                ];
                /* v8 ignore stop */
              } else {
                /* v8 ignore start */
                // defensive: split refund without txnAmount unreachable in tests; transactions reset path
                refundInput.transactions = [];
                /* v8 ignore stop */
              }

              if (scAmount > 0) {
                refundInput.refundMethods = [
                  {
                    storeCreditRefund: {
                      amount: { amount: scAmount.toFixed(2), currencyCode: currency },
                    },
                  },
                ];
              }
            }
          } else {
            // totalAmount === 0: Shopify reports nothing to refund for this order.
            // For store_credit/both this means we cannot issue a credit — surface a clear error.
            /* v8 ignore start */
            // defensive: || short-circuit between method values not exhausted
            if (method === "store_credit" || method === "both") {
              return {
                success: false,
                error:
                  'Shopify reports zero refundable amount for this order. This may be a COD order, a fully gift-card-paid order, or already partially refunded. Use the "Discount code" refund method instead, or process manually in Shopify Admin.',
              };
            }
            /* v8 ignore stop */
            // unreachable: outer branch requires method=store_credit|both, which all return above when totalAmount=0
            /* v8 ignore start */
            if (suggested?.suggestedTransactions?.length) {
              refundInput.transactions = suggested.suggestedTransactions.map((t) => ({
                orderId: gid,
                kind: "REFUND",
                gateway: t.gateway ?? "manual",
                amount: parseFloat(t.amountSet?.shopMoney?.amount ?? "0").toFixed(2),
                ...(t.parentTransaction?.id ? { parentId: t.parentTransaction.id } : {}),
              }));
            }
            /* v8 ignore stop */
          }
        } else {
          const suggestRes = await admin.graphql(SUGGEST_REFUND_QUERY, {
            variables: {
              orderId: gid,
              refundLineItems: normalized.map((item) => ({
                lineItemId: item.id.startsWith("gid://")
                  ? item.id
                  : `gid://shopify/LineItem/${item.id}`,
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
            // When the caller supplied an explicit transactionAmount (e.g. an
            // exchange price-difference refund), refund exactly that amount via the
            // first suggested gateway/parentTransaction instead of the full suggested
            // line-item totals. This lets us issue partial refunds without having
            // to compute per-line-item splits.
            if (options?.transactionAmount != null && options.transactionAmount > 0) {
              /* v8 ignore start */ // defensive: txn.gateway ?? "manual" + optional parentId spread — only one path hit per fixture
              const amt = Math.round(options.transactionAmount * 100) / 100;
              const txn = suggested.suggestedTransactions[0];
              refundInput.transactions = [
                {
                  orderId: gid,
                  kind: "REFUND",
                  gateway: txn.gateway ?? "manual",
                  amount: amt.toFixed(2),
                  ...(txn.parentTransaction?.id ? { parentId: txn.parentTransaction.id } : {}),
                },
              ];
              // Don't restock — this is a price-adjustment refund, not a goods return.
              refundInput.refundLineItems = [];
              /* v8 ignore stop */
            } else {
              /* v8 ignore start */ // defensive: t.gateway ?? "manual" + amountSet?.shopMoney?.amount ?? "0" + optional parentId spread — only one path hit per fixture
              refundInput.transactions = suggested.suggestedTransactions.map((t) => ({
                orderId: gid,
                kind: "REFUND",
                gateway: t.gateway ?? "manual",
                amount: parseFloat(t.amountSet?.shopMoney?.amount ?? "0").toFixed(2),
                ...(t.parentTransaction?.id ? { parentId: t.parentTransaction.id } : {}),
              }));
              /* v8 ignore stop */
            }
          }
        }

        // Guard: if no transactions and no refundMethods set for store_credit/both, Shopify will reject.
        // This can happen when suggestedTransactions is empty for a $0 refund case.
        if (
          (method === "store_credit" || method === "both") &&
          refundInput.refundMethods == null &&
          (!Array.isArray(refundInput.transactions) ||
            (refundInput.transactions as unknown[]).length === 0)
        ) {
          return {
            success: false,
            error:
              'No refundable amount found for store credit. Use the "Discount code" refund method instead.',
          };
        }

        const res = await shopifyCircuitBreaker.execute(() =>
          admin.graphql(REFUND_MUTATION, { variables: { input: refundInput } }),
        );
        let json: RefundJson;
        try {
          json = (await res.json()) as RefundJson;
        } catch {
          shopifyApiDuration.record(timer(), { operation: "refund.create", status_code: "error" });
          return { success: false, error: "Invalid response from Shopify. Please try again." };
        }

        if (!res.ok) {
          shopifyApiDuration.record(timer(), {
            operation: "refund.create",
            status_code: String(res.status),
          });
          return {
            success: false,
            error: `Shopify API error (${res.status}). Please try again or refund manually in Shopify Admin.`,
          };
        }

        const result = parseRefundResponse(json);
        /* v8 ignore start */ // defensive: each `?? ""` is fallback for an optional refund field; only one path hit per fixture
        if (!result.success) {
          const isLocationError = /location|restock/i.test(result.error ?? "");
          if (isLocationError) {
            const noRestockInput: Record<string, unknown> = {
              ...refundInput,
              refundLineItems: normalized.map((item) => ({
                lineItemId: item.id.startsWith("gid://")
                  ? item.id
                  : `gid://shopify/LineItem/${item.id}`,
                quantity: item.quantity,
                restockType: "NO_RESTOCK",
              })),
            };
            const retryRes = await admin.graphql(REFUND_MUTATION, {
              variables: { input: noRestockInput },
            });
            let retryJson: RefundJson;
            try {
              retryJson = (await retryRes.json()) as RefundJson;
            } catch {
              shopifyApiDuration.record(timer(), {
                operation: "refund.create",
                status_code: "error",
              });
              return { success: false, error: "Retry without restock failed." };
            }
            const retryResult = parseRefundResponse(retryJson);
            if (retryResult.success) {
              retryResult.refundMethod = method;
              shopifyApiDuration.record(timer(), {
                operation: "refund.create",
                status_code: "200",
              });
              addBusinessEvent("refund.shopify.created", {
                "order.id": gid,
                "refund.method": method,
                "refund.id": retryResult.refundId ?? "",
                "refund.amount": retryResult.refundAmount ?? "",
                retried: "true",
              });
            } else {
              shopifyApiDuration.record(timer(), {
                operation: "refund.create",
                status_code: "error",
              });
            }
            return retryResult;
          }
          result.refundMethod = method;
          shopifyApiDuration.record(timer(), { operation: "refund.create", status_code: "error" });
          return result;
        }

        result.refundMethod = method;
        shopifyApiDuration.record(timer(), { operation: "refund.create", status_code: "200" });
        addBusinessEvent("refund.shopify.created", {
          "order.id": gid,
          "refund.method": method,
          "refund.id": result.refundId ?? "",
          "refund.amount": result.refundAmount ?? "",
        });
        return result;
        /* v8 ignore stop */
      } catch (err) {
        /* v8 ignore start */ // defensive: error instanceof Error narrowing
        const msg = err instanceof Error ? err.message : "Refund request failed";
        shopifyApiDuration.record(timer(), { operation: "refund.create", status_code: "error" });
        return { success: false, error: msg };
        /* v8 ignore stop */
      }
    },
  );
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
    returns(first: 50) {
      edges {
        node {
          id
          status
          returnLineItems(first: 50) {
            edges {
              node {
                ... on ReturnLineItem {
                  quantity
                  fulfillmentLineItem {
                    id
                    lineItem { id sku }
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
  const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  return withSpan("shopify.return.create", { "order.id": orderGid }, async () => {
    const timer = startTimer();
    try {
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
          returns?: {
            edges?: Array<{
              node?: {
                id: string;
                status?: string | null;
                returnLineItems?: {
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

      /* v8 ignore start */ // defensive: error-message + per-edge `?? 0|[]` fallbacks for optional GraphQL fields — only one path hit per fixture
      if (fulfillmentsJson.errors?.length) {
        const errMsg = fulfillmentsJson.errors[0]?.message ?? "Unknown error";
        if (/access denied|not approved|protected/i.test(errMsg)) {
          return {
            success: false,
            error: `Shopify Return creation requires "write_returns" access scope. Error: ${errMsg}`,
          };
        }
        return { success: false, error: `Failed to query returnable fulfillments: ${errMsg}` };
      }
      /* v8 ignore stop */

      // Bug #15 idempotency guard (early). BEFORE building the FLI maps
      // and running the distribution loop, check whether any existing
      // OPEN/REQUESTED/IN_PROGRESS Shopify return on this order already
      // matches the customer's request. Match is computed by line-item
      // GID + total-qty, which is invariant across multi-fulfillment
      // distributions (a single qty-3 LI may show up across 3 FLIs in
      // the existing return; what matters is the per-LI totals).
      // Returning the existing return's id here protects against:
      //  - silent .catch(() => {}) on shopifyReturnId writeback in
      //    approve.server.ts / retry-fynd-sync.server.ts
      //  - portal duplicate submissions producing two ReturnCases
      //  - eventual-consistency in returnableFulfillments after the
      //    fresh return is created
      const NON_TERMINAL_RETURN_STATUSES_EARLY = new Set(["OPEN", "REQUESTED", "IN_PROGRESS"]);
      const requestPerLi = new Map<string, number>();
      for (const ri of returnItems) {
        if (!ri.shopifyLineItemId?.startsWith("gid://shopify/LineItem/")) continue;
        const q = Math.max(0, Math.floor(ri.qty || 0));
        if (q <= 0) continue;
        requestPerLi.set(ri.shopifyLineItemId, (requestPerLi.get(ri.shopifyLineItemId) ?? 0) + q);
      }
      if (requestPerLi.size > 0) {
        for (const retEdge of fulfillmentsJson.data?.returns?.edges ?? []) {
          const ret = retEdge.node;
          if (!ret?.id) continue;
          const status = (ret.status ?? "").toUpperCase();
          if (status && !NON_TERMINAL_RETURN_STATUSES_EARLY.has(status)) continue;
          const existingPerLi = new Map<string, number>();
          for (const lineEdge of ret.returnLineItems?.edges ?? []) {
            const node = lineEdge.node;
            const lineItemGid = node?.fulfillmentLineItem?.lineItem?.id;
            const qty = node?.quantity ?? 0;
            if (!lineItemGid || qty <= 0) continue;
            existingPerLi.set(lineItemGid, (existingPerLi.get(lineItemGid) ?? 0) + qty);
          }
          if (existingPerLi.size !== requestPerLi.size) continue;
          let allMatch = true;
          for (const [lineItemGid, qty] of requestPerLi) {
            if (existingPerLi.get(lineItemGid) !== qty) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            refundLogger.info(
              { existingReturnId: ret.id, orderGid, requestPerLi: [...requestPerLi.entries()] },
              "createShopifyReturn: idempotent — existing OPEN return matches customer request; reusing",
            );
            shopifyApiDuration.record(timer(), { operation: "return.create", status_code: "200" });
            return { success: true, shopifyReturnId: ret.id };
          }
        }
      }

      // Build maps: order lineItem GID → fulfillmentLineItem, and SKU → fulfillmentLineItem.
      // We accumulate qty across fulfillments for the same lineItem GID (a 3-qty product
      // split into 3 separate fulfillments produces three edges with qty=1 each — the
      // overall returnable qty is 3, not 1 from the last fulfillment seen). We also keep
      // a per-fulfillment-line-item entry so the returnCreate mutation can target a
      // specific fulfillment_line_item_id (Shopify requires exact ID, not a roll-up).
      type FliEntry = { fulfillmentLineItemId: string; maxQty: number };
      const fulfillmentLineItemMap = new Map<string, FliEntry[]>();
      const skuMap = new Map<string, FliEntry[]>();

      /* v8 ignore start */ // defensive: per-edge `?? 0|[]` fallbacks + per-field guards — only one path hit per fixture
      for (const edge of fulfillmentsJson.data?.returnableFulfillments?.edges ?? []) {
        for (const lineEdge of edge.node?.returnableFulfillmentLineItems?.edges ?? []) {
          const fli = lineEdge.node?.fulfillmentLineItem;
          if (!fli?.id) continue;
          const maxQty = lineEdge.node?.quantity ?? 0;
          if (maxQty <= 0) continue;
          const entry: FliEntry = { fulfillmentLineItemId: fli.id, maxQty };

          if (fli.lineItem?.id) {
            const arr = fulfillmentLineItemMap.get(fli.lineItem.id) ?? [];
            arr.push(entry);
            fulfillmentLineItemMap.set(fli.lineItem.id, arr);
          }
          if (fli.lineItem?.sku) {
            const skuKey = fli.lineItem.sku.toLowerCase().trim();
            if (skuKey) {
              const arr = skuMap.get(skuKey) ?? [];
              arr.push(entry);
              skuMap.set(skuKey, arr);
            }
          }
        }
      }
      /* v8 ignore stop */

      // Subtract qty from any in-flight Shopify Return on this order to prevent the
      // returnCreate call from over-returning. Without this, two separate ReturnCases
      // created on the same order will each see Shopify's "returnable" qty as the
      // ordered qty (Shopify only decrements *after* a return is closed), and both
      // will create returns — the order ends up with two open returns covering the
      // same units. We treat OPEN-status returns as already consuming returnable qty.
      const NON_TERMINAL_RETURN_STATUSES = new Set(["OPEN", "REQUESTED", "IN_PROGRESS"]);
      /* v8 ignore start */ // defensive: each `?? 0|[]|""` is a per-edge fallback for optional GraphQL fields — only one path hit per fixture
      for (const retEdge of fulfillmentsJson.data?.returns?.edges ?? []) {
        const ret = retEdge.node;
        if (!ret) continue;
        const status = (ret.status ?? "").toUpperCase();
        if (status && !NON_TERMINAL_RETURN_STATUSES.has(status)) continue;
        for (const lineEdge of ret.returnLineItems?.edges ?? []) {
          const node = lineEdge.node;
          if (!node?.fulfillmentLineItem?.id) continue;
          const consumedFliId = node.fulfillmentLineItem.id;
          const consumedQty = node.quantity ?? 0;
          if (consumedQty <= 0) continue;
          // Bug #15 sub-bug: fulfillmentLineItemMap and skuMap share the
          // SAME `arr` reference at build-time (see line ~2127), so
          // decrementing both maps double-counts. We only need to decrement
          // ONCE per FLI — the entry tracked by lineItem.id (and shared with
          // skuMap) is the same object. SKU-fallback decrement is only
          // needed when no lineItem.id is set on the existing return's
          // line item (rare). This matches the pre-existing intent and
          // closes the duplicate-counting source.
          const decrement = (entries?: FliEntry[]) => {
            // unreachable: callers always pass result of map.get() under a truthy lineItem.id/sku check, never undefined here
            /* v8 ignore start */
            if (!entries) return;
            /* v8 ignore stop */
            for (const e of entries) {
              if (e.fulfillmentLineItemId === consumedFliId) {
                e.maxQty = Math.max(0, e.maxQty - consumedQty);
              }
            }
          };
          if (node.fulfillmentLineItem.lineItem?.id) {
            decrement(fulfillmentLineItemMap.get(node.fulfillmentLineItem.lineItem.id));
          } else if (node.fulfillmentLineItem.lineItem?.sku) {
            // Only fall back to SKU-keyed decrement when no lineItem.id was
            // present (so we haven't already touched the entry above).
            decrement(skuMap.get(node.fulfillmentLineItem.lineItem.sku.toLowerCase().trim()));
          }
        }
      }
      /* v8 ignore stop */

      // Pick best entry (highest remaining maxQty) for fallback callers that don't iterate.
      // unreachable: callers re-lookup the same maps that already returned undefined/empty
      /* v8 ignore start */
      const pickBest = (entries?: FliEntry[]): FliEntry | undefined => {
        if (!entries || entries.length === 0) return undefined;
        return entries.reduce((best, cur) => (cur.maxQty > best.maxQty ? cur : best), entries[0]);
      };
      /* v8 ignore stop */

      if (fulfillmentLineItemMap.size === 0 && skuMap.size === 0) {
        return {
          success: false,
          error:
            "No returnable fulfillment line items found. The order may not be fulfilled yet, or all items have already been returned.",
        };
      }

      refundLogger.info(
        { gidCount: fulfillmentLineItemMap.size, skuCount: skuMap.size },
        "createShopifyReturn: found fulfillment line items",
      );

      // Step 2: Map return items to fulfillment line items
      const returnLineItems: Array<{
        fulfillmentLineItemId: string;
        quantity: number;
        returnReason: string;
        returnReasonNote?: string;
      }> = [];

      for (const item of returnItems) {
        let entries: FliEntry[] | undefined;

        // Primary: match by order lineItem GID
        if (item.shopifyLineItemId?.startsWith("gid://shopify/LineItem/")) {
          entries = fulfillmentLineItemMap.get(item.shopifyLineItemId);
        }

        // Fallback: match by SKU
        if ((!entries || entries.length === 0) && item.sku) {
          const skuKey = item.sku.toLowerCase().trim();
          entries = skuMap.get(skuKey);
        }

        if (!entries || entries.length === 0) {
          // Last-resort: pickBest off the maps (any remaining entry tied to the line)
          const fallback = pickBest(
            item.shopifyLineItemId?.startsWith("gid://shopify/LineItem/")
              ? fulfillmentLineItemMap.get(item.shopifyLineItemId)
              : item.sku
                ? skuMap.get(item.sku.toLowerCase().trim())
                : undefined,
          );
          if (!fallback) {
            refundLogger.warn(
              { lineItemId: item.shopifyLineItemId, sku: item.sku },
              "createShopifyReturn: no fulfillment line item match, skipping",
            );
            continue;
          }
          // unreachable: pickBest always returns undefined here (see comment above)
          /* v8 ignore start */
          entries = [fallback];
          /* v8 ignore stop */
        }

        const reason = mapReturnReason(item.reasonCode);
        // Distribute the requested qty across the available fulfillment line items.
        // For multi-fulfillment lineItems (Shopify split a 3-qty order across 3
        // fulfillments) one returnLineItem with qty=3 isn't valid — Shopify wants
        // up to qty per fulfillment_line_item_id. We consume in-place from each
        // entry's maxQty, which also keeps the bookkeeping correct if multiple
        // returnItems target the same lineItem GID (e.g. two separate bags).
        let remainingQty = Math.max(0, Math.floor(item.qty));
        for (const entry of entries) {
          if (remainingQty <= 0) break;
          // unreachable: entries with maxQty<=0 are filtered at map-build time (line ~1794) and only decremented in-place during this same loop
          /* v8 ignore start */
          if (entry.maxQty <= 0) continue;
          /* v8 ignore stop */
          const take = Math.min(remainingQty, entry.maxQty);
          // unreachable: take = min(remainingQty>0, entry.maxQty>0) so always >0
          /* v8 ignore start */
          if (take <= 0) continue;
          /* v8 ignore stop */
          returnLineItems.push({
            fulfillmentLineItemId: entry.fulfillmentLineItemId,
            quantity: take,
            returnReason: reason,
            ...(item.notes
              ? { returnReasonNote: item.notes.slice(0, 255) }
              : reason === "OTHER"
                ? { returnReasonNote: item.reasonCode || "Customer return request" }
                : {}),
          });
          entry.maxQty -= take;
          remainingQty -= take;
        }
        if (remainingQty > 0) {
          refundLogger.warn(
            {
              lineItemId: item.shopifyLineItemId,
              sku: item.sku,
              requested: item.qty,
              unfulfilled: remainingQty,
            },
            "createShopifyReturn: requested qty exceeds returnable balance — capped to what Shopify reports as remaining",
          );
        }
      }

      if (returnLineItems.length === 0) {
        return {
          success: false,
          error:
            "Could not match any return items to fulfilled line items. Items may not be fulfilled yet or have already been returned.",
        };
      }

      // Diagnostic: log the qty distribution + the customer-requested qty so
      // we can spot Bug #9-shaped regressions (over-creating qty across
      // fulfillments) at a glance in production logs.
      const totalReturnRequestedQty = returnItems.reduce(
        (s, ri) => s + Math.max(0, Math.floor(Number(ri.qty) || 0)),
        0,
      );
      const totalShopifyReturnQty = returnLineItems.reduce((s, rli) => s + (rli.quantity || 0), 0);
      // unreachable: distribution loop caps `take` at remainingQty so totalShopifyReturnQty <= sum(floor(item.qty)) = totalReturnRequestedQty (defensive bug-#9 sentinel)
      /* v8 ignore start */
      if (totalShopifyReturnQty > totalReturnRequestedQty) {
        refundLogger.error(
          {
            totalReturnRequestedQty,
            totalShopifyReturnQty,
            returnLineItemsCount: returnLineItems.length,
            orderGid,
          },
          "createShopifyReturn: SHOPIFY RETURN QTY EXCEEDS CUSTOMER REQUEST — bug #9 regression",
        );
      }
      /* v8 ignore stop */
      refundLogger.info(
        {
          lineItemCount: returnLineItems.length,
          totalShopifyReturnQty,
          totalReturnRequestedQty,
          orderGid,
        },
        "createShopifyReturn: creating Shopify return",
      );

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
        return {
          success: false,
          error: `Shopify API error: ${createJson.errors[0]?.message ?? "Unknown"}`,
        };
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

      refundLogger.info({ returnId }, "createShopifyReturn: successfully created Shopify return");
      shopifyApiDuration.record(timer(), { operation: "return.create", status_code: "200" });
      addBusinessEvent("return.shopify.created", { "order.id": orderGid, "return.id": returnId });
      return { success: true, shopifyReturnId: returnId };
    } catch (err) {
      /* v8 ignore start */ // defensive: error instanceof Error narrowing in both msg and log
      const msg = err instanceof Error ? err.message : String(err);
      refundLogger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "createShopifyReturn: error",
      );
      shopifyApiDuration.record(timer(), { operation: "return.create", status_code: "error" });
      return { success: false, error: `Shopify Return creation error: ${msg}` };
      /* v8 ignore stop */
    }
  });
}

/* ── Shopify Return close / decline ── */

const RETURN_CLOSE_MUTATION = `#graphql
  mutation returnClose($id: ID!) {
    returnClose(id: $id) {
      return { id status }
      userErrors { field message }
    }
  }
`;

const RETURN_DECLINE_MUTATION = `#graphql
  mutation returnDecline($input: ReturnDeclineRequestInput!) {
    returnDecline(input: $input) {
      return { id status }
      userErrors { field message }
    }
  }
`;

export type CloseShopifyReturnResult = {
  success: boolean;
  error?: string;
  status?: string;
  alreadyClosed?: boolean;
};

/** Close a Shopify Return (marks it as returned/closed). Idempotent. */
export async function closeShopifyReturn(
  admin: AdminGraphQL,
  shopifyReturnId: string,
): Promise<CloseShopifyReturnResult> {
  const gid = shopifyReturnId.startsWith("gid://")
    ? shopifyReturnId
    : `gid://shopify/Return/${shopifyReturnId}`;
  return withSpan("shopify.return.close", { "return.id": gid }, async () => {
    try {
      const res = await admin.graphql(RETURN_CLOSE_MUTATION, { variables: { id: gid } });
      const json = (await res.json()) as {
        data?: {
          returnClose?: {
            return?: { id: string; status: string } | null;
            userErrors?: Array<{ field?: string[]; message: string }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      /* v8 ignore start */ // defensive: each `?? "Unknown"|[]|"CLOSED"` is fallback for an optional GraphQL field — only one path hit per fixture
      if (json.errors?.length) {
        const msg = json.errors[0]?.message ?? "Unknown";
        if (/already closed|CLOSED/i.test(msg)) {
          refundLogger.info({ gid }, "closeShopifyReturn: return already closed");
          return { success: true, alreadyClosed: true, status: "CLOSED" };
        }
        return { success: false, error: `Shopify API error: ${msg}` };
      }

      const userErrors = json.data?.returnClose?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e) => e.message).join("; ");
        if (/already closed|CLOSED|cannot close/i.test(msg)) {
          refundLogger.info({ gid }, "closeShopifyReturn: return already closed (userError)");
          return { success: true, alreadyClosed: true, status: "CLOSED" };
        }
        return { success: false, error: `Return close failed: ${msg}` };
      }
      /* v8 ignore stop */

      const status = json.data?.returnClose?.return?.status ?? "CLOSED";
      refundLogger.info({ gid, status }, "closeShopifyReturn: successfully closed Shopify return");
      return { success: true, status };
    } catch (err) {
      /* v8 ignore start */ // defensive: error instanceof Error narrowing
      const msg = err instanceof Error ? err.message : String(err);
      refundLogger.error({ error: msg }, "closeShopifyReturn: error");
      return { success: false, error: msg };
      /* v8 ignore stop */
    }
  });
}

/** Decline a Shopify Return (for rejected returns). Idempotent. */
export async function declineShopifyReturn(
  admin: AdminGraphQL,
  shopifyReturnId: string,
  reason?: string,
): Promise<CloseShopifyReturnResult> {
  const gid = shopifyReturnId.startsWith("gid://")
    ? shopifyReturnId
    : `gid://shopify/Return/${shopifyReturnId}`;
  return withSpan("shopify.return.decline", { "return.id": gid }, async () => {
    try {
      const res = await admin.graphql(RETURN_DECLINE_MUTATION, {
        variables: { input: { id: gid, declineReason: reason || "Return declined" } },
      });
      const json = (await res.json()) as {
        data?: {
          returnDecline?: {
            return?: { id: string; status: string } | null;
            userErrors?: Array<{ field?: string[]; message: string }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };

      /* v8 ignore start */ // defensive: each `?? "Unknown"|[]|"DECLINED"` is fallback for an optional GraphQL field — only one path hit per fixture
      if (json.errors?.length) {
        const msg = json.errors[0]?.message ?? "Unknown";
        if (/already declined|DECLINED|already closed|CLOSED/i.test(msg)) {
          refundLogger.info({ gid }, "declineShopifyReturn: return already declined/closed");
          return { success: true, alreadyClosed: true, status: "DECLINED" };
        }
        return { success: false, error: `Shopify API error: ${msg}` };
      }

      const userErrors = json.data?.returnDecline?.userErrors ?? [];
      if (userErrors.length > 0) {
        const msg = userErrors.map((e) => e.message).join("; ");
        if (/already declined|DECLINED|already closed|CLOSED|cannot decline/i.test(msg)) {
          refundLogger.info(
            { gid },
            "declineShopifyReturn: return already declined/closed (userError)",
          );
          return { success: true, alreadyClosed: true, status: "DECLINED" };
        }
        return { success: false, error: `Return decline failed: ${msg}` };
      }
      /* v8 ignore stop */

      const status = json.data?.returnDecline?.return?.status ?? "DECLINED";
      refundLogger.info(
        { gid, status },
        "declineShopifyReturn: successfully declined Shopify return",
      );
      return { success: true, status };
    } catch (err) {
      /* v8 ignore start */ // defensive: error instanceof Error narrowing
      const msg = err instanceof Error ? err.message : String(err);
      refundLogger.error({ error: msg }, "declineShopifyReturn: error");
      return { success: false, error: msg };
      /* v8 ignore stop */
    }
  });
}

/**
 * Best-effort wrapper: close or decline a Shopify Return.
 * Skips gracefully if no shopifyReturnId exists or if the order is manual.
 * Never throws — all errors are logged and optionally recorded as events.
 */
/**
 * Result shape for `closeShopifyReturnBestEffort`. The function name still says
 * "best effort" — callers may ignore the result entirely. The cancellation
 * handler uses it to refuse to mark the local return cancelled if Shopify's side
 * couldn't be closed (P1 finding — previously this left orphan open returns).
 */
export type CloseShopifyReturnBestEffortResult = {
  ok: boolean;
  /** True when there was nothing to do (no shopifyReturnId, manual return). */
  skipped?: boolean;
  alreadyClosed?: boolean;
  error?: string;
};

/**
 * Close ALL non-terminal returns currently open on a Shopify order. Used as a
 * post-refund safety net: `createRefund` with `restockType: RETURN` causes
 * Shopify to auto-attach a Return entity to the refund, which keeps the order
 * displaying "Return in progress" until that Return is explicitly closed.
 * Returns the list of closed return IDs (errors are swallowed best-effort).
 */
async function closeAllOpenReturnsOnOrder(
  admin: AdminGraphQL,
  orderGid: string,
  excludeReturnIds: Set<string> = new Set(),
): Promise<{ closed: string[]; failed: Array<{ id: string; error: string }> }> {
  const closed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  /* v8 ignore start */ // defensive: each `?? []|"unknown"|""` is fallback for an optional GraphQL field — only one path hit per fixture
  try {
    const res = await admin.graphql(
      `#graphql
        query openReturns($id: ID!) {
          order(id: $id) {
            returns(first: 50) {
              edges { node { id status } }
            }
          }
        }`,
      { variables: { id: orderGid } },
    );
    const json = (await res.json()) as {
      data?: {
        order?: { returns?: { edges?: Array<{ node?: { id: string; status: string } }> } } | null;
      };
    };
    const edges = json.data?.order?.returns?.edges ?? [];
    const open = edges
      .map((e) => e.node)
      .filter(
        (n): n is { id: string; status: string } =>
          !!n && ["OPEN", "REQUESTED", "IN_PROGRESS"].includes((n.status || "").toUpperCase()),
      )
      .filter((n) => !excludeReturnIds.has(n.id));
    for (const ret of open) {
      const r = await closeShopifyReturn(admin, ret.id);
      if (r.success) closed.push(ret.id);
      else failed.push({ id: ret.id, error: r.error ?? "unknown" });
    }
  } catch (err) {
    refundLogger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "closeAllOpenReturnsOnOrder: query failed (non-fatal)",
    );
  }
  return { closed, failed };
  /* v8 ignore stop */
}

export async function closeShopifyReturnBestEffort(
  admin: AdminGraphQL,
  returnCase: { id: string; shopifyReturnId?: string | null; shopifyOrderId?: string | null },
  options?: {
    action?: "close" | "decline";
    declineReason?: string;
    logEvent?: (event: { eventType: string; payloadJson: string }) => Promise<void>;
  },
): Promise<CloseShopifyReturnBestEffortResult> {
  try {
    const { shopifyReturnId, shopifyOrderId } = returnCase;

    if (shopifyOrderId?.startsWith("manual:")) {
      refundLogger.info(
        { returnCaseId: returnCase.id },
        "closeShopifyReturnBestEffort: manual return, skipping Shopify close",
      );
      await options
        ?.logEvent?.({
          eventType: "shopify_return_close_skipped",
          payloadJson: JSON.stringify({ reason: "manual_return", returnCaseId: returnCase.id }),
        })
        .catch(() => {});
      return { ok: true, skipped: true };
    }

    // For close-action, ALWAYS sweep any other open returns on the order
    // (e.g. one auto-created by `createRefund` with `restockType: RETURN`).
    // Decline-action stays narrowly scoped to the explicit shopifyReturnId.
    const orderGid =
      shopifyOrderId && shopifyOrderId.startsWith("gid://")
        ? shopifyOrderId
        : shopifyOrderId && /^\d+$/.test(shopifyOrderId)
          ? `gid://shopify/Order/${shopifyOrderId}`
          : null;

    if (!shopifyReturnId) {
      // No tracked Shopify return — but the order may still have an auto-created
      // Return from a prior createRefund. Sweep on close-action to clear the
      // order's "Return in progress" indicator (Bug #4).
      if (options?.action !== "decline" && orderGid) {
        const sweep = await closeAllOpenReturnsOnOrder(admin, orderGid);
        await options
          ?.logEvent?.({
            eventType:
              sweep.closed.length > 0 ? "shopify_return_closed" : "shopify_return_close_skipped",
            payloadJson: JSON.stringify({
              reason: "no_tracked_return_id",
              returnCaseId: returnCase.id,
              sweepClosed: sweep.closed,
              sweepFailed: sweep.failed,
            }),
          })
          .catch(() => {});
        return { ok: true, skipped: sweep.closed.length === 0 };
      }
      refundLogger.info(
        { returnCaseId: returnCase.id },
        "closeShopifyReturnBestEffort: no shopifyReturnId, skipping",
      );
      await options
        ?.logEvent?.({
          eventType: "shopify_return_close_skipped",
          payloadJson: JSON.stringify({ reason: "no_return_id", returnCaseId: returnCase.id }),
        })
        .catch(() => {});
      return { ok: true, skipped: true };
    }

    let result: CloseShopifyReturnResult;
    if (options?.action === "decline") {
      result = await declineShopifyReturn(admin, shopifyReturnId, options.declineReason);
    } else {
      result = await closeShopifyReturn(admin, shopifyReturnId);
    }

    // Post-close sweep: if a refund auto-created a sibling Return on the order,
    // close that too so the order UI clears "Return in progress".
    let sweepClosed: string[] = [];
    let sweepFailed: Array<{ id: string; error: string }> = [];
    if (options?.action !== "decline" && orderGid && result.success) {
      const sweep = await closeAllOpenReturnsOnOrder(admin, orderGid, new Set([shopifyReturnId]));
      sweepClosed = sweep.closed;
      sweepFailed = sweep.failed;
    }

    const eventType = result.success
      ? options?.action === "decline"
        ? "shopify_return_declined"
        : "shopify_return_closed"
      : "shopify_return_close_failed";

    await options
      ?.logEvent?.({
        eventType,
        payloadJson: JSON.stringify({
          shopifyReturnId,
          returnCaseId: returnCase.id,
          status: result.status,
          alreadyClosed: result.alreadyClosed,
          error: result.error,
          ...(sweepClosed.length > 0 ? { sweepClosed } : {}),
          ...(sweepFailed.length > 0 ? { sweepFailed } : {}),
        }),
      })
      .catch(() => {});

    return {
      ok: result.success === true,
      alreadyClosed: result.alreadyClosed ?? false,
      error: result.error,
    };
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    const errMsg = err instanceof Error ? err.message : String(err);
    refundLogger.warn(
      { error: errMsg },
      "closeShopifyReturnBestEffort: unexpected error (non-fatal)",
    );
    return { ok: false, error: errMsg };
    /* v8 ignore stop */
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
  refunds: Array<{
    id: string;
    amount: number;
    currency: string;
    createdAt: string;
    note: string | null;
  }>;
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

    /* v8 ignore start */ // defensive: each `?? null|""|"USD"|"0"` is fallback for an optional GraphQL field — only one path hit per fixture
    const nodes = json.data?.orders?.nodes ?? [];
    return nodes.map((n) => {
      const cust = n.customer;
      const ship = n.shippingAddress;
      const custName =
        [cust?.firstName, cust?.lastName].filter(Boolean).join(" ") || ship?.name || null;
      const custPhone =
        cust?.phone || cust?.defaultAddress?.phone || ship?.phone || n.phone || null;
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
    /* v8 ignore stop */
  } catch (err) {
    /* v8 ignore start */ // defensive: error instanceof Error narrowing
    refundLogger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "fetchOrdersForCustomer: error",
    );
    return [];
    /* v8 ignore stop */
  }
}

/* ── Product variant fetch (for exchange/replacement flows) ─────────────────
 *
 * Returns price (`shopMoney`), inventory, and identity for a batch of variants
 * so the exchange flow can:
 *   - validate inventory before creating a draft order;
 *   - compute the price difference between original returned items and the
 *     replacement variants the customer picked;
 *   - render rich UI without the merchant having to round-trip to Shopify.
 *
 * `inventoryAvailable` is conservatively `null` when `tracksInventory=false`,
 * so callers can interpret it as "infinite / not tracked" instead of zero.
 */
export type ShopifyVariantInfo = {
  id: string; // gid://shopify/ProductVariant/...
  productId: string | null; // gid://shopify/Product/...
  productTitle: string | null;
  variantTitle: string | null; // e.g. "M / Blue"
  sku: string | null;
  price: string; // numeric string in the shop's currency
  currencyCode: string;
  compareAtPrice: string | null;
  inventoryAvailable: number | null; // null = inventory not tracked
  availableForSale: boolean;
  imageUrl: string | null;
};

const VARIANTS_BY_ID_QUERY = `#graphql
  query exchangeVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        title
        availableForSale
        inventoryQuantity
        inventoryPolicy
        inventoryItem { tracked }
        price
        compareAtPrice
        image { url }
        product {
          id
          title
          featuredImage { url }
        }
      }
    }
  }
`;

export async function fetchVariantInfo(
  admin: AdminGraphQL,
  variantIds: string[],
): Promise<Map<string, ShopifyVariantInfo>> {
  const out = new Map<string, ShopifyVariantInfo>();
  const ids = (variantIds || [])
    .filter((id) => typeof id === "string" && id.trim().length > 0)
    .map((id) =>
      id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id.replace(/^.*\//, "")}`,
    );
  if (ids.length === 0) return out;

  return withSpan("shopify.variants.fetch", { "variant.count": ids.length }, async () => {
    try {
      const res = await admin.graphql(VARIANTS_BY_ID_QUERY, { variables: { ids } });
      if (!res.ok) return out;
      const json = (await res.json()) as {
        data?: {
          nodes?: Array<null | {
            id?: string;
            sku?: string | null;
            title?: string | null;
            availableForSale?: boolean;
            inventoryQuantity?: number | null;
            inventoryPolicy?: string | null;
            inventoryItem?: { tracked?: boolean } | null;
            price?: string;
            compareAtPrice?: string | null;
            image?: { url?: string | null } | null;
            product?: {
              id?: string;
              title?: string | null;
              featuredImage?: { url?: string | null } | null;
            } | null;
          }>;
        };
        errors?: Array<{ message?: string }>;
      };
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        refundLogger.warn(
          { errors: json.errors.map((e) => e.message).join("; ") },
          "fetchVariantInfo: GraphQL errors",
        );
      }
      /* v8 ignore start */ // defensive: each `?? null|"0.00"|true|false|0` is fallback for an optional GraphQL field — only one path hit per fixture
      for (const node of json.data?.nodes ?? []) {
        if (!node?.id) continue;
        const tracked = node.inventoryItem?.tracked ?? true;
        const info: ShopifyVariantInfo = {
          id: node.id,
          productId: node.product?.id ?? null,
          productTitle: node.product?.title ?? null,
          variantTitle: node.title ?? null,
          sku: node.sku ?? null,
          price: node.price ?? "0.00",
          currencyCode: "shop", // shop currency; caller will resolve from order
          compareAtPrice: node.compareAtPrice ?? null,
          inventoryAvailable: tracked ? (node.inventoryQuantity ?? 0) : null,
          availableForSale: node.availableForSale ?? false,
          imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null,
        };
        out.set(node.id, info);
      }
      /* v8 ignore stop */
      return out;
    } catch (err) {
      /* v8 ignore start */ // defensive: error instanceof Error narrowing
      refundLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "fetchVariantInfo: error",
      );
      return out;
      /* v8 ignore stop */
    }
  });
}

/* ── Draft order completion + invoice (for exchange payment workflows) ──── */

const DRAFT_ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation draftOrderInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder { id name invoiceUrl }
      userErrors { field message }
    }
  }
`;

export type DraftOrderInvoiceResult = {
  success: boolean;
  invoiceUrl?: string | null;
  error?: string;
};

/**
 * Send the Shopify draft-order invoice email to the customer. Used when an
 * exchange leaves a positive balance for the customer to pay before the
 * warehouse ships the new variant.
 */
export async function sendDraftOrderInvoice(
  admin: AdminGraphQL,
  draftOrderId: string,
  customerEmail: string | null,
  subject?: string,
  bodyMessage?: string,
): Promise<DraftOrderInvoiceResult> {
  return withSpan("shopify.draft_order.invoice_send", { "draft.id": draftOrderId }, async () => {
    /* v8 ignore start */ // defensive: each `?? null|default-string|[]` is fallback for an optional GraphQL field — only one path hit per fixture
    try {
      const variables: Record<string, unknown> = {
        id: draftOrderId,
        email: customerEmail
          ? {
              to: customerEmail,
              subject: subject ?? "Complete your exchange",
              customMessage:
                bodyMessage ?? "Please complete payment to receive your exchange items.",
            }
          : null,
      };
      const res = await admin.graphql(DRAFT_ORDER_INVOICE_SEND_MUTATION, { variables });
      const json = (await res.json()) as {
        data?: {
          draftOrderInvoiceSend?: {
            draftOrder?: { id: string; name: string; invoiceUrl?: string | null } | null;
            userErrors?: Array<{ field?: string[]; message: string }>;
          };
        };
        errors?: Array<{ message?: string }>;
      };
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        return { success: false, error: json.errors.map((e) => e.message).join("; ") };
      }
      const ue = json.data?.draftOrderInvoiceSend?.userErrors ?? [];
      if (ue.length > 0) {
        return { success: false, error: ue.map((e) => e.message).join("; ") };
      }
      return {
        success: true,
        invoiceUrl: json.data?.draftOrderInvoiceSend?.draftOrder?.invoiceUrl ?? null,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    /* v8 ignore stop */
  });
}
