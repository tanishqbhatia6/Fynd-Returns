/**
 * Loader + action tests for app.settings.widget.tsx — portal theming &
 * customisation. Covers theme/config persistence + label override
 * filtering + shop-locale defaults.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  findOrCreateShopMock,
  parsePortalThemeMock,
  parsePortalConfigMock,
  getPortalLabelsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  parsePortalThemeMock: vi.fn(() => ({ primaryColor: "#000" })),
  parsePortalConfigMock: vi.fn(() => ({ showOrderTracking: true })),
  getPortalLabelsMock: vi.fn(() => ({ "portal.title": "Returns" })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/portal-theme.server", () => ({
  parsePortalTheme: parsePortalThemeMock,
  DEFAULT_PORTAL_THEME: {
    primaryColor: "#4E52F2",
    primaryHoverColor: "#3940d6",
    backgroundColor: "#fff",
    surfaceColor: "#f8fafc",
    textColor: "#0f172a",
    textMutedColor: "#64748b",
    borderColor: "#e2e8f0",
    fontFamily: "Inter",
    headingFont: "Inter",
    borderRadius: "10",
    shadow: "default",
  },
  FONT_OPTIONS: ["Inter", "Roboto"],
}));
vi.mock("../../lib/portal-config.server", () => ({
  parsePortalConfig: parsePortalConfigMock,
}));
vi.mock("../../lib/portal-i18n", () => ({
  SUPPORTED_LANGUAGES: [{ code: "en", label: "English" }],
  DEFAULT_LABELS: { "portal.title": "Returns Center" },
  getPortalLabels: getPortalLabelsMock,
}));

import { loader, action } from "../app.settings.widget";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
  parsePortalThemeMock.mockReset().mockReturnValue({ primaryColor: "#000" });
  parsePortalConfigMock.mockReset().mockReturnValue({ showOrderTracking: true });
  getPortalLabelsMock.mockReset().mockReturnValue({ "portal.title": "Returns" });
});

describe("loader", () => {
  it("returns theme + config + portalUrl built from session shop", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: { portalLanguage: "en", shopLocale: "en", shopCurrency: "USD" },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.portalUrl).toBe("https://store.myshopify.com/apps/returns");
    expect(data.portalLanguage).toBe("en");
    expect(data.portalTheme.primaryColor).toBe("#000");
  });

  it("tolerates malformed portalLabelsJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: { portalLabelsJson: "{not json", portalLanguage: "en" },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.portalLabelOverrides).toEqual({});
  });

  it("parses valid portalLabelsJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: {
        portalLabelsJson: JSON.stringify({ "portal.title": "Custom Heading" }),
        portalLanguage: "en",
      },
    });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.portalLabelOverrides).toEqual({ "portal.title": "Custom Heading" });
  });

  it("returns DEFAULT shop locale/currency/timezone when settings missing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ settings: null });
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.shopLocale).toBe("en");
    expect(data.shopCurrency).toBe("USD");
    expect(data.shopTimezone).toBe("UTC");
  });
});

describe("action", () => {
  it("persists portalConfigJson with all toggles + valid defaultTab", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({
        showOrderTracking: "on",
        showReturnTracking: "on",
        showCreateReturnTab: "on",
        allowMediaUploads: "on",
        defaultTab: "create",
      }),
      params: {},
      context: {},
    } as never);
    expect(res).toEqual({ success: true });
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    const cfg = JSON.parse(upsertArg.update.portalConfigJson);
    expect(cfg.showOrderTracking).toBe(true);
    expect(cfg.allowMediaUploads).toBe(true);
    expect(cfg.allowReturnCancellation).toBe(true); // default-true unless "off"
    expect(cfg.defaultTab).toBe("create");
  });

  it("sanitises invalid defaultTab to 'return'", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ defaultTab: "garbage" }),
      params: {},
      context: {},
    } as never);
    const cfg = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.portalConfigJson);
    expect(cfg.defaultTab).toBe("return");
  });

  it("interprets allowReturnCancellation='off' as false", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ allowReturnCancellation: "off" }),
      params: {},
      context: {},
    } as never);
    const cfg = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.portalConfigJson);
    expect(cfg.allowReturnCancellation).toBe(false);
  });

  it("only writes portalThemeJson when at least one theme field is provided", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        /* no theme fields */
      }),
      params: {},
      context: {},
    } as never);
    const arg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(arg.update.portalThemeJson).toBeUndefined();
  });

  it("populates theme defaults for missing colours", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ primaryColor: "#abcdef" }),
      params: {},
      context: {},
    } as never);
    const themeJson = prismaMock.shopSettings.upsert.mock.calls[0][0].update.portalThemeJson;
    const theme = JSON.parse(themeJson);
    expect(theme.primaryColor).toBe("#abcdef");
    expect(theme.fontFamily).toBe("Inter"); // default fallback
  });

  it("filters non-string label values out of portalLabelsJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const labels = JSON.stringify({
      "portal.title": "Custom",
      "portal.subtitle": "  ", // whitespace-only → dropped
      "portal.misc": 42, // non-string → dropped
      "portal.ok": "Trim me  ", // trimmed
    });
    await action({
      request: formReq({ portalLabelsJson: labels }),
      params: {},
      context: {},
    } as never);
    const stored = JSON.parse(
      prismaMock.shopSettings.upsert.mock.calls[0][0].update.portalLabelsJson,
    );
    expect(stored["portal.title"]).toBe("Custom");
    expect(stored["portal.ok"]).toBe("Trim me");
    expect(stored).not.toHaveProperty("portal.subtitle");
    expect(stored).not.toHaveProperty("portal.misc");
  });

  it("tolerates malformed portalLabelsJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ portalLabelsJson: "{not json" }),
      params: {},
      context: {},
    } as never);
    expect(res).toEqual({ success: true });
    const arg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(arg.update.portalLabelsJson).toBeNull();
  });

  it("returns success:false on DB error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res).toEqual({ success: false, error: "DB unavailable" });
  });
});
