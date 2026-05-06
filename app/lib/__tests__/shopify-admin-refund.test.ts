/**
 * Focused unit tests for createRefund() in app/lib/shopify-admin.server.ts.
 *
 * These tests sit alongside (but do not modify) the broader
 * shopify-admin-deep.test.ts suite. They exercise the refundCreate
 * mutation, store-credit / both-method splits, COD-fallback behavior,
 * refundLocationId pass-through, refund-line-item shaping, partial
 * (transactionAmount) refunds, network-error rejection, GraphQL
 * userErrors propagation, and refund-amount currency formatting.
 *
 * No source modifications — only mocks of the AdminGraphQL client and
 * the observability layers (which would otherwise try to talk to a
 * real OTel collector during tests).
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

import { createRefund, type AdminGraphQL } from "../shopify-admin.server";

type Variables = Record<string, unknown> | undefined;
type GraphqlCall = { query: string; variables: Variables };
type CannedResponse =
  | unknown
  | Error
  | { status: number; body: unknown };

function makeAdmin(responses: CannedResponse[]): {
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
      const v = r as { status: number; body: unknown };
      return new Response(JSON.stringify(v.body), {
        status: v.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as unknown as AdminGraphQL, graphql, calls };
}

const LOCATIONS_OK = {
  data: { locations: { nodes: [{ id: "gid://shopify/Location/L1", name: "Main", isActive: true }] } },
};

function suggested(amount = "100.00", currency = "USD", withTxn = true) {
  return {
    data: {
      order: {
        suggestedRefund: {
          amountSet: { shopMoney: { amount, currencyCode: currency } },
          subtotalSet: { shopMoney: { amount, currencyCode: currency } },
          suggestedTransactions: withTxn
            ? [
                {
                  gateway: "shopify_payments",
                  parentTransaction: { id: "gid://shopify/OrderTransaction/T1" },
                  amountSet: { shopMoney: { amount, currencyCode: currency } },
                  kind: "SUGGESTED_REFUND",
                },
              ]
            : [],
        },
      },
    },
  };
}

function refundOk(opts: {
  id?: string;
  amount?: string;
  currency?: string;
  userErrors?: Array<{ field?: string; message: string }>;
} = {}) {
  return {
    data: {
      refundCreate: {
        refund: {
          id: opts.id ?? "gid://shopify/Refund/R1",
          createdAt: "2026-05-06T00:00:00Z",
          totalRefundedSet: {
            presentmentMoney: {
              amount: opts.amount ?? "100.00",
              currencyCode: opts.currency ?? "USD",
            },
          },
        },
        userErrors: opts.userErrors ?? [],
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRefund — happy path", () => {
  it("invokes the refundCreate mutation and returns mapped fields", async () => {
    const { admin, calls, graphql } = makeAdmin([
      LOCATIONS_OK,
      suggested(),
      refundOk(),
    ]);
    const r = await createRefund(admin, "gid://shopify/Order/42", [
      { id: "gid://shopify/LineItem/9", quantity: 2 },
    ]);
    expect(r.success).toBe(true);
    expect(r.refundId).toBe("gid://shopify/Refund/R1");
    expect(r.refundAmount).toBe("100.00");
    expect(r.refundCurrency).toBe("USD");
    expect(r.refundCreatedAt).toBe("2026-05-06T00:00:00Z");
    expect(r.refundMethod).toBe("original");
    // Three calls: locations, suggested-refund, refundCreate.
    expect(graphql).toHaveBeenCalledTimes(3);
    // Final call is the refundCreate mutation.
    expect(calls[2].query).toMatch(/refundCreate/);
  });
});

describe("createRefund — original-method (default)", () => {
  it("populates transactions from the suggested-refund response", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggested("75.50"), refundOk({ amount: "75.50" })]);
    await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    const input = calls[2].variables?.input as {
      transactions: Array<{ gateway: string; amount: string; parentId?: string; kind: string }>;
    };
    expect(input.transactions[0]).toMatchObject({
      gateway: "shopify_payments",
      amount: "75.50",
      kind: "REFUND",
      parentId: "gid://shopify/OrderTransaction/T1",
    });
  });

  it("treats absent refundMethodConfig as 'original'", async () => {
    const { admin } = makeAdmin([LOCATIONS_OK, suggested(), refundOk()]);
    const r = await createRefund(admin, "1", [{ id: "9", quantity: 1 }]);
    expect(r.refundMethod).toBe("original");
  });
});

describe("createRefund — store_credit method", () => {
  it("emits refundMethods.storeCreditRefund with the suggested total", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggested("250.00", "INR"),
      refundOk({ amount: "250.00", currency: "INR" }),
    ]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "store_credit" },
    );
    expect(r.success).toBe(true);
    expect(r.refundMethod).toBe("store_credit");
    const input = calls[2].variables?.input as {
      transactions: unknown[];
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string; currencyCode: string } } }>;
    };
    // Original-payment transactions are explicitly empty — money flows
    // exclusively through storeCreditRefund.
    expect(input.transactions).toEqual([]);
    expect(input.refundMethods[0].storeCreditRefund.amount).toEqual({
      amount: "250.00",
      currencyCode: "INR",
    });
  });
});

describe("createRefund — both method (split)", () => {
  it("splits refund into transactions + refundMethods using requested amounts", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggested("100.00", "USD"),
      refundOk(),
    ]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "both", storeCreditAmount: 70, originalAmount: 30 },
    );
    const input = calls[2].variables?.input as {
      transactions: Array<{ amount: string; gateway: string; parentId?: string }>;
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
    };
    expect(input.refundMethods[0].storeCreditRefund.amount.amount).toBe("70.00");
    expect(input.transactions[0].amount).toBe("30.00");
    expect(input.transactions[0].gateway).toBe("shopify_payments");
    expect(input.transactions[0].parentId).toBe("gid://shopify/OrderTransaction/T1");
  });

  it("uses storeCreditPct fallback split when amounts not explicit", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      suggested("200.00", "USD"),
      refundOk(),
    ]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "both", storeCreditPct: 75 },
    );
    const input = calls[2].variables?.input as {
      transactions: Array<{ amount: string }>;
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string } } }>;
    };
    // 75% of 200 = 150 store credit, 25% of 200 = 50 original.
    expect(input.refundMethods[0].storeCreditRefund.amount.amount).toBe("150.00");
    expect(input.transactions[0].amount).toBe("50.00");
  });
});

describe("createRefund — COD / zero-refundable fallback", () => {
  it("rejects store_credit when suggested amount is 0 (COD-style order)", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested("0.00", "INR", false),
    ]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "store_credit" },
    );
    expect(r.success).toBe(false);
    // Error message points the merchant at Discount-code refund / manual flow.
    expect(r.error).toMatch(/COD|zero refundable|Discount code|manually/i);
  });

  it("rejects 'both' when suggested amount is 0", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested("0.00", "INR", false),
    ]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "both", storeCreditAmount: 50, originalAmount: 50 },
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/zero refundable|COD|Discount code/i);
  });
});

describe("createRefund — refundLocationId pass-through", () => {
  it("threads explicit locationId into each refundLineItem and skips locations fetch", async () => {
    const { admin, calls, graphql } = makeAdmin([suggested(), refundOk()]);
    await createRefund(
      admin,
      "1001",
      [
        { id: "9", quantity: 2 },
        { id: "10", quantity: 1 },
      ],
      "with-loc",
      "gid://shopify/Location/Custom-77",
    );
    expect(graphql).toHaveBeenCalledTimes(2); // no locations call
    const input = calls[1].variables?.input as {
      refundLineItems: Array<{ lineItemId: string; quantity: number; restockType: string; locationId?: string }>;
    };
    for (const li of input.refundLineItems) {
      expect(li.locationId).toBe("gid://shopify/Location/Custom-77");
      expect(li.restockType).toBe("RETURN");
    }
  });
});

describe("createRefund — refundLineItem shaping", () => {
  it("maps {id, quantity} → {lineItemId, quantity, restockType}", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggested(), refundOk()]);
    await createRefund(admin, "1001", [{ id: "777", quantity: 3 }]);
    const input = calls[2].variables?.input as {
      refundLineItems: Array<{ lineItemId: string; quantity: number; restockType: string }>;
    };
    expect(input.refundLineItems).toHaveLength(1);
    expect(input.refundLineItems[0]).toMatchObject({
      lineItemId: "gid://shopify/LineItem/777",
      quantity: 3,
      restockType: "RETURN",
    });
  });

  it("uses NO_RESTOCK and omits locationId when skipLocation=true", async () => {
    const { admin, calls } = makeAdmin([suggested(), refundOk()]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      undefined,
      { skipLocation: true },
    );
    const input = calls[1].variables?.input as {
      refundLineItems: Array<{ restockType: string; locationId?: string }>;
    };
    expect(input.refundLineItems[0].restockType).toBe("NO_RESTOCK");
    expect(input.refundLineItems[0].locationId).toBeUndefined();
  });

  it("filters out line items whose quantity <= 0", async () => {
    const { admin, calls } = makeAdmin([LOCATIONS_OK, suggested(), refundOk()]);
    await createRefund(admin, "1001", [
      { id: "1", quantity: 1 },
      { id: "2", quantity: 0 },
      { id: "3", quantity: 2 },
    ]);
    const input = calls[2].variables?.input as {
      refundLineItems: Array<{ lineItemId: string; quantity: number }>;
    };
    expect(input.refundLineItems).toHaveLength(2);
    expect(input.refundLineItems.map((li) => li.lineItemId)).toEqual([
      "gid://shopify/LineItem/1",
      "gid://shopify/LineItem/3",
    ]);
  });
});

describe("createRefund — partial / transactionAmount split", () => {
  it("issues an amount-only refund without restocking line items", async () => {
    // isAmountOnly=true skips both the locations fetch AND the per-line-item
    // restock pathway, so only two graphql calls fire.
    const { admin, calls } = makeAdmin([suggested("100.00"), refundOk({ amount: "12.34" })]);
    const r = await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      undefined,
      { transactionAmount: 12.34 },
    );
    expect(r.success).toBe(true);
    const input = calls[1].variables?.input as {
      refundLineItems: unknown[];
      transactions: Array<{ amount: string; gateway: string; parentId?: string }>;
    };
    // Price-adjustment refund — line items are explicitly cleared so
    // we don't double-restock the goods.
    expect(input.refundLineItems).toEqual([]);
    expect(input.transactions).toHaveLength(1);
    expect(input.transactions[0].amount).toBe("12.34");
  });
});

describe("createRefund — error propagation", () => {
  it("rejects when admin.graphql throws (network error)", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested(),
      new Error("ECONNRESET: socket hang up"),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ECONNRESET|socket/i);
  });

  it("propagates GraphQL userErrors verbatim from the refundCreate response", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested(),
      {
        data: {
          refundCreate: {
            refund: null,
            userErrors: [{ field: ["input"], message: "Refund total exceeds order total." }],
          },
        },
      },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toBe("Refund total exceeds order total.");
    // refundMethod is still tagged so callers can route the error.
    expect(r.refundMethod).toBe("original");
  });

  it("propagates top-level GraphQL errors", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested(),
      { data: null, errors: [{ message: "Throttled" }] },
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Throttled/);
  });
});

describe("createRefund — currency formatting", () => {
  it("formats store-credit amount to two decimals regardless of input precision", async () => {
    const { admin, calls } = makeAdmin([
      LOCATIONS_OK,
      // Suggested amount with 4-decimal precision — Shopify sometimes returns this.
      suggested("123.4567", "EUR"),
      refundOk({ amount: "123.46", currency: "EUR" }),
    ]);
    await createRefund(
      admin,
      "1001",
      [{ id: "9", quantity: 1 }],
      undefined,
      undefined,
      { method: "store_credit" },
      { bonusAmount: 0 },
    );
    const input = calls[2].variables?.input as {
      refundMethods: Array<{ storeCreditRefund: { amount: { amount: string; currencyCode: string } } }>;
    };
    // Math.round(123.4567 * 100) / 100 = 123.46 → ".toFixed(2)" = "123.46".
    expect(input.refundMethods[0].storeCreditRefund.amount.amount).toBe("123.46");
    expect(input.refundMethods[0].storeCreditRefund.amount.currencyCode).toBe("EUR");
  });

  it("preserves presentmentMoney currency in the parsed result", async () => {
    const { admin } = makeAdmin([
      LOCATIONS_OK,
      suggested("99.99", "GBP"),
      refundOk({ amount: "99.99", currency: "GBP" }),
    ]);
    const r = await createRefund(admin, "1001", [{ id: "9", quantity: 1 }]);
    expect(r.refundCurrency).toBe("GBP");
    expect(r.refundAmount).toBe("99.99");
  });
});
