import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { Search, X } from "lucide-react";
import React, { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAppMode } from "../lib/fynd-config.server";
import { syncShopLocaleAndCurrency } from "../lib/shop.server";
import { getBillingStatus } from "../lib/billing.server";
import { getEmbeddedAdminLaunchParams } from "../lib/shopify-admin-launch.server";
import {
  addShopifyFrameContext,
  getShopifyFrameContextSearch,
  isAdminAppPath,
  readShopifyFrameContext,
  writeShopifyFrameContext,
} from "../lib/shopify-frame-context";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": any;
      "s-page": any;
      "s-section": any;
      "s-button": any;
    }
  }
}

const APP_SETTINGS_SEARCH_ITEMS = [
  {
    title: "Policy Rules",
    path: "/app/settings/rules",
    description: "Return reasons, restricted regions, no-return periods, and per-category rules.",
    keywords: "rules reasons regions no return minimum price offers category policy",
  },
  {
    title: "Return Settings",
    path: "/app/settings/return-settings",
    description: "Return window, fees, photo requirements, auto-approve, auto-refund, and refunds.",
    keywords: "window fees photo approval refund store credit exchange instructions labels",
  },
  {
    title: "Product Policies",
    path: "/app/settings/product-policies",
    description: "Per-product return policies by tag, product type, or collection.",
    keywords: "product tag collection type override window",
  },
  {
    title: "Customer Blocklist",
    path: "/app/settings/blocklist",
    description: "Block customers from returns by email, phone, or order name.",
    keywords: "blocklist blocked fraud email phone customer",
  },
  {
    title: "Channel Policies",
    path: "/app/settings/channel-policies",
    description: "Return rules by Shopify sales channel, POS, Draft Orders, and B2B.",
    keywords: "channel online store pos draft b2b sales channel",
  },
  {
    title: "Auto-Approve Rules",
    path: "/app/settings/auto-rules",
    description: "Automation rules for approving or flagging return requests.",
    keywords: "automation auto approve manual review order value tags",
  },
  {
    title: "Fynd Integration",
    path: "/app/settings/integrations",
    description: "Credentials, environment, connection testing, shipment tracking, and sync.",
    keywords: "fynd integration credentials connection shipment tracking sync uat production webhook",
  },
  {
    title: "Notifications",
    path: "/app/settings/notifications",
    description: "SMTP email, sound alerts, WhatsApp/SMS, and notification templates.",
    keywords: "smtp email whatsapp sms alerts templates notification",
  },
  {
    title: "Fynd Webhook Logs",
    path: "/app/settings/webhook-logs",
    description: "Incoming Fynd webhook events, processing status, errors, and payloads.",
    keywords: "webhook logs events errors payload analytics fynd",
  },
  {
    title: "External API Keys",
    path: "/app/settings/api-keys",
    description: "API keys, external integrations, docs, and Postman collection.",
    keywords: "api keys erp docs postman external integration",
  },
  {
    title: "Portal Appearance",
    path: "/app/settings/widget",
    description: "Customer portal colors, fonts, layout, tabs, language, and labels.",
    keywords: "portal widget theme appearance colors fonts tabs language translation labels locale i18n",
  },
  {
    title: "Permissions",
    path: "/app/settings/permissions",
    description: "read_all_orders scope and order-history access.",
    keywords: "permissions read all orders access scope",
  },
  {
    title: "Billing",
    path: "/app/billing",
    description: "Shopify plan, subscription status, pricing, and charges.",
    keywords: "billing plan subscription pricing charges",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const hasEmbeddedContext =
    Boolean(url.searchParams.get("shop") && url.searchParams.get("host")) ||
    Boolean(url.searchParams.get("id_token")) ||
    Boolean(request.headers.get("authorization"));

  if (!hasEmbeddedContext) {
    const params = getEmbeddedAdminLaunchParams(request, url.searchParams);
    if (params && params.toString() !== url.searchParams.toString()) {
      throw redirect(`${url.pathname}?${params.toString()}`);
    }
  }

  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const portalUrl = `https://${shopDomain}/apps/returns`;

  // ── Billing gate ──
  // Layers: APP_BILLING_MODE env (dev bypasses) → per-shop override
  // (free/paid/null) → live Shopify Managed Pricing subscription check.
  // See app/lib/billing.server.ts for the full decision tree.
  //
  // Redirect to /app/billing if access denied. We explicitly exempt the
  // billing page itself and the superadmin override UI to avoid a
  // redirect loop — if a superadmin with no subscription tries to open
  // /app/settings/billing-override, they still need to get there.
  const onBillingRoute =
    url.pathname === "/app/billing" || url.pathname.startsWith("/app/settings/billing-override");
  if (!onBillingRoute) {
    const billing = await getBillingStatus(shopDomain, admin);
    if (!billing.hasAccess) {
      throw redirect("/app/billing");
    }
  }

  let appMode: "dev" | "prod" = "prod";
  let pendingCount = 0;
  let adminSoundEnabled = true;
  try {
    // Sync shop locale/currency/timezone from Shopify (only writes if changed)
    await syncShopLocaleAndCurrency(admin, shopDomain).catch(() => {});
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { settings: true },
    });
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
    } catch {
      /* AudioContext unavailable */
    }
  }, []);

  useEffect(() => {
    if (enabled && currentCount > prevCount.current) {
      playSound();
    }
    prevCount.current = currentCount;
  }, [currentCount, enabled, playSound]);
}

