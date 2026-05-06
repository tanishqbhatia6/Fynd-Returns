/**
 * Coverage closure for app.settings._index.tsx loader. Targets lines 93-94 —
 * the outer try/catch that logs an error and returns a default-shaped payload
 * when the database lookup throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));

import { loader } from "../app.settings._index";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
  });
});

describe("app.settings._index loader — coverage closure", () => {
  it("catch branch returns the default payload when prisma throws (lines 93-94)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("DB connection refused"));
    try {
      const data = await loader({
        request: new Request("https://x"),
        params: {},
        context: {},
      } as never);
      // The fallback payload exposes hasFynd:false plus a notifCount:0 sentinel.
      expect(data).toMatchObject({
        hasFynd: false,
        hasReasons: false,
        hasPortalTheme: false,
        readAllOrders: false,
        notifCount: 0,
      });
      expect(errSpy).toHaveBeenCalledWith("[app.settings._index] Loader error:", expect.any(Error));
    } finally {
      errSpy.mockRestore();
    }
  });
});
