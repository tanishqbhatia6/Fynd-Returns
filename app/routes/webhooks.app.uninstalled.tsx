import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session } = await authenticate.webhook(request);
  if (session) {
    try {
      await prisma.session.deleteMany({ where: { shop } });
    } catch (err) {
      console.error("[webhooks.app.uninstalled] Failed to delete sessions:", err);
      // Don't fail the webhook - Shopify expects 2xx
    }
  }
  return new Response();
};
