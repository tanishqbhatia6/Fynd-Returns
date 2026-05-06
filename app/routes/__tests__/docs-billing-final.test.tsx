/**
 * @vitest-environment jsdom
 *
 * Final-mile coverage suite for `app/routes/app.docs.tsx` and
 * `app/routes/app.billing.tsx`. Targets the residual unreached branches
 * left after `app.docs.component.test.tsx`, `app.docs.gap.test.tsx`,
 * `app.billing.component.test.tsx`, and `app.billing.test.ts`.
 *
 * Specifically:
 *   - docs line 2013 (`|| CHAPTERS[0]` fallback): the runtime cannot
 *     produce an invalid `activeChapter` value through component
 *     interaction (initial state is "welcome", and only the sidebar
 *     buttons mutate it via valid chapter ids), so we patch React's
 *     `useState` to seed an unknown id, forcing the `find(...) ||
 *     CHAPTERS[0]` short-circuit to fall through.
 *   - docs no-prev/no-next via the same patched-state path (cheap
 *     boundary coverage).
 *   - billing `ReasonLabel` default arm (line 220) for an unknown
 *     reason string — re-asserted here so the gap suite stays
 *     untouched per task brief.
 *
 * NO source modifications. NO existing test files are edited.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

// AppPage stub — same passthrough shape used by the sibling docs/billing
// component test files so heading targeting stays consistent.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

// Server-side mocks for the billing route (transitively pulled in via the
// route module's top-level imports of `shopify.server` and
// `lib/billing.server`). The component itself only consumes loader data
// via useLoaderData, so the real implementations are never invoked here.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
  getManagedPricingUpgradeUrl: vi.fn(() => "https://example.test/upgrade"),
  getBillingMode: vi.fn(() => "prod"),
  isSuperAdmin: vi.fn(() => false),
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
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

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import Documentation from "../app.docs";
import BillingPage from "../app.billing";

afterEach(() => {
  vi.restoreAllMocks();
});

/* ──────────────────── docs.tsx — fallback branch ──────────────────── */

/**
 * Render `Documentation` with the first `useState` call (which seeds
 * `activeChapter`) coerced to an invalid chapter id. The source file
 * imports `useState` as a named binding, so a `React.useState` spy
 * would no-op against the bound reference. Instead we install a
 * **stable, suite-wide** `react` module mock at the top of the file
 * (see `vi.mock("react", ...)` below) that delegates to the real
 * implementation but threads each call through a per-test counter.
 *
 * Tests opt into the override by toggling `__forceInvalidActiveChapter`
 * via `setForceInvalidChapter(true)` before rendering — when the flag
 * is on, the very first useState invocation seen during the next render
 * tree is force-seeded to an invalid id, then the flag clears so the
 * rest of the render proceeds normally.
 */
let __forceInvalidActiveChapter = false;
function setForceInvalidChapter(on: boolean) {
  __forceInvalidActiveChapter = on;
}

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useStateOverride = <S,>(initial?: S | (() => S)) => {
    // Only redirect the very specific `useState("welcome")` call that
    // seeds `activeChapter` in app.docs.tsx — every other useState call
    // (RouterProvider internals, AppPage, the `search` state, etc.)
    // forwards untouched. The flag is consumed on first match per render.
    if (__forceInvalidActiveChapter && initial === "welcome") {
      __forceInvalidActiveChapter = false;
      return actual.useState("not-a-real-chapter-id" as unknown as S);
    }
    return actual.useState(initial as S);
  };
  return {
    ...actual,
    // Re-spread to preserve any default-export shape exposed by the
    // installed `react` build without referring to `.default` (which may
    // be missing from the typed namespace import in current @types/react).
    useState: useStateOverride,
  };
});

describe("docs.tsx — `|| CHAPTERS[0]` fallback (line 2013) and prev/next null branches", () => {
  it("falls back to CHAPTERS[0] when activeChapter does not match any chapter id", () => {
    setForceInvalidChapter(true);
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    // Fallback chapter is CHAPTERS[0] = "welcome", whose title is
    // "Welcome to Fynd Returns". The chapter content (h1) renders that.
    const h1s = Array.from(container.querySelectorAll("h1")).map((h) =>
      (h.textContent || "").trim(),
    );
    expect(h1s).toContain("Welcome to Fynd Returns");
  });

  it("collapses the prev nav button when activeChapter is invalid (chapterIdx === -1)", () => {
    setForceInvalidChapter(true);
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    // chapterIdx === -1 → prev: chapterIdx > 0 is false → null branch.
    const allBtnText = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent || "",
    );
    expect(allBtnText.some((t) => t.includes("← Previous"))).toBe(false);
  });

  it("renders the chapter index header showing 'Chapter 0 of N' for the invalid-state path", () => {
    // Pure boundary check: chapterIdx + 1 === 0 when the find fails and
    // only the right-hand `CHAPTERS[0]` is used as the rendered chapter.
    setForceInvalidChapter(true);
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    expect(container.textContent).toMatch(/Chapter 0 of \d+/);
  });
});

