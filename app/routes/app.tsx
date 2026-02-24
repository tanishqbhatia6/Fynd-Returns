import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
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
  try {
    const shop = await prisma.shop.findUnique({ where: { shopDomain }, include: { settings: true } });
    if (shop?.settings) appMode = getAppMode(shop.settings);
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
  };
};

const BREADCRUMB_MAP: Record<string, { parent: string; parentLabel: string; label: string }> = {
  "/app/returns": { parent: "/app", parentLabel: "Dashboard", label: "Returns" },
  "/app/reports": { parent: "/app", parentLabel: "Dashboard", label: "Reports" },
  "/app/settings": { parent: "/app", parentLabel: "Dashboard", label: "Settings" },
  "/app/portal": { parent: "/app", parentLabel: "Dashboard", label: "Customer Portal" },
  "/app/settings/integrations": { parent: "/app/settings", parentLabel: "Settings", label: "Integrations" },
  "/app/settings/notifications": { parent: "/app/settings", parentLabel: "Settings", label: "Notifications" },
  "/app/settings/setup": { parent: "/app/settings", parentLabel: "Settings", label: "Setup Guide" },
  "/app/settings/return-settings": { parent: "/app/settings", parentLabel: "Settings", label: "Return Settings" },
  "/app/settings/rules": { parent: "/app/settings", parentLabel: "Settings", label: "Policy Rules" },
  "/app/settings/widget": { parent: "/app/settings", parentLabel: "Settings", label: "Portal Widget" },
  "/app/settings/permissions": { parent: "/app/settings", parentLabel: "Settings", label: "Permissions" },
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

export default function App() {
  const { apiKey, appMode, pendingCount } = useLoaderData<typeof loader>();
  const location = useLocation();
  const isDashboard = location.pathname === "/app" || location.pathname === "/app/";
  const breadcrumb = getBreadcrumb(location.pathname);

  return (
    <AppProvider embedded apiKey={apiKey}>
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
          <span style={{ fontSize: 14 }}>⚠️</span>
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
        <s-link href="/app/reports">Reports</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/portal">Portal</s-link>
      </s-app-nav>
      {!isDashboard && breadcrumb && (
        <div
          style={{
            padding: "10px 24px 4px",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
          }}
        >
          <Link
            to={breadcrumb.parent}
            style={{
              color: "var(--rpm-accent, #005bd3)",
              textDecoration: "none",
              fontWeight: 500,
              transition: "opacity 0.15s",
            }}
          >
            {breadcrumb.parentLabel}
          </Link>
          <span style={{ color: "var(--rpm-text-subtle, #94a3b8)" }}>›</span>
          <span style={{ color: "var(--rpm-text-muted, #64748b)", fontWeight: 500 }}>
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
