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

function mkReq(path = "/app", init?: RequestInit) {
  return new Request(`https://app.example${path}`, init);
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
  it("recovers Shopify Admin launches without query context before auth runs", async () => {
    const request = mkReq("/app", {
      headers: {
        referer: "https://admin.shopify.com/store/fynd-store-1/apps/fynd-returns",
      },
    });

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (error) {
      thrown = error;
    }

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/app?")).toBe(true);
    expect(location).toContain("shop=fynd-store-1.myshopify.com");
    expect(location).toContain("host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZnluZC1zdG9yZS0x");
    expect(location).toContain("embedded=1");
  });

  it("fills missing host context on direct /app launches with a shop param", async () => {
    let thrown: unknown;
    try {
      await loader({
        request: mkReq("/app?shop=mystore.myshopify.com"),
        params: {},
        context: {},
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/app?")).toBe(true);
    expect(location).toContain("shop=mystore.myshopify.com");
    expect(location).toContain("host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXlzdG9yZQ");
    expect(location).toContain("embedded=1");
  });

  it("does not mutate signed Shopify launch params before auth", async () => {
    const data = await loader({
      request: mkReq("/app?shop=mystore.myshopify.com&timestamp=1700000000&hmac=signed"),
      params: {},
      context: {},
    } as never);

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(data.shopDomain).toBe("store.myshopify.com");
  });

  it("redirects to /app/billing when billing access is denied", async () => {
    getBillingStatusMock.mockResolvedValueOnce({ hasAccess: false });
    await expect(
      loader({ request: mkReq("/app/returns"), params: {}, context: {} } as never),
    ).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });

  it("preserves Shopify embedded params when redirecting to billing", async () => {
    getBillingStatusMock.mockResolvedValueOnce({ hasAccess: false });

    let thrown: unknown;
    try {
      await loader({
        request: mkReq("/app?embedded=1&shop=store.myshopify.com&host=abc&id_token=token"),
        params: {},
        context: {},
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("location") ?? "";
    expect(location).toBe(
      "/app/billing?embedded=1&shop=store.myshopify.com&host=abc&id_token=token",
    );
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
