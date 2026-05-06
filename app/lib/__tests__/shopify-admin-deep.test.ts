import { describe, it, expect, vi, beforeEach } from "vitest";

/* Stub observability layers so tests don't try to talk to a real OTel
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
  createRefund,
  closeShopifyReturnBestEffort,
  fetchOrderByOrderNumber,
  fetchOrderByGid,
  fetchOrderByFyndAffiliateId,
  fetchVariantInfo,
  sendDraftOrderInvoice,
  fetchOrderLineItemsOnly,
  fetchOrderLineItemsByName,
  fetchAllLocations,
  fetchOrdersForCustomer,
  OrderAccessError,
  type AdminGraphQL,
} from "../shopify-admin.server";

/* ─── Helpers ───────────────────────────────────────────────────────── */

type GraphqlCall = { query: string; variables?: Record<string, unknown> };

/**
 * Build a mock AdminGraphQL whose `graphql()` returns canned JSON responses
 * keyed by call order. `responses[i]` is consumed on the i-th call.
 */
function makeAdmin(responses: Array<unknown | Error | { status: number; body: unknown }>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let i = 0;
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "status" in r && "body" in r) {
      return new Response(JSON.stringify((r as { body: unknown }).body), {
        status: (r as { status: number }).status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

/** Build a primary-location response (used by createRefund when restock=true). */
const LOCATIONS_OK = {
  data: {
    locations: { nodes: [{ id: "gid://shopify/Location/1", name: "Main", isActive: true }] },
  },
};

/** Suggested-refund happy-path canned response. */
function suggestedRefund(amount = "100.00", currency = "USD") {
  return {
    data: {
      order: {
        suggestedRefund: {
          amountSet: { shopMoney: { amount, currencyCode: currency } },
          subtotalSet: { shopMoney: { amount, currencyCode: currency } },
          suggestedTransactions: [
            {
              gateway: "shopify_payments",
              parentTransaction: { id: "gid://shopify/OrderTransaction/9001" },
              amountSet: { shopMoney: { amount, currencyCode: currency } },
              kind: "SUGGESTED_REFUND",
            },
          ],
        },
      },
    },
  };
}

function refundCreateOk(id = "gid://shopify/Refund/1", amount = "100.00", currency = "USD") {
  return {
    data: {
      refundCreate: {
        refund: {
          id,
          createdAt: "2026-05-01T00:00:00Z",
          totalRefundedSet: { presentmentMoney: { amount, currencyCode: currency } },
        },
        userErrors: [],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ─── createRefund ──────────────────────────────────────────────────── */

describe("createRefund", () => {
  it("rejects when no line items and no transactionAmount", async () => {
    const { admin } = makeAdmin([]);
    const r = await createRefund(admin, "1001", []);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No line items/i);
  });

  it("performs a happy-path original-payment refund", async () => {
    const { admin, graphql } = makeAdmin([
      LOCATIONS_OK, // fetchPrimaryLocationId
      suggestedRefund(), // SUGGEST_REFUND_QUERY
      refundCreateOk(), // REFUND_MUTATION
    ]);
    const r = await createRefund(admin, "1001", [{ id: "gid://shopify/LineItem/9", quantity: 1 }]);
    expect(r.success).toBe(true);
    expect(r.refundId).toBe("gid://shopify/Refund/1");
    expect(r.refundAmount).toBe("100.00");
    expect(r.refundMethod).toBe("original");
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("uses GID-prefixed orderId when given a numeric id", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggestedRefund(), refundCreateOk()]);
    await createRefund(admin, "555", [{ id: "1", quantity: 1 }]);
    const mutation = calls[2].variables?.input as { orderId: string };
    expect(mutation.orderId).toBe("gid://shopify/Order/555");
  });

  it("normalizes string lineItem ids to {id, quantity:1}", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggestedRefund(), refundCreateOk()]);
    await createRefund(admin, "1001", ["gid://shopify/LineItem/77"]);
    const input = calls[2].variables?.input as {
      refundLineItems: Array<{ lineItemId: string; quantity: number }>;
    };
    expect(input.refundLineItems[0]).toMatchObject({
      lineItemId: "gid://shopify/LineItem/77",
      quantity: 1,
    });
  });

  it("skips primary-location fetch when skipLocation=true", async () => {
    const { admin, graphql } = makeAdmin([suggestedRefund(), refundCreateOk()]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "gid://shopify/LineItem/9", quantity: 1 }],
      undefined,
      undefined,
      undefined,
      { skipLocation: true },
    );
    expect(r.success).toBe(true);
    // Two calls only: suggestRefund + refundCreate (no locations call).
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("uses caller-provided locationId without fetching primary", async () => {
    const { admin, graphql, calls } = makeAdmin([suggestedRefund(), refundCreateOk()]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      "test note",
      "gid://shopify/Location/42",
    );
    expect(graphql).toHaveBeenCalledTimes(2);
    const input = calls[1].variables?.input as { refundLineItems: Array<{ locationId: string }> };
    expect(input.refundLineItems[0].locationId).toBe("gid://shopify/Location/42");
  });

  it("issues a store_credit refund using suggested totalAmount", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund("250.00", "INR"),
      refundCreateOk("gid://shopify/Refund/2", "250.00", "INR"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "store_credit",
    });
    expect(r.success).toBe(true);
    expect(r.refundMethod).toBe("store_credit");
    const input = calls[2].variables?.input as {
      refundMethods: Array<{
        storeCreditRefund: { amount: { amount: string; currencyCode: string } };
      }>;
    };
    expect(input.refundMethods[0].storeCreditRefund.amount).toEqual({
      amount: "250.00",
      currencyCode: "INR",
    });
  });

  it("adds bonusAmount on top of store_credit refund", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund("100.00", "USD"),
      refundCreateOk("gid://shopify/Refund/3", "110.00", "USD"),
    ]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "store_credit" },
      { bonusAmount: 10 },
    );
    const input = calls[2].variables?.input as {
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
    };
    expect(input.refundMethods[0].storeCreditRefund.amount.amount).toBe("110.00");
  });

  it("splits a 'both' refund using requested storeCredit + original amounts", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund("100.00", "USD"),
      refundCreateOk(),
    ]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
      storeCreditAmount: 60,
      originalAmount: 40,
    });
    const input = calls[2].variables?.input as {
      refundMethods?: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
      transactions?: Array<{ amount: string }>;
    };
    expect(input.refundMethods?.[0].storeCreditRefund.amount.amount).toBe("60.00");
    expect(input.transactions?.[0].amount).toBe("40.00");
  });

  it("rejects 'both' when split exceeds suggested refund total", async () => {
    const { admin } = makeAdmin([LOCATIONS_OK, suggestedRefund("100.00", "USD")]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
      storeCreditAmount: 80,
      originalAmount: 80,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/exceeds Shopify's refundable amount/i);
  });

  it("falls back to storeCreditPct split when amounts are not provided", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund("100.00", "USD"),
      refundCreateOk(),
    ]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "both",
      storeCreditPct: 70,
    });
    const input = calls[2].variables?.input as {
      refundMethods?: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
      transactions?: Array<{ amount: string }>;
    };
    expect(input.refundMethods?.[0].storeCreditRefund.amount.amount).toBe("70.00");
    expect(input.transactions?.[0].amount).toBe("30.00");
  });

  it("returns clear error when store_credit suggested amount is 0", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      {
        data: {
          order: {
            suggestedRefund: {
              amountSet: { shopMoney: { amount: "0", currencyCode: "USD" } },
              suggestedTransactions: [],
            },
          },
        },
      },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, {
      method: "store_credit",
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/zero refundable amount/i);
  });

  it("uses transactionAmount override when provided (price-difference refund)", async () => {
    // isAmountOnly=true → skips fetchPrimaryLocationId.
    const { admin, calls } = makeAdmin([suggestedRefund("200.00", "USD"), refundCreateOk()]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], undefined, undefined, undefined, {
      transactionAmount: 25,
    });
    const input = calls[1].variables?.input as {
      transactions: Array<{ amount: string }>;
      refundLineItems: unknown[];
    };
    expect(input.transactions[0].amount).toBe("25.00");
    expect(input.refundLineItems).toEqual([]);
  });

  it("retries with NO_RESTOCK when initial response has location/restock error", async () => {
    const { admin, graphql } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund(),
      // First refundCreate fails with a restock-related userError
      {
        data: {
          refundCreate: {
            refund: null,
            userErrors: [
              {
                field: ["input", "refundLineItems"],
                message: "Invalid restock location for line item.",
              },
            ],
          },
        },
      },
      refundCreateOk("gid://shopify/Refund/retry", "100.00", "USD"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(true);
    expect(r.refundId).toBe("gid://shopify/Refund/retry");
    expect(graphql).toHaveBeenCalledTimes(4);
  });

  it("returns userError verbatim for non-restock failures", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund(),
      {
        data: {
          refundCreate: {
            refund: null,
            userErrors: [{ field: ["input"], message: "Order has been archived" }],
          },
        },
      },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/archived/);
  });

  it("returns error on non-OK HTTP status from refund mutation", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggestedRefund(),
      { status: 500, body: { data: null } },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Shopify API error \(500\)/);
  });

  it("returns error message when graphql throws", async () => {
    const { admin } = makeAdmin([LOCATIONS_OK, suggestedRefund(), new Error("network down")]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/network down/);
  });

  it("uses 'Return processed via Fynd Returns' as default note", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggestedRefund(), refundCreateOk()]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    const input = calls[2].variables?.input as { note: string };
    expect(input.note).toBe("Return processed via Fynd Returns");
  });

  it("preserves caller-provided note", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggestedRefund(), refundCreateOk()]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }], "Custom reason");
    const input = calls[2].variables?.input as { note: string };
    expect(input.note).toBe("Custom reason");
  });
});

