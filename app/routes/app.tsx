import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getAppMode } from "../lib/fynd-config.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  const portalUrl = `https://${shopDomain}/apps/returns`;
  let appMode: "dev" | "prod" = "prod";
  try {
    const shop = await prisma.shop.findUnique({ where: { shopDomain }, include: { settings: true } });
    if (shop?.settings) appMode = getAppMode(shop.settings);
  } catch {
    // ignore
  }
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain,
    portalUrl,
    appMode,
  };
};

export default function App() {
  const { apiKey, appMode } = useLoaderData<typeof loader>();
  const location = useLocation();
  const isDashboard = location.pathname === "/app" || location.pathname === "/app/";

  return (
    <AppProvider embedded apiKey={apiKey}>
      {appMode === "dev" && (
        <div style={{ background: "#fef3c7", color: "#92400e", padding: "8px 24px", fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
          <span>⚠️ Dev mode</span>
          <span style={{ opacity: 0.9 }}>— Test data only. Switch to Prod in Settings → Integrations for live operations.</span>
        </div>
      )}
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/returns">Returns</s-link>
        <s-link href="/app/reports">Reports</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/portal">Customer Portal</s-link>
      </s-app-nav>
      {!isDashboard && (
        <div style={{ padding: "0 24px" }}>
          <Link to="/app" style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "#005bd3", textDecoration: "none", fontSize: 14, fontWeight: 500, marginBottom: 16 }}>
            ← Back to Dashboard
          </Link>
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
