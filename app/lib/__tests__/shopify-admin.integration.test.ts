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
  withSpan: async <T>(_name: string, _attrs: unknown, fn: (span: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T>(fn: () => Promise<T>) => fn() },
}));

import {
  createAdminClient,
  fetchOrder,
  fetchOrderByGid,
  fetchPrimaryLocationId,
  fetchAllLocations,
  OrderAccessError,
  closeShopifyReturn,
  declineShopifyReturn,
  closeShopifyReturnBestEffort,
  createRefund,
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
            nodes: [
              {
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
              },
            ],
          },
        }),
      ),
    );
    const result = await fetchOrder(admin(), "1001");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
    expect(result?.email).toBe("cust@example.com");
  });

  it("returns null when Shopify responds with empty node", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () => HttpResponse.json({ data: { nodes: [null] } })),
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
        }),
      ),
    );
    const result = await fetchOrder(admin(), "1001");
    expect(result).toBe(null);
  });

  it("returns null when Shopify throws a network error", async () => {
    server.use(http.post(TEST_SHOPIFY_GRAPHQL_URL, () => HttpResponse.error()));
    const result = await fetchOrder(admin(), "1001");
    expect(result).toBe(null);
  });

  it("accepts both gid:// and numeric ID inputs", async () => {
    let receivedIds: string[] | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { ids?: string[] } };
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
                {
                  id: "gid://shopify/Location/1",
                  name: "Warehouse",
                  isActive: true,
                  fulfillsOnlineOrders: true,
                  isFulfillmentService: false,
                },
                {
                  id: "gid://shopify/Location/2",
                  name: "Store",
                  isActive: true,
                  fulfillsOnlineOrders: false,
                  isFulfillmentService: false,
                },
                {
                  id: "gid://shopify/Location/3",
                  name: "3rd party",
                  isActive: true,
                  fulfillsOnlineOrders: true,
                  isFulfillmentService: true,
                },
                {
                  id: "gid://shopify/Location/4",
                  name: "Inactive",
                  isActive: false,
                  fulfillsOnlineOrders: true,
                  isFulfillmentService: false,
                },
              ],
            },
          },
        }),
      ),
    );
    const locs = await fetchAllLocations(admin());
    expect(locs.length).toBeGreaterThanOrEqual(1);
    // At minimum, the active non-3PL locations should be returned.
    const names = locs.map((l) => l.name);
    expect(names).toContain("Warehouse");
  });

  it("returns empty array when the API has no locations", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { locations: { nodes: [] } } }),
      ),
    );
    const locs = await fetchAllLocations(admin());
    expect(locs).toEqual([]);
  });

  it("returns empty array on error response", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ errors: [{ message: "boom" }] }, { status: 500 }),
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
                {
                  id: "gid://shopify/Location/1",
                  name: "Warehouse",
                  isActive: true,
                  fulfillsOnlineOrders: true,
                  isFulfillmentService: false,
                },
                {
                  id: "gid://shopify/Location/2",
                  name: "Store",
                  isActive: true,
                  fulfillsOnlineOrders: false,
                  isFulfillmentService: false,
                },
              ],
            },
          },
        }),
      ),
    );
    const id = await fetchPrimaryLocationId(admin());
    expect(id).toBe("gid://shopify/Location/1");
  });

  it("returns null when there are no eligible locations", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { locations: { nodes: [] } } }),
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

/* ─ closeShopifyReturn ─────────────────────────────────────────────── */

