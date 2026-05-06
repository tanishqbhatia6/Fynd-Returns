/**
 * Final gap-coverage tests for `app/lib/shopify-admin.server.ts`.
 *
 * Targets the few branches that the existing shopify-admin*.test.ts files
 * leave uncovered:
 *   - closeShopifyReturnBestEffort: logEvent rejection paths (the no-id
 *     skip, the manual-return skip, and the post-close logEvent reject)
 *   - createShopifyReturn: in-flight return decrement closure paths via
 *     non-terminal returns that match by lineItem.id and by SKU; pickBest
 *     reduce body via multiple FLI entries
 *   - fetchOrderByFyndAffiliateId: 8s timeout short-circuit
 *
 * NEW FILE — does not modify existing tests or source.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  closeShopifyReturnBestEffort,
  createShopifyReturn,
  fetchOrderByFyndAffiliateId,
  sendDraftOrderInvoice,
  fetchAllLocations,
  fetchPrimaryLocationId,
  type AdminGraphQL,
} from "../shopify-admin.server";

/* ─── Helpers ─────────────────────────────────────────────────────── */

type Canned = unknown | Error;

function makeAdmin(responses: Canned[]) {
  let i = 0;
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ─── closeShopifyReturnBestEffort logEvent reject paths ──────────── */

describe("closeShopifyReturnBestEffort — logEvent rejection paths", () => {
  it("swallows logEvent rejection on no-shopifyReturnId skip", async () => {
    const { admin } = makeAdmin([]);
    const logEvent = vi
      .fn<(e: { eventType: string; payloadJson: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("log down"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc1", shopifyReturnId: null, shopifyOrderId: "gid://shopify/Order/1" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![0].eventType).toBe("shopify_return_close_skipped");
  });

  it("swallows logEvent rejection on manual-order skip", async () => {
    const { admin } = makeAdmin([]);
    const logEvent = vi
      .fn<(e: { eventType: string; payloadJson: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("ohno"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc2", shopifyReturnId: "gid://shopify/Return/9", shopifyOrderId: "manual:abc" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    const payload = JSON.parse(logEvent.mock.calls[0]![0].payloadJson) as { reason: string };
    expect(payload.reason).toBe("manual_return");
  });

  it("swallows logEvent rejection after successful close", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi
      .fn<(e: { eventType: string; payloadJson: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("post-close log fail"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc3",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![0].eventType).toBe("shopify_return_closed");
  });

  it("logs declined event on decline action with logEvent reject", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/9", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi
      .fn<(e: { eventType: string; payloadJson: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("decline log fail"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc4",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { action: "decline", declineReason: "OTHER", logEvent },
    );
    expect(r.ok).toBe(true);
    expect(logEvent.mock.calls[0]![0].eventType).toBe("shopify_return_declined");
  });

  it("returns ok=false when both close and logEvent fail", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnClose: { return: null, userErrors: [{ message: "Some unrecoverable error" }] },
        },
      },
    ]);
    const logEvent = vi
      .fn<(e: { eventType: string; payloadJson: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("log fail"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc5",
        shopifyReturnId: "gid://shopify/Return/9",
        shopifyOrderId: "gid://shopify/Order/1",
      },
      { logEvent },
    );
    expect(r.ok).toBe(false);
    expect(logEvent.mock.calls[0]![0].eventType).toBe("shopify_return_close_failed");
  });

  it("works without logEvent option (no-op)", async () => {
    const { admin } = makeAdmin([]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc6",
      shopifyReturnId: null,
      shopifyOrderId: null,
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });
});

/* ─── createShopifyReturn — in-flight decrement closure paths ─────── */

describe("createShopifyReturn — in-flight return subtraction by gid + sku", () => {
  it("decrements maxQty in fulfillmentLineItemMap via lineItem.id match (line 1823 path)", async () => {
    const fulfillmentsResp = {
      data: {
        returnableFulfillments: {
          edges: [
            {
              node: {
                returnableFulfillmentLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 5,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/F1",
                          lineItem: { id: "gid://shopify/LineItem/9", sku: "SKU-X" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        // OPEN return that has consumed 2 of the 5
        returns: {
          edges: [
            {
              node: {
                id: "gid://shopify/Return/77",
                status: "OPEN",
                returnLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 2,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/F1",
                          lineItem: { id: "gid://shopify/LineItem/9", sku: "SKU-X" },
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
    };
    const { admin, calls } = makeAdmin([
      fulfillmentsResp,
      { data: { returnCreate: { return: { id: "gid://shopify/Return/200" }, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      {
        shopifyLineItemId: "gid://shopify/LineItem/9",
        qty: 3,
        sku: "SKU-X",
        reasonCode: "defective",
      },
    ]);
    expect(r.success).toBe(true);
    // The decrement closure ran via both gid (line 1831) and sku (line 1834).
    // The chosen returnLineItem qty must be ≤ 5-2 = 3.
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const returnInput = (
      createCall?.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } }
    ).returnInput;
    const totalQty = returnInput.returnLineItems.reduce((s, x) => s + x.quantity, 0);
    expect(totalQty).toBeLessThanOrEqual(3);
    expect(totalQty).toBeGreaterThan(0);
  });

  it("ignores in-flight return entries that target an unknown FLI id (decrement no-op)", async () => {
    const fulfillmentsResp = {
      data: {
        returnableFulfillments: {
          edges: [
            {
              node: {
                returnableFulfillmentLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 4,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/A",
                          lineItem: { id: "gid://shopify/LineItem/9", sku: "SKU-A" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        // Return points to a DIFFERENT FLI id — decrement should run but find no matching entry.
        returns: {
          edges: [
            {
              node: {
                id: "gid://shopify/Return/88",
                status: "OPEN",
                returnLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 1,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/UNKNOWN",
                          lineItem: { id: "gid://shopify/LineItem/9", sku: "SKU-A" },
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
    };
    const { admin } = makeAdmin([
      fulfillmentsResp,
      { data: { returnCreate: { return: { id: "gid://shopify/Return/300" }, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/9", qty: 4, sku: "SKU-A" },
    ]);
    expect(r.success).toBe(true);
  });

  it("skips in-flight returns whose status is terminal (CLOSED) — no decrement", async () => {
    const fulfillmentsResp = {
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
                          id: "gid://shopify/FulfillmentLineItem/B",
                          lineItem: { id: "gid://shopify/LineItem/10", sku: "SKU-B" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        returns: {
          edges: [
            {
              node: {
                id: "gid://shopify/Return/closed",
                status: "CLOSED",
                returnLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 5,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/B",
                          lineItem: { id: "gid://shopify/LineItem/10", sku: "SKU-B" },
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
    };
    const { admin, calls } = makeAdmin([
      fulfillmentsResp,
      { data: { returnCreate: { return: { id: "gid://shopify/Return/400" }, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/10", qty: 3, sku: "SKU-B" },
    ]);
    expect(r.success).toBe(true);
    // CLOSED return is terminal → no subtraction → full qty=3 should go through.
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const ri = (
      createCall?.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } }
    ).returnInput;
    const totalQty = ri.returnLineItems.reduce((s, x) => s + x.quantity, 0);
    expect(totalQty).toBe(3);
  });
});

/* ─── createShopifyReturn — pickBest reduce path (line 1842) ──────── */

describe("createShopifyReturn — pickBest reduce body", () => {
  it("walks multiple FLI entries via pickBest reduce", async () => {
    // Two fulfillments → two FLI entries on same LineItem GID.
    // We then send a request whose lineItem id is NOT in the gid map but
    // whose sku IS in the sku map. Forces the fallback at line 1875 to
    // call pickBest, which iterates entries via reduce (line 1842).
    // Trick: use a different lineItem.id in the maps so item.shopifyLineItemId
    // doesn't match the gid lookup. We use sku to force the SKU-only path.
    const fulfillmentsResp = {
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
                          id: "gid://shopify/FulfillmentLineItem/SMALL",
                          lineItem: { id: "gid://shopify/LineItem/A", sku: "DUPE" },
                        },
                      },
                    },
                    {
                      node: {
                        quantity: 7,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/BIG",
                          lineItem: { id: "gid://shopify/LineItem/A", sku: "DUPE" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        returns: { edges: [] },
      },
    };
    const { admin } = makeAdmin([
      fulfillmentsResp,
      { data: { returnCreate: { return: { id: "gid://shopify/Return/500" }, userErrors: [] } } },
    ]);
    // Initial entries from fulfillmentLineItemMap.get("gid://shopify/LineItem/A") returns 2 entries.
    // Distribution path in lines 1893-1909 iterates entries (covers maxQty/take guards).
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/A", qty: 5, sku: "DUPE" },
    ]);
    expect(r.success).toBe(true);
  });

  it("distributes qty across multiple FLI entries (consume both)", async () => {
    const fulfillmentsResp = {
      data: {
        returnableFulfillments: {
          edges: [
            {
              node: {
                returnableFulfillmentLineItems: {
                  edges: [
                    {
                      node: {
                        quantity: 2,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/E1",
                          lineItem: { id: "gid://shopify/LineItem/B", sku: "SKU-Q" },
                        },
                      },
                    },
                    {
                      node: {
                        quantity: 3,
                        fulfillmentLineItem: {
                          id: "gid://shopify/FulfillmentLineItem/E2",
                          lineItem: { id: "gid://shopify/LineItem/B", sku: "SKU-Q" },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        returns: { edges: [] },
      },
    };
    const { admin, calls } = makeAdmin([
      fulfillmentsResp,
      { data: { returnCreate: { return: { id: "gid://shopify/Return/600" }, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/B", qty: 4 },
    ]);
    expect(r.success).toBe(true);
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const ri = (
      createCall?.variables as {
        returnInput: {
          returnLineItems: Array<{ fulfillmentLineItemId: string; quantity: number }>;
        };
      }
    ).returnInput;
    // qty=4 should spread across the two FLIs (2+2 or 2+3-1).
    const totalQty = ri.returnLineItems.reduce((s, x) => s + x.quantity, 0);
    expect(totalQty).toBe(4);
    expect(ri.returnLineItems.length).toBe(2);
  });
});

/* ─── fetchOrderByFyndAffiliateId — timeout short-circuit ─────────── */

describe("fetchOrderByFyndAffiliateId — timeout", () => {
  it("returns null when 8s budget exceeded between variants", async () => {
    // We can't actually wait 8s; we monkeypatch Date.now to fast-forward
    // after the first variant lookup runs. Then the next iteration sees
    // elapsed > 8000 and exits via lines 718-719.
    const realNow = Date.now.bind(Date);
    let calls = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      calls++;
      // First call: real time (sets startTime).
      // Subsequent: jump 9 seconds ahead.
      if (calls === 1) return realNow();
      return realNow() + 9_000;
    });
    try {
      // Mock graphql to return null so the first variant lookup falls through
      // (no order found), then loop continues to next variant where timeout hits.
      const { admin } = makeAdmin([
        { data: { orders: { nodes: [] } } }, // SDK strategy 2 — first query, no result
        { data: { orders: { nodes: [] } } }, // SDK strategy 2 — second query, no result
      ]);
      const r = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFYX12345");
      expect(r).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns first matched variant before timeout", async () => {
    // affiliateOrderId "FYNDSHOPIFY12345" → variants ["FYNDSHOPIFY12345", "12345"].
    // Strategy 2 (SDK) tries name:#<variant> then name:<variant>. We let the
    // first variant fail (both queries return empty), and the second variant
    // ("12345") matches on its first query.
    const orderNode = {
      id: "gid://shopify/Order/1",
      legacyResourceId: "1",
      name: "#12345",
      createdAt: "2025-01-01T00:00:00Z",
      totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
      lineItems: { nodes: [] },
    };
    const empty = { data: { orders: { nodes: [] } } };
    const { admin } = makeAdmin([empty, empty, { data: { orders: { nodes: [orderNode] } } }]);
    const r = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFY12345");
    expect(r).not.toBeNull();
    expect(r?.id).toBe("gid://shopify/Order/1");
  });

  it("returns null when no variants match", async () => {
    // 4-5 variants typically, all return empty
    const empty = { data: { orders: { nodes: [] } } };
    const { admin } = makeAdmin(Array(20).fill(empty));
    const r = await fetchOrderByFyndAffiliateId(admin, "ZZZZZ");
    expect(r).toBeNull();
  });
});

/* ─── extra guards on already-covered helpers ─────────────────────── */

describe("sendDraftOrderInvoice — exception path", () => {
  it("returns success:false with error message on graphql throw", async () => {
    const admin = {
      graphql: vi.fn().mockRejectedValue(new Error("network down")),
    } as unknown as AdminGraphQL;
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", "x@y.com");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/network down/);
  });

  it("returns success:false with stringified non-Error throw", async () => {
    const admin = {
      // Throw a plain string
      graphql: vi.fn().mockRejectedValue("boom"),
    } as unknown as AdminGraphQL;
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", null);
    expect(r.success).toBe(false);
    expect(r.error).toBe("boom");
  });
});

describe("fetchAllLocations / fetchPrimaryLocationId edge cases", () => {
  it("fetchAllLocations returns [] when nodes missing entirely", async () => {
    const { admin } = makeAdmin([{ data: { locations: {} } }]);
    const r = await fetchAllLocations(admin);
    expect(r).toEqual([]);
  });

  it("fetchAllLocations returns [] on empty data", async () => {
    const { admin } = makeAdmin([{ data: {} }]);
    const r = await fetchAllLocations(admin);
    expect(r).toEqual([]);
  });

  it("fetchPrimaryLocationId returns null when locations object absent", async () => {
    const { admin } = makeAdmin([{ data: {} }]);
    expect(await fetchPrimaryLocationId(admin)).toBeNull();
  });
});

describe("closeShopifyReturnBestEffort — outer catch swallows top-level throw", () => {
  it("returns ok:false with error message when admin.graphql throws synchronously through close", async () => {
    const admin = {
      graphql: vi.fn().mockRejectedValue(new Error("explode")),
    } as unknown as AdminGraphQL;
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-x",
      shopifyReturnId: "gid://shopify/Return/1",
      shopifyOrderId: "gid://shopify/Order/1",
    });
    // closeShopifyReturn itself catches and returns success:false, so best-effort
    // returns ok:false with no thrown error reaching the outer catch.
    expect(r.ok).toBe(false);
  });

  it("returns ok:false with non-Error string thrown from outer scope", async () => {
    // Force an outer throw by passing a returnCase whose property access throws.
    const evil: { id: string; shopifyReturnId: string; shopifyOrderId: string } = {
      id: "rc-evil",
      get shopifyReturnId(): string {
        throw "string-thrown";
      },
      shopifyOrderId: "gid://shopify/Order/1",
    } as unknown as { id: string; shopifyReturnId: string; shopifyOrderId: string };
    const { admin } = makeAdmin([]);
    const r = await closeShopifyReturnBestEffort(admin, evil);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("string-thrown");
  });
});