/* ─── closeShopifyReturnBestEffort ──────────────────────────────────── */

describe("closeShopifyReturnBestEffort", () => {
  it("skips when no shopifyReturnId and emits skip event", async () => {
    const { admin, graphql } = makeAdmin([]);
    const logEvent = vi.fn().mockResolvedValue(undefined);
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: null },
      { logEvent },
    );
    expect(r).toEqual({ ok: true, skipped: true });
    expect(graphql).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "shopify_return_close_skipped",
      }),
    );
  });

  it("skips manual returns (shopifyOrderId starts with 'manual:')", async () => {
    const { admin, graphql } = makeAdmin([]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "gid://shopify/Return/1",
      shopifyOrderId: "manual:abc",
    });
    expect(r).toEqual({ ok: true, skipped: true });
    expect(graphql).not.toHaveBeenCalled();
  });

  it("close branch: success when returnClose returns a status", async () => {
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
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "9",
    });
    expect(r.ok).toBe(true);
    expect(r.alreadyClosed).toBe(false);
  });

  it("close branch: detects already-closed via top-level errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Return already closed" }] }]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "gid://shopify/Return/9",
    });
    expect(r.ok).toBe(true);
    expect(r.alreadyClosed).toBe(true);
  });

  it("close branch: detects already-closed via userErrors", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnClose: { return: null, userErrors: [{ message: "Return is already CLOSED" }] },
        },
      },
    ]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "gid://shopify/Return/9",
    });
    expect(r.ok).toBe(true);
    expect(r.alreadyClosed).toBe(true);
  });

  it("close branch: returns ok=false on non-recoverable userError", async () => {
    const { admin } = makeAdmin([
      { data: { returnClose: { return: null, userErrors: [{ message: "Unauthorized" }] } } },
    ]);
    const r = await closeShopifyReturnBestEffort(admin, {
      id: "rc-1",
      shopifyReturnId: "9",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unauthorized/);
  });

  it("decline branch: success path", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/9", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc-1",
        shopifyReturnId: "9",
      },
      { action: "decline", declineReason: "Customer change of mind" },
    );
    expect(r.ok).toBe(true);
    const vars = calls[0].variables as { input: { id: string; declineReason: string } };
    expect(vars.input.declineReason).toBe("Customer change of mind");
  });

  it("decline branch: detects already-declined via userErrors", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: null,
            userErrors: [{ message: "Cannot decline a return that is already DECLINED" }],
          },
        },
      },
    ]);
    const r = await closeShopifyReturnBestEffort(
      admin,
      {
        id: "rc-1",
        shopifyReturnId: "9",
      },
      { action: "decline" },
    );
    expect(r.ok).toBe(true);
    expect(r.alreadyClosed).toBe(true);
  });

  it("emits 'shopify_return_closed' on success", async () => {
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
    const logEvent = vi.fn().mockResolvedValue(undefined);
    await closeShopifyReturnBestEffort(admin, { id: "rc-1", shopifyReturnId: "9" }, { logEvent });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "shopify_return_closed" }),
    );
  });

  it("emits 'shopify_return_declined' on successful decline", async () => {
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
    const logEvent = vi.fn().mockResolvedValue(undefined);
    await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { action: "decline", logEvent },
    );
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "shopify_return_declined" }),
    );
  });

  it("emits 'shopify_return_close_failed' on hard failure", async () => {
    const { admin } = makeAdmin([
      { data: { returnClose: { return: null, userErrors: [{ message: "boom" }] } } },
    ]);
    const logEvent = vi.fn().mockResolvedValue(undefined);
    await closeShopifyReturnBestEffort(admin, { id: "rc-1", shopifyReturnId: "9" }, { logEvent });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "shopify_return_close_failed" }),
    );
  });

  it("never throws even when logEvent rejects", async () => {
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
    const logEvent = vi.fn().mockRejectedValue(new Error("kafka down"));
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
  });
});