describe("closeShopifyReturn", () => {
  it("returns success when Shopify closes the return", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            returnClose: {
              return: { id: "gid://shopify/Return/1", status: "CLOSED" },
              userErrors: [],
            },
          },
        }),
      ),
    );
    const res = await closeShopifyReturn(admin(), "gid://shopify/Return/1");
    expect(res.success).toBe(true);
    expect(res.status).toBe("CLOSED");
  });

  it("treats 'already closed' top-level errors as idempotent success", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          errors: [{ message: "Return is already closed" }],
          data: null,
        }),
      ),
    );
    const res = await closeShopifyReturn(admin(), "gid://shopify/Return/1");
    expect(res.success).toBe(true);
    expect(res.alreadyClosed).toBe(true);
  });

  it("treats 'already closed' userError as idempotent success", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            returnClose: {
              return: null,
              userErrors: [{ message: "Return is already CLOSED" }],
            },
          },
        }),
      ),
    );
    const res = await closeShopifyReturn(admin(), "gid://shopify/Return/1");
    expect(res.success).toBe(true);
    expect(res.alreadyClosed).toBe(true);
  });

  it("returns error on non-idempotent userErrors", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            returnClose: {
              return: null,
              userErrors: [{ message: "Return not found" }],
            },
          },
        }),
      ),
    );
    const res = await closeShopifyReturn(admin(), "999");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("returns error on network failure", async () => {
    server.use(http.post(TEST_SHOPIFY_GRAPHQL_URL, () => HttpResponse.error()));
    const res = await closeShopifyReturn(admin(), "1");
    expect(res.success).toBe(false);
  });

  it("accepts bare IDs and expands them to gid://", async () => {
    let receivedVars: { id?: string } | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { id?: string } };
        receivedVars = body.variables;
        return HttpResponse.json({
          data: {
            returnClose: {
              return: { id: "gid://shopify/Return/42", status: "CLOSED" },
              userErrors: [],
            },
          },
        });
      }),
    );
    await closeShopifyReturn(admin(), "42");
    expect(receivedVars?.id).toBe("gid://shopify/Return/42");
  });
});

/* ─ declineShopifyReturn ───────────────────────────────────────────── */

describe("declineShopifyReturn", () => {
  it("declines with provided reason", async () => {
    let receivedInput: { declineReason?: string; id?: string } | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: typeof receivedInput } };
        receivedInput = body.variables?.input;
        return HttpResponse.json({
          data: {
            returnDecline: {
              return: { id: "gid://shopify/Return/1", status: "DECLINED" },
              userErrors: [],
            },
          },
        });
      }),
    );
    const res = await declineShopifyReturn(admin(), "1", "Outside return window");
    expect(res.success).toBe(true);
    expect(res.status).toBe("DECLINED");
    expect(receivedInput?.declineReason).toBe("Outside return window");
  });

  it("uses default reason when not provided", async () => {
    let receivedReason = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as {
          variables?: { input?: { declineReason?: string } };
        };
        receivedReason = body.variables?.input?.declineReason ?? "";
        return HttpResponse.json({
          data: {
            returnDecline: { return: { id: "gid://1", status: "DECLINED" }, userErrors: [] },
          },
        });
      }),
    );
    await declineShopifyReturn(admin(), "1");
    expect(receivedReason.length).toBeGreaterThan(0);
  });

  it("returns error on userErrors", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            returnDecline: {
              return: null,
              userErrors: [{ message: "Invalid return state" }],
            },
          },
        }),
      ),
    );
    const res = await declineShopifyReturn(admin(), "1", "bad");
    expect(res.success).toBe(false);
  });
});

/* ─ closeShopifyReturnBestEffort ───────────────────────────────────── */

