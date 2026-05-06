/**
 * @vitest-environment jsdom
 *
 * Branch-coverage top-up for three previously-undercovered routes:
 *
 *   - app/routes/app.tsx              (97% br → ≥99%)
 *   - app/routes/apps.returns.tsx     (65% br → ≥90%)
 *   - app/routes/auth.login/route.tsx (50% fns → ≥99%)
 *
 * Targets the specific branches the v8 report flagged:
 *
 *   app.tsx
 *     - line 151 isNavigating === "loading" → renders <div role="…"> bar.
 *
 *   apps.returns.tsx
 *     - line 79 portalThemeJson truthy → parsePortalTheme(json).
 *     - line 91 portalLabelsJson truthy + valid JSON      (try-success).
 *     - line 91 portalLabelsJson truthy + malformed JSON  (catch).
 *     - greenReturns/donate flag pass-through.
 *
 *   auth.login/route.tsx
 *     - loader: invalid shop param → returns {} (no redirect)
 *     - loader: valid shop param   → throws redirect to /auth?shop=…
 *     - default export Auth() rendering branch.
 *
 * No source modifications. New file — does not collide with existing
 * app.layout.* or apps.returns.* suites.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ────────────────────────────────────────────────────────────────────────
// Shared mocks. apps.returns reads the portal template via fs.readFileSync
// at runtime; app.tsx imports server-only deps (prisma, shopify auth) at
// module top level, so we stub those too.
// ────────────────────────────────────────────────────────────────────────
const TEMPLATE_HTML = [
  '<html lang="en">',
  "<head>",
  "  <!-- %FAVICON% -->",
  "  <title>Returns</title>",
  "  <style>body{color:%TEXT_COLOR%;background:%BG_COLOR%;}</style>",
  "</head>",
  "<body>",
  '  <input type="hidden" id="shop" value="%SHOP%">',
  '  <div class="policy">%RETURN_POLICY%</div>',
  "</body>",
  "</html>",
].join("\n");

const {
  prismaMock,
  authenticateMock,
  getBillingStatusMock,
  getAppModeMock,
  syncShopLocaleAndCurrencyMock,
  readFileSyncMock,
  parsePortalThemeMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  getBillingStatusMock: vi.fn(async () => ({ hasAccess: true })),
  getAppModeMock: vi.fn(() => "prod"),
  syncShopLocaleAndCurrencyMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  readFileSyncMock: vi.fn(() => ""),
  parsePortalThemeMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/billing.server", () => ({
  getBillingStatus: getBillingStatusMock,
}));
vi.mock("../../lib/fynd-config.server", () => ({ getAppMode: getAppModeMock }));
vi.mock("../../lib/shop.server", () => ({
  syncShopLocaleAndCurrency: syncShopLocaleAndCurrencyMock,
}));
// Spy on parsePortalTheme so we can assert it was called when
// portalThemeJson is non-null. The real implementation handles arbitrary
// JSON, so we delegate to it via importActual then track invocations.
vi.mock("../../lib/portal-theme.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/portal-theme.server")>(
    "../../lib/portal-theme.server",
  );
  parsePortalThemeMock.mockImplementation((json) =>
    actual.parsePortalTheme(json as Parameters<typeof actual.parsePortalTheme>[0]),
  );
  return {
    ...actual,
    parsePortalTheme: parsePortalThemeMock,
  };
});
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: readFileSyncMock };
});
// AppProvider wants to be inside an embedded host. Replace with a
// passthrough so children render in jsdom.
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-provider">{children}</div>
  ),
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => new Headers()),
  },
}));

// Imports under test — must come *after* the mocks above.
import App from "../app";
import { loader as appsReturnsLoader } from "../apps.returns";
import AuthLogin, { loader as authLoginLoader } from "../auth.login/route";

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  getBillingStatusMock.mockReset().mockResolvedValue({ hasAccess: true });
  getAppModeMock.mockReset().mockReturnValue("prod");
  syncShopLocaleAndCurrencyMock.mockReset().mockResolvedValue(undefined);
  readFileSyncMock.mockReset().mockReturnValue(TEMPLATE_HTML);
  parsePortalThemeMock.mockClear();
  delete process.env.SHOPIFY_APP_URL;
});

function makeAppsReturnsArgs(qs: string) {
  const req = new Request(`https://example.com/apps/returns${qs}`);
  return { request: req, params: {}, context: {} } as unknown as Parameters<
    typeof appsReturnsLoader
  >[0];
}

function makeAuthLoginArgs(qs: string) {
  const req = new Request(`https://example.com/auth/login${qs}`);
  return { request: req, params: {}, context: {} } as unknown as Parameters<
    typeof authLoginLoader
  >[0];
}

// ────────────────────────────────────────────────────────────────────────
// app.tsx — covers the navigation loading-bar branch (line 151).
// ────────────────────────────────────────────────────────────────────────
describe("app.tsx — navigation loading bar branch", () => {
  it("renders the navigation loading bar while a route transition is loading", async () => {
    // To force navigation.state === "loading" we mount App into a memory
    // router and call router.navigate() to a route whose loader sleeps.
    // The bar renders synchronously at the start of the transition.
    const { createMemoryRouter, RouterProvider } = await import("react-router");
    const { render, act } = await import("@testing-library/react");
    const { waitFor } = await import("@testing-library/react");

    const baseLoaderData = {
      apiKey: "k",
      shopDomain: "s.myshopify.com",
      portalUrl: "https://s.myshopify.com/apps/returns",
      appMode: "prod" as const,
      pendingCount: 0,
      adminSoundEnabled: false,
    };

    let resolveSlow: () => void = () => {};
    const slowLoader = () =>
      new Promise<typeof baseLoaderData>((resolve) => {
        resolveSlow = () => resolve(baseLoaderData);
      });

    const router = createMemoryRouter(
      [
        {
          path: "/app",
          element: <App />,
          loader: () => baseLoaderData,
        },
        {
          path: "/app/returns",
          element: <App />,
          loader: slowLoader,
        },
      ],
      { initialEntries: ["/app"] },
    );

    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelector("s-app-nav")).toBeTruthy();
    });
    // Kick off navigation; do NOT await — the slow loader keeps state="loading".
    act(() => {
      void router.navigate("/app/returns");
    });
    await waitFor(() => {
      // The loading bar is the only fixed-position div with height:3 inside
      // the layout; it appears during state==="loading".
      const bars = Array.from(container.querySelectorAll("div")).filter(
        (d) =>
          /position:\s*fixed/.test(d.getAttribute("style") || "") &&
          /height:\s*3/.test(d.getAttribute("style") || ""),
      );
      expect(bars.length).toBeGreaterThan(0);
    });
    // Resolve the slow loader so cleanup doesn't leave a pending promise.
    await act(async () => {
      resolveSlow();
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// apps.returns.tsx — branch top-ups (lines 79, 91, plus various ??).
// ────────────────────────────────────────────────────────────────────────
describe("apps.returns loader — uncovered branches", () => {
  it("calls parsePortalTheme(json) when portalThemeJson is non-null (line 79 truthy branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        portalThemeJson: '{"primary":"#ff0000"}',
        returnWindowDays: 30,
        returnPolicyText: "",
        returnReasonsJson: "[]",
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
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    expect(res.status).toBe(200);
    // parsePortalTheme should have been called with both the null default
    // (initial) AND the JSON string (line 79 branch) — assert the JSON one.
    const calledArgs = parsePortalThemeMock.mock.calls.map((c) => c[0]);
    expect(calledArgs).toContain('{"primary":"#ff0000"}');
  });

  it("parses portalLabelsJson when valid JSON (line 91 try-success branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        portalThemeJson: null,
        returnWindowDays: 30,
        returnPolicyText: "",
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "en",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: '{"hello":"world"}',
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
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    const body = await res.text();
    // Parsed labels merge into the i18n bootstrap script.
    expect(body).toContain("__RPM_LABELS__");
    expect(res.status).toBe(200);
  });

  it("swallows malformed portalLabelsJson via try/catch (line 91 catch branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        portalThemeJson: null,
        returnWindowDays: 30,
        returnPolicyText: "",
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "en",
        shopLocale: "en",
        shopCurrency: "USD",
        shopTimezone: "UTC",
        portalLabelsJson: "{not-json",
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
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    // Malformed JSON must NOT crash the loader; fallback empty overrides.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("__RPM_LABELS__");
  });

  it("propagates greenReturnsEnabled / donate flags into the feature blob", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        portalThemeJson: null,
        returnWindowDays: 30,
        returnPolicyText: "",
        returnReasonsJson: "[]",
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
        greenReturnsEnabled: true,
        greenReturnsDonateEnabled: true,
        greenReturnsDonateMessage: "We donate $1 per return",
        channelPoliciesJson: '{"web":{"window":30}}',
      },
    });
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    const body = await res.text();
    expect(body).toMatch(/greenReturnsEnabled/);
    expect(body).toMatch(/greenReturnsDonateEnabled/);
    expect(body).toMatch(/We donate/);
  });

  it("hits every ?? right-side default when settings fields are all null/undefined", async () => {
    // Drives the unmet branches at lines 81-89 / 93-100: each `?? <default>`
    // only marks the right-hand branch executed when the left value is
    // null or undefined, which existing fixtures never trigger en-masse.
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        // Every nullable column explicitly null so each ?? falls through.
        portalThemeJson: null,
        returnWindowDays: null,
        returnPolicyText: null,
        returnReasonsJson: null,
        returnReasonsByCategoryJson: null,
        portalConfigJson: null,
        portalLanguage: null,
        shopLocale: null,
        shopCurrency: null,
        shopTimezone: null,
        portalLabelsJson: null,
        brandLogoUrl: null,
        brandFaviconUrl: null,
        giftReturnsEnabled: null,
        portalExchangeEnabled: null,
        greenReturnsEnabled: null,
        greenReturnsDonateEnabled: null,
        greenReturnsDonateMessage: null,
        channelPoliciesJson: null,
      },
    });
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    // The defaults were applied: 30-day window, USD, en, etc.
    expect(body).toContain("30");
    expect(body).toContain('window.__RPM_LOCALE__="en"');
    expect(body).toContain('window.__RPM_CURRENCY__="USD"');
    expect(body).toContain('window.__RPM_TIMEZONE__="UTC"');
  });

  it("falls back to shopLocale when portalLanguage is empty (|| short-circuit)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        portalThemeJson: null,
        returnWindowDays: 30,
        returnPolicyText: "",
        returnReasonsJson: "[]",
        returnReasonsByCategoryJson: "",
        portalConfigJson: "",
        portalLanguage: "",
        shopLocale: "de",
        shopCurrency: "EUR",
        shopTimezone: "Europe/Berlin",
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
    const res = (await appsReturnsLoader(makeAppsReturnsArgs("?shop=acme"))) as Response;
    const body = await res.text();
    expect(body).toContain('lang="de"');
    expect(body).toContain('window.__RPM_LOCALE__="de"');
  });
});

// ────────────────────────────────────────────────────────────────────────
// auth.login/route.tsx — loader + default export branches.
// ────────────────────────────────────────────────────────────────────────
describe("auth.login route — loader + render", () => {
  it("loader returns {} when no shop param is present", async () => {
    const data = await authLoginLoader(makeAuthLoginArgs(""));
    expect(data).toEqual({});
  });

  it("loader returns {} when shop param is malformed (regex reject)", async () => {
    const data = await authLoginLoader(makeAuthLoginArgs("?shop=not-a-shop"));
    expect(data).toEqual({});
  });

  it("loader redirects to /auth when shop matches *.myshopify.com", async () => {
    let thrown: unknown;
    try {
      await authLoginLoader(makeAuthLoginArgs("?shop=acme.myshopify.com"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Response);
    const r = thrown as Response;
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(r.status).toBeLessThan(400);
    expect(r.headers.get("location")).toBe("/auth?shop=acme.myshopify.com");
  });

  it("default export Auth() renders the install-from-App-Store info card", async () => {
    const { render } = await import("@testing-library/react");
    const { container } = render(<AuthLogin />);
    expect(container.textContent).toMatch(/Install Fynd Returns/i);
    expect(container.textContent).toMatch(/Shopify App Store/i);
    // The CTA link must point at the App Store listing URL.
    const cta = container.querySelector('a[href="https://apps.shopify.com/"]');
    expect(cta).toBeTruthy();
    expect(cta?.getAttribute("target")).toBe("_blank");
    expect(cta?.getAttribute("rel")).toBe("noopener noreferrer");
    // Marketing fallback link.
    expect(container.querySelector('a[href="https://www.fynd.com/"]')).toBeTruthy();
  });
});
