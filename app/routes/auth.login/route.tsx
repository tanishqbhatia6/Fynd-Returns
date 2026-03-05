import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

const FYND_LOGO = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40" fill="none"><text x="0" y="30" font-family="system-ui,-apple-system,sans-serif" font-size="32" font-weight="800" fill="#0f172a">fynd</text></svg>`)}`;

const FEATURES = [
  { icon: "sync", title: "End-to-End Returns", desc: "Complete return lifecycle from customer request to refund processing with Fynd logistics integration." },
  { icon: "globe", title: "15 Languages", desc: "Full i18n with RTL support. Auto-detects shop locale, currency, and timezone from Shopify." },
  { icon: "chart", title: "Analytics & Reports", desc: "Real-time dashboard with return trends, approval rates, revenue impact, and resolution insights." },
  { icon: "shield", title: "Enterprise Security", desc: "OTP verification, encrypted credentials, customer blocklist, and full audit trail." },
  { icon: "zap", title: "Auto-Approve Rules", desc: "Conditional rules to auto-approve or flag returns based on order value, reason, tags, or history." },
  { icon: "palette", title: "Branded Portal", desc: "Fully customizable customer-facing portal with your brand colors, fonts, and messaging." },
];

const ICONS: Record<string, string> = {
  sync: `<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>`,
  chart: `<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>`,
  shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  zap: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  palette: `<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.04-.23-.29-.38-.63-.38-1.04 0-.82.68-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-9.92-10-9.92z"/><circle cx="7.5" cy="11.5" r="1.5"/><circle cx="10.5" cy="7.5" r="1.5"/><circle cx="14.5" cy="7.5" r="1.5"/><circle cx="17.5" cy="11.5" r="1.5"/>`,
};