/* ──────────────────── billing.tsx — default ReasonLabel arm ────────── */

const UPGRADE_URL = "https://test-shop.myshopify.com/admin/charges/test/pricing_plans";

type Reason =
  | "dev_mode"
  | "override_free"
  | "subscription_active"
  | "subscription_missing"
  | "override_paid_no_sub";

type LoaderData = {
  status: { hasAccess: boolean; reason: Reason | string; subscriptionName: string | null };
  upgradeUrl: string;
  mode: "prod" | "dev";
  isSuperadmin: boolean;
  sessionEmail: string | null;
};

const baseLoaderData: LoaderData = {
  status: { hasAccess: false, reason: "subscription_missing", subscriptionName: null },
  upgradeUrl: UPGRADE_URL,
  mode: "prod",
  isSuperadmin: false,
  sessionEmail: null,
};

function withData(overrides: Partial<LoaderData> = {}): LoaderData {
  return { ...baseLoaderData, ...overrides };
}

describe("billing.tsx — ReasonLabel default arm (line 220)", () => {
  it("renders the unknown reason verbatim when reason falls outside the union", async () => {
    // `reason` strings outside the canonical 5 values flow through to the
    // default arm of the switch (line 219–220), which renders the reason
    // string as-is. Cast through unknown so TS allows the out-of-union value.
    const exotic = "shopify_internal_error_7afb1" as unknown as Reason;
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: { hasAccess: false, reason: exotic, subscriptionName: null },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toContain("shopify_internal_error_7afb1");
  });

  it("renders an empty-string default-arm reason without crashing", async () => {
    // Empty-string is a particularly nasty default-arm input — it must not
    // collapse the layout or throw during the switch fallthrough.
    const exotic = "" as unknown as Reason;
    const { container, findByText } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: { hasAccess: false, reason: exotic, subscriptionName: null },
      }),
    });
    expect(await findByText("Subscription required")).toBeTruthy();
    // No matched arm copy from the canonical reasons should appear.
    expect(container.textContent).not.toMatch(/Development build/);
    expect(container.textContent).not.toMatch(/Free access granted/);
    expect(container.textContent).not.toMatch(/No active Shopify subscription/);
  });

  it("renders a numeric-coerced reason via the default arm", async () => {
    // Defensive: a non-string reason value (e.g. accidentally serialised
    // number) still routes through default → React renders the value.
    const exotic = 42 as unknown as Reason;
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: { hasAccess: false, reason: exotic, subscriptionName: null },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    expect(container.textContent).toContain("42");
  });

  it("default-arm reason still renders the upgrade CTA (hasAccess=false branch interlock)", async () => {
    // Even when the reason label takes the default arm, the parent
    // `!status.hasAccess` block still has to render the Choose-a-plan CTA
    // unchanged. This guards the boundary between the switch fallthrough
    // and the surrounding hasAccess gate.
    const exotic = "future_reason_value" as unknown as Reason;
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: { hasAccess: false, reason: exotic, subscriptionName: null },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Subscription required/);
    });
    const chooseLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.trim().startsWith("Choose a plan"),
    );
    expect(chooseLink).toBeTruthy();
    expect(chooseLink?.getAttribute("href")).toBe(UPGRADE_URL);
  });

  it("default-arm reason coexists with hasAccess=true (active-subscription card layout)", async () => {
    // Mirror of the above for the hasAccess=true side: the default arm
    // text must still render in the reason slot while the "Current plan"
    // card and "Manage plan" link continue to appear.
    const exotic = "legacy_grandfathered" as unknown as Reason;
    const { container } = renderWithRouter(BillingPage, {
      initialEntries: ["/app/billing"],
      loaderData: withData({
        status: { hasAccess: true, reason: exotic, subscriptionName: "Legacy" },
      }),
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(/Access granted/);
    });
    expect(container.textContent).toContain("legacy_grandfathered");
    expect(container.textContent).toContain("Current plan");
  });
});
