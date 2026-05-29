import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { HeadersFunction } from "react-router";
import crypto from "node:crypto";
import stylesheetHref from "./styles.css?url";

/**
 * Security headers applied to ALL routes.
 *
 * Notes on CSP for a Shopify embedded app:
 *  - `frame-ancestors` MUST allow the merchant's *.myshopify.com domain so the app
 *    renders inside the Shopify admin iframe; without it Shopify shows a blank frame.
 *  - script-src uses BOTH a hash for our single hand-written inline script AND
 *    `'strict-dynamic'`. In browsers that honour `'strict-dynamic'` (Chrome 52+,
 *    Firefox 52+, Safari 15.4+, Edge 79+), the policy effectively becomes "only
 *    scripts loaded by trusted code run" — `'unsafe-inline'` is silently ignored.
 *    Older browsers ignore `'strict-dynamic'` and use `'unsafe-inline'` (degraded
 *    but no worse than before this hardening).
 *  - The single inline script in <head> (attachShadow patch) is whitelisted by
 *    SHA-256 hash. If you EDIT that script, regenerate the hash:
 *      node -e "console.log('sha256-' + require('crypto').createHash('sha256').update('<body>').digest('base64'))"
 *  - `style-src 'unsafe-inline'` stays — Polaris and many embedded UI components
 *    inject inline styles that aren't trivially hashable. Inline CSS is a much
 *    smaller XSS surface than inline JS.
 *  - `connect-src` allows the app's own origin + Shopify Admin GraphQL + monorail
 *    telemetry that App Bridge sends.
 */

// Single source of truth for the inline attachShadow patch. The CSP hash is
// derived from this string at boot, so edits can't desync the script and its
// allow-listed hash. Keep this on ONE line — React preserves the textContent
// verbatim, so any whitespace change here changes the hash, but since we
// recompute it the policy stays in sync automatically.
const INLINE_SCRIPT_BODY = `(function(){var o=HTMLElement.prototype.attachShadow;HTMLElement.prototype.attachShadow=function(i){if(this.tagName&&/^S-/i.test(this.tagName)){i=Object.assign({},i,{mode:"open"})}return o.call(this,i)};})();`;

const INLINE_SCRIPT_HASH = `sha256-${crypto.createHash("sha256").update(INLINE_SCRIPT_BODY).digest("base64")}`;
const UI_STYLES_VERSION = "2026-05-29-app-shell-v4";

export const links = () => [
  {
    rel: "stylesheet",
    href: `${stylesheetHref}?v=${UI_STYLES_VERSION}`,
  },
];

export const headers: HeadersFunction = () => {
  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' upgrades modern browsers; 'unsafe-inline' is the fallback
    // for older browsers that ignore 'strict-dynamic'. https → allow inline scripts
    // injected by trusted scripts (App Bridge, React Router hydration). Hashed
    // attachShadow patch is whitelisted explicitly.
    `script-src 'self' '${INLINE_SCRIPT_HASH}' 'strict-dynamic' 'unsafe-inline' https: https://cdn.shopify.com https://*.shopifycdn.com`,
    "style-src 'self' 'unsafe-inline' https://cdn.shopify.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://cdn.shopify.com",
    // Shopify Admin GraphQL + Monorail telemetry the embedded App Bridge needs.
    "connect-src 'self' https://*.myshopify.com https://*.shopify.com https://monorail-edge.shopifysvc.com",
    // Embedded apps load INSIDE Shopify Admin — must allow that frame parent only.
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
    "base-uri 'self'",
    "form-action 'self' https://*.myshopify.com",
    // Block plugin-served content and Flash.
    "object-src 'none'",
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    // Prefer CSP frame-ancestors (modern), keep XFO for old browsers — set to a value
    // that doesn't conflict (XFO can't express the *.myshopify.com allow, so SAMEORIGIN
    // is closest; the CSP frame-ancestors above is what actually enforces).
    "X-Frame-Options": "SAMEORIGIN",
    // 1-year HSTS. Don't preload until the team has confirmed all subdomains are HTTPS.
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  };
};

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/*
          CRITICAL: Intercept attachShadow BEFORE Shopify's polaris.js loads.
          Shopify's <s-page> creates a CLOSED shadow DOM with internal max-width
          constraints. By forcing mode: "open", our JS can later inject CSS into
          the shadow root to remove those constraints.
        */}
        <script dangerouslySetInnerHTML={{ __html: INLINE_SCRIPT_BODY }} />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link rel="stylesheet" href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
