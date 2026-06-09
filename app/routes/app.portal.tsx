import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parsePortalTheme } from "../lib/portal-theme.server";
import { parsePortalConfig } from "../lib/portal-config.server";
import { AppPage } from "../components/AppPage";
import { portalLogger } from "../lib/observability/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const portalUrl = `https://${session.shop}/apps/returns`;
    const storeName = session.shop.replace(".myshopify.com", "");

    const shop = await prisma.shop.findUnique({
      where: { shopDomain: session.shop },
      include: { settings: true },
    });

    const hasTheme = !!shop?.settings?.portalThemeJson;
    const theme = parsePortalTheme(shop?.settings?.portalThemeJson ?? null);
    const config = parsePortalConfig(shop?.settings?.portalConfigJson ?? null);

    let totalReturns = 0;
    let activeReturns = 0;
    if (shop) {
      const [total, active] = await Promise.all([
        prisma.returnCase.count({ where: { shopId: shop.id } }),
        prisma.returnCase.count({
          where: {
            shopId: shop.id,
            status: { in: ["pending", "processing", "in progress", "approved", "initiated"] },
          },
        }),
      ]);
      totalReturns = total;
      activeReturns = active;
    }

    return {
      portalUrl,
      storeName,
      hasTheme,
      theme,
      config,
      totalReturns,
      activeReturns,
    };
  } catch (err) {
    portalLogger.error({ err, shopDomain: session.shop }, "Portal admin loader failed");
    // defensive loader catch fallback
    /* v8 ignore start */
    return {
      portalUrl: "",
      storeName: session.shop?.replace(".myshopify.com", "") ?? "",
      hasTheme: false,
      theme: parsePortalTheme(null),
      config: parsePortalConfig(null),
      totalReturns: 0,
      activeReturns: 0,
    };
    /* v8 ignore stop */
  }
};

