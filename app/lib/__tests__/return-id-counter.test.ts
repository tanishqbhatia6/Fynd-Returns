/**
 * Tests for return-id-counter.server.ts: atomic counter increment via raw SQL.
 *
 * The counter is the source of truth for human-readable return IDs (e.g.
 * #R1042). Concurrent return creation must never produce duplicate counters,
 * so the helper relies on a single UPDATE ... RETURNING round-trip rather
 * than read-modify-write. These tests lock in:
 *   - the SQL shape (atomic UPDATE + RETURNING),
 *   - parameterised binding of shopSettingsId,
 *   - the new value is what's returned to the caller (initial + nth call),
 *   - error handling when the ShopSettings row is missing,
 *   - DB error propagation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock } = vi.hoisted(() => ({ prismaMock: {} as ReturnType<typeof createPrismaMock> }));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

import { nextReturnIdCounter } from "../return-id-counter.server";

beforeEach(() => {
  resetPrismaMock(prismaMock);
});

describe("nextReturnIdCounter", () => {
  it("returns the new counter value from RETURNING clause", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 42 }]);
    const result = await nextReturnIdCounter("settings-1");
    expect(result).toBe(42);
  });

  it("returns 1 on first increment (initial counter creation case)", async () => {
    // ShopSettings rows are seeded with returnIdCounter = 0; the very first
    // increment yields 1. This is the bootstrap path callers depend on.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 1 }]);
    const result = await nextReturnIdCounter("settings-fresh");
    expect(result).toBe(1);
  });

  it("passes the shopSettingsId as a parameterised arg (not interpolated)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 1 }]);
    await nextReturnIdCounter("settings-xyz");
    const call = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE "ShopSettings"/);
    expect(call[0]).toMatch(/RETURNING "returnIdCounter"/);
    expect(call[1]).toBe("settings-xyz");
  });

  it("uses an atomic UPDATE (single round-trip — no SELECT-then-UPDATE)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 5 }]);
    await nextReturnIdCounter("settings-1");
    const sql = prismaMock.$queryRawUnsafe.mock.calls[0][0] as string;
    // Increment is performed inside the UPDATE itself, never as a JS-side +1.
    expect(sql).toMatch(/"returnIdCounter"\s*=\s*"returnIdCounter"\s*\+\s*1/);
    // Only one DB call.
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("touches updatedAt on the ShopSettings row", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 7 }]);
    await nextReturnIdCounter("settings-1");
    const sql = prismaMock.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/"updatedAt"\s*=\s*NOW\(\)/);
  });

  it("scopes the UPDATE by id (WHERE \"id\" = $1)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 9 }]);
    await nextReturnIdCounter("settings-abc");
    const sql = prismaMock.$queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toMatch(/WHERE "id" = \$1/);
  });

  it("returns successive counter values on repeated calls", async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ returnIdCounter: 1 }])
      .mockResolvedValueOnce([{ returnIdCounter: 2 }])
      .mockResolvedValueOnce([{ returnIdCounter: 3 }]);
    expect(await nextReturnIdCounter("s")).toBe(1);
    expect(await nextReturnIdCounter("s")).toBe(2);
    expect(await nextReturnIdCounter("s")).toBe(3);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it("supports concurrent callers without collapsing calls", async () => {
    // Each concurrent caller should hit the DB independently; the atomic
    // UPDATE is what guarantees uniqueness — the helper itself does not
    // batch or dedupe.
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ returnIdCounter: 10 }])
      .mockResolvedValueOnce([{ returnIdCounter: 11 }])
      .mockResolvedValueOnce([{ returnIdCounter: 12 }]);
    const [a, b, c] = await Promise.all([
      nextReturnIdCounter("s"),
      nextReturnIdCounter("s"),
      nextReturnIdCounter("s"),
    ]);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it("preserves large counter values without precision loss", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 9_000_000 }]);
    const result = await nextReturnIdCounter("s");
    expect(result).toBe(9_000_000);
  });

  it("throws when no rows returned (ShopSettings row missing)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(nextReturnIdCounter("missing")).rejects.toThrow(
      /ShopSettings not found for counter increment: missing/,
    );
  });

  it("throws when query returns null (defensive against driver quirks)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(null);
    await expect(nextReturnIdCounter("null-settings")).rejects.toThrow(
      /ShopSettings not found for counter increment: null-settings/,
    );
  });

  it("throws when query returns undefined", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(undefined);
    await expect(nextReturnIdCounter("undef-settings")).rejects.toThrow(
      /ShopSettings not found for counter increment: undef-settings/,
    );
  });

  it("includes the offending shopSettingsId in the error message", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(nextReturnIdCounter("shop-42")).rejects.toThrow(/shop-42/);
  });

  it("propagates DB errors untouched", async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error("serialisation failure"));
    await expect(nextReturnIdCounter("s-1")).rejects.toThrow("serialisation failure");
  });

  it("propagates non-Error rejections untouched", async () => {
    // Some Prisma engine failures surface as plain objects; the helper
    // should not wrap or swallow them.
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce({ code: "P1001" });
    await expect(nextReturnIdCounter("s-1")).rejects.toMatchObject({ code: "P1001" });
  });
});