/* ─── fetchOrderByGid ───────────────────────────────────────────────── */

describe("fetchOrderByGid", () => {
  it("returns null for empty/non-gid input", async () => {
    const { admin, graphql } = makeAdmin([]);
    expect(await fetchOrderByGid(admin, "")).toBeNull();
    expect(await fetchOrderByGid(admin, "1001")).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns parsed order on happy path", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orderByIdentifier: {
            id: "gid://shopify/Order/1001",
            name: "#1001",
            createdAt: "2026-04-01T00:00:00Z",
            email: "buyer@example.com",
            totalPriceSet: { shopMoney: { amount: "50.00", currencyCode: "USD" } },
            customAttributes: [{ key: "affiliate_order_id", value: "FY-1" }],
            lineItems: { nodes: [] },
            fulfillments: [],
          },
        },
      },
    ]);
    const order = await fetchOrderByGid(admin, "gid://shopify/Order/1001");
    expect(order).not.toBeNull();
    expect(order?.name).toBe("#1001");
    expect(order?.affiliateOrderId).toBe("FY-1");
  });

  it("throws OrderAccessError when error mentions 'protected'", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Customer data is protected" }] }]);
    await expect(fetchOrderByGid(admin, "gid://shopify/Order/1")).rejects.toBeInstanceOf(
      OrderAccessError,
    );
  });

  it("returns null on generic GraphQL errors (no PCDA keyword)", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "Something went wrong" }] }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when graphql throws (network)", async () => {
    const { admin } = makeAdmin([new Error("ECONNRESET")]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when orderByIdentifier is null", async () => {
    const { admin } = makeAdmin([{ data: { orderByIdentifier: null } }]);
    expect(await fetchOrderByGid(admin, "gid://shopify/Order/1")).toBeNull();
  });
});