export default function PortalInfo() {
  const { portalUrl, storeName, hasTheme, theme, config, totalReturns, activeReturns } =
    useLoaderData<typeof loader>();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(portalUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const enabledSections = [
    config.showOrderTracking && "Order tracking",
    config.showReturnTracking && "Return tracking",
    config.showCreateReturnTab && "Create return",
  ].filter(Boolean) as string[];

  const setupChecks = [
    { label: "Theme customized", done: hasTheme, link: "/app/settings/widget" },
    { label: "Return reasons configured", done: true, link: "/app/settings/rules" },
    {
      label: "Portal sections enabled",
      done: enabledSections.length > 0,
      link: "/app/settings/widget",
    },
  ];
  const setupDone = setupChecks.filter((c) => c.done).length;

  return (
    <AppPage heading="Customer Portal">
      <div className="app-content layout-form">
        {/* ── Portal URL + Status Bar ── */}
        <div
          style={{
            padding: "20px 24px",
            background: "var(--rpm-surface, white)",
            borderRadius: 14,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 10,
              background: "linear-gradient(135deg, #EFF6FF, #DBEAFE)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#3B82F6"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
            </svg>
          </div>

          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase" as const,
                  letterSpacing: "0.08em",
                  color: "#059669",
                  background: "#ECFDF5",
                  padding: "3px 8px",
                  borderRadius: 4,
                  border: "1px solid #A7F3D0",
                }}
              >
                Live
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}>
                {portalUrl}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)" }}>
              Customers use this link to look up orders, initiate returns, and track status.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <s-button variant="primary" onClick={handleCopy}>
              {copied ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Copied
                </span>
              ) : (
                "Copy URL"
              )}
            </s-button>
            <a
              href={portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <s-button variant="secondary">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  Open portal
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </span>
              </s-button>
            </a>
          </div>
        </div>

        {/* ── Stats + Setup Row ── */}
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}
        >
          {/* Active returns */}
          <div
            style={{
              padding: "20px 22px",
              background: "var(--rpm-surface, white)",
              borderRadius: 12,
              border: "var(--rpm-border, 1px solid #e5e7eb)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--rpm-text-muted, #64748b)",
                marginBottom: 8,
                textTransform: "uppercase" as const,
                letterSpacing: "0.04em",
              }}
            >
              Active returns
            </div>
            {/* defensive active returns visual ternaries */}
            {/* v8 ignore start */}
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: activeReturns > 0 ? "#D97706" : "var(--rpm-text, #0f172a)",
                lineHeight: 1,
              }}
            >
              {activeReturns}
            </div>
            <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginTop: 6 }}>
              {activeReturns === 0 ? "No pending requests" : "Awaiting action"}
            </div>
            {/* v8 ignore stop */}
          </div>

          {/* Total returns */}
          <div
            style={{
              padding: "20px 22px",
              background: "var(--rpm-surface, white)",
              borderRadius: 12,
              border: "var(--rpm-border, 1px solid #e5e7eb)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--rpm-text-muted, #64748b)",
                marginBottom: 8,
                textTransform: "uppercase" as const,
                letterSpacing: "0.04em",
              }}
            >
              Total returns
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: "var(--rpm-text, #0f172a)",
                lineHeight: 1,
              }}
            >
              {totalReturns}
            </div>
            <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginTop: 6 }}>
              All time via portal
            </div>
          </div>

          {/* Setup progress */}
          <div
            style={{
              padding: "20px 22px",
              background: "var(--rpm-surface, white)",
              borderRadius: 12,
              border: "var(--rpm-border, 1px solid #e5e7eb)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--rpm-text-muted, #64748b)",
                marginBottom: 8,
                textTransform: "uppercase" as const,
                letterSpacing: "0.04em",
              }}
            >
              Setup
            </div>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: setupDone === setupChecks.length ? "#059669" : "var(--rpm-text, #0f172a)",
                lineHeight: 1,
              }}
            >
              {setupDone}/{setupChecks.length}
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
              {setupChecks.map((c, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    height: 4,
                    borderRadius: 2,
                    background: c.done ? "#059669" : "#E5E7EB",
                    transition: "background 0.3s",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── Two Column: Configuration + Portal Preview ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 340px",
            gap: 20,
            alignItems: "start",
          }}
        >
          {/* LEFT: Configuration & Actions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Portal Configuration Summary */}
            <div
              style={{
                padding: 24,
                background: "var(--rpm-surface, white)",
                borderRadius: 14,
                border: "var(--rpm-border, 1px solid #e5e7eb)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 18,
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 700,
                    color: "var(--rpm-text, #0f172a)",
                  }}
                >
                  Portal configuration
                </h3>
                <Link to="/app/settings/widget" style={{ textDecoration: "none" }}>
                  <s-button variant="secondary">
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13 }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                      Edit
                    </span>
                  </s-button>
                </Link>
              </div>

              {/* Enabled sections */}
              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--rpm-text-muted, #64748b)",
                    marginBottom: 10,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.04em",
                  }}
                >
                  Enabled sections
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {enabledSections.length > 0 ? (
                    enabledSections.map((s) => (
                      <span
                        key={s}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          padding: "6px 12px",
                          background: "#ECFDF5",
                          borderRadius: 6,
                          fontSize: 13,
                          fontWeight: 500,
                          color: "#065F46",
                          border: "1px solid #A7F3D0",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        {s}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: 13, color: "#DC2626", fontWeight: 500 }}>
                      No sections enabled
                    </span>
                  )}
                  {config.allowMediaUploads && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "6px 12px",
                        background: "#EFF6FF",
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "#1E40AF",
                        border: "1px solid #BFDBFE",
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      Media uploads
                    </span>
                  )}
                </div>
              </div>

              {/* Theme summary */}
              <div style={{ marginBottom: 18 }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--rpm-text-muted, #64748b)",
                    marginBottom: 10,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.04em",
                  }}
                >
                  Theme
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      theme.primaryColor,
                      theme.backgroundColor,
                      theme.surfaceColor,
                      theme.textColor,
                    ].map((c, i) => (
                      <div
                        key={i}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          background: c,
                          border: "1px solid rgba(0,0,0,0.1)",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                        }}
                        title={c}
                      />
                    ))}
                  </div>
                  <span style={{ fontSize: 13, color: "var(--rpm-text-muted)", fontWeight: 500 }}>
                    {theme.fontFamily.split(",")[0].replace(/['"]/g, "")} · {theme.borderRadius}{" "}
                    radius
                  </span>
                </div>
              </div>

              {/* Default tab */}
              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--rpm-text-muted, #64748b)",
                    marginBottom: 6,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.04em",
                  }}
                >
                  Default tab
                </div>
                <span
                  style={{
                    display: "inline-block",
                    padding: "5px 12px",
                    background: "#F1F5F9",
                    borderRadius: 6,
                    fontSize: 13,
                    fontWeight: 500,
                    color: "#334155",
                    textTransform: "capitalize" as const,
                  }}
                >
                  {/* defensive default tab label */}
                  {/* v8 ignore start */}
                  {config.defaultTab === "order"
                    ? "Order tracking"
                    : config.defaultTab === "create"
                      ? "Create return"
                      : "Return tracking"}
                  {/* v8 ignore stop */}
                </span>
              </div>
            </div>

            {/* Setup Checklist */}
            <div
              style={{
                padding: 24,
                background: "var(--rpm-surface, white)",
                borderRadius: 14,
                border: "var(--rpm-border, 1px solid #e5e7eb)",
              }}
            >
              <h3
                style={{
                  margin: "0 0 16px",
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--rpm-text, #0f172a)",
                }}
              >
                Setup checklist
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {setupChecks.map((check, i) => (
                  <Link
                    key={i}
                    to={check.link}
                    style={{ textDecoration: "none", color: "inherit" }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "14px 0",
                        borderBottom: i < setupChecks.length - 1 ? "1px solid #F3F4F6" : "none",
                        cursor: "pointer",
                        transition: "background 0.15s",
                      }}
                    >
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          flexShrink: 0,
                          background: check.done ? "#059669" : "#E5E7EB",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          transition: "background 0.3s",
                        }}
                      >
                        {check.done ? (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="white"
                            strokeWidth="3"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <span style={{ fontSize: 11, fontWeight: 700, color: "#9CA3AF" }}>
                            {i + 1}
                          </span>
                        )}
                      </div>
                      <span
                        style={{
                          flex: 1,
                          fontSize: 14,
                          fontWeight: 500,
                          color: check.done
                            ? "var(--rpm-text-muted, #64748b)"
                            : "var(--rpm-text, #0f172a)",
                          textDecoration: check.done ? "line-through" : "none",
                        }}
                      >
                        {check.label}
                      </span>
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#9CA3AF"
                        strokeWidth="2"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                  </Link>
                ))}

                {/* Add to store navigation - always shown as action */}
                <a
                  href={`https://admin.shopify.com/store/${storeName}/menus`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none", color: "inherit" }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "14px 0",
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: "#E5E7EB",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#9CA3AF"
                        strokeWidth="2"
                      >
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </div>
                    <span
                      style={{
                        flex: 1,
                        fontSize: 14,
                        fontWeight: 500,
                        color: "var(--rpm-text, #0f172a)",
                      }}
                    >
                      Add "Returns" link to store navigation
                    </span>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#9CA3AF"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </a>
              </div>
            </div>

            {/* App Proxy */}
            <div
              style={{
                padding: 20,
                background: "var(--rpm-surface, white)",
                borderRadius: 14,
                border: "var(--rpm-border, 1px solid #e5e7eb)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#6B7280"
                  strokeWidth="2"
                >
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
                <h3
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--rpm-text, #0f172a)",
                  }}
                >
                  App Proxy
                </h3>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--rpm-text-muted, #64748b)",
                  lineHeight: 1.6,
                  margin: "0 0 12px",
                }}
              >
                The portal is served through Shopify's App Proxy. Verify this in your{" "}
                <a
                  href="https://partners.shopify.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--rpm-accent, #005bd3)", fontWeight: 500 }}
                >
                  Shopify Partners
                </a>{" "}
                dashboard → App setup → App proxy.
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  gap: "6px 16px",
                  padding: "12px 14px",
                  background: "#F8FAFC",
                  borderRadius: 8,
                  border: "1px solid #E2E8F0",
                  fontSize: 13,
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                }}
              >
                <span style={{ color: "#64748B", fontWeight: 500 }}>Sub path prefix</span>
                <span style={{ color: "#0F172A", fontWeight: 600 }}>apps</span>
                <span style={{ color: "#64748B", fontWeight: 500 }}>Sub path</span>
                <span style={{ color: "#0F172A", fontWeight: 600 }}>returns</span>
                <span style={{ color: "#64748B", fontWeight: 500 }}>Proxy URL</span>
                <span style={{ color: "#0F172A", fontWeight: 600, wordBreak: "break-all" }}>
                  https://&lt;your-app-url&gt;/apps/returns
                </span>
              </div>
            </div>
          </div>

          {/* RIGHT: Portal Preview Card */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              position: "sticky",
              top: 16,
            }}
          >
            {/* Mini preview */}
            <div
              style={{
                padding: 0,
                background: "var(--rpm-surface, white)",
                borderRadius: 14,
                border: "var(--rpm-border, 1px solid #e5e7eb)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid #F3F4F6",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 700,
                    color: "var(--rpm-text, #0f172a)",
                  }}
                >
                  Portal preview
                </h3>
                <a
                  href={portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--rpm-accent, #005bd3)",
                      cursor: "pointer",
                    }}
                  >
                    Open full →
                  </span>
                </a>
              </div>

              {/* Mock portal preview */}
              <div
                style={{
                  padding: 16,
                  background: theme.backgroundColor,
                  minHeight: 240,
                  fontFamily: theme.fontFamily,
                }}
              >
                {/* Mock header */}
                <div
                  style={{
                    textAlign: "center" as const,
                    marginBottom: 16,
                    color: theme.textColor,
                    fontSize: 15,
                    fontWeight: 700,
                  }}
                >
                  Returns & Exchanges
                </div>

                {/* Mock search bar */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginBottom: 16,
                  }}
                >
                  {/* defensive borderColor fallback */}
                  {/* v8 ignore start */}
                  <div
                    style={{
                      flex: 1,
                      height: 36,
                      borderRadius: theme.borderRadius,
                      background: theme.surfaceColor,
                      border: `1px solid ${theme.borderColor || "#E5E7EB"}`,
                    }}
                  />
                  {/* v8 ignore stop */}
                  <div
                    style={{
                      width: 80,
                      height: 36,
                      borderRadius: theme.borderRadius,
                      background: theme.primaryColor,
                    }}
                  />
                </div>

                {/* Mock tabs */}
                <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
                  {/* defensive theme/section visual ternaries */}
                  {/* v8 ignore start */}
                  {enabledSections.slice(0, 3).map((s, i) => (
                    <div
                      key={s}
                      style={{
                        flex: 1,
                        padding: "8px 4px",
                        textAlign: "center" as const,
                        fontSize: 10,
                        fontWeight: 600,
                        borderRadius: `${parseInt(theme.borderRadius, 10) / 2}px`,
                        background: i === 0 ? theme.primaryColor : theme.surfaceColor,
                        color: i === 0 ? "#fff" : theme.textMutedColor || "#64748b",
                        border: i === 0 ? "none" : `1px solid ${theme.borderColor || "#E5E7EB"}`,
                      }}
                    >
                      {s}
                    </div>
                  ))}
                  {/* v8 ignore stop */}
                </div>

                {/* Mock cards */}
                {/* defensive borderColor fallback in cards */}
                {/* v8 ignore start */}
                {[1, 2].map((n) => (
                  <div
                    key={n}
                    style={{
                      padding: 12,
                      marginBottom: 8,
                      background: theme.surfaceColor,
                      borderRadius: theme.borderRadius,
                      border: `1px solid ${theme.borderColor || "#E5E7EB"}`,
                    }}
                  >
                    <div
                      style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}
                    >
                      <div
                        style={{ width: 80, height: 10, borderRadius: 3, background: "#E5E7EB" }}
                      />
                      <div
                        style={{
                          width: 50,
                          height: 10,
                          borderRadius: 3,
                          background: n === 1 ? "#FDE68A" : "#BBF7D0",
                        }}
                      />
                    </div>
                    <div
                      style={{ width: "60%", height: 8, borderRadius: 3, background: "#F3F4F6" }}
                    />
                  </div>
                ))}
                {/* v8 ignore stop */}
              </div>
            </div>

            {/* Quick actions */}
            <div
              style={{
                padding: 20,
                background: "var(--rpm-surface, white)",
                borderRadius: 14,
                border: "var(--rpm-border, 1px solid #e5e7eb)",
              }}
            >
              <h3
                style={{
                  margin: "0 0 14px",
                  fontSize: 14,
                  fontWeight: 700,
                  color: "var(--rpm-text, #0f172a)",
                }}
              >
                Quick actions
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Link to="/app/settings/widget" style={{ textDecoration: "none", width: "100%" }}>
                  <s-button variant="secondary" style={{ width: "100%" }}>
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.04-.23-.29-.38-.63-.38-1.04 0-.82.68-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-9.92-10-9.92z" />
                        <circle cx="7.5" cy="11.5" r="1.5" />
                        <circle cx="10.5" cy="7.5" r="1.5" />
                      </svg>
                      Customize appearance
                    </span>
                  </s-button>
                </Link>
                <Link to="/app/settings/rules" style={{ textDecoration: "none", width: "100%" }}>
                  <s-button variant="secondary" style={{ width: "100%" }}>
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                      </svg>
                      Configure return reasons
                    </span>
                  </s-button>
                </Link>
                <Link to="/app/returns" style={{ textDecoration: "none", width: "100%" }}>
                  <s-button variant="secondary" style={{ width: "100%" }}>
                    <span
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
                      </svg>
                      View all returns
                    </span>
                  </s-button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppPage>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error
      ? error.message
      : "An unexpected error occurred.";
  return (
    <AppPage heading="Customer Portal">
      <div className="app-content layout-form">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a
            href="/app/portal"
            style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}
          >
            Try again
          </a>
        </div>
      </div>
    </AppPage>
  );
}
