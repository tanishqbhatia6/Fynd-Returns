import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { webhookLogger } from "../lib/observability/logger.server";

/**
 * GDPR: shop/redact
 *
 * Triggered 48 hours after the merchant uninstalls the app.
 * We must delete all data associated with this shop.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Re-throw HMAC 401 Responses (correct Shopify behaviour) but swallow other
  // authenticate-time errors so we don't trigger retry storms.
  let authed: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    webhookLogger.error({ topic: "SHOP_REDACT", err }, "Shop redact webhook authentication failed");
    return new Response();
  }
  const { shop, payload } = authed;

  webhookLogger.info(
    { topic: "SHOP_REDACT", shop, hasShopId: Boolean(payload.shop_id) },
    "Shopify shop redact webhook received",
  );

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      webhookLogger.info({ topic: "SHOP_REDACT", shop }, "Shop not found for shop redact");
      return new Response();
    }

    // Delete all data in dependency order to avoid FK constraint violations

    // 1. Delete return-related data
    const returnCases = await prisma.returnCase.findMany({
      where: { shopId: shopRecord.id },
      select: { id: true },
    });
    const caseIds = returnCases.map((rc) => rc.id);

    if (caseIds.length > 0) {
      await prisma.returnItem.deleteMany({
        where: { returnCaseId: { in: caseIds } },
      });
      await prisma.returnEvent.deleteMany({
        where: { returnCaseId: { in: caseIds } },
      });
      await prisma.returnCase.deleteMany({
        where: { id: { in: caseIds } },
      });
    }

    // 2. Delete Fynd data
    await prisma.fyndOrderMapping.deleteMany({
      where: { shopId: shopRecord.id },
    });
    await prisma.fyndWebhookLog.deleteMany({
      where: { shopDomain: shop },
    });

    // 3. Delete lookup sessions, API keys, webhook subscriptions
    await prisma.lookupSession.deleteMany({
      where: { shopId: shopRecord.id },
    });
    await prisma.apiKey.deleteMany({
      where: { shopId: shopRecord.id },
    });
    await prisma.webhookSubscription.deleteMany({
      where: { shopId: shopRecord.id },
    });
    await prisma.notificationLog.deleteMany({
      where: { shopId: shopRecord.id },
    });

    // 4. Delete shop settings (cascades blocklist entries via onDelete: Cascade)
    await prisma.shopSettings.deleteMany({
      where: { shopId: shopRecord.id },
    });

    // 5. Delete sessions
    await prisma.session.deleteMany({
      where: { shop },
    });

    // 6. Delete the shop record itself
    await prisma.shop.delete({
      where: { id: shopRecord.id },
    });

    webhookLogger.info(
      { topic: "SHOP_REDACT", shop, returnCaseCount: returnCases.length },
      "Shopify shop redact completed",
    );
  } catch (err) {
    webhookLogger.error({ topic: "SHOP_REDACT", shop, err }, "Shop redact failed");
  }

  return new Response();
};
