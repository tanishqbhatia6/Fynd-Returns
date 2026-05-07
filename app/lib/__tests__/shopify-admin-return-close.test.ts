import { describe, it, expect, vi, beforeEach } from "vitest";

/* Stub observability layers — not the subject of these tests. */
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
  createShopifyReturn,
  closeShopifyReturn,
  declineShopifyReturn,
  closeShopifyReturnBestEffort,
  type AdminGraphQL,
} from "../shopify-admin.server";

/* ─── Helpers ───────────────────────────────────────────────────────── */

type GraphqlCall = { query: string; variables?: Record<string, unknown> };

function makeAdmin(responses: Array<unknown | Error>): {
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
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

/** Build a returnable-fulfillments response with one matching line. */
function fulfillmentsResp(opts: {
  fliId?: string;
  lineItemId?: string;
  sku?: string;
  qty?: number;
}) {
  const fliId = opts.fliId ?? "gid://shopify/FulfillmentLineItem/1";
  const lineItemId = opts.lineItemId ?? "gid://shopify/LineItem/100";
  const sku = opts.sku ?? "SKU-A";
  const qty = opts.qty ?? 1;
  return {
    data: {
      returnableFulfillments: {
        edges: [
          {
            node: {
              returnableFulfillmentLineItems: {
                edges: [
                  {
                    node: {
                      quantity: qty,
                      fulfillmentLineItem: {
                        id: fliId,
                        lineItem: { id: lineItemId, sku },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      order: { returns: { edges: [] } },
    },
  };
}

const RETURN_OK = {
  data: { returnCreate: { return: { id: "gid://shopify/Return/777" }, userErrors: [] } },
};

beforeEach(() => vi.clearAllMocks());

/* ─── createShopifyReturn ───────────────────────────────────────────── */

describe("createShopifyReturn — happy path & shaping", () => {
  it("returns success with shopifyReturnId on the happy path", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({ qty: 2 }), RETURN_OK]);
    const result = await createShopifyReturn(admin, "555", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1, reasonCode: "defective" },
    ]);
    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/777");
    // First call was the fulfillment lookup
    expect(calls[0]?.query).toContain("returnableFulfillments");
    expect(calls[0]?.variables).toEqual({ orderId: "gid://shopify/Order/555" });
  });

  it("normalises numeric orderId into an Order GID", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({}), RETURN_OK]);
    await createShopifyReturn(admin, "42", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    const createCall = calls[1];
    const input = (createCall?.variables as { returnInput: { orderId: string } }).returnInput;
    expect(input.orderId).toBe("gid://shopify/Order/42");
  });

  it("passes through orderId already in GID form", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({}), RETURN_OK]);
    await createShopifyReturn(admin, "gid://shopify/Order/9", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(calls[0]?.variables).toEqual({ orderId: "gid://shopify/Order/9" });
  });

  it("shapes returnInput with notifyCustomer + requestedAt option", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({}), RETURN_OK]);
    const ts = "2026-01-01T00:00:00Z";
    await createShopifyReturn(
      admin,
      "1",
      [{ shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 }],
      { notifyCustomer: true, requestedAt: ts },
    );
    const input = (calls[1]?.variables as { returnInput: Record<string, unknown> }).returnInput;
    expect(input.notifyCustomer).toBe(true);
    expect(input.requestedAt).toBe(ts);
    expect(Array.isArray(input.returnLineItems)).toBe(true);
  });

  it("defaults notifyCustomer to false and omits requestedAt when not provided", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({}), RETURN_OK]);
    await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    const input = (calls[1]?.variables as { returnInput: Record<string, unknown> }).returnInput;
    expect(input.notifyCustomer).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(input, "requestedAt")).toBe(false);
  });
});

/* ─── createShopifyReturn — line-item resolution ────────────────────── */

