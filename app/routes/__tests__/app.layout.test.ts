/**
 * Loader tests for app.tsx — the embedded admin layout root. Covers the
 * billing gate (redirect to /app/billing on access denied), exempt routes
 * (the billing page itself + superadmin override), and the locale/sound/
 * pendingCount data shape returned to the component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  getBillingStatusMock,
  getAppModeMock,
  syncShopLocaleAndCurrencyMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  getBillingStatusMock: vi.fn(async () => ({ hasAccess: true })),
  getAppModeMock: vi.fn(() => "prod"),
  syncShopLocaleAndCurrencyMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/billing.server", () => ({ getBillingStatus: getBillingStatusMock }));
vi.mock("../../lib/fynd-config.server", () => ({ getAppMode: getAppModeMock }));
vi.mock("../../lib/shop.server", () => ({
  syncShopLocaleAndCurrency: syncShopLocaleAndCurrencyMock,
}));

import { loader } from "../app";

function mkReq(path = "/app") {
  return new Request(`https://app.example${path}`);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  getBillingStatusMock.mockReset().mockResolvedValue({ hasAccess: true });
  getAppModeMock.mockReset().mockReturnValue("prod");
  syncShopLocaleAndCurrencyMock.mockReset().mockResolvedValue(undefined);
});

describe("app.tsx loader", () => {
  it("redirects to /app/billing when billing access is denied", async () => {
    getBillingStatusMock.mockResolvedValueOnce({ hasAccess: false });
    await expect(
      loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never),
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it("does NOT check billing on /app/billing itself (avoids redirect loop)", async () => {
    await loader({ request: mkReq("/app/billing"), params: {}, context: {} } as never);
    expect(getBillingStatusMock).not.toHaveBeenCalled();
  });

  it("does NOT check billing on /app/settings/billing-override", async () => {
    await loader({
      request: mkReq("/app/settings/billing-override"),
      params: {},
      context: {},
    } as never);
    expect(getBillingStatusMock).not.toHaveBeenCalled();
  });

  it("returns shop data when billing OK", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { id: "s-1", adminSoundEnabled: true },
    });
    prismaMock.returnCase.count.mockResolvedValueOnce(3);
    const data = await loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never);
    expect(data).toMatchObject({
      shopDomain: "store.myshopify.com",
      portalUrl: "https://store.myshopify.com/apps/returns",
      appMode: "prod",
      pendingCount: 3,
      adminSoundEnabled: true,
    });
  });

  it("falls through to defaults if shop+settings lookup throws", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("DB unavailable"));
    const data = await loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never);
    expect(data.appMode).toBe("prod"); // default
    expect(data.pendingCount).toBe(0);
    expect(data.adminSoundEnabled).toBe(true);
  });

  it("respects adminSoundEnabled=false from settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { id: "s-1", adminSoundEnabled: false },
    });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    const data = await loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never);
    expect(data.adminSoundEnabled).toBe(false);
  });

  it("returns 0 pending when shop record is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const data = await loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never);
    expect(data.pendingCount).toBe(0);
  });

  it("counts only initiated + pending statuses", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { id: "s-1" },
    });
    prismaMock.returnCase.count.mockResolvedValueOnce(7);
    await loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["initiated", "pending"] },
        }),
      }),
    );
  });
});
