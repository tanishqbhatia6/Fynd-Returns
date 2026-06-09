import type { ActionFunctionArgs } from "react-router";
import shopifyApp, { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fetchSubscriptionSnapshot } from "../lib/billing.server";
import { webhookLogger } from "../lib/observability/logger.server";

/**
 * app_subscriptions/update webhook.
 *
 * Fires when a merchant's Managed Pricing subscription transitions —
 * install, activation, cancellation, frozen (non-payment), etc. We
 * don't trust the payload's status value directly; instead we refetch
 * the live snapshot via currentAppInstallation so our cache always
 * reflects Shopify's source of truth.
 *
 * Cached on ShopSettings.subscriptionStatus / subscriptionName /
 * subscriptionCheckedAt — the billing gate reads these when no live
 * admin client is available (e.g. early in a webhook flow).
 *
 * Follows the same guarded pattern as orders/* webhooks: authenticate
 * outside a try, re-throw Response (401 etc.) back to Shopify,
 * swallow everything else with structured logging so the delivery
 * counts as success.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  let authed;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    webhookLogger.error(
      { topic: "APP_SUBSCRIPTIONS_UPDATE", err },
      "App subscription update webhook authentication failed",
    );
    return new Response();
  }

  const { shop } = authed;

  try {
    // Get the offline session so we can make an admin GraphQL call. If
    // none exists (shop uninstalled mid-flight), fall back to storing
    // only what the payload gave us.
    const { admin } = await shopifyApp.unauthenticated.admin(shop);
    const snapshot = await fetchSubscriptionSnapshot(admin);

    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
      include: { settings: true },
    });
    if (!shopRecord?.settings) return new Response();

    await prisma.shopSettings.update({
      where: { id: shopRecord.settings.id },
      data: {
        subscriptionStatus: snapshot.status,
        subscriptionName: snapshot.name,
        subscriptionCheckedAt: new Date(),
      },
    });
  } catch (err) {
    webhookLogger.error({ topic: "APP_SUBSCRIPTIONS_UPDATE", shop, err }, "App subscription update failed");
  }

  return new Response();
};