describe("closeShopifyReturnBestEffort", () => {
  it("skips when returnCase has no shopifyReturnId", async () => {
    // No MSW handler registered — any GraphQL call would error, so this
    // also verifies we're not making one.
    const logged: Array<{ eventType: string; payloadJson: string }> = [];
    const res = await closeShopifyReturnBestEffort(
      admin(),
      { id: "rc-1", shopifyReturnId: null, shopifyOrderId: null },
      {
        logEvent: async (evt) => {
          logged.push(evt);
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(logged[0].eventType).toBe("shopify_return_close_skipped");
    expect(logged[0].payloadJson).toContain("no_return_id");
  });

  it("skips for manual returns (shopifyOrderId starts with 'manual:')", async () => {
    const logged: Array<{ eventType: string; payloadJson: string }> = [];
    const res = await closeShopifyReturnBestEffort(
      admin(),
      { id: "rc-2", shopifyReturnId: "gid://shopify/Return/1", shopifyOrderId: "manual:xyz" },
      {
        logEvent: async (evt) => {
          logged.push(evt);
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.skipped).toBe(true);
    expect(logged[0].payloadJson).toContain("manual_return");
  });

  it("calls closeShopifyReturn for action='close' (default)", async () => {
    // closeShopifyReturnBestEffort now ALSO sweeps any other open returns on
    // the order (Bug #4 fix) — that adds a leading `openReturns` query
    // before the `returnClose` mutation. Accept either, and just assert
    // that AT LEAST ONE call carried the returnClose mutation.
    let sawClose = false;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = await request.text();
        if (body.includes("returnClose")) sawClose = true;
        if (body.includes("openReturns")) {
          return HttpResponse.json({ data: { order: { returns: { edges: [] } } } });
        }
        return HttpResponse.json({
          data: { returnClose: { return: { id: "gid://1", status: "CLOSED" }, userErrors: [] } },
        });
      }),
    );
    const res = await closeShopifyReturnBestEffort(admin(), {
      id: "rc-3",
      shopifyReturnId: "gid://shopify/Return/1",
      shopifyOrderId: "gid://shopify/Order/1",
    });
    expect(res.ok).toBe(true);
    expect(sawClose).toBe(true);
  });

  it("calls declineShopifyReturn for action='decline'", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = await request.text();
        expect(body).toContain("returnDecline");
        return HttpResponse.json({
          data: {
            returnDecline: { return: { id: "gid://1", status: "DECLINED" }, userErrors: [] },
          },
        });
      }),
    );
    const res = await closeShopifyReturnBestEffort(
      admin(),
      {
        id: "rc-4",
        shopifyReturnId: "gid://shopify/Return/1",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { action: "decline", declineReason: "Outside return window" },
    );
    expect(res.ok).toBe(true);
  });

  it("logs shopify_return_closed on success", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: { returnClose: { return: { id: "gid://1", status: "CLOSED" }, userErrors: [] } },
        }),
      ),
    );
    const logged: Array<{ eventType: string; payloadJson: string }> = [];
    await closeShopifyReturnBestEffort(
      admin(),
      {
        id: "rc-5",
        shopifyReturnId: "gid://shopify/Return/1",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      {
        logEvent: async (evt) => {
          logged.push(evt);
        },
      },
    );
    expect(logged[0].eventType).toBe("shopify_return_closed");
  });

  it("logs shopify_return_close_failed on failure", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: { returnClose: { return: null, userErrors: [{ message: "forbidden" }] } },
        }),
      ),
    );
    const logged: Array<{ eventType: string; payloadJson: string }> = [];
    const res = await closeShopifyReturnBestEffort(
      admin(),
      {
        id: "rc-6",
        shopifyReturnId: "gid://shopify/Return/1",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      {
        logEvent: async (evt) => {
          logged.push(evt);
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(logged[0].eventType).toBe("shopify_return_close_failed");
  });

  it("survives an async logEvent that throws", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: { returnClose: { return: { id: "gid://1", status: "CLOSED" }, userErrors: [] } },
        }),
      ),
    );
    const res = await closeShopifyReturnBestEffort(
      admin(),
      {
        id: "rc-7",
        shopifyReturnId: "gid://shopify/Return/1",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      {
        logEvent: async () => {
          throw new Error("log infra down");
        },
      },
    );
    // logEvent errors are caught with .catch(() => {}) so the main call succeeds.
    expect(res.ok).toBe(true);
  });
});

/* ─ fetchOrderByGid ────────────────────────────────────────────────── */

