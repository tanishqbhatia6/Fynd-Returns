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
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";

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
  // Rate limit FIRST — was previously absent, allowing catalog enumeration. The
  // exchange variant picker on the customer portal calls this 1-2 times per item;
  // 60/min is plenty for legitimate flows.
  const rl = await checkRateLimit(request, "portal.products");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop") || "";
  const productId = url.searchParams.get("productId") || "";
  const search = url.searchParams.get("search") || "";
  const productType = url.searchParams.get("productType") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10), 50);

  if (!shopDomain) {
    return Response.json({ error: "Missing shop parameter" }, { status: 400 });
  }

  // Verify shop exists and has portal exchange enabled
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com` },
    include: { settings: true },
  });

  if (!shop?.settings?.portalExchangeEnabled) {
    return Response.json({ error: "Exchange not enabled" }, { status: 403 });
  }

  // Get admin session for this shop
  const session = await prisma.session.findFirst({
    where: { shop: shop.shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });

  if (!session?.accessToken) {
    return Response.json({ error: "Shop not authenticated" }, { status: 401 });
  }

  try {
    let products: PortalProduct[] = [];

    if (productId) {
      // Fetch specific product variants (for same-product exchange)
      const response = await fetch(
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

      const response = await fetch(endpoint, {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        products = (data.products || []).map(mapProduct);
      }
    }

    // Filter to only show products with available variants
    const availableProducts = products.map(p => ({
      ...p,
      variants: p.variants.filter(v => v.available),
    })).filter(p => p.variants.length > 0);

    return Response.json({ products: availableProducts });
  } catch (err) {
    console.error("Portal products API error:", err);
    return Response.json({ error: "Failed to fetch products" }, { status: 500 });
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
    variants: (p.variants || []).map(v => ({
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
