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

// Cap upstream Shopify Admin REST calls so a hung backend doesn't pin the
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
      // Fetch specific product variants (for same-product exchange)
      const response = await fetchWithTimeout(
        `https://${shop.shopDomain}/admin/api/2024-10/products/${productId.replace("gid://shopify/Product/", "")}.json?fields=id,title,handle,product_type,vendor,images,variants`,
        {
          headers: {
            "X-Shopify-Access-Token": session.accessToken,
            "Content-Type": "application/json",
          },
        },
      );

      if (response.ok) {
        const data = await response.json();
        const p = data.product;
        if (p) {
          products = [mapProduct(p)];
        }
      }
    } else {
      // Search/browse products
      const queryParts: string[] = [];
      if (search) queryParts.push(search);
      if (productType) queryParts.push(`product_type:${productType}`);

      const searchQuery = queryParts.length > 0 ? queryParts.join(" ") : "";
      const endpoint = searchQuery
        ? `https://${shop.shopDomain}/admin/api/2024-10/products.json?limit=${limit}&fields=id,title,handle,product_type,vendor,images,variants&title=${encodeURIComponent(search)}`
        : `https://${shop.shopDomain}/admin/api/2024-10/products.json?limit=${limit}&fields=id,title,handle,product_type,vendor,images,variants`;

      const response = await fetchWithTimeout(endpoint, {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        // defensive: data.products always present in 200 response; [] fallback unreachable
        /* v8 ignore start */
        products = (data.products || []).map(mapProduct);
        /* v8 ignore stop */
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

function mapProduct(p: {
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
    image_id: number | null;
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
      available: v.inventory_quantity > 0 || v.inventory_quantity === -1, // -1 = inventory not tracked
      sku: v.sku,
      imageUrl: mainImage, // simplified: use main product image
      options: [
        v.option1 ? { name: "Option 1", value: v.option1 } : null,
        v.option2 ? { name: "Option 2", value: v.option2 } : null,
        v.option3 ? { name: "Option 3", value: v.option3 } : null,
      ].filter((o): o is { name: string; value: string } => o !== null),
    })),
  };
}
