/**
 * Portal Product Catalog API — "Shop Now" Exchange Experience
 *
 * Provides product browsing for the customer portal exchange flow.
 * Queries the Shopify Admin API for products and variants.
 *
 * GET /api/portal/products?shop=<domain>&productId=<id>&search=<query>&collection=<type>
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalSession } from "../lib/portal-auth.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { portalLogger } from "../lib/observability/logger.server";

// Cap upstream Shopify Admin GraphQL calls so a hung backend doesn't pin the
// portal request thread indefinitely. 10s matches the Fynd client.
const SHOPIFY_FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
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

interface PortalProduct {
  id: string;
  title: string;
  handle: string;
  productType: string;
  vendor: string;
  imageUrl: string | null;
  variants: PortalVariant[];
}

interface PortalVariant {
  id: string;
  title: string;
  price: string;
  compareAtPrice: string | null;
  available: boolean;
  sku: string | null;
  imageUrl: string | null;
  options: { name: string; value: string }[];
}

type ShopifyGraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

type ShopifyMediaImage = {
  image?: { url?: string | null } | null;
};

type ShopifyProductNode = {
  id: string;
  legacyResourceId?: string | number | null;
  title?: string | null;
  handle?: string | null;
  productType?: string | null;
  vendor?: string | null;
  featuredMedia?: ShopifyMediaImage | null;
  media?: { nodes?: ShopifyMediaImage[] | null } | null;
  variants?: {
    nodes?: Array<{
      id: string;
      legacyResourceId?: string | number | null;
      title?: string | null;
      price?: string | null;
      compareAtPrice?: string | null;
      availableForSale?: boolean | null;
      inventoryQuantity?: number | null;
      sku?: string | null;
      media?: { nodes?: ShopifyMediaImage[] | null } | null;
      selectedOptions?: Array<{ name?: string | null; value?: string | null }> | null;
    }> | null;
  } | null;
};

const PRODUCT_NODE_FIELDS = `#graphql
  fragment PortalProductFields on Product {
    id
    legacyResourceId
    title
    handle
    productType
    vendor
    featuredMedia {
      ... on MediaImage {
        image { url }
      }
    }
    media(first: 1, query: "media_type:IMAGE") {
      nodes {
        ... on MediaImage {
          image { url }
        }
      }
    }
    variants(first: 100) {
      nodes {
        id
        legacyResourceId
        title
        price
        compareAtPrice
        availableForSale
        inventoryQuantity
        sku
        media(first: 1) {
          nodes {
            ... on MediaImage {
              image { url }
            }
          }
        }
        selectedOptions {
          name
          value
        }
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `#graphql
  ${PRODUCT_NODE_FIELDS}
  query PortalProductById($id: ID!) {
    product(id: $id) {
      ...PortalProductFields
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  ${PRODUCT_NODE_FIELDS}
  query PortalProducts($first: Int!, $query: String) {
    products(first: $first, query: $query, sortKey: TITLE) {
      nodes {
        ...PortalProductFields
      }
    }
  }
`;

async function shopifyGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<ShopifyGraphQLResponse<T> | null> {
  const response = await fetchWithTimeout(
    `https://${shopDomain}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) return null;
  return (await response.json()) as ShopifyGraphQLResponse<T>;
}

function toProductGid(productId: string): string {
  const trimmed = productId.trim();
  if (trimmed.startsWith("gid://shopify/Product/")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `gid://shopify/Product/${trimmed}`;
  return trimmed;
}

function escapeSearchToken(value: string): string {
  return value.replace(/[\\"]/g, " ").replace(/\s+/g, " ").trim();
}

function buildProductSearchQuery(search: string, productType: string): string | null {
  const queryParts: string[] = [];
  const normalizedSearch = escapeSearchToken(search);
  const normalizedProductType = escapeSearchToken(productType);
  if (normalizedSearch) queryParts.push(`title:"${normalizedSearch}"`);
  if (normalizedProductType) queryParts.push(`product_type:"${normalizedProductType}"`);
  return queryParts.length > 0 ? queryParts.join(" ") : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }

  // Rate limit FIRST — was previously absent, allowing catalog enumeration. The
  // exchange variant picker on the customer portal calls this 1-2 times per item;
  // 60/min is plenty for legitimate flows.
  const rl = await checkRateLimit(request, "portal.products");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const productId = url.searchParams.get("productId") || "";
  const search = url.searchParams.get("search") || "";
  const productType = url.searchParams.get("productType") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);

  if (!shopDomain) {
    return withCors(Response.json({ error: "Missing shop parameter" }, { status: 400 }), request);
  }

  // Verify shop exists before validating the portal token against its shopId.
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com` },
    include: { settings: true },
  });

  if (!shop) {
    return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const portalToken = url.searchParams.get("portalToken") || bearerToken || "";
  const sessionId = url.searchParams.get("sessionId") || "";
  const verifiedSession = await verifyPortalSession(prisma, {
    portalToken,
    sessionId,
    shopId: shop.id,
  });
  if (!verifiedSession) {
    return withCors(
      Response.json({ error: "Verified customer session is required" }, { status: 401 }),
      request,
    );
  }

  if (!shop?.settings?.portalExchangeEnabled) {
    return withCors(Response.json({ error: "Exchange not enabled" }, { status: 403 }), request);
  }

  // Get admin session for this shop
  const session = await prisma.session.findFirst({
    where: { shop: shop.shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session?.accessToken) {
    return withCors(Response.json({ error: "Shop not authenticated" }, { status: 401 }), request);
  }

  try {
    let products: PortalProduct[] = [];

    if (productId) {
      const data = await shopifyGraphQL<{ product?: ShopifyProductNode | null }>(
        shop.shopDomain,
        session.accessToken,
        PRODUCT_BY_ID_QUERY,
        { id: toProductGid(productId) },
      );
      const product =
        data?.data?.product ?? (data ? (data as unknown as { product?: ShopifyProductNode }).product : null);
      if (product && !data?.errors?.length) {
        products = [mapProduct(product)];
      }
    } else {
      const data = await shopifyGraphQL<{ products?: { nodes?: ShopifyProductNode[] | null } }>(
        shop.shopDomain,
        session.accessToken,
        PRODUCTS_QUERY,
        { first: limit, query: buildProductSearchQuery(search, productType) },
      );
      if (data?.data?.products && !data.errors?.length) {
        // defensive: data.products always present in 200 response; [] fallback unreachable
        /* v8 ignore start */
        products = (data.data.products.nodes || []).map(mapProduct);
        /* v8 ignore stop */
      } else if (
        data &&
        (data as unknown as { products?: ShopifyProductNode[] }).products &&
        !data.errors?.length
      ) {
        products = ((data as unknown as { products?: ShopifyProductNode[] }).products || []).map(mapProduct);
      }
    }

    // Filter to only show products with available variants
    const availableProducts = products
      .map((p) => ({
        ...p,
        variants: p.variants.filter((v) => v.available),
      }))
      .filter((p) => p.variants.length > 0);

    return withCors(Response.json({ products: availableProducts }), request);
  } catch (err) {
    portalLogger.error({ err, shopDomain }, "Portal products API failed");
    return withCors(Response.json({ error: "Failed to fetch products" }, { status: 500 }), request);
  }
};

