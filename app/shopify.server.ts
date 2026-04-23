import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  // Webhook subscriptions are declared in shopify.app.toml (declarative,
  // managed by the Shopify CLI). The imperative webhooks: {} block that
  // used to live here was removed in the April 2026 webhook-reliability
  // audit — the hybrid config left orders/updated and orders/fulfilled
  // effectively orphaned in the toml, which made monitoring and re-auth
  // diffs hard to reason about. See WEBHOOK_RELIABILITY_AUDIT.md.
  hooks: {
    afterAuth: async ({ session }) => {
      // Create filterable metafield definition for Fynd order ID on Order.
      // This lets us search orders via: metafields.$app.fynd_order_id:"VALUE"
      // which is indexed by Shopify — instant O(1) lookup, any volume.
      try {
        const { admin } = await shopify.unauthenticated.admin(session.shop);
        await admin.graphql(
          `#graphql
          mutation EnsureFyndMetafield($definition: MetafieldDefinitionInput!) {
            metafieldDefinitionCreate(definition: $definition) {
              createdDefinition { id }
              userErrors { field message code }
            }
          }`,
          {
            variables: {
              definition: {
                name: "Fynd Order ID",
                namespace: "$app",
                key: "fynd_order_id",
                type: "single_line_text_field",
                description: "Fynd/affiliate order ID for indexed search",
                ownerType: "ORDER",
                capabilities: {
                  adminFilterable: { enabled: true },
                },
              },
            },
          }
        );
      } catch {
        // Ignore — definition may already exist (idempotent)
      }
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