/* ─── fetchOrderByOrderNumber ───────────────────────────────────────── */

describe("fetchOrderByOrderNumber", () => {
  it("returns null for empty input", async () => {
    const { admin } = makeAdmin([]);
    expect(await fetchOrderByOrderNumber(admin, "")).toBeNull();
    expect(await fetchOrderByOrderNumber(admin, "#")).toBeNull();
  });

  it("delegates to fetchOrderByGid for gid:// inputs", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          orderByIdentifier: {
            id: "gid://shopify/Order/1",
            name: "#1",
            createdAt: "2026-01-01T00:00:00Z",
            totalPriceSet: { shopMoney: { amount: "1.00", currencyCode: "USD" } },
            customAttributes: [],
            lineItems: { nodes: [] },
            fulfillments: [],
          },
        },
      },
    ]);
    const o = await fetchOrderByOrderNumber(admin, "gid://shopify/Order/1");
    expect(o?.id).toBe("gid://shopify/Order/1");
    expect(calls[0].variables).toMatchObject({ id: "gid://shopify/Order/1" });
  });

  it("falls back to SDK searchOrders when no REST credentials are attached", async () => {
    // Without _rest, only the SDK search path runs (two queries: name:#X and name:X).
    const { admin, graphql } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/2",
                name: "#1001",
                createdAt: "2026-01-01T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "1.00", currencyCode: "USD" } },
                customAttributes: [],
                lineItems: { nodes: [] },
                fulfillments: [],
              },
            ],
          },
        },
      },
    ]);
    const o = await fetchOrderByOrderNumber(admin, "1001");
    expect(o?.name).toBe("#1001");
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("returns null for purely numeric names with no matches (no metafield retry)", async () => {
    const { admin, graphql } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // name:#1001
      { data: { orders: { nodes: [] } } }, // name:1001
    ]);
    expect(await fetchOrderByOrderNumber(admin, "1001")).toBeNull();
    // Should not attempt the metafield query — the regex /^\d+$/ short-circuits.
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("falls through to metafield search for non-numeric names", async () => {
    const { admin, graphql } = makeAdmin([
      { data: { orders: { nodes: [] } } }, // name:#FYNDX
      { data: { orders: { nodes: [] } } }, // name:FYNDX
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/3",
                name: "#1234",
                createdAt: "2026-01-01T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "1.00", currencyCode: "USD" } },
                customAttributes: [],
                lineItems: { nodes: [] },
                fulfillments: [],
              },
            ],
          },
        },
      }, // metafield query
    ]);
    const o = await fetchOrderByOrderNumber(admin, "FYNDX");
    expect(o).not.toBeNull();
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("strips a leading # before searching", async () => {
    const { admin, calls } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    await fetchOrderByOrderNumber(admin, "#1001");
    expect((calls[0].variables as { query: string }).query).toBe("name:#1001");
  });
});

