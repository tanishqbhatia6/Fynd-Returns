import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * /auth/login — information page, not an install form.
 *
 * Shopify App Store policy: apps must be installed from a Shopify-owned
 * surface (the App Store listing, or Admin → Apps → Install). Prompting
 * a merchant to type their `.myshopify.com` domain manually is an
 * explicit prohibition, so this route no longer renders a form.
 *
 * Two behaviours remain:
 *
 *   1. If Shopify sent us here with `?shop=<store>.myshopify.com` in
 *      the query string (expired-session redirect), forward straight
 *      to `/auth?shop=…` — which triggers the canonical OAuth flow.
 *   2. Otherwise render a neutral page telling the merchant where to
 *      install from. No input, no submit button.
 *
 * The page is NOT linked from anywhere in the app surface — it's
 * only reachable via direct navigation or Shopify-emitted redirects.
 */

// ────────────────────────────────────────────────────────────────────────
// Update this constant after the App Store listing goes live. Until
// then, link merchants to the public marketing page that explains what
// the app is and how to install.
// ────────────────────────────────────────────────────────────────────────
const APP_STORE_LISTING_URL = "https://apps.shopify.com/";
const MARKETING_URL = "https://www.fynd.com/";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  // Shopify redirects here with ?shop=<store>.myshopify.com when an
  // admin session expires. Forward directly to /auth so OAuth restarts.
  if (shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  return {};
};

export default function Auth() {
  return (
    <AppProvider embedded={false}>
      <div style={{
        minHeight: "100vh",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "40px 20px",
        background: "linear-gradient(135deg, #f8fafc 0%, #eef2ff 50%, #f0f9ff 100%)",
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}>
        <div style={{
          width: "100%", maxWidth: 520,
          background: "#fff", borderRadius: 16, padding: "40px 36px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06)",
          border: "1px solid #e2e8f0",
          textAlign: "center",
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: "linear-gradient(135deg, #4f46e5, #6366f1)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            marginBottom: 20,
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
              <line x1="12" y1="22.08" x2="12" y2="12"/>
            </svg>
          </div>

          <h1 style={{
            fontSize: 24, fontWeight: 800, letterSpacing: "-0.025em",
            margin: "0 0 10px", color: "#0f172a",
          }}>
            Install Fynd Returns
          </h1>
          <p style={{
            fontSize: 15, color: "#475569", lineHeight: 1.6,
            margin: "0 0 28px",
          }}>
            Fynd Returns installs from the Shopify App Store. Open the
            listing and click &quot;Add app&quot; to connect it to your
            store.
          </p>

          <a
            href={APP_STORE_LISTING_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "12px 24px",
              background: "linear-gradient(135deg, #4f46e5, #6366f1)",
              color: "#fff", fontSize: 15, fontWeight: 700,
              borderRadius: 10, textDecoration: "none",
              boxShadow: "0 2px 8px #6366f140",
              letterSpacing: "-0.01em",
            }}
          >
            Open Shopify App Store
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7"/>
              <polyline points="7 7 17 7 17 17"/>
            </svg>
          </a>

          <div style={{
            marginTop: 32, paddingTop: 24, borderTop: "1px solid #f1f5f9",
            fontSize: 13, color: "#64748b", lineHeight: 1.65,
          }}>
            <p style={{ margin: "0 0 6px" }}>
              Already installed? Open Fynd Returns from your store&apos;s{" "}
              <strong style={{ color: "#334155" }}>Admin → Apps</strong>.
            </p>
            <p style={{ margin: 0 }}>
              Learn more at{" "}
              <a href={MARKETING_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1", fontWeight: 600, textDecoration: "none" }}>
                fynd.com
              </a>.
            </p>
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
