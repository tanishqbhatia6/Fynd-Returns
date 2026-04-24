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
  it("returns the new counter value", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 42 }]);
    const result = await nextReturnIdCounter("settings-1");
    expect(result).toBe(42);
  });

  it("passes the shopSettingsId as a parameterised arg", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 1 }]);
    await nextReturnIdCounter("settings-xyz");
    const call = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(call[0]).toMatch(/UPDATE "ShopSettings"/);
    expect(call[0]).toMatch(/RETURNING "returnIdCounter"/);
    expect(call[1]).toBe("settings-xyz");
  });

  it("throws when no rows returned (ShopSettings row missing)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(nextReturnIdCounter("missing")).rejects.toThrow(
      /ShopSettings not found for counter increment: missing/,
    );
  });

  it("throws when query returns null (defensive)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(null);
    await expect(nextReturnIdCounter("null-settings")).rejects.toThrow(
      /ShopSettings not found for counter increment: null-settings/,
    );
  });

  it("propagates DB errors untouched", async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValueOnce(new Error("serialisation failure"));
    await expect(nextReturnIdCounter("s-1")).rejects.toThrow("serialisation failure");
  });
});
