import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const portalUrl = `https://${session.shop}/apps/returns`;
  return { portalUrl, shopDomain: session.shop };
};

export default function PortalInfo() {
  const { portalUrl, shopDomain } = useLoaderData<typeof loader>();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(portalUrl).catch(() => { });
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const storeName = shopDomain.replace(".myshopify.com", "");

  return (
    <s-page heading="Customer Portal">
      <div className="app-content">
        {/* Hero — Portal URL */}
        <div
          style={{
            padding: "32px 28px",
            background: "linear-gradient(135deg, var(--rpm-accent-subtle, #eff6ff) 0%, #f0fdf4 50%, #fdf4ff 100%)",
            borderRadius: "var(--rpm-radius-xl, 18px)",
            border: "1px solid var(--rpm-accent-light, #bfdbfe)",
            marginBottom: 28,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Decorative circles */}
          <div style={{ position: "absolute", top: -30, right: -30, width: 120, height: 120, borderRadius: "50%", background: "rgba(0,91,211,0.05)" }} />
          <div style={{ position: "absolute", bottom: -20, left: -20, width: 80, height: 80, borderRadius: "50%", background: "rgba(5,150,105,0.05)" }} />

          <div style={{ position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.08em", color: "var(--rpm-accent, #005bd3)", background: "white", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--rpm-accent-light, #bfdbfe)" }}>
                Live
              </span>
              <span style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)" }}>
                Customer-facing portal
              </span>
            </div>

            <h2 style={{ margin: "12px 0 8px", fontSize: 22, fontWeight: 700, color: "var(--rpm-text, #0f172a)", letterSpacing: "-0.02em" }}>
              Your Return Portal
            </h2>
            <p style={{ margin: "0 0 20px", color: "var(--rpm-text-muted, #64748b)", fontSize: 14, lineHeight: 1.6, maxWidth: 520 }}>
              Customers use this link to look up orders, initiate returns, and track their return status — all self-service.
            </p>

            {/* URL display */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
              <code
                style={{
                  padding: "12px 16px",
                  background: "white",
                  borderRadius: "var(--rpm-radius, 10px)",
                  fontSize: 14,
                  flex: "1 1 280px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap" as const,
                  border: "1px solid #e5e7eb",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: "var(--rpm-accent, #005bd3)",
                  fontWeight: 500,
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }}
              >
                {portalUrl}
              </code>
              <s-button variant="primary" onClick={handleCopy}>
                {copied ? "Copied!" : "Copy URL"}
              </s-button>
              <a href={portalUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">Open portal ↗</s-button>
              </a>
            </div>

            {copied && (
              <div style={{ marginTop: 10, fontSize: 13, color: "#059669", fontWeight: 500, animation: "app-slideDown 0.2s ease" }}>
                Portal URL copied to clipboard
              </div>
            )}
          </div>
        </div>

        {/* Quick Setup Steps */}
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
            Quick setup
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
            {[
              { num: "1", title: "Add link to store", desc: "Add a \"Returns\" link in your footer navigation", done: false },
              { num: "2", title: "Customize theme", desc: "Match colors and fonts to your brand", done: false },
              { num: "3", title: "Test the portal", desc: "Open the portal and try a test lookup", done: false },
            ].map((s) => (
              <div
                key={s.num}
                style={{
                  padding: "18px 16px",
                  background: "var(--rpm-surface, white)",
                  borderRadius: "var(--rpm-radius, 10px)",
                  border: "var(--rpm-border, 1px solid #e5e7eb)",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  transition: "box-shadow 0.2s, border-color 0.2s",
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: "50%",
                    background: "var(--rpm-accent-subtle, #eff6ff)",
                    color: "var(--rpm-accent, #005bd3)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {s.num}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2, color: "var(--rpm-text, #0f172a)" }}>{s.title}</div>
                  <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.5 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Two column layout */}
        <div className="app-grid-2" style={{ marginBottom: 28 }}>
          {/* How it works */}
          <div
            style={{
              padding: 24,
              background: "var(--rpm-surface, white)",
              borderRadius: "var(--rpm-radius-lg, 14px)",
              border: "var(--rpm-border, 1px solid #e5e7eb)",
              boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
            }}
          >
            <h3 style={{ margin: "0 0 18px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>
              How your customers use the portal
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>, title: "Look up their order", desc: "Search by order number, email, phone, or tracking number", step: "1" },
                { icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>, title: "Select items to return", desc: "Choose products, pick a reason, and submit the request", step: "2" },
                { icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>, title: "Track return status", desc: "Real-time updates from Shopify and Fynd shown on a timeline", step: "3" },
                { icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>, title: "Get notified", desc: "Email updates when their return is approved, shipped, or refunded", step: "4" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      background: "linear-gradient(135deg, var(--rpm-accent-subtle, #eff6ff), var(--rpm-accent-light, #dbeafe))",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                      flexShrink: 0,
                      border: "1px solid var(--rpm-accent-light, #dbeafe)",
                    }}
                  >
                    {item.icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, color: "var(--rpm-text)" }}>{item.title}</div>
                    <div style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.5 }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right column — action cards */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Add to store navigation */}
            <div
              style={{
                padding: 20,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>
                Add to your store
              </h3>
              <p style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6, marginBottom: 14 }}>
                Add a "Returns" link to your store's footer so customers can easily find the portal.
              </p>
              <div
                style={{
                  padding: "14px 16px",
                  background: "var(--rpm-accent-subtle, #eff6ff)",
                  borderRadius: 10,
                  fontSize: 13,
                  color: "var(--rpm-text-secondary, #334155)",
                  lineHeight: 1.7,
                  borderLeft: "3px solid var(--rpm-accent, #005bd3)",
                }}
              >
                <strong>Shopify Admin</strong> → Online Store → Navigation → Footer menu → Add menu item → Paste the portal URL
              </div>
            </div>

            {/* Customize appearance */}
            <div
              style={{
                padding: 20,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>
                Customize appearance
              </h3>
              <p style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6, marginBottom: 14 }}>
                Match the portal to your brand with custom colors, fonts, and layout.
              </p>
              <Link to="/app/settings/widget" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">Customize portal theme →</s-button>
              </Link>
            </div>

            {/* App Proxy */}
            <div
              style={{
                padding: 20,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>
                App Proxy configuration
              </h3>
              <p style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6, marginBottom: 12 }}>
                The portal is served through Shopify's App Proxy. Ensure this is configured in your app settings:
              </p>
              <div
                style={{
                  padding: "12px 16px",
                  background: "var(--rpm-surface-elevated, #f1f5f9)",
                  borderRadius: 10,
                  fontSize: 13,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: "var(--rpm-text-secondary, #334155)",
                  lineHeight: 1.8,
                  border: "var(--rpm-border, 1px solid #e5e7eb)",
                }}
              >
                Sub path: <strong>/apps/returns</strong>
                <br />
                Proxy URL: <strong>{`https://your-app-url/apps/returns`}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