/* ─── fetchOrderByFyndAffiliateId ───────────────────────────────────── */

describe("fetchOrderByFyndAffiliateId", () => {
  it("returns null when no variants are extractable", async () => {
    const { admin, graphql } = makeAdmin([]);
    expect(await fetchOrderByFyndAffiliateId(admin, "")).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("tries each variant and returns the first match", async () => {
    // Variants of "FYNDSHOPIFYX14126" are: ["FYNDSHOPIFYX14126", "X14126", "14126"]
    // FYNDSHOPIFYX14126 path runs SDK search ×2 then metafield search ×1 (non-numeric).
    // Then X14126 path runs SDK search ×2 then metafield search ×1 (non-numeric).
    // Then 14126 path runs SDK search ×2 — purely numeric, no metafield. We make
    // the very first call return a hit so we only do one query.
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/5",
                name: "#FYNDSHOPIFYX14126",
                createdAt: "2026-01-01T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "1.00", currencyCode: "USD" } },
                customAttributes: [],
                lineItems: { nodes: [] },
                fulfillments: [],
              },
            ],
          },
        },
      },
    ]);
    const o = await fetchOrderByFyndAffiliateId(admin, "FYNDSHOPIFYX14126");
    expect(o?.name).toBe("#FYNDSHOPIFYX14126");
  });

  it("returns null when no variant matches", async () => {
    // "14126" is purely numeric → 2 search calls, no metafield.
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    expect(await fetchOrderByFyndAffiliateId(admin, "14126")).toBeNull();
  });

  it("propagates OrderAccessError from underlying lookup", async () => {
    const { admin } = makeAdmin([
      // SDK search throws PCDA via top-level errors
      { errors: [{ message: "Order data not approved" }] },
    ]);
    await expect(fetchOrderByFyndAffiliateId(admin, "14126")).rejects.toBeInstanceOf(
      OrderAccessError,
    );
  });
});

/* ─── fetchVariantInfo ──────────────────────────────────────────────── */

