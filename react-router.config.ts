import type { Config } from "@react-router/dev/config";

export default {
  // Boltic forwards requests through a regional host while browser form posts
  // originate from the public app host. Allow the public host so React Router's
  // action CSRF check does not reject legitimate embedded Shopify posts.
  allowedActionOrigins: ["fynd-returns-b9ef13cc.serverless.boltic.app"],
} satisfies Config;
