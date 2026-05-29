import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  redirect,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import React, { useEffect, useRef, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAppMode } from "../lib/fynd-config.server";
import { syncShopLocaleAndCurrency } from "../lib/shop.server";
import { getBillingStatus } from "../lib/billing.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
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
  const url = new URL(request.url);
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
  const navigation = useNavigation();
  const isNavigating = navigation.state === "loading";
  useNotificationSound(adminSoundEnabled, pendingCount);

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
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/returns">Returns{pendingCount > 0 ? ` (${pendingCount})` : ""}</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/reports">Analytics</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/portal">Customer Portal</s-link>
        <s-link href="/app/docs">Documentation</s-link>
      </s-app-nav>
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