function FeatureIcon({ name }: { name: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[name] || "" }} />
  );
}

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <div style={{
        minHeight: "100vh", display: "flex",
        background: "linear-gradient(135deg, #f8fafc 0%, #eef2ff 50%, #f0f9ff 100%)",
        fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      }}>

        {/* Left Panel — Branding & Features */}
        <div style={{
          flex: "0 0 520px", display: "flex", flexDirection: "column",
          justifyContent: "center", padding: "60px 56px",
          background: "linear-gradient(160deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
          color: "#fff", position: "relative", overflow: "hidden",
        }}>
          {/* Decorative gradient orbs */}
          <div style={{ position: "absolute", top: -80, right: -80, width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, #6366f120 0%, transparent 70%)", pointerEvents: "none" }} />
          <div style={{ position: "absolute", bottom: -60, left: -60, width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, #06b6d420 0%, transparent 70%)", pointerEvents: "none" }} />

          {/* Logo + App Name */}
          <div style={{ marginBottom: 40, position: "relative", zIndex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <img src="/fynd-logo.png" alt="Fynd" style={{ height: 28, filter: "brightness(0) invert(1)" }} />
              <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>Returns</span>
            </div>
            <div style={{ fontSize: 13, color: "#94a3b8", fontWeight: 500, letterSpacing: "0.02em" }}>
              by <a href="https://www.fynd.com/" target="_blank" rel="noopener noreferrer" style={{ color: "#a5b4fc", textDecoration: "none", fontWeight: 600 }}>Fynd</a> — The AI Platform for Commerce
            </div>
          </div>

          {/* Tagline */}
          <div style={{ position: "relative", zIndex: 1, marginBottom: 40 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.25, letterSpacing: "-0.03em", margin: "0 0 14px" }}>
              Enterprise-grade returns<br />management for Shopify
            </h1>
            <p style={{ fontSize: 15, color: "#94a3b8", lineHeight: 1.7, margin: 0, maxWidth: 400 }}>
              Automate your entire return workflow — from customer-initiated requests through logistics, approval, and refund processing — with full Fynd integration.
            </p>
          </div>

          {/* Features Grid */}
          <div style={{ position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {FEATURES.map((f) => (
              <div key={f.title} style={{
                background: "#ffffff08", border: "1px solid #ffffff12",
                borderRadius: 12, padding: "14px 16px",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, color: "#a5b4fc" }}>
                  <FeatureIcon name={f.icon} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0" }}>{f.title}</span>
                </div>
                <p style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, margin: 0 }}>{f.desc}</p>
              </div>
            ))}
          </div>

          {/* Stats */}
          <div style={{ position: "relative", zIndex: 1, display: "flex", gap: 32, marginTop: 32, paddingTop: 24, borderTop: "1px solid #ffffff12" }}>
            {[
              { n: "15", label: "Languages" },
              { n: "10+", label: "Settings Modules" },
              { n: "229", label: "Translation Keys" },
              { n: "15+", label: "API Endpoints" },
            ].map((s) => (
              <div key={s.label}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "#a5b4fc", letterSpacing: "-0.02em" }}>{s.n}</div>
                <div style={{ fontSize: 11, color: "#64748b", fontWeight: 500 }}>{s.label}</div>
              </div>
            ))}
          </div>

          {/* Fynd link */}
          <div style={{ position: "relative", zIndex: 1, marginTop: 32 }}>
            <a
              href="https://www.fynd.com/"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                fontSize: 13, color: "#64748b", textDecoration: "none",
                padding: "8px 16px", borderRadius: 8,
                background: "#ffffff06", border: "1px solid #ffffff10",
                transition: "all 0.2s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Learn more about Fynd — fynd.com
            </a>
          </div>
        </div>

        {/* Right Panel — Login Form */}
        <div style={{
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          padding: "40px",
        }}>
          <div style={{ width: "100%", maxWidth: 440 }}>
            {/* Welcome header */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
                <img src="/fynd-logo.png" alt="Fynd" style={{ height: 24 }} />
                <span style={{ fontSize: 18, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" }}>Returns</span>
              </div>
              <h2 style={{ fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", margin: "0 0 8px" }}>
                Connect your store
              </h2>
              <p style={{ fontSize: 15, color: "#64748b", margin: 0, lineHeight: 1.6 }}>
                Enter your Shopify store domain to install Fynd Returns and start managing returns like an enterprise.
              </p>
            </div>

            {/* Login Card */}
            <div style={{
              background: "#fff", borderRadius: 16, padding: "32px 28px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06)",
              border: "1px solid #e2e8f0",
            }}>
              <Form method="post">
                <div style={{ marginBottom: 20 }}>
                  <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
                    Store domain
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      name="shop"
                      type="text"
                      placeholder="your-store.myshopify.com"
                      value={shop}
                      onChange={(e) => setShop(e.target.value)}
                      autoComplete="on"
                      style={{
                        width: "100%", padding: "12px 16px", fontSize: 15,
                        border: errors.shop ? "2px solid #ef4444" : "1px solid #d1d5db",
                        borderRadius: 10, outline: "none",
                        transition: "border-color 0.2s, box-shadow 0.2s",
                        background: "#fafafa",
                      }}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = "#6366f1";
                        e.currentTarget.style.boxShadow = "0 0 0 3px #6366f120";
                        e.currentTarget.style.background = "#fff";
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = "#d1d5db";
                        e.currentTarget.style.boxShadow = "none";
                        e.currentTarget.style.background = "#fafafa";
                      }}
                    />
                  </div>
                  {errors.shop && (
                    <p style={{ fontSize: 13, color: "#ef4444", marginTop: 6, fontWeight: 500 }}>
                      {errors.shop}
                    </p>
                  )}
                  <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
                    Example: <span style={{ fontFamily: "monospace", color: "#64748b" }}>my-store.myshopify.com</span>
                  </p>
                </div>

                <button
                  type="submit"
                  style={{
                    width: "100%", padding: "13px 24px",
                    background: "linear-gradient(135deg, #4f46e5, #6366f1)",
                    color: "#fff", fontSize: 15, fontWeight: 700,
                    border: "none", borderRadius: 10, cursor: "pointer",
                    transition: "transform 0.15s, box-shadow 0.15s",
                    boxShadow: "0 2px 8px #6366f140",
                    letterSpacing: "-0.01em",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.transform = "translateY(-1px)";
                    e.currentTarget.style.boxShadow = "0 4px 16px #6366f150";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "0 2px 8px #6366f140";
                  }}
                >
                  Install Fynd Returns
                </button>
              </Form>
            </div>

            {/* Trust signals */}
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { icon: "M22 11.08V12a10 10 0 11-5.93-9.14", text: "Free to install — no credit card required" },
                { icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", text: "SOC 2 compliant infrastructure by Fynd" },
                { icon: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2", text: "Trusted by 300M+ customers via Fynd platform" },
              ].map((item, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#64748b" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {item.text}
                </div>
              ))}
            </div>

            {/* Footer */}
            <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #f1f5f9", textAlign: "center" }}>
              <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>
                Powered by{" "}
                <a href="https://www.fynd.com/" target="_blank" rel="noopener noreferrer" style={{ color: "#6366f1", fontWeight: 600, textDecoration: "none" }}>
                  Fynd
                </a>
                {" "}— The AI Platform for Commerce
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppProvider>
  );
}
