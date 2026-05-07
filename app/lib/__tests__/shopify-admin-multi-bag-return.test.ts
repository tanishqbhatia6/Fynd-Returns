/**
 * Bug #12 — multi-bag → single Shopify return distribution.
 *
 * Customer complaint: a Shopify line item with qty=N had every unit
 * returned on Shopify even though only one bag was cancelled on Fynd.
 * Expected: each unit is its own Shopify returnLineItem, distributed
 * across fulfillment line items, summing to exactly the requested qty.
 *
 * This file pins the in-memory distribution loop in `createShopifyReturn`
 * (the GraphQL receiver is mocked) for two key scenarios:
 *  1. Single ReturnItem with qty=1 against a multi-qty FLI — only 1 unit
 *     should be in the returnRequestCreate input.
 *  2. Three ReturnItems with qty=1 each against three separate FLIs
 *     (the "multi-bag fan-out" shape that the portal produces post-fix
 *     for multi-qty Shopify lines split into per-unit Fynd bags) — the
 *     resulting return should have exactly 3 returnLineItems totaling 3.
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

/** One returnableFulfillmentLineItem per FLI given. Each has `quantity` set
 *  to the bag's per-unit qty. Multi-bag-same-SKU is modeled as multiple
 *  FLIs with quantity=1 each. */
function fulfillmentsRespMultiFli(
  flis: Array<{ id: string; lineItemId: string; sku?: string; qty?: number }>,
) {
  return {
    data: {
      returnableFulfillments: {
        edges: flis.map((f) => ({
          node: {
            returnableFulfillmentLineItems: {
              edges: [
                {
                  node: {
                    quantity: f.qty ?? 1,
                    fulfillmentLineItem: {
                      id: f.id,
                      lineItem: { id: f.lineItemId, sku: f.sku ?? "SKU-A" },
                    },
                  },
                },
              ],
            },
          },
        })),
      },
      returns: { edges: [] },
    },
  };
}

const RETURN_OK = {
  data: { returnCreate: { return: { id: "gid://shopify/Return/R-OK" }, userErrors: [] } },
};

beforeEach(() => vi.clearAllMocks());

describe("Bug #12 — multi-bag → single Shopify return", () => {
  it("emits exactly one returnLineItem with qty=1 when 1 bag of a multi-qty line is returned", async () => {
    // Order has 1 Shopify line item (LineItem/100) with qty=2, split into
    // 2 fulfillment line items (one bag each). Customer is returning ONLY
    // bag 1 (FLI/A). The Shopify return should have exactly 1 entry, qty=1.
    const { admin, calls } = makeAdmin([
      fulfillmentsRespMultiFli([
        { id: "gid://shopify/FulfillmentLineItem/A", lineItemId: "gid://shopify/LineItem/100" },
        { id: "gid://shopify/FulfillmentLineItem/B", lineItemId: "gid://shopify/LineItem/100" },
      ]),
      RETURN_OK,
    ]);
    const result = await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A", reasonCode: "DEFECTIVE" },
    ]);
    expect(result.success).toBe(true);
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    expect(createCall).toBeTruthy();
    const lineItems =
      (createCall!.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } })
        .returnInput.returnLineItems;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].quantity).toBe(1);
  });

  it("fans out 3 returnLineItems (one per FLI) for 3 separate bag-aware ReturnItems each qty=1", async () => {
    // Customer ticked 3 bag rows in the portal → 3 ReturnItems on the
    // ReturnCase, each with qty=1 targeting the same Shopify line GID.
    // ALL 3 fulfillment line items should be exhausted; total qty=3.
    const { admin, calls } = makeAdmin([
      fulfillmentsRespMultiFli([
        { id: "gid://shopify/FulfillmentLineItem/A", lineItemId: "gid://shopify/LineItem/100" },
        { id: "gid://shopify/FulfillmentLineItem/B", lineItemId: "gid://shopify/LineItem/100" },
        { id: "gid://shopify/FulfillmentLineItem/C", lineItemId: "gid://shopify/LineItem/100" },
      ]),
      RETURN_OK,
    ]);
    await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const lineItems =
      (createCall!.variables as { returnInput: { returnLineItems: Array<{ quantity: number; fulfillmentLineItemId: string }> } })
        .returnInput.returnLineItems;
    expect(lineItems).toHaveLength(3);
    expect(lineItems.map((l) => l.quantity)).toEqual([1, 1, 1]);
    // Each bag goes to its own fulfillment line item (no over-collapsing).
    const fliIds = lineItems.map((l) => l.fulfillmentLineItemId).sort();
    expect(fliIds).toEqual([
      "gid://shopify/FulfillmentLineItem/A",
      "gid://shopify/FulfillmentLineItem/B",
      "gid://shopify/FulfillmentLineItem/C",
    ]);
  });

  it("does NOT over-return: 1 ReturnItem with qty=1 against a single FLI of qty=3 stays at qty=1", async () => {
    // Order has 1 Shopify line item with qty=3 in a single fulfillment
    // (one FLI with quantity=3, NOT split). Customer wants only 1 unit
    // back. We must send qty=1, not 3.
    const { admin, calls } = makeAdmin([
      fulfillmentsRespMultiFli([
        {
          id: "gid://shopify/FulfillmentLineItem/SOLO",
          lineItemId: "gid://shopify/LineItem/100",
          qty: 3,
        },
      ]),
      RETURN_OK,
    ]);
    await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, sku: "SKU-A" },
    ]);
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const lineItems =
      (createCall!.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } })
        .returnInput.returnLineItems;
    expect(lineItems).toHaveLength(1);
    expect(lineItems[0].quantity).toBe(1);
  });

  it("caps qty at the FLI's own maxQty when requested qty exceeds it", async () => {
    // Customer asks to return qty=5 but the FLI only has 2 returnable.
    // Result should be qty=2 (capped), not qty=5.
    const { admin, calls } = makeAdmin([
      fulfillmentsRespMultiFli([
        {
          id: "gid://shopify/FulfillmentLineItem/A",
          lineItemId: "gid://shopify/LineItem/100",
          qty: 2,
        },
      ]),
      RETURN_OK,
    ]);
    await createShopifyReturn(admin, "gid://shopify/Order/1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 5, sku: "SKU-A" },
    ]);
    const createCall = calls.find((c) => c.query.includes("returnCreate"));
    const lineItems =
      (createCall!.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } })
        .returnInput.returnLineItems;
    expect(lineItems[0].quantity).toBe(2);
  });
});
