import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const portalUrl = `https://${session.shop}/apps/returns`;
  return { portalUrl, shopDomain: session.shop };
};

export default function PortalInfo() {
  const { portalUrl } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Customer Portal">
      <s-section heading="Portal URL">
        <p style={{ marginBottom: 12, color: "#6d7175" }}>
          Share this URL with your customers so they can initiate and track returns.
          They can look up orders by Order #, AWB, Email, or Mobile.
        </p>
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
              padding: "12px 16px",
              background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
              borderRadius: 8,
              fontSize: 14,
              flex: "1 1 300px",
              overflow: "auto",
              border: "1px solid var(--p-color-border-secondary, #e1e3e5)",
            }}
          >
            {portalUrl}
          </code>
          <s-button
            variant="primary"
            onClick={() => {
              navigator.clipboard.writeText(portalUrl);
            }}
          >
            Copy URL
          </s-button>
          <a
            href={portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none" }}
          >
            <s-button variant="secondary">Open in new tab</s-button>
          </a>
        </div>
      </s-section>

      <s-section heading="How it works">
        <ol
          style={{
            paddingLeft: 20,
            lineHeight: 1.8,
            color: "#4a4a4a",
          }}
        >
          <li>Customer visits the portal URL (copy or open in a new tab to preview)</li>
          <li>They enter Order #, AWB, Email, or Mobile to look up their order or return</li>
          <li>They see end-to-end tracking: Shopify status, Fynd status, tracking URL, and timeline</li>
          <li>They can initiate new returns from the same portal</li>
          <li>Returns appear in your admin Returns list</li>
        </ol>
      </s-section>

      <s-section heading="Add to your store">
        <p style={{ marginBottom: 12, color: "#6d7175" }}>
          Add a link to your store navigation or footer so customers can easily find the returns portal.
        </p>
        <p style={{ fontSize: 14, color: "#6d7175" }}>
          Example: Add a "Returns" link in your footer that points to the portal URL above.
        </p>
      </s-section>
    </s-page>
  );
}