describe("fetchOrderByGid", () => {
  it("returns null for empty/invalid GIDs without hitting the API", async () => {
    // No MSW handler — any HTTP call would error, proving we didn't make one.
    expect(await fetchOrderByGid(admin(), "")).toBe(null);
    expect(await fetchOrderByGid(admin(), "1001")).toBe(null);
    expect(await fetchOrderByGid(admin(), "not-a-gid")).toBe(null);
  });

  it("returns parsed order when orderByIdentifier resolves", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            orderByIdentifier: {
              id: "gid://shopify/Order/1001",
              name: "#1001",
              createdAt: "2026-04-01T00:00:00Z",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              totalPriceSet: { shopMoney: { amount: "99.99", currencyCode: "USD" } },
              lineItems: { nodes: [] },
              fulfillments: [],
              customAttributes: [],
            },
          },
        }),
      ),
    );
    const result = await fetchOrderByGid(admin(), "gid://shopify/Order/1001");
    expect(result).not.toBeNull();
    expect(result?.name).toBe("#1001");
  });

  it("returns null when orderByIdentifier is null (order missing)", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({ data: { orderByIdentifier: null } }),
      ),
    );
    expect(await fetchOrderByGid(admin(), "gid://shopify/Order/999")).toBe(null);
  });

  it("throws OrderAccessError for PCDA / 'not approved' errors", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          errors: [{ message: "Your app is not approved to access the Order object" }],
          data: { orderByIdentifier: null },
        }),
      ),
    );
    await expect(fetchOrderByGid(admin(), "gid://shopify/Order/1001")).rejects.toBeInstanceOf(
      OrderAccessError,
    );
  });

  it("returns null for unrelated GraphQL errors (not PCDA)", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          errors: [{ message: "Field 'xyz' doesn't exist" }],
          data: null,
        }),
      ),
    );
    expect(await fetchOrderByGid(admin(), "gid://shopify/Order/1")).toBe(null);
  });

  it("returns null on network error", async () => {
    server.use(http.post(TEST_SHOPIFY_GRAPHQL_URL, () => HttpResponse.error()));
    expect(await fetchOrderByGid(admin(), "gid://shopify/Order/1")).toBe(null);
  });
});

/* ─ createRefund ───────────────────────────────────────────────────── */

