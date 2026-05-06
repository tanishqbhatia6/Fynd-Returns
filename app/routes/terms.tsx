import type { MetaFunction } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Terms of Service — ReturnPro by Fynd" },
  {
    name: "description",
    content: "Terms of service for the ReturnPro (Fynd Returns) Shopify application.",
  },
];

export default function TermsOfService() {
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
        <h1>Terms of Service</h1>
        <p className="legal-date">Effective date: {effectiveDate}</p>

        <p>
          These Terms of Service (&quot;Terms&quot;) govern your use of the ReturnPro application
          (&quot;Fynd Returns&quot;, &quot;the App&quot;), developed and operated by Shopsense
          Retail Technologies Ltd. (&quot;Fynd&quot;, &quot;we&quot;, &quot;us&quot;, or
          &quot;our&quot;). By installing or using the App, you agree to these Terms.
        </p>

        <h2>1. Service Description</h2>
        <p>
          ReturnPro is a Shopify application that provides merchants with tools to manage product
          returns, including a customer-facing return portal, automated return approvals, analytics,
          and optional integration with Fynd OMS for logistics.
        </p>

        <h2>2. Account and Installation</h2>
        <ul>
          <li>You must have an active Shopify store to install and use the App.</li>
          <li>
            By installing the App, you authorize us to access your store data as described in the
            requested Shopify API scopes.
          </li>
          <li>
            You are responsible for maintaining the security of your store and any third-party
            credentials (e.g., Fynd API keys) you configure in the App.
          </li>
        </ul>

        <h2>3. Acceptable Use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>
            Use the App for any unlawful purpose or in violation of Shopify&apos;s Terms of Service.
          </li>
          <li>Attempt to reverse-engineer, decompile, or extract the source code of the App.</li>
          <li>
            Interfere with or disrupt the App&apos;s infrastructure or other users&apos; access.
          </li>
          <li>Use the App to process fraudulent return claims.</li>
        </ul>

        <h2>4. Data and Privacy</h2>
        <p>
          Our collection and use of data is governed by our <a href="/privacy">Privacy Policy</a>.
          By using the App, you consent to the data practices described therein.
        </p>

        <h2>5. Intellectual Property</h2>
        <p>
          The App, including its design, code, features, and documentation, is the intellectual
          property of Shopsense Retail Technologies Ltd. You are granted a limited, non-exclusive,
          non-transferable license to use the App in connection with your Shopify store.
        </p>

        <h2>6. Third-Party Services</h2>
        <p>
          The App integrates with third-party services including Shopify and optionally Fynd OMS. We
          are not responsible for the availability, accuracy, or performance of these third-party
          services. Your use of such services is subject to their respective terms and conditions.
        </p>

        <h2>7. Availability and Support</h2>
        <ul>
          <li>We strive for 99.9% uptime but do not guarantee uninterrupted service.</li>
          <li>
            We may perform maintenance that temporarily affects availability, with reasonable notice
            when possible.
          </li>
          <li>Support is provided via email and the Shopify App Store listing.</li>
        </ul>

        <h2>8. Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, Fynd shall not be liable for any indirect,
          incidental, special, consequential, or punitive damages, including but not limited to loss
          of profits, data, or business opportunities, arising from or related to your use of the
          App.
        </p>

        <h2>9. Indemnification</h2>
        <p>
          You agree to indemnify and hold harmless Fynd from any claims, damages, or expenses
          arising from your use of the App, your violation of these Terms, or your violation of any
          rights of a third party.
        </p>

        <h2>10. Termination</h2>
        <ul>
          <li>
            You may terminate your use of the App at any time by uninstalling it from your Shopify
            store.
          </li>
          <li>
            We may suspend or terminate your access if you violate these Terms or Shopify&apos;s
            policies.
          </li>
          <li>
            Upon termination, your data will be handled as described in our Privacy Policy (data
            deletion occurs 48 hours after uninstall).
          </li>
        </ul>

        <h2>11. Modifications</h2>
        <p>
          We reserve the right to modify these Terms at any time. Updated Terms will be posted at
          this URL with a revised effective date. Continued use of the App constitutes acceptance of
          the updated Terms.
        </p>

        <h2>12. Governing Law</h2>
        <p>
          These Terms are governed by the laws of India. Any disputes shall be subject to the
          exclusive jurisdiction of the courts in Mumbai, India.
        </p>

        <h2>13. Contact</h2>
        <p>
          For questions about these Terms, contact us at:{" "}
          <a href="mailto:legal@fynd.com">legal@fynd.com</a>
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
