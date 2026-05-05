import type { LoaderFunctionArgs } from "react-router";
import { authenticateApiKey } from "../lib/api-key-auth.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { checkPerKeyRateLimit } from "../lib/external-api-helpers.server";
import { generatePostmanCollection } from "../lib/postman-collection.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rl = await checkRateLimit(request, "external.postman");
  if (!rl.allowed) return rateLimitResponse(rl.retryAfterMs);

  // Any valid API key can download the collection. Try each permission in order
  // and hold onto the first successful auth so we can bind the per-key rate limit
  // to it below.
  let authedKeyId: string | undefined;
  const auth = await authenticateApiKey(request, "read_returns");
  if (auth.ok) {
    authedKeyId = auth.keyId;
  } else {
    const auth2 = await authenticateApiKey(request, "read_settings");
    if (auth2.ok) {
      authedKeyId = auth2.keyId;
    } else {
      const auth3 = await authenticateApiKey(request, "manage_webhooks");
      if (!auth3.ok) return auth3.response;
      authedKeyId = auth3.keyId;
    }
  }

  const perKey = await checkPerKeyRateLimit(request, "external.postman", authedKeyId ?? "anon");
  if (perKey) return perKey;

  const baseUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  const collection = generatePostmanCollection(baseUrl);

  return new Response(collection, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="ReturnProMax-API.postman_collection.json"',
    },
  });
};
