import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import React, { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAppMode } from "../lib/fynd-config.server";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      's-app-nav': any;
      's-page': any;
      's-section': any;
      's-button': any;
    }
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const portalUrl = `https://${shopDomain}/apps/returns`;
  let appMode: "dev" | "prod" = "prod";
  let pendingCount = 0;
  let adminSoundEnabled = true;
  try {
    const shop = await prisma.shop.findUnique({ where: { shopDomain }, include: { settings: true } });
    if (shop?.settings) {
      appMode = getAppMode(shop.settings);
      adminSoundEnabled = shop.settings.adminSoundEnabled ?? true;
    }
    if (shop) {
      pendingCount = await prisma.returnCase.count({
        where: { shopId: shop.id, status: { in: ["initiated", "pending"] } },
      });
    }
  } catch {
    // ignore
  }
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain,
    portalUrl,
    appMode,
    pendingCount,
    adminSoundEnabled,
  };
};

const BREADCRUMB_MAP: Record<string, { parent: string; parentLabel: string; label: string }> = {
  "/app/returns": { parent: "/app", parentLabel: "Dashboard", label: "Returns" },
  "/app/customers": { parent: "/app", parentLabel: "Dashboard", label: "Customers" },
  "/app/reports": { parent: "/app", parentLabel: "Dashboard", label: "Analytics" },
  "/app/settings": { parent: "/app", parentLabel: "Dashboard", label: "Settings" },
  "/app/portal": { parent: "/app", parentLabel: "Dashboard", label: "Customer Portal" },
  "/app/settings/integrations": { parent: "/app/settings", parentLabel: "Settings", label: "Integrations" },
  "/app/settings/notifications": { parent: "/app/settings", parentLabel: "Settings", label: "Notifications" },
  "/app/settings/setup": { parent: "/app/settings", parentLabel: "Settings", label: "Setup Guide" },
  "/app/settings/return-settings": { parent: "/app/settings", parentLabel: "Settings", label: "Return Settings" },
  "/app/settings/rules": { parent: "/app/settings", parentLabel: "Settings", label: "Policy Rules" },
  "/app/settings/widget": { parent: "/app/settings", parentLabel: "Settings", label: "Portal Widget" },
  "/app/settings/permissions": { parent: "/app/settings", parentLabel: "Settings", label: "Permissions" },
  "/app/settings/blocklist": { parent: "/app/settings", parentLabel: "Settings", label: "Customer Blocklist" },
  "/app/settings/auto-rules": { parent: "/app/settings", parentLabel: "Settings", label: "Auto-Approve Rules" },
  "/app/settings/webhook-logs": { parent: "/app/settings", parentLabel: "Settings", label: "Fynd Webhook Logs" },
  "/app/docs": { parent: "/app", parentLabel: "Dashboard", label: "Documentation" },
};

function getBreadcrumb(pathname: string) {
  // Exact match first
  if (BREADCRUMB_MAP[pathname]) return BREADCRUMB_MAP[pathname];
  // Dynamic routes: /app/returns/:id
  if (pathname.startsWith("/app/returns/")) {
    return { parent: "/app/returns", parentLabel: "Returns", label: "Return Detail" };
  }
  return null;
}

function useNotificationSound(enabled: boolean, currentCount: number) {
  const prevCount = useRef(currentCount);

  const playSound = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch { /* AudioContext unavailable */ }
  }, []);

  useEffect(() => {
    if (enabled && currentCount > prevCount.current) {
      playSound();
    }
    prevCount.current = currentCount;
  }, [currentCount, enabled, playSound]);
}

/**
 * Force <s-page> to use full available width.
 *
 * Root cause: Shopify's <s-page> web component creates a shadow DOM with an
 * internal container that has a hardcoded max-width (~998px). CSS from outside
 * the shadow DOM cannot override this.
 *
 * Strategy (3-layer):
 * 1. root.tsx <head> script intercepts attachShadow → forces mode:"open"
 *    so we CAN access the shadow root from JS.
 * 2. This hook injects a <style> into the now-open shadow root that nukes
 *    all max-width / padding constraints on every internal element.
 * 3. CSS custom properties + inline styles on <s-page> itself as belt-and-suspenders.
 *
 * Timing: polaris.js loads async → element upgrades → shadow DOM created.
 * We use customElements.whenDefined + MutationObserver + retry timers to
 * catch the exact moment the shadow root appears.
 */
