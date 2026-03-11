import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { generatePostmanCollection } from "../lib/postman-collection.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rl = checkRateLimit(request, "external.postman");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // Any valid API key can download the collection
  const auth = await authenticateApiKey(request, "read_returns");
  if (!auth.ok) {
    // Try other permissions
    const auth2 = await authenticateApiKey(request, "read_settings");
    if (!auth2.ok) {
      const auth3 = await authenticateApiKey(request, "manage_webhooks");
      if (!auth3.ok) return auth3.response;
    }
  }

  const baseUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const collection = generatePostmanCollection(baseUrl);

  return new Response(collection, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="ReturnProMax-API.postman_collection.json"',
    },
  });
};
