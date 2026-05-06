/**
 * Loader tests for app.returns._index.tsx — the returns listing page.
 * Covers tile counts, status filter (single + comma-separated), pagination
 * math, search query OR clause across all 8 fields, resolution/channel/date
 * filters, and the error fallback shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));

import { loader } from "../app.returns._index";

const SHOP = {
  id: "shop-1",
  shopDomain: "store.myshopify.com",
  settings: { shopLocale: "en", shopTimezone: "UTC" },
};

function mkReq(qs = "") {
  return new Request(`https://app.example/app/returns${qs ? `?${qs}` : ""}`);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  prismaMock.shop.findUnique.mockResolvedValue(SHOP);
});

describe("app.returns._index loader", () => {
  it("creates the shop record on first visit when not yet provisioned", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce(SHOP);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
      }),
    );
  });

  it("returns the five tile counts (total/pending/inProgress/approved/rejected/all)", async () => {
    // Promise.all order: returns, totalCount, pending, inProgress, approved, rejected, all
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count
      .mockResolvedValueOnce(0) // totalCount
      .mockResolvedValueOnce(5) // pendingCount (pending+initiated)
      .mockResolvedValueOnce(3) // inProgressCount
      .mockResolvedValueOnce(7) // approvedCount
      .mockResolvedValueOnce(2) // rejectedCount
      .mockResolvedValueOnce(17); // allCount
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data).toMatchObject({
      pendingCount: 5,
      inProgressCount: 3,
      approvedCount: 7,
      rejectedCount: 2,
      allCount: 17,
    });
  });

  it("tile count queries scope to shopId only (ignore filters)", async () => {
    await loader({ request: mkReq("status=approved&query=foo"), params: {}, context: {} } as never);
    // The "allCount" query is the last count call — must filter only by shopId
    const calls = prismaMock.returnCase.count.mock.calls;
    expect(calls[calls.length - 1][0]).toEqual({ where: { shopId: "shop-1" } });
  });

  it("pending tile counts BOTH 'pending' and 'initiated'", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    const calls = prismaMock.returnCase.count.mock.calls;
    // Index 2 = pendingCount (totalCount is index 1; main count is 0... actually:
    // calls order: totalCount(0), pending(1), inProgress(2), approved(3), rejected(4), all(5))
    expect(calls[1][0]).toEqual({
      where: { shopId: "shop-1", status: { in: ["pending", "initiated"] } },
    });
  });

  it("in-progress tile counts both 'processing' and 'in progress'", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    const calls = prismaMock.returnCase.count.mock.calls;
    expect(calls[2][0]).toEqual({
      where: { shopId: "shop-1", status: { in: ["processing", "in progress"] } },
    });
  });

  it("approved tile counts both 'approved' and 'completed'", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    const calls = prismaMock.returnCase.count.mock.calls;
    expect(calls[3][0]).toEqual({
      where: { shopId: "shop-1", status: { in: ["approved", "completed"] } },
    });
  });

  it("treats single-value status as equality (not `in`)", async () => {
    await loader({ request: mkReq("status=approved"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "approved" }),
      }),
    );
  });

  it("treats comma-separated status as `in` clause and trims whitespace", async () => {
    await loader({
      request: mkReq("status=pending%2C%20initiated"),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["pending", "initiated"] } }),
      }),
    );
  });

  it("filters out empty entries from comma-separated status", async () => {
    await loader({ request: mkReq("status=approved%2C%2C"), params: {}, context: {} } as never);
    // Only "approved" survives → falls back to equality
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "approved" }),
      }),
    );
  });

  it("applies pagination skip/take based on page param", async () => {
    await loader({ request: mkReq("page=3"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25 }),
    );
  });

  it("clamps page to minimum of 1 (negative or zero becomes 1)", async () => {
    await loader({ request: mkReq("page=-5"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 25 }),
    );
  });

  it("computes totalPages from totalCount / PAGE_SIZE", async () => {
    prismaMock.returnCase.count.mockResolvedValueOnce(60); // first count = totalCount
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.totalPages).toBe(3); // ceil(60/25) = 3
  });

  it("builds OR clause across all 8 search fields when query is provided", async () => {
    await loader({ request: mkReq("query=ABC123"), params: {}, context: {} } as never);
    const findManyCall = prismaMock.returnCase.findMany.mock.calls[0][0];
    const where = findManyCall.where as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toHaveLength(8);
    const fields = where.OR.map((c) => Object.keys(c)[0]);
    expect(fields).toEqual(
      expect.arrayContaining([
        "shopifyOrderName",
        "returnRequestNo",
        "fyndOrderId",
        "forwardAwb",
        "returnAwb",
        "fyndReturnNo",
        "customerEmailNorm",
        "customerPhoneNorm",
      ]),
    );
    // Each clause uses contains + insensitive
    for (const clause of where.OR) {
      const inner = Object.values(clause)[0] as Record<string, unknown>;
      expect(inner).toEqual({ contains: "ABC123", mode: "insensitive" });
    }
  });

  it("trims whitespace from query and skips OR clause when empty", async () => {
    await loader({ request: mkReq("query=%20%20%20"), params: {}, context: {} } as never);
    const findManyCall = prismaMock.returnCase.findMany.mock.calls[0][0];
    const where = findManyCall.where as Record<string, unknown>;
    expect(where.OR).toBeUndefined();
  });

  it("translates sourceChannel='web' to null (online store has no explicit channel)", async () => {
    await loader({ request: mkReq("sourceChannel=web"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceChannel: null }),
      }),
    );
  });

  it("passes through non-web sourceChannel values verbatim", async () => {
    await loader({ request: mkReq("sourceChannel=pos"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ sourceChannel: "pos" }),
      }),
    );
  });

  it("applies date range filter with start-of-day / end-of-day boundaries", async () => {
    await loader({
      request: mkReq("from=2026-05-01&to=2026-05-05"),
      params: {},
      context: {},
    } as never);
    const findManyCall = prismaMock.returnCase.findMany.mock.calls[0][0];
    const where = findManyCall.where as { createdAt: { gte: Date; lte: Date } };
    expect(where.createdAt.gte).toEqual(new Date("2026-05-01T00:00:00"));
    expect(where.createdAt.lte).toEqual(new Date("2026-05-05T23:59:59.999"));
  });

  it("returns the error fallback shape when prisma throws", async () => {
    prismaMock.returnCase.findMany.mockRejectedValueOnce(new Error("DB down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loader({
      request: mkReq("query=foo&status=approved"),
      params: {},
      context: {},
    } as never);
    expect(data).toMatchObject({
      returns: [],
      query: "foo",
      status: "approved",
      page: 1,
      totalCount: 0,
      totalPages: 1,
      pendingCount: 0,
      error: "Failed to load returns. Please try again.",
    });
    errSpy.mockRestore();
  });

  it("orders results by createdAt desc and includes up to 3 items per case", async () => {
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
        include: { items: { take: 3 } },
      }),
    );
  });
});
