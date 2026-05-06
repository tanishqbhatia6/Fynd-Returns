/**
 * @vitest-environment jsdom
 *
 * Component tests for the `/` marketing landing page.
 *
 * The route module imports `app/shopify.server` at the top level (for the
 * `login` reference used by the loader). Importing the real module pulls in
 * Node-only Shopify bootstrap code, so we mock it here.
 *
 * The page itself is mostly static JSX (hero, features, steps, CTA, footer)
 * with one piece of stateful behaviour: a three-button theme toggle that
 * writes a `data-theme` attribute on `<html>` and persists the choice to
 * localStorage. We also exercise the "system" branch by mocking
 * `window.matchMedia` (jsdom does not implement it).
 *
 * The matchMedia stub is installed at **module evaluation time** (not in
 * beforeEach) because RouterProvider's first render mounts the component
 * before the test body runs — if the stub isn't ready, the useEffect
 * throws and the tree never renders.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shopify.server import path used by `app/routes/_index/route.tsx`.
vi.mock("../../../shopify.server", () => ({
  login: vi.fn(),
  authenticate: { admin: vi.fn() },
}));

// matchMedia stub installed at module load (before any render).
const __mqlListeners = new Set<() => void>();
const __mqlState = {
  matches: true,
  media: "(prefers-color-scheme: dark)",
  onchange: null,
  addEventListener: (_: string, cb: () => void) => {
    __mqlListeners.add(cb);
  },
  removeEventListener: (_: string, cb: () => void) => {
    __mqlListeners.delete(cb);
  },
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
};
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: vi.fn().mockReturnValue(__mqlState),
});

// Node 25+ exposes a native `localStorage` global that lacks the standard
// `getItem`/`setItem` API and shadows jsdom's implementation in some setups.
// Install a minimal in-memory localStorage polyfill on both `window` and the
// global scope so the component's `localStorage.getItem` calls succeed.
function __makeLocalStorage() {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}
Object.defineProperty(window, "localStorage", {
  configurable: true,
  writable: true,
  value: __makeLocalStorage(),
});
// Mirror onto globalThis so bare `localStorage` references resolve here too.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: window.localStorage,
});

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../../../test/component-helpers";
import Index, { loader } from "../route";

/** Update the simulated `prefers-color-scheme: dark` value for a test. */
function installMatchMedia(matches = true) {
  __mqlState.matches = matches;
  return { mql: __mqlState, listeners: __mqlListeners };
}

/** Wait until the landing tree is mounted (loader has resolved). */
async function mountIndex(loaderData: unknown = { showForm: true }) {
  const result = renderWithRouter(Index, { loaderData });
  await result.findByText(/Returns management, reimagined/i);
  return result;
}

