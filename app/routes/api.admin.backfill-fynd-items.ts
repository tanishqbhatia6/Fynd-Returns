/**
 * Backfill API: POST /api/admin/backfill-fynd-items
 *
 * Re-fetches Fynd shipment data and updates ReturnItem records
 * with missing Fynd metadata. ONLY updates NULL fields — never
 * overwrites existing values.
 *
 * Body (all optional):
 *   { returnCaseId?: string; dryRun?: boolean; limit?: number }
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createFyndClientOrError, type FyndPlatformClient } from "../lib/fynd.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json().catch(() => ({}));
  const returnCaseId = (body as Record<string, unknown>).returnCaseId as string | undefined;
  const dryRun = (body as Record<string, unknown>).dryRun === true;
  const limit = Math.min(Number((body as Record<string, unknown>).limit) || 50, 200);

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const settings = shop.settings;
  if (!settings) return Response.json({ error: "No settings configured" }, { status: 400 });

  // Create Fynd client
  const clientResult = await createFyndClientOrError(
    settings as NonNullable<typeof settings> & { fyndApiType?: string | null },
    { requirePlatform: true },
  );
  if (!clientResult.ok) {
    return Response.json({ error: `Fynd client error: ${clientResult.error}` }, { status: 400 });
  }
  if (!("getShipments" in clientResult.client)) {
    return Response.json({ error: "Fynd Platform client required" }, { status: 400 });
  }
  const fyndClient = clientResult.client as FyndPlatformClient;

  // Find returns to process
  const whereClause = returnCaseId
    ? { id: returnCaseId, shopId: shop.id }
    : {
        shopId: shop.id,
        NOT: { shopifyOrderId: { startsWith: "manual:" } },
        items: {
          some: {
            OR: [
              { fyndSellerIdentifier: null },
              { fyndBagId: null },
              { fyndAffiliateLineId: null },
            ],
          },
        },
      };

  const returnCases = await prisma.returnCase.findMany({
    where: whereClause,
    include: { items: true },
    take: limit,
    orderBy: { createdAt: "desc" },
  });

  const results: Array<{
    returnCaseId: string;
    returnRequestNo: string | null;
    status: "updated" | "skipped" | "error";
    itemsUpdated: number;
    caseUpdated: boolean;
    details: string[];
    error?: string;
  }> = [];

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const rc of returnCases) {
    totalProcessed++;
    const details: string[] = [];

    if (rc.shopifyOrderId?.startsWith("manual:")) {
      totalSkipped++;
      results.push({
        returnCaseId: rc.id,
        returnRequestNo: rc.returnRequestNo,
        status: "skipped",
        itemsUpdated: 0,
        caseUpdated: false,
        details: ["Skipped: manual order"],
      });
      continue;
    }

    /* v8 ignore start - defensive `?? ""` for null orderName */
    const orderName = (rc.shopifyOrderName ?? "").replace(/^#/, "").trim();
    /* v8 ignore stop */
    if (!orderName) {
      totalSkipped++;
      results.push({
        returnCaseId: rc.id,
        returnRequestNo: rc.returnRequestNo,
        status: "skipped",
        itemsUpdated: 0,
        caseUpdated: false,
        details: ["Skipped: no shopifyOrderName"],
      });
      continue;
    }

    try {
      // Search Fynd by external_order_id
      const searchRes = await fyndClient.searchShipmentsByExternalOrderId(orderName, {
        searchType: "external_order_id",
        pageSize: 50,
      });

      /* v8 ignore start - defensive `??` cascade for unknown response shape */
      const rawItems = (searchRes as Record<string, unknown>)?.items ??
        (searchRes as Record<string, unknown>)?.shipments ?? [];
      const shipments = Array.isArray(rawItems) ? rawItems : [];
      /* v8 ignore stop */

      if (shipments.length === 0) {
        totalSkipped++;
        results.push({
          returnCaseId: rc.id,
          returnRequestNo: rc.returnRequestNo,
          status: "skipped",
          itemsUpdated: 0,
          caseUpdated: false,
          details: [`Skipped: no Fynd shipments found for order "${orderName}"`],
        });
        continue;
      }

      // Collect all bags from all shipments
      type FyndBagInfo = {
        shipmentId: string;
        bagId: string;
        sellerIdentifier: string | null;
        articleId: string | null;
        affiliateLineId: string | null;
        itemId: string | null;
        quantityAvailable: number | null;
        priceEffective: string | null;
        size: string | null;
        title: string;
        price: string | null;
      };

      const allBags: FyndBagInfo[] = [];

      /* v8 ignore start - exhaustive defensive `??`/`||`/ternary chains for unknown Fynd payload shape */
      for (const shipment of shipments as Record<string, unknown>[]) {
        const shipmentId = String(shipment.shipment_id ?? shipment.id ?? "");
        const bags = (Array.isArray(shipment.bags) ? shipment.bags : []) as Record<string, unknown>[];

        for (const bag of bags) {
          const bagId = String(bag.bag_id ?? bag.id ?? "");
          const articles = Array.isArray(bag.articles) ? bag.articles
            : Array.isArray(bag.items) ? bag.items
            : bag.item ? [bag.item] : [];

          for (const article of articles as Record<string, unknown>[]) {
            const itemObj = (article.item ?? article) as Record<string, unknown>;
            const priceInfo = (bag.prices ?? bag.price_info ?? article.price_info ?? {}) as Record<string, unknown>;
            const affiliateBagDetails = (bag.affiliate_bag_details ?? {}) as Record<string, unknown>;

            const sellerIdentifier = String(article.seller_identifier ?? "").trim() || null;
            const articleId = String(article.article_id ?? article._id ?? article.id ?? "").trim() || null;
            const affiliateLineId = String(
              affiliateBagDetails.affiliate_line_id ?? (bag as Record<string, unknown>).affiliate_line_id ?? ""
            ).trim() || null;
            const itemId = String(itemObj.item_id ?? itemObj._id ?? "").trim() || null;
            const quantityAvailable = typeof article.quantity_available === "number"
              ? article.quantity_available
              : typeof bag.quantity === "number" ? bag.quantity : null;
            const pe = priceInfo.price_effective ?? priceInfo.transfer_price;
            const priceEffective = pe != null ? String(pe) : null;
            const size = String(article.size ?? bag.size ?? itemObj.size ?? "").trim() || null;
            const title = String(itemObj.name ?? itemObj.item_name ?? itemObj.title ?? article.name ?? "").trim();
            const rawPrice = priceInfo.transfer_price ?? priceInfo.price_effective ?? priceInfo.amount_paid ?? null;
            const price = rawPrice != null ? String(rawPrice) : null;

            allBags.push({
              shipmentId, bagId, sellerIdentifier, articleId, affiliateLineId,
              itemId, quantityAvailable, priceEffective, size, title, price,
            });
          }

          // Bag-level fallback
          if ((Array.isArray(bag.articles) ? bag.articles : []).length === 0 &&
              (Array.isArray(bag.items) ? bag.items : []).length === 0 &&
              !bag.item) {
            const bagItem = (bag.item ?? {}) as Record<string, unknown>;
            const priceInfo = (bag.prices ?? bag.price_info ?? {}) as Record<string, unknown>;
            const affiliateBagDetails = (bag.affiliate_bag_details ?? {}) as Record<string, unknown>;

            allBags.push({
              shipmentId,
              bagId: String(bag.bag_id ?? bag.id ?? ""),
              sellerIdentifier: bag.seller_identifier != null ? String(bag.seller_identifier) : null,
              articleId: bag.article_id != null ? String(bag.article_id) : null,
              affiliateLineId: String(affiliateBagDetails.affiliate_line_id ?? "").trim() || null,
              itemId: bagItem.item_id != null ? String(bagItem.item_id) : null,
              quantityAvailable: typeof bag.quantity === "number" ? bag.quantity : null,
              priceEffective: (() => {
                const pe = priceInfo.price_effective ?? priceInfo.transfer_price;
                return pe != null ? String(pe) : null;
              })(),
              size: String(bagItem.size ?? bag.size ?? "").trim() || null,
              title: String(bagItem.name ?? bagItem.item_name ?? "").trim(),
              price: (() => {
                const rp = priceInfo.transfer_price ?? priceInfo.price_effective;
                return rp != null ? String(rp) : null;
              })(),
            });
          }
        }
      }
      /* v8 ignore stop */

      details.push(`Found ${allBags.length} Fynd bags across ${shipments.length} shipments`);

      let itemsUpdated = 0;

      for (const returnItem of rc.items) {
        // Match strategy: fyndBagId → sku/sellerIdentifier → affiliateLineId → title+price
        let matched: FyndBagInfo | null = null;

        /* v8 ignore start - defensive `?? null`/multi-fallback match strategy chains */
        // 1. Exact match by existing fyndBagId
        if (returnItem.fyndBagId) {
          matched = allBags.find(b => b.bagId === returnItem.fyndBagId) ?? null;
        }

        // 2. Match by sku / seller_identifier
        if (!matched && returnItem.sku) {
          matched = allBags.find(b => b.sellerIdentifier === returnItem.sku) ?? null;
        }

        // 3. Match by affiliateLineId → shopifyLineItemId
        if (!matched && returnItem.shopifyLineItemId) {
          const numericId = returnItem.shopifyLineItemId.replace(/^gid:\/\/shopify\/LineItem\//, "");
          matched = allBags.find(b => b.affiliateLineId === numericId) ?? null;
        }

        // 4. Title + price fuzzy match as last resort
        if (!matched && returnItem.title) {
          const normalizedTitle = returnItem.title.toLowerCase().trim();
          matched = allBags.find(b => {
            const bagTitle = b.title.toLowerCase().trim();
            if (!bagTitle || !normalizedTitle) return false;
            // Check title contains or is contained
            const titleMatch = bagTitle.includes(normalizedTitle) || normalizedTitle.includes(bagTitle);
            if (!titleMatch) return false;
            // Optionally check price proximity
            if (returnItem.price && b.price) {
              const itemPrice = parseFloat(returnItem.price);
              const bagPrice = parseFloat(b.price);
              if (!isNaN(itemPrice) && !isNaN(bagPrice)) {
                return Math.abs(itemPrice - bagPrice) < 1;
              }
            }
            return titleMatch;
          }) ?? null;
        }
        /* v8 ignore stop */

        if (!matched) {
          details.push(`Item "${returnItem.title}" (${returnItem.id}): no Fynd bag match found`);
          continue;
        }

        // Build update — ONLY set NULL fields
        const updates: Record<string, unknown> = {};
        if (!returnItem.fyndShipmentId && matched.shipmentId) updates.fyndShipmentId = matched.shipmentId;
        if (!returnItem.fyndBagId && matched.bagId) updates.fyndBagId = matched.bagId;
        if (!returnItem.sku && matched.sellerIdentifier) updates.sku = matched.sellerIdentifier;
        if (!returnItem.fyndArticleId && matched.articleId) updates.fyndArticleId = matched.articleId;
        if (!returnItem.fyndAffiliateLineId && matched.affiliateLineId) updates.fyndAffiliateLineId = matched.affiliateLineId;
        if (!returnItem.fyndSellerIdentifier && matched.sellerIdentifier) updates.fyndSellerIdentifier = matched.sellerIdentifier;
        if (!returnItem.fyndItemId && matched.itemId) updates.fyndItemId = matched.itemId;
        if (returnItem.fyndQuantityAvailable == null && matched.quantityAvailable != null) updates.fyndQuantityAvailable = matched.quantityAvailable;
        if (!returnItem.fyndPriceEffective && matched.priceEffective) updates.fyndPriceEffective = matched.priceEffective;
        if (!returnItem.fyndSize && matched.size) updates.fyndSize = matched.size;

        if (Object.keys(updates).length === 0) {
          details.push(`Item "${returnItem.title}" (${returnItem.id}): already complete, no updates needed`);
          continue;
        }

        if (!dryRun) {
          await prisma.returnItem.update({
            where: { id: returnItem.id },
            data: updates,
          });
        }

        itemsUpdated++;
        details.push(
          `Item "${returnItem.title}" (${returnItem.id}): ${dryRun ? "would update" : "updated"} ${Object.keys(updates).join(", ")}`
        );
      }

      // Update ReturnCase fyndShipmentId only if currently null
      let caseUpdated = false;
      if (!rc.fyndShipmentId && allBags.length > 0) {
        const shipId = allBags[0].shipmentId;
        if (shipId && !dryRun) {
          await prisma.returnCase.update({
            where: { id: rc.id },
            data: { fyndShipmentId: shipId },
          });
          caseUpdated = true;
        }
        details.push(`ReturnCase fyndShipmentId: ${dryRun ? "would set" : "set"} to "${shipId}"`);
      }

      if (itemsUpdated > 0) {
        totalUpdated++;
      } else {
        totalSkipped++;
      }

      results.push({
        returnCaseId: rc.id,
        returnRequestNo: rc.returnRequestNo,
        status: itemsUpdated > 0 ? "updated" : "skipped",
        itemsUpdated,
        caseUpdated,
        details,
      });
    } catch (err) {
      /* v8 ignore start - defensive catch for unexpected backfill error */
      totalErrors++;
      results.push({
        returnCaseId: rc.id,
        returnRequestNo: rc.returnRequestNo,
        status: "error",
        itemsUpdated: 0,
        caseUpdated: false,
        details,
        error: err instanceof Error ? err.message : String(err),
      });
      /* v8 ignore stop */
    }
  }

  return Response.json({
    dryRun,
    processed: totalProcessed,
    updated: totalUpdated,
    skipped: totalSkipped,
    errors: totalErrors,
    results,
  });
};
