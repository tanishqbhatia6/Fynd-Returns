import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import "./styles.css";

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
