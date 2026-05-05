/**
 * Extra coverage tests for `app/routes/api.v1.external.returns.ts`.
 *
 * These tests focus on the gaps left by the two existing files:
 *   - `api.external.returns.test.ts`           (auth/rate-limit happy paths)
 *   - `api.v1.external.returns.test.ts`        (basic filter spot-checks)
 *
 * Coverage targets:
 *   1. Every value in the route's status enum whitelist (8 statuses).
 *   2. All filter parameter combinations (status + dates + orderName + email).
 *   3. Sort-order verification — the route always sorts by
 *      `[{ createdAt: "desc" }, { id: "desc" }]`. Even though no `sortBy`
 *      query param exists, we lock that contract in so a future refactor
 *      that introduces `sortBy` cannot silently drop the stable secondary
 *      sort on `id`.
 *   4. Cursor pagination edge cases:
 *        - cursor returns 0 rows  -> nextCursor === null
 *        - cursor returns < pageSize rows -> nextCursor === null
 *        - cursor returns full pageSize rows -> nextCursor === last id
 *        - cursor row missing in DB -> Prisma rejects, route returns 500
 *        - cursor + filters combine correctly
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: authenticateApiKeyMock,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (_ms: number) => Response.json({ error: "rate limited" }, { status: 429 }),
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});

import { loader } from "../api.v1.external.returns";

function mkReq(qs = "") {
  return new Request(`https://app.example/api/v1/external/returns${qs ? "?" + qs : ""}`);
}

function ctx() {
  return { request: mkReq(""), params: {}, context: {} } as never;
}

function withQs(qs: string) {
  return { request: mkReq(qs), params: {}, context: {} } as never;
}

const VALID_STATUSES = [
  "initiated",
  "pending",
  "processing",
  "in progress",
  "approved",
  "rejected",
  "completed",
  "cancelled",
] as const;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset().mockResolvedValue({ ok: true, keyId: "k-1", shopId: "shop-1" });
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("api.v1.external.returns — extra coverage", () => {
  // ── 1. Every status enum value ──────────────────────────────────────
  describe("status whitelist", () => {
    for (const status of VALID_STATUSES) {
      it(`accepts status="${status}" and forwards it to prisma`, async () => {
        prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
        prismaMock.returnCase.count.mockResolvedValueOnce(0);
        const res = await loader(withQs(`status=${encodeURIComponent(status)}`));
        expect(res.status).toBe(200);
        const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
        expect(where.status).toBe(status);
        expect(where.shopId).toBe("shop-1");
      });
    }

    it("rejects an unknown status with a helpful error message listing all valid values", async () => {
      const res = await loader(withQs("status=foo"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("BAD_REQUEST");
      // Message should mention all 8 valid statuses.
      for (const s of VALID_STATUSES) {
        expect(body.error.message).toContain(s);
      }
      // No DB call should happen for invalid input.
      expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    });

    it("rejects operator-injection style status values like `status[gt]=foo`", async () => {
      // URLSearchParams collapses `status[gt]` to literal key `status[gt]`,
      // so `status` itself is missing — request should pass straight through
      // without a status filter (sanity-check, not a 400).
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      const res = await loader(withQs("status[gt]=foo"));
      expect(res.status).toBe(200);
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.status).toBeUndefined();
    });
  });

  // ── 2. All filter combinations ─────────────────────────────────────
  describe("filter combinations", () => {
    it("combines status + createdAfter + createdBefore + orderName + customerEmail", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(
        withQs(
          [
            "status=approved",
            "createdAfter=2025-01-01",
            "createdBefore=2025-12-31",
            "orderName=%231001",
            "customerEmail=Alice%40Example.COM",
          ].join("&"),
        ),
      );
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.status).toBe("approved");
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.lte).toBeInstanceOf(Date);
      expect(where.shopifyOrderName).toEqual({ contains: "#1001", mode: "insensitive" });
      // Email is lower-cased before being passed to Prisma.
      expect(where.customerEmailNorm).toEqual({ contains: "alice@example.com" });
      expect(where.shopId).toBe("shop-1");
    });

    it("only createdAfter populates `gte` without `lte`", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(withQs("createdAfter=2025-06-01"));
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte).toBeInstanceOf(Date);
      expect(where.createdAt.lte).toBeUndefined();
    });

    it("only createdBefore populates `lte` without `gte`", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(withQs("createdBefore=2025-06-01"));
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.createdAt.lte).toBeInstanceOf(Date);
      expect(where.createdAt.gte).toBeUndefined();
    });

    it("invalid createdBefore is silently ignored (no createdAt clause)", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(withQs("createdBefore=garbage-date"));
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toBeUndefined();
    });

    it("orderName + customerEmail without dates does not introduce a createdAt clause", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(withQs("orderName=1001&customerEmail=foo%40bar.com"));
      const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
      expect(where.createdAt).toBeUndefined();
      expect(where.shopifyOrderName).toEqual({ contains: "1001", mode: "insensitive" });
      expect(where.customerEmailNorm).toEqual({ contains: "foo@bar.com" });
    });
  });

  // ── 3. Sort order contract ─────────────────────────────────────────
  describe("sort order", () => {
    it("offset path always sorts by [createdAt desc, id desc]", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(ctx());
      const args = prismaMock.returnCase.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    });

    it("cursor path uses the same stable orderBy", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      await loader(withQs("cursor=rc-anchor"));
      const args = prismaMock.returnCase.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    });

    it("ignores unknown sortBy params (route does not implement sorting overrides)", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      prismaMock.returnCase.count.mockResolvedValueOnce(0);
      await loader(withQs("sortBy=updatedAt&sortOrder=asc"));
      const args = prismaMock.returnCase.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    });
  });

  // ── 4. Cursor pagination edge cases ────────────────────────────────
  describe("cursor pagination", () => {
    it("cursor returning 0 rows yields data:[] and nextCursor:null", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      const res = await loader(withQs("cursor=rc-anchor&pageSize=10"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.nextCursor).toBeNull();
      // Cursor responses do not include offset meta.
      expect(body.meta.totalCount).toBeUndefined();
    });

    it("cursor returning < pageSize rows yields nextCursor:null", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        { id: "rc-a", items: [], createdAt: new Date() },
        { id: "rc-b", items: [], createdAt: new Date() },
      ]);
      const res = await loader(withQs("cursor=rc-anchor&pageSize=10"));
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.meta.nextCursor).toBeNull();
    });

    it("cursor returning exactly pageSize rows surfaces last id as nextCursor", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        { id: "rc-a", items: [], createdAt: new Date() },
        { id: "rc-b", items: [], createdAt: new Date() },
        { id: "rc-c", items: [], createdAt: new Date() },
      ]);
      const res = await loader(withQs("cursor=rc-anchor&pageSize=3"));
      const body = await res.json();
      expect(body.meta.nextCursor).toBe("rc-c");
      // Must skip the cursor row itself.
      expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: "rc-anchor" }, skip: 1, take: 3 }),
      );
    });

    it("cursor row missing in DB (Prisma rejects with P2025-style error) -> 500", async () => {
      prismaMock.returnCase.findMany.mockRejectedValueOnce(
        new Error("Record to anchor pagination on not found (P2025)"),
      );
      const res = await loader(withQs("cursor=does-not-exist"));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("INTERNAL_ERROR");
      // Count is never called on the cursor path even on failure.
      expect(prismaMock.returnCase.count).not.toHaveBeenCalled();
    });

    it("cursor combines with status + email filters", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
      await loader(
        withQs("cursor=rc-anchor&pageSize=5&status=completed&customerEmail=BOB%40x.com"),
      );
      const args = prismaMock.returnCase.findMany.mock.calls[0][0];
      expect(args.cursor).toEqual({ id: "rc-anchor" });
      expect(args.skip).toBe(1);
      expect(args.take).toBe(5);
      expect(args.where.status).toBe("completed");
      expect(args.where.customerEmailNorm).toEqual({ contains: "bob@x.com" });
      // Cursor path must not call count() — that's the whole point of cursor pagination.
      expect(prismaMock.returnCase.count).not.toHaveBeenCalled();
    });

    it("offset response also surfaces nextCursor for clients migrating to cursor pagination", async () => {
      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        { id: "rc-x", items: [], createdAt: new Date() },
        { id: "rc-y", items: [], createdAt: new Date() },
      ]);
      prismaMock.returnCase.count.mockResolvedValueOnce(50);
      const res = await loader(withQs("page=1&pageSize=2"));
      const body = await res.json();
      expect(body.meta.nextCursor).toBe("rc-y");
      expect(body.meta.hasNextPage).toBe(true);
    });
  });
});
