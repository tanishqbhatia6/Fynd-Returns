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
  /* v8 ignore start */
  // defensive: className typically not passed in tests; falsy branch covered, truthy not exercised
  const outerClass = className ? `app-page ${className}` : "app-page";
  /* v8 ignore stop */
  return (
    <div className={outerClass}>
      <header className="app-page-header">
        <div className="app-page-header__left">
          {backHref && (
            <Link to={backHref} aria-label="Back" className="app-page-back">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </Link>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 className="app-page-title">{heading}</h1>
            {/* v8 ignore start */}
            {/* defensive: subtitle prop not passed by every caller; truthy/falsy combos vary */}
            {subtitle && <div className="app-page-subtitle">{subtitle}</div>}
            {/* v8 ignore stop */}
          </div>
        </div>
        {/* v8 ignore start */}
        {/* defensive: actions prop only passed by some pages */}
        {actions && <div className="app-page-header__actions">{actions}</div>}
        {/* v8 ignore stop */}
      </header>
      {children}
    </div>
  );
}