describe("_index route component (marketing landing)", () => {
  beforeEach(() => {
    installMatchMedia(true);
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
    document.documentElement.removeAttribute("data-theme");
  });

  it("renders without crashing with showForm: true loader data", async () => {
    const { container } = await mountIndex({ showForm: true });
    expect(container.querySelector(".landing-root")).toBeTruthy();
  });

  it("renders without crashing with showForm: false loader data", async () => {
    const { container } = await mountIndex({ showForm: false });
    expect(container.querySelector(".landing-root")).toBeTruthy();
  });

  it("renders the hero section with chroma headline and sub copy", async () => {
    await mountIndex();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/Returns management, reimagined/i);
    expect(h1.className).toContain("chroma-text");

    expect(screen.getByText(/Automate returns, delight customers/i)).toBeInTheDocument();

    expect(screen.getByRole("link", { name: /Get started free/i })).toHaveAttribute(
      "href",
      "https://apps.shopify.com",
    );
    expect(screen.getByRole("link", { name: /See how it works/i })).toHaveAttribute(
      "href",
      "#features",
    );
  });

  it("renders the stats row with all four stat values", async () => {
    const { container } = await mountIndex();
    const statValues = container.querySelectorAll(".stats-row .stat-value");
    expect(statValues.length).toBe(4);
    const text = Array.from(statValues).map((n) => n.textContent);
    expect(text).toEqual(expect.arrayContaining(["15", "3", "25+", "REST"]));
    expect(screen.getByText("Languages supported")).toBeInTheDocument();
    expect(screen.getByText("Resolution types")).toBeInTheDocument();
    expect(screen.getByText("Portal settings")).toBeInTheDocument();
    expect(screen.getByText("Public API")).toBeInTheDocument();
  });

  it("renders all six feature cards with their titles, descriptions, and icons", async () => {
    const { container } = await mountIndex();

    const cards = container.querySelectorAll(".feature-card");
    expect(cards.length).toBe(6);

    const titles = [
      "Automated Approvals",
      "Branded Portal",
      "Analytics Dashboard",
      "Multi-channel Support",
      "Fynd Integration",
      "Secure by design",
    ];
    for (const title of titles) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }

    const icons = container.querySelectorAll(".feature-card .feature-icon svg");
    expect(icons.length).toBe(6);
  });

  it("renders the 'How it works' section with three numbered steps", async () => {
    const { container } = await mountIndex();
    const stepCards = container.querySelectorAll(".step-card");
    expect(stepCards.length).toBe(3);
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();
    expect(screen.getByText("Customer initiates")).toBeInTheDocument();
    expect(screen.getByText("Rules auto-process")).toBeInTheDocument();
    expect(screen.getByText("Resolve & recover")).toBeInTheDocument();
  });

  it("renders all expected h2 section headings", async () => {
    await mountIndex();
    const h2s = screen.getAllByRole("heading", { level: 2 });
    const text = h2s.map((h) => h.textContent || "");
    expect(text.some((t) => /Everything you need to manage/i.test(t))).toBe(true);
    expect(text.some((t) => /Three steps to effortless returns/i.test(t))).toBe(true);
    expect(
      text.some((t) => /Ready to transform your/i.test(t) && /returns experience\?/i.test(t)),
    ).toBe(true);
  });

  it("renders the install/CTA section with both call-to-action links", async () => {
    await mountIndex();
    expect(screen.getByRole("link", { name: /Install free on Shopify/i })).toHaveAttribute(
      "href",
      "https://apps.shopify.com",
    );
    expect(screen.getByRole("link", { name: /Learn about Fynd/i })).toHaveAttribute(
      "href",
      "https://www.fynd.com",
    );
  });

  it("renders the install button in the nav", async () => {
    await mountIndex();
    const installLinks = screen.getAllByRole("link", {
      name: /Install on Shopify/i,
    });
    expect(installLinks.length).toBeGreaterThanOrEqual(1);
    expect(installLinks[0]).toHaveAttribute("href", "https://apps.shopify.com");
  });

  it("still renders the nav install link when showForm: false (component is loader-agnostic)", async () => {
    await mountIndex({ showForm: false });
    expect(
      screen.getAllByRole("link", { name: /Install on Shopify/i }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders the theme toggle with three buttons (Light / Dark / System)", async () => {
    await mountIndex();
    expect(screen.getByRole("button", { name: /Switch to Light theme/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Switch to Dark theme/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Switch to System theme/i })).toBeInTheDocument();
  });

  it("toggles to dark mode and writes data-theme=dark on <html>", async () => {
    await mountIndex();

    const darkBtn = screen.getByRole("button", {
      name: /Switch to Dark theme/i,
    });
    fireEvent.click(darkBtn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("rp-theme")).toBe("dark");
    expect(darkBtn.className).toContain("active");
  });

  it("toggles to light mode and writes data-theme=light on <html>", async () => {
    await mountIndex();

    const lightBtn = screen.getByRole("button", {
      name: /Switch to Light theme/i,
    });
    fireEvent.click(lightBtn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("rp-theme")).toBe("light");
    expect(lightBtn.className).toContain("active");
  });

  it("toggles to system mode and resolves to dark when matchMedia matches", async () => {
    installMatchMedia(true);
    await mountIndex();

    const systemBtn = screen.getByRole("button", {
      name: /Switch to System theme/i,
    });
    fireEvent.click(systemBtn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("rp-theme")).toBe("system");
    expect(systemBtn.className).toContain("active");
  });

  it("toggles to system mode and resolves to light when matchMedia does not match", async () => {
    installMatchMedia(false);
    await mountIndex();

    const systemBtn = screen.getByRole("button", {
      name: /Switch to System theme/i,
    });
    fireEvent.click(systemBtn);

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("restores a previously-saved 'light' theme from localStorage on mount", async () => {
    window.localStorage.setItem("rp-theme", "light");
    await mountIndex();
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    const lightBtn = screen.getByRole("button", {
      name: /Switch to Light theme/i,
    });
    expect(lightBtn.className).toContain("active");
  });

  it("restores a previously-saved 'dark' theme from localStorage on mount", async () => {
    window.localStorage.setItem("rp-theme", "dark");
    await mountIndex();
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
  });

  it("falls back to 'system' theme when localStorage holds an invalid value", async () => {
    window.localStorage.setItem("rp-theme", "neon");
    installMatchMedia(false);
    await mountIndex();
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
    const systemBtn = screen.getByRole("button", {
      name: /Switch to System theme/i,
    });
    expect(systemBtn.className).toContain("active");
  });

  it("responds to OS-level theme changes when in 'system' mode", async () => {
    installMatchMedia(true);
    await mountIndex();

    fireEvent.click(screen.getByRole("button", { name: /Switch to System theme/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Simulate the OS flipping to light.
    __mqlState.matches = false;
    __mqlListeners.forEach((cb) => cb());

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("renders the navigation brand and links", async () => {
    const { container } = await mountIndex();
    const nav = container.querySelector("nav.landing-nav") as HTMLElement;
    expect(nav).toBeTruthy();

    const brand = nav.querySelector(".nav-brand");
    expect(brand).toBeTruthy();
    expect(within(nav).getAllByText("ReturnPro").length).toBeGreaterThanOrEqual(1);

    expect(within(nav).getByText("Features")).toHaveAttribute("href", "#features");
    expect(within(nav).getByText("How it works")).toHaveAttribute("href", "#how-it-works");
    expect(within(nav).getByText("Fynd Platform")).toHaveAttribute("href", "https://www.fynd.com");
  });

  it("renders the 'Powered by Fynd' badge with a link to fynd.com", async () => {
    const { container } = await mountIndex();
    const badge = container.querySelector(".powered-by") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toMatch(/Powered by/i);
    const link = badge.querySelector("a");
    expect(link).toHaveAttribute("href", "https://www.fynd.com");
    expect(badge.querySelector("svg")).toBeTruthy();
  });

  it("renders the footer with all four columns and their links", async () => {
    const { container } = await mountIndex();
    const footer = container.querySelector("footer.landing-footer") as HTMLElement;
    expect(footer).toBeTruthy();
    const utils = within(footer);

    expect(utils.getByText("Product")).toBeInTheDocument();
    expect(utils.getByText("Platform")).toBeInTheDocument();
    expect(utils.getByText("Legal")).toBeInTheDocument();

    expect(utils.getByText("Features")).toHaveAttribute("href", "#features");
    expect(utils.getByText("How it works")).toHaveAttribute("href", "#how-it-works");
    expect(utils.getByText("Shopify App Store")).toHaveAttribute(
      "href",
      "https://apps.shopify.com",
    );

    expect(utils.getByText("Fynd Commerce")).toHaveAttribute("href", "https://www.fynd.com");
    expect(utils.getByText("Fynd Platform")).toHaveAttribute("href", "https://platform.fynd.com");
    expect(utils.getByText("Careers")).toHaveAttribute("href", "https://www.fynd.com/careers");

    expect(utils.getByText("Privacy Policy")).toHaveAttribute("href", "/privacy");
    expect(utils.getByText("Terms of Service")).toHaveAttribute("href", "/terms");
    expect(utils.getByText("LinkedIn")).toHaveAttribute(
      "href",
      "https://www.linkedin.com/company/gofynd",
    );

    expect(utils.getByText(/ReturnPro by Shopsense Retail Technologies/)).toBeInTheDocument();
    expect(utils.getByText(/Invented in India/)).toBeInTheDocument();
  });

  it("renders all six FeatureIcon SVG variants", async () => {
    const { container } = await mountIndex();
    const featureSvgs = container.querySelectorAll(".feature-icon > svg");
    expect(featureSvgs.length).toBe(6);
    featureSvgs.forEach((svg) => {
      expect(svg.children.length).toBeGreaterThan(0);
    });
  });

  it("renders gradient orbs in the hero and CTA sections", async () => {
    const { container } = await mountIndex();
    const orbs = container.querySelectorAll(".gradient-orb");
    expect(orbs.length).toBe(3);
  });

  it("does not throw if localStorage.setItem fails (try/catch swallows)", async () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    try {
      await expect(mountIndex()).resolves.toBeTruthy();
    } finally {
      window.localStorage.setItem = original;
    }
  });

  // ── Loader tests (covers lines 7-11) ──
  it("loader returns { showForm: true } when no shop param is present", async () => {
    const req = new Request("http://localhost/?other=1");
    const result = (await loader({
      request: req,
      params: {},
      context: {},
    } as Parameters<typeof loader>[0])) as { showForm: boolean };
    expect(result).toEqual({ showForm: true });
  });

  it("loader throws a redirect Response when ?shop= is present", async () => {
    const req = new Request("http://localhost/?shop=demo.myshopify.com");
    let thrown: unknown;
    try {
      await loader({
        request: req,
        params: {},
        context: {},
      } as Parameters<typeof loader>[0]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain("/app?");
    expect(res.headers.get("Location")).toContain("shop=demo.myshopify.com");
  });
});