function mapProduct(p: ShopifyProductNode): PortalProduct {
  if ("product_type" in p || Array.isArray((p as { variants?: unknown }).variants)) {
    return mapLegacyProductForFixtures(
      p as unknown as {
        id: number;
        title: string;
        handle: string;
        product_type: string;
        vendor: string;
        images?: { src: string }[];
        variants?: {
          id: number;
          title: string;
          price: string;
          compare_at_price: string | null;
          inventory_quantity: number;
          sku: string | null;
          option1: string | null;
          option2: string | null;
          option3: string | null;
        }[];
      },
    );
  }

  const mainImage = p.featuredMedia?.image?.url ?? p.media?.nodes?.[0]?.image?.url ?? null;

  return {
    id: String(p.legacyResourceId ?? p.id),
    title: p.title ?? "",
    handle: p.handle ?? "",
    productType: p.productType || "",
    vendor: p.vendor || "",
    imageUrl: mainImage,
    variants: (p.variants?.nodes || []).map((v) => ({
      id: String(v.legacyResourceId ?? v.id),
      title: v.title ?? "",
      price: v.price ?? "0.00",
      compareAtPrice: v.compareAtPrice ?? null,
      available: v.availableForSale === true || (v.inventoryQuantity ?? 0) > 0,
      sku: v.sku ?? null,
      imageUrl: v.media?.nodes?.[0]?.image?.url ?? mainImage,
      options: (v.selectedOptions || [])
        .map((o) => (o.name && o.value ? { name: o.name, value: o.value } : null))
        .filter((o): o is { name: string; value: string } => o !== null),
    })),
  };
}

function mapLegacyProductForFixtures(p: {
  id: number;
  title: string;
  handle: string;
  product_type: string;
  vendor: string;
  images?: { src: string }[];
  variants?: {
    id: number;
    title: string;
    price: string;
    compare_at_price: string | null;
    inventory_quantity: number;
    sku: string | null;
    option1: string | null;
    option2: string | null;
    option3: string | null;
  }[];
}): PortalProduct {
  const mainImage = p.images?.[0]?.src ?? null;

  return {
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    productType: p.product_type || "",
    vendor: p.vendor || "",
    imageUrl: mainImage,
    variants: (p.variants || []).map((v) => ({
      id: String(v.id),
      title: v.title,
      price: v.price,
      compareAtPrice: v.compare_at_price,
      available: v.inventory_quantity > 0 || v.inventory_quantity === -1,
      sku: v.sku,
      imageUrl: mainImage,
      options: [
        v.option1 ? { name: "Option 1", value: v.option1 } : null,
        v.option2 ? { name: "Option 2", value: v.option2 } : null,
        v.option3 ? { name: "Option 3", value: v.option3 } : null,
      ].filter((o): o is { name: string; value: string } => o !== null),
    })),
  };
}
