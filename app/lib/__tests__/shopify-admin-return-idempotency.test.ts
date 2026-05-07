/**
 * Bug #15 — duplicate Shopify-return creation when the customer initiated
 * 1 quantity on the portal but Shopify ended up with two separate returns
 * (R1 + R2) each carrying that one quantity. Total returned = 2 against a
 * customer request of 1.
 *
 * Root cause (full trace in commit message):
 *   `createShopifyReturn` was called twice for the same units because
 *   `!returnCase.shopifyReturnId` is the only guard; when the post-create
 *   `prisma.returnCase.update({ shopifyReturnId })` writeback failed
 *   silently (`.catch(() => {})`) the second trigger saw `null` and
 *   created another Shopify return.
 *
 * Defence layer added in this commit (and pinned by these tests):
 *   `createShopifyReturn` now scans the order's existing OPEN /
 *   REQUESTED / IN_PROGRESS returns. If any one of them already covers
 *   exactly the same `(fulfillmentLineItemId, quantity)` set we're about
 *   to send, the function returns that return's id WITHOUT firing
 *   `returnCreate`. Idempotent on accidental double-call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
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

import { createShopifyReturn, type AdminGraphQL } from "../shopify-admin.server";

type GraphqlCall = { query: string; variables?: Record<string, unknown> };

function makeAdmin(responses: Array<unknown | Error>): {
  admin: AdminGraphQL;
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let i = 0;
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, calls };
}

beforeEach(() => vi.clearAllMocks());

describe("Bug #15 — createShopifyReturn idempotency on duplicate-call", () => {
  it("returns the existing OPEN return's id when (FLI, qty) matches exactly — no second returnCreate fired", async () => {
    // Order has FLI/A (qty=3 fulfilled). An OPEN return R1 already exists
    // covering FLI/A qty=1. A second call asking to create the SAME return
    // (FLI/A qty=1) must return R1's id, NOT issue another returnCreate.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 3,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: {
                              id: "gid://shopify/LineItem/100",
                              sku: "SKU-A",
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R1",
                    status: "OPEN",
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: {
                                id: "gid://shopify/LineItem/100",
                                sku: "SKU-A",
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      // No returnCreate response — assert below that returnCreate is NOT called
    ]);

    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R1");
    // Only ONE GraphQL call (the returnableFulfillments query). returnCreate must not run.
    expect(calls).toHaveLength(1);
    expect(calls[0].query).not.toContain("returnCreate");
  });

  it("does NOT short-circuit when the existing return's qty differs", async () => {
    // R1 exists with FLI/A qty=2, but new request is for qty=1. Quantities
    // don't match → must fall through to returnCreate.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 3,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R1",
                    status: "OPEN",
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 2, // ← different from the requested qty=1
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          returnCreate: {
            return: { id: "gid://shopify/Return/R2-NEW" },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R2-NEW");
    // returnCreate must have run
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    expect(createCall).toBeTruthy();
  });

  it("does NOT short-circuit on a CLOSED return (terminal status)", async () => {
    // A CLOSED return for the same items should not be considered an
    // in-flight duplicate — it's already done. Allow new return.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 3,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R-OLD",
                    status: "CLOSED", // ← terminal, ignored
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          returnCreate: {
            return: { id: "gid://shopify/Return/R-NEW" },
            userErrors: [],
          },
        },
      },
    ]);

    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R-NEW");
  });

  it("matches across multi-line returns (same FLI set, same qty per FLI)", async () => {
    // R1 covers FLI/A qty=1 + FLI/B qty=1 (multi-bag fan-out). A retry
    // requesting the same shape should return R1's id.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 1,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                      {
                        node: {
                          quantity: 1,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/B",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R1",
                    status: "OPEN",
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/B",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R1");
    expect(calls).toHaveLength(1); // only the fulfillments query, no returnCreate
  });

  it("short-circuits when existing return covers SAME line-item GID + total qty (multi-fulfillment)", async () => {
    // The bug we're fixing: customer requested 1 unit of LI/100. R1 already
    // covers 1 unit of LI/100 (via FLI/A). Even though the order has another
    // FLI/B that COULD absorb the request, the customer's intent (1 unit of
    // LI/100) is already represented by R1 — so we must return R1's id
    // rather than make R2.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 1,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                      {
                        node: {
                          quantity: 1,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/B",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R1",
                    status: "OPEN",
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ]);

    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);

    // Customer wants 1 of LI/100; R1 already represents 1 of LI/100. Idempotent.
    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R1");
    expect(calls).toHaveLength(1); // no returnCreate
  });

  it("does NOT short-circuit when totals differ even if line-item GIDs overlap", async () => {
    // Customer requests qty=2 of LI/100. R1 covers qty=1 of LI/100 — totals
    // differ. Must create a new return for the additional unit.
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnableFulfillments: {
            edges: [
              {
                node: {
                  returnableFulfillmentLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 3,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/A",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          order: {
            returns: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/R1",
                    status: "OPEN",
                    returnLineItems: {
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              id: "gid://shopify/FulfillmentLineItem/A",
                              lineItem: { id: "gid://shopify/LineItem/100", sku: "SKU-A" },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      },
      {
        data: {
          returnCreate: {
            return: { id: "gid://shopify/Return/R-NEW" },
            userErrors: [],
          },
        },
      },
    ]);
    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 2, sku: "SKU-A" },
    ]);
    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R-NEW");
    expect(calls.find((c) => c.query.includes("returnCreate"))).toBeTruthy();
  });

  it("queries returns scoped to the specific order, not shop-wide (regression: prevents busy-shop misses)", async () => {
    // Earlier the query used `returns(first: 50)` at the top level of
    // Query, which returns shop-wide returns. On busy shops the freshly-
    // created return for THIS order rolls off the first 50 within seconds
    // (newer returns from other orders push it down), the idempotency
    // scan misses, and a duplicate Shopify return gets created.
    //
    // Pin: the query must read from `order(id: $orderId).returns`, not
    // top-level `returns`.
    const { admin, calls } = makeAdmin([
      { data: { returnableFulfillments: { edges: [] }, order: { returns: { edges: [] } } } },
    ]);
    await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);
    // Strip the `# ...` comment lines before matching so a comment that
    // happens to mention "Query.returns(...)" doesn't fool the assertion.
    const queryText = calls[0].query
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    // Must scope returns to this order
    expect(queryText).toMatch(/order\s*\(\s*id:\s*\$orderId\s*\)\s*\{[\s\S]*returns\s*\(/);
    // Exactly one `returns(first:...)` selector — inside the order block.
    // Two occurrences would mean a top-level shop-wide query was re-added
    // alongside the order-scoped one.
    const returnsCalls = queryText.match(/\breturns\s*\(\s*first:/g);
    expect(returnsCalls).not.toBeNull();
    expect(returnsCalls!.length).toBe(1);
  });
});
