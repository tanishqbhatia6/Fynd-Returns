import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, redirect, useLoaderData } from "react-router";
import jwt from "jsonwebtoken";
import { authenticate } from "../shopify.server";
import { AppPage } from "../components/AppPage";
import {
  getBillingStatus,
  getManagedPricingUpgradeUrl,
  getBillingMode,
  isSuperAdmin,
  selectFreeBillingPlan,
} from "../lib/billing.server";
import {
  buildAdminHostParam,
  getEmbeddedAdminLaunchParams,
  normalizeShop,
} from "../lib/shopify-admin-launch.server";

/**
 * Billing status page.
 *
 * Reached two ways:
 *   1. Redirected by the app.tsx root-loader gate when a prod shop
 *      has no active subscription and no per-shop override.
 *   2. Linked directly from settings → Billing (superadmins) or the
 *      top-right admin nav (future).
 *
 * Renders:
 *   - current plan name (when active)
 *   - an "Upgrade" CTA pointing at Shopify Managed Pricing's plan
 *     picker when the shop has no active subscription
 *   - a dev-mode banner (and "nothing to do here") when
 *     APP_BILLING_MODE=dev
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const status = await getBillingStatus(session.shop, admin);
  const upgradeUrl = getManagedPricingUpgradeUrl(session.shop);
  const mode = getBillingMode();
  // App Bridge flag so users can see which environment they're in.
  // Superadmins also see the link to the override UI.
  const sessionEmail =
    (session as unknown as { onlineAccessInfo?: { associated_user?: { email?: string } } })
      .onlineAccessInfo?.associated_user?.email ?? null;
  return {
    status,
    upgradeUrl,
    mode,
    isSuperadmin: isSuperAdmin(sessionEmail),
    sessionEmail,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const shopDomain = await getBillingActionShop(request);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  if (intent !== "select-free-plan") {
    return { error: "Unsupported billing action" };
  }

  await selectFreeBillingPlan(shopDomain);
  throw redirect(getPostSelectionRedirect(request, shopDomain));
};

type ShopifyAdminSessionTokenClaims = {
  dest?: string;
  aud?: string;
};

async function getBillingActionShop(request: Request): Promise<string> {
  try {
    const { session } = await authenticate.admin(request);
    return session.shop;
  } catch (error) {
    const fallbackShop = verifyBillingActionSessionToken(request);
    if (fallbackShop) return fallbackShop;
    throw error;
  }
}

function verifyBillingActionSessionToken(request: Request): string | null {
  const url = new URL(request.url);
  const token =
    url.searchParams.get("id_token") ??
    request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ??
    null;
  if (!token || !process.env.SHOPIFY_API_SECRET) return null;

  try {
    const claims = jwt.verify(token, process.env.SHOPIFY_API_SECRET, {
      algorithms: ["HS256"],
    }) as ShopifyAdminSessionTokenClaims;

    if (process.env.SHOPIFY_API_KEY && claims.aud && claims.aud !== process.env.SHOPIFY_API_KEY) {
      return null;
    }

    const tokenShop = normalizeShop(claims.dest ?? null);
    if (!tokenShop) return null;

    const queryShop = normalizeShop(url.searchParams.get("shop"));
    if (queryShop && queryShop !== tokenShop) return null;

    return tokenShop;
  } catch {
    return null;
  }
}

function getPostSelectionRedirect(request: Request, shopDomain: string): string {
  const url = new URL(request.url);
  const params =
    getEmbeddedAdminLaunchParams(request, url.searchParams) ??
    new URLSearchParams(url.searchParams);
  const hasSignedQuery = params.has("hmac") || params.has("signature");

  if (!params.get("shop")) {
    params.set("shop", shopDomain);
  }
  if (!params.get("host") && !hasSignedQuery) {
    params.set("host", buildAdminHostParam(shopDomain));
  }
  if (!params.get("embedded") && !hasSignedQuery) {
    params.set("embedded", "1");
  }

  const search = params.toString();
  return search ? `/app?${search}` : "/app";
}

export default function BillingPage() {
  const { status, upgradeUrl, mode, isSuperadmin } = useLoaderData<typeof loader>();

  return (
    <AppPage heading="Billing">
      <div className="app-content layout-medium" style={{ paddingBottom: 48 }}>
        {/* Mode banner */}
        <div
          style={{
            padding: "12px 16px",
            background: mode === "dev" ? "#FEF9C3" : "#EFF6FF",
            border: `1px solid ${mode === "dev" ? "#FDE68A" : "#BFDBFE"}`,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 20,
            fontSize: 13,
            color: mode === "dev" ? "#92400E" : "#1E40AF",
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            App is running in <strong>{mode === "dev" ? "development" : "production"}</strong> mode.
            {mode === "dev" && " Billing is bypassed — all features are free on this build."}
            {mode === "prod" && " Subscription is required for app access."}
          </span>
        </div>

        {/* Status card */}
        <div
          style={{
            background: "#fff",
            borderRadius: 14,
            border: "1px solid #E2E8F0",
            padding: "28px 28px 24px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
            marginBottom: 20,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: status.hasAccess ? "#ECFDF5" : "#FEF2F2",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {status.hasAccess ? (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#059669"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#DC2626"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
              )}
            </div>
            <div>
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  margin: "0 0 4px",
                  letterSpacing: "-0.02em",
                  color: "#0F172A",
                }}
              >
                {status.hasAccess ? "Access granted" : "Subscription required"}
              </h2>
              <div style={{ fontSize: 13, color: "#64748B" }}>
                <ReasonLabel reason={status.reason} subscriptionName={status.subscriptionName} />
              </div>
            </div>
          </div>

          {/* Upgrade CTA when billing missing */}
          {!status.hasAccess && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #F1F5F9" }}>
              <p style={{ fontSize: 14, color: "#475569", lineHeight: 1.6, margin: "0 0 16px" }}>
                Start on the Free plan, or open Shopify Managed Pricing to choose a paid plan.
                Shopify handles paid-plan approval; no credit card is entered into this app.
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                <form method="post">
                  <input type="hidden" name="intent" value="select-free-plan" />
                  <button
                    type="submit"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "12px 22px",
                      background: "#FFFFFF",
                      color: "#0F172A",
                      fontSize: 15,
                      fontWeight: 700,
                      borderRadius: 10,
                      border: "1px solid #CBD5E1",
                      cursor: "pointer",
                      boxShadow: "0 1px 2px rgba(15,23,42,0.06)",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    Continue with Free
                  </button>
                </form>
                <a
                  href={upgradeUrl}
                  target="_top"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "12px 24px",
                    background: "linear-gradient(135deg, #4F46E5, #6366F1)",
                    color: "#fff",
                    fontSize: 15,
                    fontWeight: 700,
                    borderRadius: 10,
                    textDecoration: "none",
                    boxShadow: "0 2px 8px #6366F140",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Choose a paid plan
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 17L17 7" />
                    <polyline points="7 7 17 7 17 17" />
                  </svg>
                </a>
              </div>
              <p style={{ fontSize: 12, color: "#94A3B8", marginTop: 12, lineHeight: 1.5 }}>
                Free starts immediately. Paid plans are approved in Shopify, then you'll be returned
                here automatically.
              </p>
            </div>
          )}

          {/* Active subscription detail */}
          {status.hasAccess && status.subscriptionName && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: "1px solid #F1F5F9" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 16,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#64748B",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      marginBottom: 4,
                    }}
                  >
                    Current plan
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>
                    {status.subscriptionName}
                  </div>
                </div>
                <a
                  href={upgradeUrl}
                  target="_top"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#4F46E5",
                    textDecoration: "none",
                    padding: "6px 12px",
                    border: "1px solid #C7D2FE",
                    borderRadius: 8,
                  }}
                >
                  Manage plan
                </a>
              </div>
            </div>
          )}
        </div>

        {/* Superadmin-only link to override UI */}
        {isSuperadmin && (
          <div
            style={{
              padding: "14px 16px",
              background: "#F5F3FF",
              border: "1px solid #DDD6FE",
              borderRadius: 10,
              fontSize: 13,
              color: "#5B21B6",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#7C3AED"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span style={{ flex: 1 }}>
              Superadmin tools —{" "}
              <Link
                to="/app/settings/billing-override"
                style={{ color: "#7C3AED", fontWeight: 700, textDecoration: "none" }}
              >
                override billing for specific shops
              </Link>
            </span>
          </div>
        )}
      </div>
    </AppPage>
  );
}

