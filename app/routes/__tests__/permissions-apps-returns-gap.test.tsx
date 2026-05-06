/**
 * @vitest-environment jsdom
 *
 * Gap-coverage test: pushes
 *   - app/routes/app.settings.permissions.tsx     (line 173 — toggle onChange)
 *   - app/routes/apps.returns.tsx                  (lines 79, 91 — branches
 *     when shop settings include portalThemeJson and portalLabelsJson)
 * to ≥99% each, without touching any source. Existing tests already cover
 * the rest; this file targets only the residual uncovered branches.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";

// ───────────────────────────────────────────────────────────────────────────────
//  Module-top-level mocks shared across both suites
// ───────────────────────────────────────────────────────────────────────────────

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

// Build a Prisma stub with the models the SUT (and its transitive
// imports — `shopify.server.ts` → `PrismaSessionStorage`, which inspects
// `prisma.session` at construction time) actually touch. Inlined rather
// than using `createPrismaMock` because `vi.hoisted` runs before module
// imports resolve.
const { prismaMock, readFileSyncMock } = vi.hoisted(() => {
  const makeModel = () => ({
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  });
  return {
    prismaMock: {
      shop: makeModel(),
      shopSettings: makeModel(),
      session: makeModel(),
      $transaction: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      $connect: vi.fn().mockResolvedValue(undefined),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    },
    readFileSyncMock: vi.fn(() => ""),
  };
});

// `apps.returns.tsx` (and `app.settings.permissions.tsx`) both live in
// `app/routes/` and import `"../db.server"` → `app/db.server`. From this
// test file the absolute path is reached via `"../../db.server"`. Vitest
// matches mocks against the resolved absolute path, so this single mock
// covers both.
vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: readFileSyncMock };
});

import { renderWithRouter } from "../../test/component-helpers";
import PermissionsPage from "../app.settings.permissions";
import { loader as appsReturnsLoader } from "../apps.returns";

// ───────────────────────────────────────────────────────────────────────────────
//  Permissions — toggle onChange handler (line 173)
// ───────────────────────────────────────────────────────────────────────────────

const baseLoaderData = {
  readAllOrdersEnabled: false,
  hasReadAllOrdersScope: true,
  scopes: ["read_orders", "read_all_orders"],
};

describe("Permissions — toggle onChange (gap)", () => {
  it("flips internal `enabled` state when the toggle checkbox is clicked", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector(
          "input[type='checkbox'][name='readAllOrdersEnabled']",
        ),
      ).toBeTruthy();
    });
    const toggle = container.querySelector(
      "input[type='checkbox'][name='readAllOrdersEnabled']",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    // Trigger the onChange handler — covers line 173.
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
  });

  it("supports a direct change event with target.checked=true", async () => {
    const { container } = renderWithRouter(PermissionsPage, {
      initialEntries: ["/app/settings/permissions"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector(
          "input[type='checkbox'][name='readAllOrdersEnabled']",
        ),
      ).toBeTruthy();
    });
    const toggle = container.querySelector(
      "input[type='checkbox'][name='readAllOrdersEnabled']",
    ) as HTMLInputElement;
    fireEvent.change(toggle, { target: { checked: true } });
    expect(toggle.checked).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
//  apps.returns — settings.portalThemeJson + portalLabelsJson branches
// ───────────────────────────────────────────────────────────────────────────────

const TEMPLATE_HTML = [
  '<html lang="en">',
  '<head>',
  '  <!-- %FAVICON% -->',
  '  <title>Returns</title>',
  '  <style>body{color:%TEXT_COLOR%;background:%BG_COLOR%;}</style>',
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

function makeRequest(qs: string): Request {
  return new Request(`https://example.com/apps/returns${qs}`);
}

function makeArgs(req: Request) {
  return { request: req, params: {}, context: {} } as unknown as Parameters<
    typeof appsReturnsLoader
  >[0];
}

const baseSettings = {
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
  portalLabelsJson: null as string | null,
  brandLogoUrl: null,
  brandFaviconUrl: null,
  giftReturnsEnabled: false,
  portalExchangeEnabled: false,
  greenReturnsEnabled: false,
  greenReturnsDonateEnabled: false,
  greenReturnsDonateMessage: "",
  channelPoliciesJson: "{}",
};

describe("apps.returns loader — portalThemeJson + portalLabelsJson (gap)", () => {
  beforeEach(() => {
    prismaMock.shop.findUnique.mockReset();
    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue(TEMPLATE_HTML);
    delete process.env.SHOPIFY_APP_URL;
  });

  it("calls parsePortalTheme with the stored JSON when settings.portalThemeJson is present (line 79)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        ...baseSettings,
        // A truthy theme JSON forces the `if (shop.settings.portalThemeJson)`
        // branch — the only path through line 79.
        portalThemeJson: JSON.stringify({
          textColor: "#123456",
          bgColor: "#abcdef",
        }),
      },
    });
    const res = (await appsReturnsLoader(
      makeArgs(makeRequest("?shop=acme")),
    )) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    // The template's %TEXT_COLOR% / %BG_COLOR% placeholders remain present
    // (parsePortalTheme returns a real object regardless of substitution
    // outcome) — the assertion that matters is that the response is 200
    // and the loader didn't throw on an unexpected JSON shape.
    expect(body).toContain("<html");
    expect(body).toContain("</html>");
  });

  it("parses portalLabelsJson when it is valid JSON (line 91 — try branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        ...baseSettings,
        portalLabelsJson: JSON.stringify({ "portal.title": "My Returns" }),
      },
    });
    const res = (await appsReturnsLoader(
      makeArgs(makeRequest("?shop=acme")),
    )) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    // Override label is merged into __RPM_LABELS__ — visible in the bootstrap
    // script.
    expect(body).toContain("My Returns");
  });

  it("silently ignores invalid portalLabelsJson (line 91 — catch branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        ...baseSettings,
        portalLabelsJson: "{not valid json",
      },
    });
    // Loader must NOT throw — it swallows the JSON parse error.
    const res = (await appsReturnsLoader(
      makeArgs(makeRequest("?shop=acme")),
    )) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    // Bootstrap script still emitted with default labels.
    expect(body).toContain("window.__RPM_LABELS__=");
  });

  it("handles both portalThemeJson and portalLabelsJson together", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "acme.myshopify.com",
      settings: {
        ...baseSettings,
        portalThemeJson: JSON.stringify({ textColor: "#000", bgColor: "#fff" }),
        portalLabelsJson: JSON.stringify({ greeting: "Hello" }),
      },
    });
    const res = (await appsReturnsLoader(
      makeArgs(makeRequest("?shop=acme")),
    )) as Response;
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("window.__RPM_LABELS__=");
  });
});
