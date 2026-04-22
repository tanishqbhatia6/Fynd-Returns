import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { HeadersFunction } from "react-router";
import "./styles.css";

/**
 * Security headers applied to ALL routes.
 *
 * Notes on CSP for a Shopify embedded app:
 *  - `frame-ancestors` MUST allow the merchant's *.myshopify.com domain so the app
 *    renders inside the Shopify admin iframe; without it Shopify shows a blank frame.
 *  - The inline script in <head> below patches `attachShadow` BEFORE App Bridge loads.
 *    We need either a nonce (stable per request) or `'unsafe-inline'`. App Bridge also
 *    injects inline scripts, so a permissive script-src is the pragmatic choice today.
 *    Tighten via nonce in a follow-up once App Bridge supports nonces consistently.
 *  - `connect-src` allows the app's own origin + Shopify Admin GraphQL + monorail
 *    telemetry that App Bridge sends.
 */
export const headers: HeadersFunction = () => {
  const csp = [
    "default-src 'self'",
    // Inline scripts (the attachShadow patch + App Bridge); CDN scripts (App Bridge).
    "script-src 'self' 'unsafe-inline' https://cdn.shopify.com https://*.shopifycdn.com",
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
        <script dangerouslySetInnerHTML={{ __html: `(function(){var o=HTMLElement.prototype.attachShadow;HTMLElement.prototype.attachShadow=function(i){if(this.tagName&&/^S-/i.test(this.tagName)){i=Object.assign({},i,{mode:"open"})}return o.call(this,i)};})();` }} />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
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