describe("fetchVariantInfo", () => {
  it("returns empty map for empty input", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await fetchVariantInfo(admin, []);
    expect(out.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("filters out empty/blank ids before calling graphql", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await fetchVariantInfo(admin, ["", "   "]);
    expect(out.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("normalizes numeric ids to gid form before calling", async () => {
    const { admin, calls } = makeAdmin([{ data: { nodes: [] } }]);
    await fetchVariantInfo(admin, ["12345"]);
    const ids = (calls[0].variables as { ids: string[] }).ids;
    expect(ids[0]).toBe("gid://shopify/ProductVariant/12345");
  });

  it("returns variant info on happy path with tracked inventory", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/100",
              sku: "SKU-1",
              title: "M / Blue",
              availableForSale: true,
              inventoryQuantity: 7,
              inventoryItem: { tracked: true },
              price: "19.99",
              compareAtPrice: "29.99",
              image: { url: "https://cdn.shop/v.jpg" },
              product: { id: "gid://shopify/Product/9", title: "Tee", featuredImage: null },
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/100"]);
    const v = out.get("gid://shopify/ProductVariant/100");
    expect(v).toBeDefined();
    expect(v?.sku).toBe("SKU-1");
    expect(v?.inventoryAvailable).toBe(7);
    expect(v?.availableForSale).toBe(true);
    expect(v?.compareAtPrice).toBe("29.99");
    expect(v?.imageUrl).toBe("https://cdn.shop/v.jpg");
    expect(v?.productId).toBe("gid://shopify/Product/9");
    expect(v?.productTitle).toBe("Tee");
  });

  it("returns null inventoryAvailable when tracked=false", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/200",
              inventoryItem: { tracked: false },
              inventoryQuantity: 0,
              availableForSale: true,
              price: "10.00",
              product: null,
              title: "Default",
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/200"]);
    expect(out.get("gid://shopify/ProductVariant/200")?.inventoryAvailable).toBeNull();
  });

  it("falls back to product featured image when variant image is missing", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/300",
              inventoryItem: { tracked: true },
              inventoryQuantity: 5,
              availableForSale: true,
              price: "5.00",
              image: null,
              product: {
                id: "gid://shopify/Product/30",
                title: "P",
                featuredImage: { url: "https://cdn/p.jpg" },
              },
              title: "Default",
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/300"]);
    expect(out.get("gid://shopify/ProductVariant/300")?.imageUrl).toBe("https://cdn/p.jpg");
  });

  it("skips null nodes returned by Shopify (variant deleted)", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [null] } }]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/x"]);
    expect(out.size).toBe(0);
  });

  it("returns empty map on non-OK HTTP status", async () => {
    const { admin } = makeAdmin([{ status: 500, body: { data: null } }]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/x"]);
    expect(out.size).toBe(0);
  });

  it("returns empty map on graphql error throw", async () => {
    const { admin } = makeAdmin([new Error("boom")]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/x"]);
    expect(out.size).toBe(0);
  });

  it("logs but still returns data when GraphQL errors are present", async () => {
    const { admin } = makeAdmin([
      {
        errors: [{ message: "Field deprecated" }],
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/400",
              inventoryItem: { tracked: true },
              inventoryQuantity: 1,
              availableForSale: true,
              price: "9.99",
              product: { id: "gid://shopify/Product/4", title: "X", featuredImage: null },
              title: "Default",
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/400"]);
    expect(out.size).toBe(1);
  });
});

/* ─── sendDraftOrderInvoice ─────────────────────────────────────────── */

describe("sendDraftOrderInvoice", () => {
  it("returns invoiceUrl on success", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/1",
              name: "D1",
              invoiceUrl: "https://shopify/invoice/abc",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", "buyer@example.com");
    expect(r.success).toBe(true);
    expect(r.invoiceUrl).toBe("https://shopify/invoice/abc");
  });

  it("passes default subject + customMessage when caller omits them", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "x", name: "x", invoiceUrl: null },
            userErrors: [],
          },
        },
      },
    ]);
    await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", "buyer@example.com");
    const vars = calls[0].variables as { email: { subject: string; customMessage: string } };
    expect(vars.email.subject).toBe("Complete your exchange");
    expect(vars.email.customMessage).toMatch(/complete payment/i);
  });

  it("respects caller-provided subject and body", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "x", name: "x", invoiceUrl: null },
            userErrors: [],
          },
        },
      },
    ]);
    await sendDraftOrderInvoice(
      admin,
      "gid://shopify/DraftOrder/1",
      "buyer@example.com",
      "Hi",
      "Body!",
    );
    const vars = calls[0].variables as { email: { subject: string; customMessage: string } };
    expect(vars.email.subject).toBe("Hi");
    expect(vars.email.customMessage).toBe("Body!");
  });

  it("sends email=null when no customer email is provided", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "x", name: "x", invoiceUrl: null },
            userErrors: [],
          },
        },
      },
    ]);
    await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", null);
    const vars = calls[0].variables as { email: unknown };
    expect(vars.email).toBeNull();
  });

  it("returns error on top-level graphql errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "DraftOrder not found" }] }]);
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", null);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("returns error joined from multiple userErrors", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: null,
            userErrors: [{ message: "no email" }, { message: "draft completed" }],
          },
        },
      },
    ]);
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", null);
    expect(r.success).toBe(false);
    expect(r.error).toBe("no email; draft completed");
  });

  it("returns error message when graphql throws", async () => {
    const { admin } = makeAdmin([new Error("net")]);
    const r = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/1", null);
    expect(r.success).toBe(false);
    expect(r.error).toBe("net");
  });
});

/* ─── fetchOrderLineItemsOnly ───────────────────────────────────────── */

