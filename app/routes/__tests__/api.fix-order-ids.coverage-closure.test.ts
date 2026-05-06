/**
 * Coverage closure for api.fix-order-ids.
 *
 * Targets:
 *   - line 288 col 105: `ri.shopifyLineItemId === "manual"` short-circuit
 *     in matchLineItems. Reached when at least one return item has
 *     shopifyLineItemId === "manual" AND another item forces the loop to run
 *     (i.e. needs fixing AND order resolution succeeds).
 *
 * Skipped (unreachable from current call chain):
 *   - line 48 inside resolveOrderByName — only called via
 *     getOrderNameVariants(candidate), which returns [] when the candidate
 *     trims to empty, so the inner `if (!clean) return null` is dead code.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, extractAffiliateMock, extractCustomerMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  extractAffiliateMock: vi.fn(() => null as string | null),
  extractCustomerMock: vi.fn(() => null as Record<string, string | undefined> | null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractAffiliateOrderIdFromFyndPayload: extractAffiliateMock,
  extractCustomerFromFyndPayload: extractCustomerMock,
}));

import { action } from "../api.fix-order-ids";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok" },
    admin: {},
  });
  extractAffiliateMock.mockReset().mockReturnValue(null);
  extractCustomerMock.mockReset().mockReturnValue(null);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1", shopDomain: "store.myshopify.com" });
  prismaMock.session.findFirst.mockResolvedValue({ shop: "store.myshopify.com", accessToken: "tok" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.fix-order-ids — closure", () => {
  it("matchLineItems skips items with shopifyLineItemId === 'manual' (line 288)", async () => {
    // Reach matchLineItems by:
    //   - shopifyOrderId is a valid GID (skips order-fix step)
    //   - one item needs fixing (forces loop entry)
    //   - one item is "manual" (exercises the short-circuit at line 288)
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-mix",
        returnRequestNo: "R-mix",
        shopifyOrderId: "gid://shopify/Order/123",
        shopifyOrderName: "#1001",
        fyndPayloadJson: null,
        items: [
          { id: "i-needs-fix", shopifyLineItemId: "bag-1", sku: "ABC-1", title: "Widget" },
          { id: "i-manual", shopifyLineItemId: "manual", sku: null, title: null },
        ],
      },
    ]);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          node: {
            lineItems: {
              edges: [
                { node: { id: "gid://shopify/LineItem/9001", title: "Widget", sku: "ABC-1" } },
              ],
            },
          },
        },
      }),
    );

    const res = await action({
      request: new Request("https://app.example/api/fix-order-ids", { method: "POST" }),
      params: {},
      context: {},
    } as never);

    const body = await res.json();
    // The "needs-fix" item must have been resolved
    expect(body.totalLineItemsFixed ?? body.lineItemsOnly).toBeGreaterThanOrEqual(1);
    // The "manual" item must NOT have been updated (skipped at line 288)
    const updateCalls = (prismaMock.returnItem.update as ReturnType<typeof vi.fn>).mock.calls;
    const manualUpdate = updateCalls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === "i-manual",
    );
    expect(manualUpdate).toBeUndefined();
  });
});
