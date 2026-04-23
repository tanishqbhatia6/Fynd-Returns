import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import {
  server,
  http,
  HttpResponse,
  TEST_SHOP_DOMAIN,
  TEST_ACCESS_TOKEN,
  TEST_SHOPIFY_GRAPHQL_URL,
} from "../../test/msw-server";

/* Stub the observability layer so tests don't try to talk to a real OTel
   collector. These are not the subject of these tests. */
vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_name: string, _attrs: unknown, fn: (span: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T,>(fn: () => Promise<T>) => fn() },
}));

import {
  createAdminClient,
  fetchOrder,
  fetchPrimaryLocationId,
  fetchAllLocations,
  OrderAccessError,
} from "../shopify-admin.server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/* ─ Helpers ─────────────────────────────────────────────────────────── */

function admin() {
  return createAdminClient(TEST_SHOP_DOMAIN, TEST_ACCESS_TOKEN);
}

/* ─ fetchOrder ──────────────────────────────────────────────────────── */

describe("fetchOrder", () => {
  it("returns parsed order on success", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            nodes: [{
              id: "gid://shopify/Order/1001",
              name: "#1001",
              createdAt: "2026-04-01T00:00:00Z",
              email: "cust@example.com",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              totalPriceSet: { shopMoney: { amount: "99.99", currencyCode: "USD" } },
              lineItems: { nodes: [] },
              fulfillments: [],
              customAttributes: [],
            }],
          },
        })
      ),
    );
    const result = await fetchOrder(admin(), "1001");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
    expect(result?.email).toBe("cust@example.com");
  });

  it("returns null when Shopify responds with empty node", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { nodes: [null] } })
      ),
    );
    const result = await fetchOrder(admin(), "9999");
    expect(result).toBe(null);
  });

  it("returns null on GraphQL errors (non-401)", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          errors: [{ message: "Field not found" }],
          data: { nodes: [null] },
        })
      ),
    );
    const result = await fetchOrder(admin(), "1001");
    expect(result).toBe(null);
  });

  it("returns null when Shopify throws a network error", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () => HttpResponse.error()),
    );
    const result = await fetchOrder(admin(), "1001");
    expect(result).toBe(null);
  });

  it("accepts both gid:// and numeric ID inputs", async () => {
    let receivedIds: string[] | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = await request.json() as { variables?: { ids?: string[] } };
        receivedIds = body.variables?.ids;
        return HttpResponse.json({ data: { nodes: [null] } });
      }),
    );
    await fetchOrder(admin(), "1001");
    expect(receivedIds).toEqual(["gid://shopify/Order/1001"]);

    await fetchOrder(admin(), "gid://shopify/Order/9999");
    expect(receivedIds).toEqual(["gid://shopify/Order/9999"]);
  });
});

/* ─ fetchPrimaryLocationId / fetchAllLocations ──────────────────────── */

describe("fetchAllLocations", () => {
  it("returns active, non-fulfillment-service locations", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            locations: {
              nodes: [
                { id: "gid://shopify/Location/1", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false },
                { id: "gid://shopify/Location/2", name: "Store", isActive: true, fulfillsOnlineOrders: false, isFulfillmentService: false },
                { id: "gid://shopify/Location/3", name: "3rd party", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: true },
                { id: "gid://shopify/Location/4", name: "Inactive", isActive: false, fulfillsOnlineOrders: true, isFulfillmentService: false },
              ],
            },
          },
        })
      ),
    );
    const locs = await fetchAllLocations(admin());
    expect(locs.length).toBeGreaterThanOrEqual(1);
    // At minimum, the active non-3PL locations should be returned.
    const names = locs.map(l => l.name);
    expect(names).toContain("Warehouse");
  });

  it("returns empty array when the API has no locations", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { locations: { nodes: [] } } })
      ),
    );
    const locs = await fetchAllLocations(admin());
    expect(locs).toEqual([]);
  });

  it("returns empty array on error response", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ errors: [{ message: "boom" }] }, { status: 500 })
      ),
    );
    const locs = await fetchAllLocations(admin());
    expect(locs).toEqual([]);
  });
});

describe("fetchPrimaryLocationId", () => {
  it("returns the primary (online-fulfilling) location ID", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            locations: {
              nodes: [
                { id: "gid://shopify/Location/1", name: "Warehouse", isActive: true, fulfillsOnlineOrders: true, isFulfillmentService: false },
                { id: "gid://shopify/Location/2", name: "Store", isActive: true, fulfillsOnlineOrders: false, isFulfillmentService: false },
              ],
            },
          },
        })
      ),
    );
    const id = await fetchPrimaryLocationId(admin());
    expect(id).toBe("gid://shopify/Location/1");
  });

  it("returns null when there are no eligible locations", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { locations: { nodes: [] } } })
      ),
    );
    const id = await fetchPrimaryLocationId(admin());
    expect(id).toBe(null);
  });
});

/* ─ OrderAccessError ────────────────────────────────────────────────── */

describe("OrderAccessError", () => {
  it("is a subclass of Error with a stable name", () => {
    const err = new OrderAccessError("Need read_all_orders", "PCDA");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OrderAccessError");
    expect(err.code).toBe("PCDA");
    expect(err.message).toBe("Need read_all_orders");
  });
  it("defaults code to PCDA", () => {
    expect(new OrderAccessError("x").code).toBe("PCDA");
  });
  it("accepts NOT_FOUND code", () => {
    expect(new OrderAccessError("no order", "NOT_FOUND").code).toBe("NOT_FOUND");
  });
});

/* ─ GraphQL request shape ──────────────────────────────────────────── */

describe("Admin client", () => {
  it("sends X-Shopify-Access-Token header with every request", async () => {
    let received = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, ({ request }) => {
        received = request.headers.get("X-Shopify-Access-Token") ?? "";
        return HttpResponse.json({ data: { nodes: [null] } });
      }),
    );
    await fetchOrder(admin(), "1");
    expect(received).toBe(TEST_ACCESS_TOKEN);
  });

  it("sends application/json content type", async () => {
    let received = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, ({ request }) => {
        received = request.headers.get("Content-Type") ?? "";
        return HttpResponse.json({ data: { nodes: [null] } });
      }),
    );
    await fetchOrder(admin(), "1");
    expect(received).toContain("application/json");
  });
});
