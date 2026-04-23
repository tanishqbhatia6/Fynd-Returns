import * as React from "react";
import { Link } from "react-router";

/**
 * Standard page chrome for every embedded admin route.
 *
 * Replaces Shopify's <s-page> web component, which sits inside a shadow DOM
 * we can't fully restyle. Even with `fullWidth` set and the shadow-DOM
 * width hack in app.tsx, <s-page> rendered some pages with the content
 * stuck to one side and a wide empty band on the other (the "mobile
 * layout" bug merchants reported). This component is just a div with
 * predictable CSS — same `.app-page` / `.app-page-header` / `.app-page-title`
 * classes Channel Policies has been using since the redesign.
 *
 * Why a component (rather than copying the markup into every route): one
 * source of truth for header layout, action bar, back arrow, and subtitle
 * styling. Tweak it once and every page picks the change up.
 */
export interface AppPageProps {
  /** Required page title — rendered as the H1. */
  heading: React.ReactNode;
  /** Optional one-line subtitle under the title. */
  subtitle?: React.ReactNode;
  /**
   * Back link target. When set, renders a chevron-left button to the left
   * of the title. The breadcrumb in `app.tsx` also provides back nav, so
   * this is mainly for routes where the breadcrumb isn't enough on its own
   * (e.g. nested settings).
   */
  backHref?: string;
  /** Right-side action area in the header (Save buttons, filters, etc.). */
  actions?: React.ReactNode;
  /** Page body. */
  children: React.ReactNode;
  /** Extra className appended to the outer .app-page div. */
  className?: string;
}

export function AppPage({
  heading,
  subtitle,
  backHref,
  actions,
  children,
  className,
}: AppPageProps) {
  const outerClass = className ? `app-page ${className}` : "app-page";
  return (
    <div className={outerClass}>
      <div className="app-page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 auto" }}>
          {backHref && (
            <Link
              to={backHref}
              aria-label="Back"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 32,
                height: 32,
                borderRadius: 8,
                color: "var(--rpm-muted, #64748b)",
                textDecoration: "none",
                flexShrink: 0,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--rpm-surface-subtle, #f1f5f9)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </Link>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 className="app-page-title" style={{ margin: 0 }}>
              {heading}
            </h1>
            {subtitle && <div className="app-page-subtitle">{subtitle}</div>}
          </div>
        </div>
        {actions && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {actions}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