describe("fetchOrderLineItemsOnly", () => {
  it("returns parsed line items on success", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/Order/1",
              name: "#1",
              lineItems: {
                nodes: [
                  { id: "gid://shopify/LineItem/10", title: "Tee", sku: "T-1", quantity: 2 },
                  { id: "gid://shopify/LineItem/11", title: "Hat", sku: null, quantity: 1 },
                ],
              },
            },
          ],
        },
      },
    ]);
    const r = await fetchOrderLineItemsOnly(admin, "1");
    expect(r?.id).toBe("gid://shopify/Order/1");
    expect(r?.lineItems.length).toBe(2);
    expect(r?.lineItems[0]).toEqual({
      id: "gid://shopify/LineItem/10",
      title: "Tee",
      sku: "T-1",
      quantity: 2,
    });
    expect(r?.lineItems[1].sku).toBeNull();
  });

  it("normalizes numeric orderId to a Shopify GID", async () => {
    const { admin, calls } = makeAdmin([{ data: { nodes: [] } }]);
    await fetchOrderLineItemsOnly(admin, "123");
    expect((calls[0].variables as { ids: string[] }).ids[0]).toBe("gid://shopify/Order/123");
  });

  it("returns null when nodes is empty", async () => {
    const { admin } = makeAdmin([{ data: { nodes: [] } }]);
    expect(await fetchOrderLineItemsOnly(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when graphql throws", async () => {
    const { admin } = makeAdmin([new Error("net")]);
    expect(await fetchOrderLineItemsOnly(admin, "gid://shopify/Order/1")).toBeNull();
  });

  it("returns null when there are top-level errors and no useful node", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "x" }], data: { nodes: [] } }]);
    expect(await fetchOrderLineItemsOnly(admin, "gid://shopify/Order/1")).toBeNull();
  });
});

/* ─── fetchOrderLineItemsByName ─────────────────────────────────────── */

describe("fetchOrderLineItemsByName", () => {
  it("returns null when input is empty", async () => {
    const { admin, graphql } = makeAdmin([]);
    expect(await fetchOrderLineItemsByName(admin, "")).toBeNull();
    expect(await fetchOrderLineItemsByName(admin, "#")).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
  });

  it("returns matched order's line items (exact name match)", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/2",
                name: "#2002",
                lineItems: { nodes: [{ id: "li-1", title: "X", sku: "X-1", quantity: 1 }] },
              },
              {
                id: "gid://shopify/Order/1",
                name: "#1001",
                lineItems: { nodes: [{ id: "li-2", title: "Y", sku: null, quantity: 3 }] },
              },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrderLineItemsByName(admin, "1001");
    expect(r?.name).toBe("#1001");
    expect(r?.lineItems[0].title).toBe("Y");
    expect(r?.lineItems[0].sku).toBeNull();
  });

  it("ignores fuzzy matches that don't normalize to the requested name", async () => {
    const { admin, graphql } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/9",
                name: "#X-DIFFERENT",
                lineItems: { nodes: [{ id: "x", title: "x", sku: null, quantity: 1 }] },
              },
            ],
          },
        },
      },
      { data: { orders: { nodes: [] } } },
    ]);
    expect(await fetchOrderLineItemsByName(admin, "1001")).toBeNull();
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("returns null when both name queries return empty", async () => {
    const { admin } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    expect(await fetchOrderLineItemsByName(admin, "1001")).toBeNull();
  });

  it("returns null when error responses come back without REST creds", async () => {
    const { admin } = makeAdmin([
      { errors: [{ message: "oops" }] },
      { errors: [{ message: "oops" }] },
    ]);
    expect(await fetchOrderLineItemsByName(admin, "1001")).toBeNull();
  });

  it("strips leading # before searching", async () => {
    const { admin, calls } = makeAdmin([
      { data: { orders: { nodes: [] } } },
      { data: { orders: { nodes: [] } } },
    ]);
    await fetchOrderLineItemsByName(admin, "#1001");
    expect((calls[0].variables as { query: string }).query).toBe("name:#1001");
  });
});

/* ─── fetchAllLocations ─────────────────────────────────────────────── */

describe("fetchAllLocations", () => {
  it("returns parsed location list", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", name: "Main", isActive: true },
              { id: "gid://shopify/Location/2", name: "Warehouse", isActive: false },
            ],
          },
        },
      },
    ]);
    const r = await fetchAllLocations(admin);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ id: "gid://shopify/Location/1", name: "Main", isActive: true });
    expect(r[1].isActive).toBe(false);
  });

  it("defaults isActive=true when missing on payload", async () => {
    const { admin } = makeAdmin([
      {
        data: { locations: { nodes: [{ id: "gid://shopify/Location/1", name: "X" }] } },
      },
    ]);
    const r = await fetchAllLocations(admin);
    expect(r[0].isActive).toBe(true);
  });

  it("returns [] on top-level GraphQL errors", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "scope missing" }] }]);
    const r = await fetchAllLocations(admin);
    expect(r).toEqual([]);
  });

  it("returns [] on empty nodes", async () => {
    const { admin } = makeAdmin([{ data: { locations: { nodes: [] } } }]);
    expect(await fetchAllLocations(admin)).toEqual([]);
  });

  it("returns [] when graphql throws", async () => {
    const { admin } = makeAdmin([new Error("network")]);
    expect(await fetchAllLocations(admin)).toEqual([]);
  });
});

