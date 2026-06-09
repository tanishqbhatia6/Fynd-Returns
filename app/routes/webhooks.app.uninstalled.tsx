import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { webhookLogger } from "../lib/observability/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);
  if (session) {
    try {
      await prisma.session.deleteMany({ where: { shop } });
    } catch (err) {
      webhookLogger.error({ topic: "APP_UNINSTALLED", shop, err }, "Failed to delete sessions");
      // Don't fail the webhook - Shopify expects 2xx
    }
  }
  return new Response();
};
