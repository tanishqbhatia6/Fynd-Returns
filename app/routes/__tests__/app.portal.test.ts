/**
 * Loader tests for app.portal.tsx — Customer Portal info page.
 *
 * Covers:
 *  - portalUrl + storeName derived from session.shop
 *  - hasTheme reflects portalThemeJson presence
 *  - parsePortalTheme / parsePortalConfig wiring
 *  - totalReturns + activeReturns from prisma counts
 *  - graceful error handling when prisma blows up
 *  - missing-shop branch (counts stay zero)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  parsePortalThemeMock,
  parsePortalConfigMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  parsePortalThemeMock: vi.fn(),
  parsePortalConfigMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/portal-theme.server", () => ({
  parsePortalTheme: parsePortalThemeMock,
}));
vi.mock("../../lib/portal-config.server", () => ({
  parsePortalConfig: parsePortalConfigMock,
}));

const DEFAULT_THEME = {
  primaryColor: "#4E52F2",
  backgroundColor: "#ffffff",
  surfaceColor: "#f8fafc",
  textColor: "#0f172a",
  textMutedColor: "#64748b",
  borderColor: "#e2e8f0",
  fontFamily: "Inter, sans-serif",
  borderRadius: "10",
};

const DEFAULT_CONFIG = {
  showOrderTracking: true,
  showReturnTracking: true,
  showCreateReturnTab: true,
  allowMediaUploads: false,
  defaultTab: "return",
};

import { loader } from "../app.portal";

const ctx = (url = "https://example.com/app/portal") => ({
  request: new Request(url),
  params: {},
  context: {},
}) as never;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
  });
  parsePortalThemeMock.mockReset().mockReturnValue({ ...DEFAULT_THEME });
  parsePortalConfigMock.mockReset().mockReturnValue({ ...DEFAULT_CONFIG });
});

describe("app.portal loader", () => {
  it("returns portalUrl built from session.shop", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const data = await loader(ctx());
    expect(data.portalUrl).toBe("https://store.myshopify.com/apps/returns");
  });

  it("strips .myshopify.com from storeName", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const data = await loader(ctx());
    expect(data.storeName).toBe("store");
  });

  it("hasTheme=true when portalThemeJson is set", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { portalThemeJson: JSON.stringify({ primaryColor: "#abc" }) },
    });
    const data = await loader(ctx());
    expect(data.hasTheme).toBe(true);
  });

  it("hasTheme=false when settings exist but portalThemeJson is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { portalThemeJson: null },
    });
    const data = await loader(ctx());
    expect(data.hasTheme).toBe(false);
  });

  it("delegates theme parsing to parsePortalTheme", async () => {
    const themeJson = JSON.stringify({ primaryColor: "#deadbe" });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { portalThemeJson: themeJson },
    });
    parsePortalThemeMock.mockReturnValueOnce({ ...DEFAULT_THEME, primaryColor: "#deadbe" });
    const data = await loader(ctx());
    expect(parsePortalThemeMock).toHaveBeenCalledWith(themeJson);
    expect(data.theme.primaryColor).toBe("#deadbe");
  });

  it("delegates config parsing to parsePortalConfig", async () => {
    const cfgJson = JSON.stringify({ defaultTab: "create" });
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { portalConfigJson: cfgJson },
    });
    parsePortalConfigMock.mockReturnValueOnce({ ...DEFAULT_CONFIG, defaultTab: "create" });
    const data = await loader(ctx());
    expect(parsePortalConfigMock).toHaveBeenCalledWith(cfgJson);
    expect(data.config.defaultTab).toBe("create");
  });

  it("falls back to null inputs when settings are missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    await loader(ctx());
    expect(parsePortalThemeMock).toHaveBeenCalledWith(null);
    expect(parsePortalConfigMock).toHaveBeenCalledWith(null);
  });

  it("returns prisma counts for total + active returns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    prismaMock.returnCase.count
      .mockResolvedValueOnce(42) // total
      .mockResolvedValueOnce(7);  // active
    const data = await loader(ctx());
    expect(data.totalReturns).toBe(42);
    expect(data.activeReturns).toBe(7);
  });

  it("filters active returns by in-progress statuses", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    await loader(ctx());
    const activeCall = prismaMock.returnCase.count.mock.calls[1][0];
    expect(activeCall.where.status.in).toEqual(
      expect.arrayContaining(["pending", "processing", "approved"]),
    );
    expect(activeCall.where.shopId).toBe("shop-1");
  });

  it("returns zero counts when shop record is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const data = await loader(ctx());
    expect(data.totalReturns).toBe(0);
    expect(data.activeReturns).toBe(0);
    expect(prismaMock.returnCase.count).not.toHaveBeenCalled();
  });

  it("falls back to safe defaults when prisma throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("DB down"));
    parsePortalThemeMock.mockReturnValueOnce(DEFAULT_THEME);
    parsePortalConfigMock.mockReturnValueOnce(DEFAULT_CONFIG);
    const data = await loader(ctx());
    expect(data.portalUrl).toBe("");
    expect(data.storeName).toBe("store");
    expect(data.hasTheme).toBe(false);
    expect(data.totalReturns).toBe(0);
    expect(data.activeReturns).toBe(0);
    errSpy.mockRestore();
  });

  it("queries shop by shopDomain from session", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    await loader(ctx());
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith({
      where: { shopDomain: "store.myshopify.com" },
      include: { settings: true },
    });
  });
});
