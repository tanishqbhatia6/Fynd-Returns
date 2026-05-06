import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * apps.returns — Storefront /apps/returns proxy that serves the
 * customer portal HTML. Reads the portal template from disk, applies
 * theme + label substitutions based on the shop's settings, and
 * injects an inline <script> with i18n / feature flags.
 *
 * Tests stub the portal template (instead of reading the real 6k-line
 * HTML) so substitutions can be asserted precisely. The shop lookup
 * goes through prisma.shop.findUnique — every test seeds (or omits) a
 * fixture row to drive the loader's branches.
 */

const TEMPLATE_HTML = [
  '<html lang="en">',
  "<head>",
  "  <!-- %FAVICON% -->",
  "  <title>Returns</title>",
  "  <style>body{color:%TEXT_COLOR%;background:%BG_COLOR%;}</style>",
  "</head>",
  "<body>",
  '  <input type="hidden" id="shop" value="%SHOP%">',
  '  <span class="window">%RETURN_WINDOW% days</span>',
  '  <div class="policy">%RETURN_POLICY%</div>',
  '  <img class="brand" src="%BRAND_LOGO_URL%" />',
  '  <a href="%APP_URL%/x">link</a>',
  "  <script>",
  '    var REASONS = "%RETURN_REASONS_JSON%";',
  '    var REASONS_BY_CAT = "%RETURN_REASONS_BY_CATEGORY_JSON%";',
  '    var CFG = "%PORTAL_CONFIG%";',
  "  </script>",
  "</body>",
  "</html>",
].join("\n");

const { prismaMock, readFileSyncMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  readFileSyncMock: vi.fn(() => ""),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

// Stub the portal template read so tests are independent of the real
// 6k-line HTML and so we can assert substitutions precisely.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: readFileSyncMock };
});

import { loader } from "../apps.returns";

function makeRequest(qs: string): Request {
  return new Request(`https://example.com/apps/returns${qs}`);
}

function makeArgs(req: Request) {
  return { request: req, params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue(TEMPLATE_HTML);
  delete process.env.SHOPIFY_APP_URL;
});

