import { useState } from "react";
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
    navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const shopName = shopDomain.replace(".myshopify.com", "");

  return (
    <s-page heading="Customer Portal">
      <div className="app-content">
        {/* Portal URL Card */}
        <div
          style={{
            padding: 28,
            background: "linear-gradient(135deg, #eff6ff 0%, #f0fdf4 100%)",
            borderRadius: "var(--rpm-radius-xl, 18px)",
            border: "1px solid #bfdbfe",
            marginBottom: 28,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 20 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "var(--rpm-radius, 10px)",
                background: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 24,
                boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                flexShrink: 0,
              }}
            >
              🌐
            </div>
            <div>
              <h3 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
                Your Portal URL
              </h3>
              <p style={{ margin: 0, color: "var(--rpm-text-muted, #64748b)", fontSize: 14, lineHeight: 1.5 }}>
                Share this link with customers to let them initiate and track returns.
              </p>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <code
              style={{
                padding: "14px 18px",
                background: "white",
                borderRadius: "var(--rpm-radius, 10px)",
                fontSize: 14,
                flex: "1 1 300px",
                overflow: "auto",
                border: "1px solid #e5e7eb",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                color: "var(--rpm-accent, #005bd3)",
                fontWeight: 500,
              }}
            >
              {portalUrl}
            </code>
            <s-button variant="primary" onClick={handleCopy}>
              {copied ? "✓ Copied!" : "📋 Copy URL"}
            </s-button>
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <s-button variant="secondary">↗ Open portal</s-button>
            </a>
          </div>

          {copied && (
            <div
              style={{
                marginTop: 12,
                fontSize: 13,
                color: "#059669",
                fontWeight: 500,
                animation: "app-slideDown 0.2s ease",
              }}
            >
              ✓ Portal URL copied to clipboard
            </div>
          )}
        </div>

        {/* How it works */}
        <div className="app-grid-2" style={{ marginBottom: 28 }}>
          <div
            style={{
              padding: 24,
              background: "var(--rpm-surface, white)",
              borderRadius: "var(--rpm-radius-lg, 14px)",
              border: "var(--rpm-border, 1px solid #e5e7eb)",
              boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
              How it works
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {[
                { step: "1", icon: "🔍", title: "Customer visits portal", desc: "They open the link from your store navigation or a shared URL" },
                { step: "2", icon: "📋", title: "Lookup their order", desc: "Search by Order #, AWB tracking number, Email, or Phone" },
                { step: "3", icon: "📦", title: "Initiate return", desc: "Select items, choose a reason, and submit the return request" },
                { step: "4", icon: "📍", title: "Track everything", desc: "Full visibility: Shopify status, Fynd status, tracking URL, and timeline" },
                { step: "5", icon: "✅", title: "You review in admin", desc: "Returns appear in your Returns list for approval, rejection, or refund" },
              ].map((item) => (
                <div key={item.step} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: "var(--rpm-accent-subtle, #eff6ff)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {item.icon}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{item.title}</div>
                    <div style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.5 }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {/* Add to store */}
            <div
              style={{
                padding: 24,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
                📌 Add to your store
              </h3>
              <p style={{ fontSize: 14, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6, marginBottom: 16 }}>
                Add a "Returns" link to your store's footer navigation that points to the portal URL. This makes it easy for customers to find.
              </p>
              <div className="app-info-box">
                <span>💡</span>
                <span>Go to <strong>Shopify Admin → Online Store → Navigation → Footer menu</strong> → Add menu item → Paste the portal URL as the link.</span>
              </div>
            </div>

            {/* Customize */}
            <div
              style={{
                padding: 24,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
                🎨 Customize appearance
              </h3>
              <p style={{ fontSize: 14, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6, marginBottom: 16 }}>
                Match the portal's look and feel to your brand with custom colors, fonts, and layout options.
              </p>
              <Link to="/app/settings/widget" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">Customize portal theme →</s-button>
              </Link>
            </div>

            {/* Setup Shopify App Proxy */}
            <div
              style={{
                padding: 24,
                background: "var(--rpm-surface, white)",
                borderRadius: "var(--rpm-radius-lg, 14px)",
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                boxShadow: "var(--rpm-shadow-xs, 0 1px 2px rgba(0,0,0,0.04))",
              }}
            >
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
                ⚙️ Shopify App Proxy
              </h3>
              <p style={{ fontSize: 14, color: "var(--rpm-text-muted, #64748b)", lineHeight: 1.6 }}>
                The portal works via Shopify App Proxy. Ensure your app has the proxy configured:
              </p>
              <div style={{ marginTop: 12, padding: "12px 16px", background: "var(--rpm-surface-elevated, #f1f5f9)", borderRadius: 8, fontSize: 13, fontFamily: "ui-monospace, monospace" }}>
                Sub path: <strong>/apps/returns</strong> → Proxy URL: <strong>https://your-app-url/apps/returns</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}