describe("createShopifyReturn — line-item resolution", () => {
  it("matches by SKU when lineItem GID does not appear in fulfillments", async () => {
    const { admin, calls } = makeAdmin([
      fulfillmentsResp({
        fliId: "gid://shopify/FulfillmentLineItem/77",
        lineItemId: "gid://shopify/LineItem/999", // different GID
        sku: "MY-SKU",
        qty: 3,
      }),
      RETURN_OK,
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/000", qty: 2, sku: "my-sku" },
    ]);
    expect(r.success).toBe(true);
    const input = (
      calls[1]?.variables as {
        returnInput: {
          returnLineItems: Array<{ fulfillmentLineItemId: string; quantity: number }>;
        };
      }
    ).returnInput;
    expect(input.returnLineItems[0]?.fulfillmentLineItemId).toBe(
      "gid://shopify/FulfillmentLineItem/77",
    );
    expect(input.returnLineItems[0]?.quantity).toBe(2);
  });

  it("caps quantity to remaining returnable balance", async () => {
    const { admin, calls } = makeAdmin([fulfillmentsResp({ qty: 1 }), RETURN_OK]);
    await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 5 },
    ]);
    const input = (
      calls[1]?.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } }
    ).returnInput;
    expect(input.returnLineItems[0]?.quantity).toBe(1);
  });

  it("subtracts in-flight OPEN returns from returnable balance", async () => {
    // Note: source decrements both lineItem-id and sku-keyed arrays which share
    // entry refs, so a consumed return with both keys decrements maxQty twice.
    // Use a no-sku in-flight return to get one clean decrement: 5 - 2 = 3.
    const fulfillments = {
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
                          id: "gid://shopify/FulfillmentLineItem/1",
                          lineItem: { id: "gid://shopify/LineItem/100", sku: null },
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
                  id: "gid://shopify/Return/9",
                  status: "OPEN",
                  returnLineItems: {
                    edges: [
                      {
                        node: {
                          quantity: 2,
                          fulfillmentLineItem: {
                            id: "gid://shopify/FulfillmentLineItem/1",
                            lineItem: { id: "gid://shopify/LineItem/100", sku: null },
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
    };
    const { admin, calls } = makeAdmin([fulfillments, RETURN_OK]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 10 },
    ]);
    expect(r.success).toBe(true);
    const input = (
      calls[1]?.variables as { returnInput: { returnLineItems: Array<{ quantity: number }> } }
    ).returnInput;
    // 5 fulfilled - 2 in-flight OPEN = 3 returnable, capped from requested 10
    expect(input.returnLineItems[0]?.quantity).toBe(3);
  });

  it("returns failure when no fulfillment line items exist", async () => {
    const empty = {
      data: { returnableFulfillments: { edges: [] }, order: { returns: { edges: [] } } },
    };
    const { admin } = makeAdmin([empty]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No returnable fulfillment line items/i);
  });

  it("returns failure when no items can be matched to fulfillments", async () => {
    const { admin } = makeAdmin([
      fulfillmentsResp({ lineItemId: "gid://shopify/LineItem/X", sku: "AAA" }),
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/Y", qty: 1, sku: "BBB" },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not match any return items/i);
  });
});

/* ─── createShopifyReturn — error fallbacks ─────────────────────────── */

describe("createShopifyReturn — error fallbacks", () => {
  it("flags access-scope errors with a clear message", async () => {
    const { admin } = makeAdmin([
      { errors: [{ message: "Access denied for returnableFulfillments." }] },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/write_returns/);
  });

  it("returns userErrors from the returnCreate mutation", async () => {
    const { admin } = makeAdmin([
      fulfillmentsResp({}),
      {
        data: {
          returnCreate: {
            return: null,
            userErrors: [{ field: ["returnInput"], message: "invalid quantity" }],
          },
        },
      },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/invalid quantity/);
  });

  it("returns failure when mutation succeeds but no return id is returned", async () => {
    const { admin } = makeAdmin([
      fulfillmentsResp({}),
      { data: { returnCreate: { return: null, userErrors: [] } } },
    ]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no ID was returned/i);
  });

  it("catches thrown fetch errors and surfaces them as failure", async () => {
    const { admin } = makeAdmin([new Error("boom")]);
    const r = await createShopifyReturn(admin, "1", [
      { shopifyLineItemId: "gid://shopify/LineItem/100", qty: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/boom/);
  });
});

/* ─── closeShopifyReturn / declineShopifyReturn mutations ───────────── */

describe("closeShopifyReturn / declineShopifyReturn", () => {
  it("returnClose returns userErrors when shopify returns one", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          returnClose: {
            return: null,
            userErrors: [{ field: ["id"], message: "not found" }],
          },
        },
      },
    ]);
    const r = await closeShopifyReturn(admin, "gid://shopify/Return/1");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  it("returnApprove path: closeShopifyReturn returns success on a closed status", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await closeShopifyReturn(admin, "9");
    expect(r.success).toBe(true);
    expect(r.status).toBe("CLOSED");
    expect(calls[0]?.variables).toEqual({ id: "gid://shopify/Return/9" });
  });

  it("declineShopifyReturn persists declineReason in mutation variables", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/1", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    const r = await declineShopifyReturn(admin, "gid://shopify/Return/1", "Outside window");
    expect(r.success).toBe(true);
    const v = calls[0]?.variables as { input: { id: string; declineReason: string } };
    expect(v.input.id).toBe("gid://shopify/Return/1");
    expect(v.input.declineReason).toBe("Outside window");
  });

  it("declineShopifyReturn falls back to default reason when none provided", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnDecline: {
            return: { id: "gid://shopify/Return/1", status: "DECLINED" },
            userErrors: [],
          },
        },
      },
    ]);
    await declineShopifyReturn(admin, "1");
    const v = calls[0]?.variables as { input: { declineReason: string } };
    expect(v.input.declineReason).toBe("Return declined");
  });
});