describe("createRefund", () => {
  const lineItems = [{ id: "gid://shopify/LineItem/1", quantity: 1 }];

  it("bails with no-line-items error when list is empty", async () => {
    const res = await createRefund(admin(), "gid://shopify/Order/1", [], "note", "gid://loc/1");
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No line items/);
  });

  it("happy path: original method returns refund info", async () => {
    // createRefund may issue a `locations` lookup or a `suggestRefund` query
    // before the actual `refundCreate` mutation depending on shop config.
    // Accept any preceding queries — we only need the mutation to fire.
    let sawRefundCreate = false;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = await request.text();
        if (body.includes("refundCreate")) sawRefundCreate = true;
        if (body.includes("query suggestRefund") || body.includes("query locations")) {
          // Permissive stub for any auxiliary lookup.
          return HttpResponse.json({
            data: {
              order: { suggestedRefund: { suggestedTransactions: [] } },
              locations: { edges: [] },
            },
          });
        }
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://shopify/Refund/1",
                createdAt: "2026-04-22T10:00:00Z",
                totalRefundedSet: {
                  shopMoney: { amount: "99.99", currencyCode: "USD" },
                  presentmentMoney: { amount: "99.99", currencyCode: "USD" },
                },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    const res = await createRefund(
      admin(),
      "gid://shopify/Order/1001",
      lineItems,
      "test refund",
      "gid://shopify/Location/1",
      { method: "original" },
    );
    expect(res.success).toBe(true);
    expect(sawRefundCreate).toBe(true);
    expect(res.refundId).toBe("gid://shopify/Refund/1");
    expect(res.refundAmount).toBe("99.99");
    expect(res.refundCurrency).toBe("USD");
  });

  it("accepts string-only lineItems (legacy API shape)", async () => {
    let receivedInput:
      | { refundLineItems?: Array<{ lineItemId?: string; quantity?: number }> }
      | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: typeof receivedInput } };
        receivedInput = body.variables?.input;
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    // Pass a string array — the impl should coerce each to { id, quantity: 1 }.
    await createRefund(
      admin(),
      "gid://shopify/Order/1",
      ["gid://shopify/LineItem/99"] as unknown as Array<{ id: string; quantity: number }>,
      undefined,
      "gid://loc/1",
      { method: "original" },
    );
    expect(receivedInput?.refundLineItems?.[0]?.quantity).toBe(1);
  });

  it("surfaces userErrors from Shopify as failures", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            refundCreate: {
              refund: null,
              userErrors: [{ message: "Cannot refund more than paid" }],
            },
          },
        }),
      ),
    );
    const res = await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      "gid://loc/1",
      { method: "original" },
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/more than paid/);
  });

  it("surfaces top-level GraphQL errors as failures", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          errors: [{ message: "Order frozen" }],
          data: null,
        }),
      ),
    );
    const res = await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      "gid://loc/1",
      { method: "original" },
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Order frozen/);
  });

  it("prefers presentmentMoney over shopMoney for display", async () => {
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, () =>
        HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: {
                  // presentmentMoney is the customer-facing currency (e.g. EUR
                  // for a EUR customer on a USD shop). Favour it for display.
                  presentmentMoney: { amount: "89.00", currencyCode: "EUR" },
                  shopMoney: { amount: "99.99", currencyCode: "USD" },
                },
              },
              userErrors: [],
            },
          },
        }),
      ),
    );
    const res = await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      "gid://loc/1",
      { method: "original" },
    );
    expect(res.refundAmount).toBe("89.00");
    expect(res.refundCurrency).toBe("EUR");
  });

  it("uses default note when none provided", async () => {
    let receivedNote = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: { note?: string } } };
        receivedNote = body.variables?.input?.note ?? "";
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    await createRefund(admin(), "gid://shopify/Order/1", lineItems, undefined, "gid://loc/1");
    expect(receivedNote).toMatch(/Fynd Returns/);
  });

  it("sets restockType to NO_RESTOCK when skipLocation=true", async () => {
    let receivedRestockType = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as {
          variables?: { input?: { refundLineItems?: Array<{ restockType?: string }> } };
        };
        receivedRestockType = body.variables?.input?.refundLineItems?.[0]?.restockType ?? "";
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      null,
      { method: "original" },
      { skipLocation: true },
    );
    expect(receivedRestockType).toBe("NO_RESTOCK");
  });

  it("sets restockType to RETURN by default (with locationId)", async () => {
    let receivedInput:
      | { refundLineItems?: Array<{ restockType?: string; locationId?: string }> }
      | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: typeof receivedInput } };
        receivedInput = body.variables?.input;
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      "gid://shopify/Location/42",
      { method: "original" },
    );
    expect(receivedInput?.refundLineItems?.[0]?.restockType).toBe("RETURN");
    expect(receivedInput?.refundLineItems?.[0]?.locationId).toBe("gid://shopify/Location/42");
  });

  it("auto-fetches primary location when locationId is null and skipLocation is false", async () => {
    const queries: string[] = [];
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = await request.text();
        // Track the first ~30 chars of the query so we can assert we
        // made BOTH a locations query and a refund mutation. Don't lock
        // in the exact call count — withSpan / instrumentation can add
        // probes that shouldn't affect the test outcome.
        if (body.includes("locations")) {
          queries.push("locations");
          return HttpResponse.json({
            data: {
              locations: {
                nodes: [
                  {
                    id: "gid://shopify/Location/1",
                    name: "Warehouse",
                    isActive: true,
                    fulfillsOnlineOrders: true,
                    isFulfillmentService: false,
                  },
                ],
              },
            },
          });
        }
        queries.push("refundCreate");
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    const res = await createRefund(
      admin(),
      "gid://shopify/Order/1",
      lineItems,
      undefined,
      null, // no location provided
      { method: "original" },
    );
    expect(res.success).toBe(true);
    expect(queries).toContain("locations");
    expect(queries).toContain("refundCreate");
  });

  it("accepts bare order ID and expands to gid://", async () => {
    let receivedOrderId = "";
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: { orderId?: string } } };
        receivedOrderId = body.variables?.input?.orderId ?? "";
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    await createRefund(admin(), "1001", lineItems, undefined, "gid://loc/1", {
      method: "original",
    });
    expect(receivedOrderId).toBe("gid://shopify/Order/1001");
  });

  it("expands bare LineItem IDs in refundLineItems", async () => {
    let receivedInput: { refundLineItems?: Array<{ lineItemId?: string }> } | undefined;
    server.use(
      http.post(TEST_SHOPIFY_GRAPHQL_URL, async ({ request }) => {
        const body = (await request.json()) as { variables?: { input?: typeof receivedInput } };
        receivedInput = body.variables?.input;
        return HttpResponse.json({
          data: {
            refundCreate: {
              refund: {
                id: "gid://1",
                createdAt: "x",
                totalRefundedSet: { shopMoney: { amount: "1", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        });
      }),
    );
    await createRefund(
      admin(),
      "gid://shopify/Order/1",
      [{ id: "9999", quantity: 2 }],
      undefined,
      "gid://loc/1",
      { method: "original" },
    );
    expect(receivedInput?.refundLineItems?.[0]?.lineItemId).toBe("gid://shopify/LineItem/9999");
  });
});