function useSPageFullWidth() {
  useLayoutEffect(() => {
    const STYLE_ID = "rpm-fullwidth";
    // Surgical shadow CSS — only target the outermost wrapper layers that enforce
    // Shopify's narrow max-width. Do NOT touch internal padding/margins/gutters.
    const shadowCSS = `
      :host {
        display: block !important;
        max-width: 100% !important;
        width: 100% !important;
      }
      :host > div,
      :host > div > div,
      :host > div > div > div {
        max-width: 100% !important;
        width: 100% !important;
        box-sizing: border-box !important;
      }
    `;

    function injectShadow(page: Element) {
      const sr = page.shadowRoot;
      if (!sr) return;
      // Inject stylesheet once — no per-element inline style loop
      if (!sr.getElementById(STYLE_ID)) {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = shadowCSS;
        sr.prepend(style);
      }
    }

    function inject(page: Element) {
      const el = page as HTMLElement;
      // Attributes
      el.setAttribute("fullWidth", "");
      el.setAttribute("fullwidth", "");
      // CSS custom properties for max-width only — preserve padding/spacing tokens
      const vars: [string, string][] = [
        ["--s-page-max-width", "100%"], ["--page-max-width", "100%"],
        ["--p-page-max-width", "100%"], ["--pc-page-max-width", "100%"],
      ];
      for (const [k, v] of vars) el.style.setProperty(k, v);
      // Inline max-width only — do NOT zero padding
      el.style.setProperty("max-width", "100%", "important");
      el.style.setProperty("width", "100%", "important");
      // Shadow DOM injection (open because of root.tsx interception)
      injectShadow(page);
    }

    function forceSection(el: Element) {
      const h = el as HTMLElement;
      h.style.setProperty("max-width", "100%", "important");
    }

    function forceParentChain() {
      document.querySelectorAll("s-page").forEach((spage) => {
        let parent = spage.parentElement;
        while (parent && parent !== document.body) {
          const h = parent as HTMLElement;
          h.style.setProperty("max-width", "100%", "important");
          parent = parent.parentElement;
        }
      });
    }

    function run() {
      document.querySelectorAll("s-page").forEach(inject);
      document.querySelectorAll("s-section").forEach(forceSection);
      forceParentChain();
    }

    // Run immediately
    run();

    // Retry at intervals (polaris.js loads async — shadow roots appear later)
    const timers = [50, 150, 400, 800, 1500, 3000, 6000].map((ms) => setTimeout(run, ms));

    // Also trigger when <s-page> custom element is defined (exact timing)
    if (typeof customElements !== "undefined") {
      customElements.whenDefined("s-page").then(() => {
        // Small delay for element upgrade + shadow DOM creation
        setTimeout(run, 0);
        setTimeout(run, 50);
        setTimeout(run, 200);
      });
    }

    // MutationObserver for dynamic elements AND shadow root changes
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) {
            if (node.tagName === "S-PAGE") inject(node);
            node.querySelectorAll?.("s-page").forEach(inject);
            if (node.tagName === "S-SECTION") forceSection(node);
            node.querySelectorAll?.("s-section").forEach(forceSection);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);
}

export default function App() {
  const { apiKey, appMode, pendingCount, adminSoundEnabled } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";
  const isDashboard = location.pathname === "/app" || location.pathname === "/app/";
  const breadcrumb = getBreadcrumb(location.pathname);
  useNotificationSound(adminSoundEnabled, pendingCount);
  useSPageFullWidth();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* Navigation loading bar — shows immediately when any page transition starts */}
      {isNavigating && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, height: 3,
          background: "linear-gradient(90deg, #4f46e5, #818cf8, #4f46e5)",
          backgroundSize: "200% 100%",
          zIndex: 9999,
          animation: "rpm-load-bar 1.2s ease-in-out infinite",
        }} />
      )}
      {appMode === "dev" && (
        <div
          style={{
            background: "linear-gradient(90deg, #fef3c7, #fef9c3)",
            color: "#92400e",
            padding: "8px 24px",
            fontSize: 13,
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid #fcd34d",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>Dev mode — Test data only.</span>
          <Link
            to="/app/settings/integrations"
            style={{ color: "#92400e", fontWeight: 600, textDecoration: "underline" }}
          >
            Switch to Prod
          </Link>
        </div>
      )}
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/returns">
          Returns{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/reports">Analytics</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/portal">Customer Portal</s-link>
        <s-link href="/app/docs">Documentation</s-link>
      </s-app-nav>
      {!isDashboard && breadcrumb && (
        <div
          style={{
            padding: "12px 20px 6px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
          }}
        >
          <Link
            to={breadcrumb.parent}
            style={{
              color: "var(--rpm-accent, #005bd3)",
              textDecoration: "none",
              fontWeight: 600,
              transition: "color 0.15s",
              fontSize: 13,
            }}
          >
            {breadcrumb.parentLabel}
          </Link>
          <span style={{ color: "var(--rpm-text-subtle, #94a3b8)", fontSize: 11 }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ display: "block" }}>
              <path d="M4.5 2.5L8 6L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
          <span style={{ color: "var(--rpm-text-muted, #64748b)", fontWeight: 600 }}>
            {breadcrumb.label}
          </span>
        </div>
      )}
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