// useSPageFullWidth removed — every page now uses <AppPage> (a plain div with
// our own .app-page CSS), so there's no <s-page> shadow DOM to force open.
// The shadow-DOM hack worked inconsistently and caused the "lots of empty
// space on the sides" / "mobile-y layout" reports from merchants.

export default function App() {
  const { apiKey, pendingCount, adminSoundEnabled } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";
  const currentFrameContext = useMemo(
    () => getShopifyFrameContextSearch(location.search),
    [location.search],
  );
  const [storedFrameContext, setStoredFrameContext] = useState<string | null>(null);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const frameContext = currentFrameContext ?? storedFrameContext;
  useNotificationSound(adminSoundEnabled, pendingCount);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (currentFrameContext) {
      writeShopifyFrameContext(window.sessionStorage, currentFrameContext);
      setStoredFrameContext(currentFrameContext);
      return;
    }

    const cachedContext = readShopifyFrameContext(window.sessionStorage);
    setStoredFrameContext(cachedContext);
    if (cachedContext && isAdminAppPath(location.pathname)) {
      const currentPath = `${location.pathname}${location.search}${location.hash}`;
      const pathWithContext = addShopifyFrameContext(currentPath, cachedContext);
      if (pathWithContext !== currentPath) {
        navigate(pathWithContext, { replace: true });
      }
    }
  }, [currentFrameContext, location.hash, location.pathname, location.search, navigate]);

  const getAdminPath = useCallback(
    (to: string) => addShopifyFrameContext(to, frameContext),
    [frameContext],
  );

  const handleNavClick = useCallback(
    (to: string) => (event: Event) => {
      event.preventDefault();
      navigate(getAdminPath(to));
    },
    [getAdminPath, navigate],
  );

  const normalizedSettingsSearchQuery = settingsSearchQuery.trim().toLowerCase();
  const settingsSearchResults = useMemo(
    () =>
      normalizedSettingsSearchQuery
        ? APP_SETTINGS_SEARCH_ITEMS.filter((item) =>
            [item.title, item.description, item.path, item.keywords]
              .join(" ")
              .toLowerCase()
              .includes(normalizedSettingsSearchQuery),
          ).slice(0, 6)
        : [],
    [normalizedSettingsSearchQuery],
  );
  const hasSettingsSearchQuery = normalizedSettingsSearchQuery.length > 0;

  const navigateToSettingsSearchResult = useCallback(
    (path: string) => {
      setSettingsSearchQuery("");
      navigate(getAdminPath(path));
    },
    [getAdminPath, navigate],
  );

  const handleSettingsSearchSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const firstResult = settingsSearchResults[0];
      if (firstResult) {
        navigateToSettingsSearchResult(firstResult.path);
      }
    },
    [navigateToSettingsSearchResult, settingsSearchResults],
  );

  return (
    <AppProvider embedded apiKey={apiKey}>
      {/* Navigation loading bar — shows immediately when any page transition starts */}
      {isNavigating && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: "linear-gradient(90deg, #4f46e5, #818cf8, #4f46e5)",
            backgroundSize: "200% 100%",
            zIndex: 9999,
            animation: "rpm-load-bar 1.2s ease-in-out infinite",
          }}
        />
      )}
      <s-app-nav>
        <s-link href={getAdminPath("/app")} onClick={handleNavClick("/app")}>
          Dashboard
        </s-link>
        <s-link href={getAdminPath("/app/returns")} onClick={handleNavClick("/app/returns")}>
          Returns{pendingCount > 0 ? ` (${pendingCount})` : ""}
        </s-link>
        <s-link href={getAdminPath("/app/customers")} onClick={handleNavClick("/app/customers")}>
          Customers
        </s-link>
        <s-link href={getAdminPath("/app/reports")} onClick={handleNavClick("/app/reports")}>
          Analytics
        </s-link>
        <s-link href={getAdminPath("/app/settings")} onClick={handleNavClick("/app/settings")}>
          Settings
        </s-link>
        <s-link href={getAdminPath("/app/portal")} onClick={handleNavClick("/app/portal")}>
          Customer Portal
        </s-link>
        <s-link href={getAdminPath("/app/docs")} onClick={handleNavClick("/app/docs")}>
          Documentation
        </s-link>
      </s-app-nav>
      <div className="app-shell-settings-search">
        <form
          className="app-shell-settings-search-box"
          role="search"
          onSubmit={handleSettingsSearchSubmit}
        >
          <Search size={17} strokeWidth={2} aria-hidden="true" />
          <input
            type="search"
            value={settingsSearchQuery}
            onChange={(event) => setSettingsSearchQuery(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings in ReturnProMax"
          />
          {settingsSearchQuery && (
            <button
              type="button"
              className="app-shell-settings-search-clear"
              onClick={() => setSettingsSearchQuery("")}
              aria-label="Clear app settings search"
            >
              <X size={15} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </form>
        {hasSettingsSearchQuery && (
          <div className="app-shell-settings-search-results" role="listbox">
            {settingsSearchResults.length > 0 ? (
              settingsSearchResults.map((item) => (
                <button
                  type="button"
                  key={item.path}
                  className="app-shell-settings-search-result"
                  onClick={() => navigateToSettingsSearchResult(item.path)}
                  role="option"
                >
                  <span>{item.title}</span>
                  <small>{item.description}</small>
                </button>
              ))
            ) : (
              <div className="app-shell-settings-search-empty">No matching settings</div>
            )}
          </div>
        )}
      </div>
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
