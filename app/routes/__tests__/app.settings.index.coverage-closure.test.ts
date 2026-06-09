/**
 * Coverage closure for app.settings._index.tsx loader. Targets lines 93-94 —
 * the outer try/catch that logs an error and returns a default-shaped payload
 * when the database lookup throws.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, appLoggerMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  appLoggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/observability/logger.server", () => ({
  appLogger: appLoggerMock,
}));

import { loader } from "../app.settings._index";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
  });
  appLoggerMock.error.mockClear();
});

describe("app.settings._index loader — coverage closure", () => {
  it("catch branch returns the default payload when prisma throws (lines 93-94)", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("DB connection refused"));
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
    expect(appLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        shopDomain: "store.myshopify.com",
      }),
      "Settings overview loader failed",
    );
  });
});