describe("apps.returns loader", () => {
  it("returns 200 text/html with the portal template body", async () => {
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("</html>");
  });

  it("expands a bare shop slug to <slug>.myshopify.com and substitutes %SHOP%", async () => {
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    expect(body).toContain('id="shop" value="acme.myshopify.com"');
    // findUnique should have been called with the expanded domain.
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: "acme.myshopify.com" } }),
    );
  });

  it("uses the raw shop param when it already contains a dot", async () => {
    await loader(makeArgs(makeRequest("?shop=acme.myshopify.com")));
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: "acme.myshopify.com" } }),
    );
  });

  it("falls back to defaults (30-day window, empty policy/logo) when no shop settings exist", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    expect(body).toContain("30 days");
    // Empty policy and brand logo just leave the attributes empty.
    expect(body).toContain('<div class="policy"></div>');
    expect(body).toContain('<img class="brand" src="" />');
  });

  it("injects shop-specific settings (return window, policy, brand logo) from prisma", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        returnWindowDays: 45,
        returnPolicyText: "No returns on sale items",
        portalThemeJson: null,
        returnReasonsJson: '["Defective","Wrong size"]',
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "en",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: null,
        brandLogoUrl: "https://cdn.example.com/logo.png",
        brandFaviconUrl: null,
        giftReturnsEnabled: true,
        portalExchangeEnabled: false,
        greenReturnsEnabled: false,
        greenReturnsDonateEnabled: false,
        greenReturnsDonateMessage: "",
        channelPoliciesJson: "{}",
      },
    });
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    expect(body).toContain("45 days");
    expect(body).toContain("No returns on sale items");
    expect(body).toContain('src="https://cdn.example.com/logo.png"');
  });

  it("escapes HTML-unsafe characters in policy text and JSON payloads", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        returnWindowDays: 30,
        returnPolicyText: "<script>bad()</script>",
        portalThemeJson: null,
        returnReasonsJson: '[{"code":"<x>"}]',
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "en",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: null,
        brandLogoUrl: null,
        brandFaviconUrl: null,
        giftReturnsEnabled: false,
        portalExchangeEnabled: false,
        greenReturnsEnabled: false,
        greenReturnsDonateEnabled: false,
        greenReturnsDonateMessage: "",
        channelPoliciesJson: "{}",
      },
    });
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    // Raw <script> tag from policyText must NOT appear unescaped.
    expect(body).not.toContain("<script>bad()</script>");
    expect(body).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    // JSON payloads escape angle brackets to < / >.
    expect(body).toContain("\\u003cx\\u003e");
  });

  it("injects the i18n bootstrap script before </head> with locale, currency, timezone & feature flags", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        returnWindowDays: 30,
        returnPolicyText: "",
        portalThemeJson: null,
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "fr",
        shopLocale: "en",
        shopCurrency: "EUR",
        shopTimezone: "Europe/Paris",
        portalLabelsJson: null,
        brandLogoUrl: null,
        brandFaviconUrl: null,
        giftReturnsEnabled: true,
        portalExchangeEnabled: true,
        greenReturnsEnabled: false,
        greenReturnsDonateEnabled: false,
        greenReturnsDonateMessage: "",
        channelPoliciesJson: "{}",
      },
    });
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    expect(body).toContain('window.__RPM_LOCALE__="fr"');
    expect(body).toContain('window.__RPM_CURRENCY__="EUR"');
    expect(body).toContain('window.__RPM_TIMEZONE__="Europe/Paris"');
    expect(body).toContain("window.__RPM_LABELS__=");
    expect(body).toContain("window.__RPM_FEATURES__=");
    // giftReturnsEnabled was true → must appear in the features blob.
    expect(body).toMatch(/giftReturnsEnabled/);
    // The script should sit immediately before </head>.
    const idxScript = body.indexOf("__RPM_LOCALE__");
    const idxHeadClose = body.indexOf("</head>");
    expect(idxScript).toBeGreaterThan(-1);
    expect(idxHeadClose).toBeGreaterThan(idxScript);
  });

  it('sets dir="rtl" and lang="ar" for Arabic locale', async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        returnWindowDays: 30,
        returnPolicyText: "",
        portalThemeJson: null,
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "ar",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: null,
        brandLogoUrl: null,
        brandFaviconUrl: null,
        giftReturnsEnabled: false,
        portalExchangeEnabled: false,
        greenReturnsEnabled: false,
        greenReturnsDonateEnabled: false,
        greenReturnsDonateMessage: "",
        channelPoliciesJson: "{}",
      },
    });
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const body = await res.text();
    expect(body).toContain('<html lang="ar" dir="rtl"');
  });

  it("uses the brand favicon when configured, otherwise falls back to APP_URL favicons", async () => {
    // Custom favicon path.
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        returnWindowDays: 30,
        returnPolicyText: "",
        portalThemeJson: null,
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "en",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: null,
        brandLogoUrl: null,
        brandFaviconUrl: "https://cdn.example.com/fav.png",
        giftReturnsEnabled: false,
        portalExchangeEnabled: false,
        greenReturnsEnabled: false,
        greenReturnsDonateEnabled: false,
        greenReturnsDonateMessage: "",
        channelPoliciesJson: "{}",
      },
    });
    const customRes = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const customBody = await customRes.text();
    expect(customBody).toContain('href="https://cdn.example.com/fav.png"');
    expect(customBody).not.toContain("/favicon-96x96.png");

    // Default fallback path — no brand favicon, request origin used as APP_URL.
    process.env.SHOPIFY_APP_URL = "";
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const defaultRes = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    const defaultBody = await defaultRes.text();
    expect(defaultBody).toContain("/favicon-96x96.png");
    expect(defaultBody).toContain("/apple-touch-icon.png");
    expect(defaultBody).toContain("/site.webmanifest");
  });

  it("returns a 500 plain-text response when the portal template cannot be read", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    const body = await res.text();
    expect(body).toContain("Portal template not found");
  });

  it("recovers when prisma throws (logs error but still serves the portal with defaults)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db down"));
    const res = (await loader(makeArgs(makeRequest("?shop=acme")))) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    // Defaults still applied: 30-day window, empty policy.
    expect(body).toContain("30 days");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
