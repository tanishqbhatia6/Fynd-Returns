/**
 * Bug #15 final defence — DB-level mutex around createShopifyReturn.
 *
 * Pinned scenarios:
 *   1. First worker wins the claim → calls createShopifyReturn, persists
 *      the real id, returns claimed=true.
 *   2. Concurrent worker loses the claim, sees a real id already set →
 *      returns the existing id, claimed=false, does NOT call create.
 *   3. Concurrent worker loses the claim, sees a `PENDING:` sentinel →
 *      skips quietly, claimed=false, does NOT call create.
 *   4. createShopifyReturn fails on the winner's call → sentinel reverts
 *      to null so a future retry can re-attempt.
 *   5. createShopifyReturn throws on the winner's call → sentinel reverts
 *      to null so a future retry can re-attempt; the throw propagates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, createShopifyReturnMock } = vi.hoisted(() => ({
  prismaMock: {
    returnCase: {
      updateMany: vi.fn<(...args: unknown[]) => Promise<{ count: number }>>(),
      update: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
      findUnique: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  },
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../shopify-admin.server", () => ({
  createShopifyReturn: createShopifyReturnMock,
}));
vi.mock("../observability/logger.server", () => ({
  refundLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { claimAndCreateShopifyReturn } from "../shopify-return-claim.server";

const ITEMS = [{ shopifyLineItemId: "gid://shopify/LineItem/1", qty: 1 }];

beforeEach(() => {
  prismaMock.returnCase.updateMany.mockReset();
  prismaMock.returnCase.update.mockReset();
  prismaMock.returnCase.findUnique.mockReset();
  createShopifyReturnMock.mockReset();
});

describe("claimAndCreateShopifyReturn — winner path", () => {
  it("when claim succeeds it calls createShopifyReturn and persists the real id", async () => {
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 1 });
    createShopifyReturnMock.mockResolvedValueOnce({
      success: true,
      shopifyReturnId: "gid://shopify/Return/R1",
    });
    prismaMock.returnCase.update.mockResolvedValueOnce({ id: "rc-1" });

    const result = await claimAndCreateShopifyReturn(
      "rc-1",
      { graphql: vi.fn() } as never,
      "gid://shopify/Order/1",
      ITEMS,
    );

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/R1");
    expect(result.claimed).toBe(true);
    expect(createShopifyReturnMock).toHaveBeenCalledOnce();
    // Final writeback puts the real id into shopifyReturnId
    const writebacks = prismaMock.returnCase.update.mock.calls as Array<[{ data: unknown }]>;
    expect(writebacks).toHaveLength(1);
    expect(writebacks[0][0].data).toEqual({ shopifyReturnId: "gid://shopify/Return/R1" });
  });
});

describe("claimAndCreateShopifyReturn — loser path", () => {
  it("when claim fails AND a real id is already persisted it returns that id without calling create", async () => {
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.returnCase.findUnique.mockResolvedValueOnce({
      shopifyReturnId: "gid://shopify/Return/EXISTING",
    });

    const result = await claimAndCreateShopifyReturn(
      "rc-1",
      { graphql: vi.fn() } as never,
      "gid://shopify/Order/1",
      ITEMS,
    );

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBe("gid://shopify/Return/EXISTING");
    expect(result.claimed).toBe(false);
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("when claim fails AND another worker holds a PENDING sentinel it skips quietly", async () => {
    prismaMock.returnCase.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.returnCase.findUnique.mockResolvedValueOnce({
      shopifyReturnId: "PENDING:abcd-1234",
    });

    const result = await claimAndCreateShopifyReturn(
      "rc-1",
      { graphql: vi.fn() } as never,
      "gid://shopify/Order/1",
      ITEMS,
    );

    expect(result.success).toBe(true);
    expect(result.shopifyReturnId).toBeUndefined();
    expect(result.claimed).toBe(false);
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });
});

describe("claimAndCreateShopifyReturn — failure paths", () => {
  it("when createShopifyReturn returns success=false it reverts the sentinel back to null", async () => {
    prismaMock.returnCase.updateMany
      .mockResolvedValueOnce({ count: 1 }) // initial claim succeeds
      .mockResolvedValueOnce({ count: 1 }); // revert succeeds
    createShopifyReturnMock.mockResolvedValueOnce({
      success: false,
      error: "no fulfillment line items",
    });

    const result = await claimAndCreateShopifyReturn(
      "rc-1",
      { graphql: vi.fn() } as never,
      "gid://shopify/Order/1",
      ITEMS,
    );

    expect(result.success).toBe(false);
    expect(result.claimed).toBe(true);
    // Two updateMany calls: 1) claim, 2) revert.
    const calls = prismaMock.returnCase.updateMany.mock.calls as Array<[{ data: unknown }]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].data).toEqual({ shopifyReturnId: null });
  });

  it("when createShopifyReturn throws it reverts the sentinel and rethrows", async () => {
    prismaMock.returnCase.updateMany
      .mockResolvedValueOnce({ count: 1 }) // initial claim
      .mockResolvedValueOnce({ count: 1 }); // revert
    createShopifyReturnMock.mockRejectedValueOnce(new Error("network down"));

    await expect(
      claimAndCreateShopifyReturn(
        "rc-1",
        { graphql: vi.fn() } as never,
        "gid://shopify/Order/1",
        ITEMS,
      ),
    ).rejects.toThrow("network down");

    const calls = prismaMock.returnCase.updateMany.mock.calls as Array<[{ data: unknown }]>;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].data).toEqual({ shopifyReturnId: null });
  });
});
