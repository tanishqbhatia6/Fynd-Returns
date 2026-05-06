/**
 * Data Viewer API: GET /api/admin/return-items-data/:id
 *
 * Returns all Fynd metadata for a return's items, plus live Fynd data
 * for comparison. Highlights missing fields.
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createFyndClientOrError, type FyndPlatformClient } from "../lib/fynd.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id!;

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const returnCase = await prisma.returnCase.findFirst({
    where: { id, shopId: shop.id },
    include: { items: true },
  });
  if (!returnCase) return Response.json({ error: "Return not found" }, { status: 404 });

  // Build items response with all Fynd metadata
  const items = returnCase.items.map((item) => ({
    id: item.id,
    shopifyLineItemId: item.shopifyLineItemId,
    title: item.title,
    variantTitle: item.variantTitle,
    sku: item.sku,
    price: item.price,
    qty: item.qty,
    reasonCode: item.reasonCode,
    fyndShipmentId: item.fyndShipmentId,
    fyndBagId: item.fyndBagId,
    fyndArticleId: item.fyndArticleId,
    fyndAffiliateLineId: item.fyndAffiliateLineId,
    fyndSellerIdentifier: item.fyndSellerIdentifier,
    fyndItemId: item.fyndItemId,
    fyndQuantityAvailable: item.fyndQuantityAvailable,
    fyndPriceEffective: item.fyndPriceEffective,
    fyndSize: item.fyndSize,
  }));

  // Identify missing fields
  const fyndFields = [
    "sku",
    "fyndShipmentId",
    "fyndBagId",
    "fyndArticleId",
    "fyndAffiliateLineId",
    "fyndSellerIdentifier",
    "fyndItemId",
    "fyndQuantityAvailable",
    "fyndPriceEffective",
    "fyndSize",
  ] as const;

  const missingFields: string[] = [];
  items.forEach((item, idx) => {
    for (const field of fyndFields) {
      if (item[field] == null) {
        missingFields.push(`items[${idx}].${field}`);
      }
    }
  });

  // Fetch live Fynd data for comparison
  let liveFyndData: unknown = null;
  let liveFyndError: string | null = null;

  const settings = shop.settings;
  if (settings) {
    try {
      const clientResult = await createFyndClientOrError(
        settings as NonNullable<typeof settings> & { fyndApiType?: string | null },
        { requirePlatform: true },
      );
      if (clientResult.ok && "getShipments" in clientResult.client) {
        const fyndClient = clientResult.client as FyndPlatformClient;
        const orderName = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
        if (orderName) {
          const searchRes = await fyndClient.searchShipmentsByExternalOrderId(orderName, {
            searchType: "external_order_id",
            pageSize: 50,
          });
          const rawItems =
            (searchRes as Record<string, unknown>)?.items ??
            (searchRes as Record<string, unknown>)?.shipments ??
            [];
          const shipments = Array.isArray(rawItems) ? rawItems : [];

          // Extract relevant bag data from each shipment
          liveFyndData = shipments.map((shipment: unknown) => {
            const s = shipment as Record<string, unknown>;
            const bags = (Array.isArray(s.bags) ? s.bags : []) as Record<string, unknown>[];
            return {
              shipment_id: s.shipment_id ?? s.id,
              status: s.status ?? s.shipment_status,
              bags: bags.map((bag) => {
                const articles = Array.isArray(bag.articles)
                  ? bag.articles
                  : Array.isArray(bag.items)
                    ? bag.items
                    : bag.item
                      ? [bag.item]
                      : [];
                const affiliateBagDetails = (bag.affiliate_bag_details ?? {}) as Record<
                  string,
                  unknown
                >;
                return {
                  bag_id: bag.bag_id ?? bag.id,
                  quantity: bag.quantity,
                  affiliate_bag_details: {
                    affiliate_line_id: affiliateBagDetails.affiliate_line_id,
                  },
                  articles: (articles as Record<string, unknown>[]).map((article) => {
                    const itemObj = (article.item ?? article) as Record<string, unknown>;
                    const priceInfo = (bag.prices ??
                      bag.price_info ??
                      article.price_info ??
                      {}) as Record<string, unknown>;
                    return {
                      seller_identifier: article.seller_identifier,
                      article_id: article.article_id ?? article._id,
                      item_id: itemObj.item_id ?? itemObj._id,
                      name: itemObj.name ?? itemObj.item_name,
                      size: article.size ?? itemObj.size,
                      quantity_available: article.quantity_available,
                      price_effective: priceInfo.price_effective,
                      transfer_price: priceInfo.transfer_price,
                    };
                  }),
                };
              }),
            };
          });
        }
      } else if (!clientResult.ok) {
        liveFyndError = clientResult.error;
      }
    } catch (err) {
      liveFyndError = err instanceof Error ? err.message : String(err);
    }
  }

  return Response.json(
    {
      returnCase: {
        id: returnCase.id,
        returnRequestNo: returnCase.returnRequestNo,
        shopifyOrderName: returnCase.shopifyOrderName,
        shopifyOrderId: returnCase.shopifyOrderId,
        fyndOrderId: returnCase.fyndOrderId,
        fyndShipmentId: returnCase.fyndShipmentId,
        fyndReturnId: returnCase.fyndReturnId,
        fyndReturnNo: returnCase.fyndReturnNo,
        status: returnCase.status,
        createdByChannel: returnCase.createdByChannel,
        createdAt: returnCase.createdAt,
      },
      items,
      missingFields,
      missingFieldCount: missingFields.length,
      liveFyndData,
      liveFyndError,
    },
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}