/* ─── fetchOrdersForCustomer ────────────────────────────────────────── */

describe("fetchOrdersForCustomer", () => {
  it("returns empty array on non-OK HTTP", async () => {
    const { admin } = makeAdmin([{ status: 500, body: { data: null } }]);
    const r = await fetchOrdersForCustomer(admin, "buyer@example.com");
    expect(r).toEqual([]);
  });

  it("returns empty array when graphql throws", async () => {
    const { admin } = makeAdmin([new Error("net")]);
    expect(await fetchOrdersForCustomer(admin, "buyer@example.com")).toEqual([]);
  });

  it("clamps maxOrders to 50", async () => {
    const { admin, calls } = makeAdmin([{ data: { orders: { nodes: [] } } }]);
    await fetchOrdersForCustomer(admin, "buyer@example.com", 1000);
    expect((calls[0].variables as { first: number }).first).toBe(50);
  });

  it("builds an `email:` query string", async () => {
    const { admin, calls } = makeAdmin([{ data: { orders: { nodes: [] } } }]);
    await fetchOrdersForCustomer(admin, "x@y.z");
    expect((calls[0].variables as { query: string }).query).toBe("email:x@y.z");
  });

  it("maps customer info, refunds, and currency fallbacks", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/1",
                name: "#1",
                email: "buyer@example.com",
                phone: null,
                createdAt: "2026-04-01T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
                totalRefundedSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
                displayFinancialStatus: "PARTIALLY_REFUNDED",
                customer: {
                  id: "gid://shopify/Customer/1",
                  firstName: "Alice",
                  lastName: "Doe",
                  email: null,
                  phone: "+15551234567",
                  numberOfOrders: "8",
                  amountSpent: { amount: "742.50", currencyCode: "USD" },
                  defaultAddress: { city: "Austin", country: "US", phone: null },
                },
                shippingAddress: { name: "Alice Doe", phone: "+1-shipping", city: "Houston" },
                refunds: [
                  {
                    id: "gid://shopify/Refund/9",
                    createdAt: "2026-04-02T00:00:00Z",
                    note: "size",
                    totalRefundedSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrdersForCustomer(admin, "buyer@example.com");
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({
      orderName: "#1",
      customerName: "Alice Doe",
      customerCity: "Austin",
      customerCountry: "US",
      customerPhone: "+15551234567",
      totalOrderAmount: 100,
      totalRefundedAmount: 10,
      lifetimeOrderCount: 8,
      lifetimeSpent: 742.5,
      financialStatus: "PARTIALLY_REFUNDED",
    });
    expect(r[0].refunds.length).toBe(1);
    expect(r[0].refunds[0].amount).toBe(10);
    expect(r[0].refunds[0].note).toBe("size");
  });

  it("falls back to shipping name when customer lacks first/last names", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/2",
                name: "#2",
                email: null,
                phone: null,
                createdAt: "2026-04-02T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "0", currencyCode: "USD" } },
                customer: { firstName: null, lastName: null, defaultAddress: null },
                shippingAddress: { name: "Bob from Shipping", country: "DE", phone: "+49" },
                refunds: [],
              },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrdersForCustomer(admin, "x@y.z");
    expect(r[0].customerName).toBe("Bob from Shipping");
    expect(r[0].customerCountry).toBe("DE");
    expect(r[0].customerPhone).toBe("+49");
  });

  it("returns sane defaults when both customer and shippingAddress are missing", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          orders: {
            nodes: [
              {
                id: "gid://shopify/Order/3",
                name: "#3",
                email: "anon@example.com",
                createdAt: "2026-04-03T00:00:00Z",
                totalPriceSet: { shopMoney: { amount: "5.00", currencyCode: "EUR" } },
                customer: null,
                shippingAddress: null,
                refunds: [],
              },
            ],
          },
        },
      },
    ]);
    const r = await fetchOrdersForCustomer(admin, "anon@example.com");
    expect(r[0]).toMatchObject({
      customerName: null,
      customerPhone: null,
      customerCity: null,
      customerCountry: null,
      lifetimeOrderCount: null,
      lifetimeSpent: null,
      refundCurrency: "EUR",
    });
  });
});
