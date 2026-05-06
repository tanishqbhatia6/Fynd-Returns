import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy — ReturnPro by Fynd" },
  {
    name: "description",
    content: "Privacy policy for the ReturnPro (Fynd Returns) Shopify application.",
  },
];

export default function PrivacyPolicy() {
  const effectiveDate = "March 24, 2026";

  return (
    <div className="legal-page">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        .legal-page {
          min-height: 100vh;
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: #18181b; background: #ffffff;
          line-height: 1.7; font-size: 15px;
        }
        @media (prefers-color-scheme: dark) {
          .legal-page { background: #09090b; color: #e4e4e7; }
          .legal-page a { color: #818cf8; }
          .legal-page h1, .legal-page h2, .legal-page h3 { color: #fafafa; }
          .legal-nav { background: rgba(9,9,11,0.85) !important; border-color: rgba(255,255,255,0.06) !important; }
          .legal-nav a { color: #fafafa !important; }
        }
        .legal-nav {
          position: sticky; top: 0; z-index: 100;
          backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
          background: rgba(255,255,255,0.85);
          border-bottom: 1px solid rgba(0,0,0,0.06);
          padding: 0 40px; height: 56px;
          display: flex; align-items: center;
        }
        .legal-nav a {
          display: flex; align-items: center; gap: 8px;
          text-decoration: none; color: #09090b;
          font-weight: 700; font-size: 16px; letter-spacing: -0.03em;
        }
        .legal-nav-icon {
          width: 22px; height: 22px; border-radius: 5px;
          background: linear-gradient(135deg, #4E52F2, #50C0FE);
        }
        .legal-content {
          max-width: 720px; margin: 0 auto;
          padding: 60px 40px 100px;
        }
        .legal-content h1 {
          font-size: 2.25rem; font-weight: 800;
          letter-spacing: -0.03em; margin-bottom: 8px;
        }
        .legal-date {
          font-size: 14px; color: #71717a; margin-bottom: 48px;
        }
        .legal-content h2 {
          font-size: 1.25rem; font-weight: 700;
          letter-spacing: -0.02em; margin: 40px 0 12px;
        }
        .legal-content p, .legal-content li {
          margin-bottom: 12px; color: inherit;
        }
        .legal-content ul {
          padding-left: 24px; margin-bottom: 16px;
        }
        .legal-content a { color: #4E52F2; text-decoration: none; }
        .legal-content a:hover { text-decoration: underline; }
        @media (max-width: 768px) {
          .legal-content { padding: 40px 20px 80px; }
          .legal-nav { padding: 0 20px; }
          .legal-content h1 { font-size: 1.75rem; }
        }
      `}</style>

      <nav className="legal-nav">
        <a href="/">
          <div className="legal-nav-icon" />
          ReturnPro
        </a>
      </nav>

      <div className="legal-content">
        <h1>Privacy Policy</h1>
        <p className="legal-date">Effective date: {effectiveDate}</p>

        <p>
          This Privacy Policy describes how Shopsense Retail Technologies Ltd. (&quot;Fynd&quot;,
          &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects, uses, and discloses
          information in connection with the ReturnPro application (&quot;Fynd Returns&quot;,
          &quot;the App&quot;), a Shopify application for managing product returns.
        </p>

        <h2>1. Information We Collect</h2>
        <p>When a merchant installs the App, we collect and process:</p>
        <ul>
          <li>
            <strong>Store information:</strong> Shop domain, Shopify access tokens, store name, and
            locale settings — required to operate the App within Shopify.
          </li>
          <li>
            <strong>Order data:</strong> Order IDs, line item details, fulfillment information, and
            return reasons — accessed via Shopify APIs to facilitate return processing.
          </li>
          <li>
            <strong>Customer data:</strong> Customer name, email, phone (when provided), and
            shipping address — used solely to process and communicate about return requests.
          </li>
          <li>
            <strong>Fynd integration data:</strong> Fynd API credentials (encrypted at rest), order
            mappings, and shipment tracking information — used for logistics integration with Fynd
            OMS.
          </li>
        </ul>

        <h2>2. How We Use Information</h2>
        <p>We use the collected information to:</p>
        <ul>
          <li>Process and manage return requests on behalf of the merchant.</li>
          <li>Provide the customer-facing return portal experience.</li>
          <li>Sync return and logistics data with Fynd OMS when configured.</li>
          <li>
            Send email notifications about return status updates (when SMTP is configured by the
            merchant).
          </li>
          <li>Generate analytics and reports for the merchant.</li>
          <li>Maintain and improve the App.</li>
        </ul>

        <h2>3. Data Storage and Security</h2>
        <ul>
          <li>All data is stored in a PostgreSQL database hosted on Railway (US region).</li>
          <li>Sensitive credentials (Fynd API keys) are encrypted using AES-256 before storage.</li>
          <li>Customer portal sessions use JWT-based authentication with configurable expiry.</li>
          <li>All communications use HTTPS/TLS encryption in transit.</li>
          <li>We follow the principle of least privilege for all Shopify API scopes.</li>
        </ul>

        <h2>4. Data Sharing</h2>
        <p>We do not sell personal data. We share data only:</p>
        <ul>
          <li>
            With <strong>Fynd OMS</strong> — when the merchant has configured Fynd integration, for
            logistics processing.
          </li>
          <li>
            With <strong>email providers</strong> — when the merchant has configured SMTP, to send
            return status notifications.
          </li>
          <li>As required by law or to comply with legal process.</li>
        </ul>

        <h2>5. Data Retention</h2>
        <ul>
          <li>Merchant and return data is retained while the App is installed.</li>
          <li>Upon uninstallation, Shopify sessions are deleted immediately.</li>
          <li>
            Upon receiving a <code>shop/redact</code> webhook (48 hours after uninstall), all shop
            data — including return cases, customer information, API keys, and settings — is
            permanently deleted.
          </li>
          <li>
            Customer personal data is deleted or anonymized upon receiving a{" "}
            <code>customers/redact</code> request.
          </li>
        </ul>

        <h2>6. GDPR and Data Subject Rights</h2>
        <p>
          If you are a customer of a store using the App, you may exercise your rights under GDPR
          (or equivalent legislation) by contacting the store directly. The store owner can initiate
          data access or deletion requests through Shopify, which triggers our automated compliance
          webhooks.
        </p>
        <p>We support the following GDPR-mandated webhooks:</p>
        <ul>
          <li>
            <strong>Customer data request</strong> — We compile all stored data for the specified
            customer.
          </li>
          <li>
            <strong>Customer data erasure</strong> — We anonymize or delete all personal data for
            the specified customer.
          </li>
          <li>
            <strong>Shop data erasure</strong> — We delete all data associated with the
            merchant&apos;s store.
          </li>
        </ul>

        <h2>7. Cookies and Tracking</h2>
        <p>
          The App does not use third-party cookies or tracking pixels. The embedded Shopify admin
          interface uses Shopify session tokens for authentication. The customer return portal uses
          short-lived JWT tokens.
        </p>

        <h2>8. Children&apos;s Privacy</h2>
        <p>
          The App is a business tool for Shopify merchants and is not directed at individuals under
          16. We do not knowingly collect data from children.
        </p>

        <h2>9. Changes to This Policy</h2>
        <p>
          We may update this Privacy Policy from time to time. The updated version will be indicated
          by the &quot;Effective date&quot; at the top of this page. Continued use of the App after
          changes constitutes acceptance.
        </p>

        <h2>10. Contact Us</h2>
        <p>
          For privacy-related questions or requests, contact us at:{" "}
          <a href="mailto:privacy@fynd.com">privacy@fynd.com</a>
        </p>
        <p>
          Shopsense Retail Technologies Ltd.
          <br />
          Mumbai, India
          <br />
          <a href="https://www.fynd.com" target="_blank" rel="noopener noreferrer">
            www.fynd.com
          </a>
        </p>
      </div>
    </div>
  );
}
