/**
 * Shared MSW (Mock Service Worker) harness for integration tests.
 *
 * Why MSW?
 * ──────────
 * Files like `shopify-admin.server.ts` and `fynd.server.ts` exist to call
 * external HTTP APIs. Unit tests that mock the modules directly end up
 * testing "did we call our own mock?" rather than "does our code produce
 * correct requests and handle real response shapes?". MSW intercepts at
 * the network layer — `fetch()` works unmodified, but instead of going
 * to the internet it hands the request to a handler we've registered.
 *
 * Usage from a test file:
 * ──────────────────────────
 *   import { server, http, HttpResponse } from "../../test/msw-server";
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 *
 *   it("calls Shopify refundCreate", async () => {
 *     server.use(
 *       http.post("https://test.myshopify.com/admin/api/2026-01/graphql.json",
 *         () => HttpResponse.json({ data: { refundCreate: { refund: { id: "gid://shopify/Refund/1" } } } })
 *       )
 *     );
 *     const res = await createRefund(...);
 *     expect(res.ok).toBe(true);
 *   });
 *
 * With `onUnhandledRequest: "error"` MSW fails any test that makes an
 * HTTP call we didn't mock — this catches accidental real network calls
 * from production code paths we forgot to test.
 */

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

// Re-export msw primitives so callers only import from this one file.
export { http, HttpResponse };

// Default server — empty handler set. Tests add per-scenario handlers
// with `server.use(...)` inside the test body.
export const server = setupServer();

/* ─ Convenience fixture builders ─
   Common response shapes factored out so tests stay readable. */

/** Build a Shopify GraphQL success envelope. */
export function shopifyGraphQLSuccess(data: Record<string, unknown>) {
  return HttpResponse.json({ data });
}

/** Build a Shopify GraphQL error envelope. */
export function shopifyGraphQLError(message: string, extras: Record<string, unknown> = {}) {
  return HttpResponse.json({
    errors: [{ message, ...extras }],
    data: null,
  });
}

/** Build a Shopify userErrors response (for mutations that half-succeeded). */
export function shopifyUserErrors(mutationName: string, userErrors: Array<{ field?: string[]; message: string }>) {
  return HttpResponse.json({
    data: {
      [mutationName]: { userErrors, [mutationName.replace("Create", "").replace(/^./, (c) => c.toLowerCase())]: null },
    },
  });
}

/** Standard Shopify Admin GraphQL endpoint for a test shop. */
export const TEST_SHOP_DOMAIN = "test-shop.myshopify.com";
export const TEST_ACCESS_TOKEN = "shpat_test_token";
export const TEST_SHOPIFY_GRAPHQL_URL = `https://${TEST_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`;
export const TEST_SHOPIFY_REST_URL = `https://${TEST_SHOP_DOMAIN}/admin/api/2026-01/orders.json`;

/** Fynd Platform API (UAT) token endpoint — used by fetchFyndPlatformToken. */
export const TEST_FYND_BASE_URL = "https://api.fynd.example";
export const TEST_FYND_TOKEN_URL = `${TEST_FYND_BASE_URL}/service/panel/authentication/v1.0/company/12345/oauth/token`;