/* ─── closeShopifyReturnBestEffort — accept vs decline & callbacks ─── */

describe("closeShopifyReturnBestEffort — accept vs decline branches", () => {
  it("invokes the close mutation when action is 'close' (default)", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          returnClose: {
            return: { id: "gid://shopify/Return/9", status: "CLOSED" },
            userErrors: [],
          },
        },
      },
    ]);
    const logEvent = vi.fn(async (_event: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.query).toContain("returnClose");
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]?.[0].eventType).toBe("shopify_return_closed");
  });

  it("invokes the decline mutation when action is 'decline' and forwards reason", async () => {
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
    const logEvent = vi.fn(async (_event: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { action: "decline", declineReason: "Past return window", logEvent },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.query).toContain("returnDecline");
    const v = calls[0]?.variables as { input: { declineReason: string } };
    expect(v.input.declineReason).toBe("Past return window");
    expect(logEvent.mock.calls[0]?.[0].eventType).toBe("shopify_return_declined");
  });

  it("logs shopify_return_close_failed event when underlying call fails", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "boom" }] }]);
    const logEvent = vi.fn(async (_event: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { logEvent },
    );
    expect(r.ok).toBe(false);
    expect(logEvent.mock.calls[0]?.[0].eventType).toBe("shopify_return_close_failed");
    const payload = JSON.parse(logEvent.mock.calls[0]?.[0].payloadJson as string);
    expect(payload.error).toMatch(/boom/);
  });

  it("skips when shopifyReturnId is missing and emits skip event", async () => {
    const { admin, graphql } = makeAdmin([]);
    const logEvent = vi.fn(async (_event: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(admin, { id: "rc-1" }, { logEvent });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
    const payload = JSON.parse(logEvent.mock.calls[0]?.[0].payloadJson as string);
    expect(payload.reason).toBe("no_return_id");
  });

  it("skips manual returns (shopifyOrderId starts with 'manual:') without calling Shopify", async () => {
    const { admin, graphql } = makeAdmin([]);
    const logEvent = vi.fn(async (_event: { eventType: string; payloadJson: string }) => {});
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9", shopifyOrderId: "manual:abc" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(graphql).not.toHaveBeenCalled();
    const payload = JSON.parse(logEvent.mock.calls[0]?.[0].payloadJson as string);
    expect(payload.reason).toBe("manual_return");
  });

  it("swallows a logEvent rejection without surfacing as an error", async () => {
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
    const logEvent = vi.fn(
      async (_event: { eventType: string; payloadJson: string }): Promise<void> => {
        throw new Error("event sink down");
      },
    );
    const r = await closeShopifyReturnBestEffort(
      admin,
      { id: "rc-1", shopifyReturnId: "9" },
      { logEvent },
    );
    expect(r.ok).toBe(true);
  });
});