function ReasonLabel({
  reason,
  subscriptionName,
}: {
  reason: ReturnType<typeof mapReasonNever>;
  subscriptionName?: string | null;
}) {
  switch (reason) {
    case "dev_mode":
      return <>Development build — billing is not enforced on this environment.</>;
    case "override_free":
      return <>Free access granted by a superadmin for this shop.</>;
    case "free_plan_selected":
      return <>Free plan selected for this shop.</>;
    case "subscription_active":
      return subscriptionName ? (
        <>
          Active subscription: <strong>{subscriptionName}</strong>
        </>
      ) : (
        <>Active Shopify subscription.</>
      );
    case "subscription_missing":
      return <>No active Shopify subscription detected for this shop.</>;
    case "override_paid_no_sub":
      return (
        <>A superadmin forced billing for this shop, but no active subscription is on file yet.</>
      );
    default:
      return <>{reason}</>;
  }
}

// Helper for the switch's exhaustiveness check.
// Never actually called — purely for TypeScript narrowing of the reason union.
/* v8 ignore start */
function mapReasonNever():
  | "dev_mode"
  | "override_free"
  | "free_plan_selected"
  | "subscription_active"
  | "subscription_missing"
  | "override_paid_no_sub" {
  throw new Error("unreachable");
}
/* v8 ignore stop */
