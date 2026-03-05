import React, { useState } from "react";
import { Link } from "react-router";

type Section = {
  id: string;
  title: string;
  icon: React.ReactNode;
  content: React.ReactNode;
};

const cardStyle: React.CSSProperties = {
  background: "var(--rpm-surface, white)", borderRadius: 14, padding: 22,
  border: "var(--rpm-border, 1px solid #e5e7eb)", marginBottom: 16,
};

const headingStyle: React.CSSProperties = {
  fontSize: 16, fontWeight: 700, color: "var(--rpm-text, #0f172a)",
  margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8,
};

const subheadingStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 600, color: "var(--rpm-text, #0f172a)",
  margin: "18px 0 8px",
};

const paraStyle: React.CSSProperties = {
  fontSize: 13, color: "var(--rpm-text-muted, #475569)", lineHeight: 1.7, margin: "0 0 10px",
};

const stepStyle: React.CSSProperties = {
  padding: "10px 14px", borderRadius: 8,
  background: "#F8FAFC", border: "1px solid #E2E8F0",
  fontSize: 13, lineHeight: 1.7, marginBottom: 8,
};

const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, monospace", fontSize: 12,
  background: "#F1F5F9", padding: "2px 6px", borderRadius: 4,
  color: "#0F172A",
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 12,
};

const thStyle: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px", fontWeight: 600, fontSize: 11,
  color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em",
  borderBottom: "2px solid #E2E8F0",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px", borderBottom: "1px solid #F1F5F9", verticalAlign: "top",
};

function Chip({ children, color = "#3B82F6" }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 5,
      background: `${color}14`, color, border: `1px solid ${color}30`,
    }}>
      {children}
    </span>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 22, height: 22, borderRadius: "50%", background: "#3B82F6", color: "white",
      fontSize: 11, fontWeight: 700, flexShrink: 0, marginRight: 8,
    }}>{n}</span>
  );
}

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
    content: (
      <>
        <p style={paraStyle}>
          <strong>Return Pro Max</strong> is an enterprise-grade Shopify app that manages the complete return lifecycle — from customer-initiated return requests through approval, Fynd logistics sync, tracking, and Shopify refund processing.
        </p>
        <div style={subheadingStyle}>Key capabilities</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Customer portal</strong> — Branded, embeddable portal where customers look up orders, request returns, upload photos, and track return status in real time.</li>
          <li><strong>Admin dashboard</strong> — Review, approve/reject returns, process refunds, and monitor analytics from the Shopify admin.</li>
          <li><strong>Fynd integration</strong> — Sync approved returns to Fynd for reverse logistics (pickup, tracking, delivery). Auto-refund when Fynd completes processing.</li>
          <li><strong>Shopify refund</strong> — Process refunds directly to the customer's original payment method from the return detail page, with inventory restock at the correct location.</li>
          <li><strong>Reports & analytics</strong> — Return trends, approval/refund rates, top reasons, processing time, and exportable CSV data.</li>
        </ul>
        <div style={subheadingStyle}>Architecture</div>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Component</th><th style={thStyle}>Technology</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}>Framework</td><td style={tdStyle}>React Router v7 (full-stack)</td></tr>
            <tr><td style={tdStyle}>Shopify integration</td><td style={tdStyle}>@shopify/shopify-app-react-router</td></tr>
            <tr><td style={tdStyle}>API version</td><td style={tdStyle}>Shopify Admin API 2025-10</td></tr>
            <tr><td style={tdStyle}>UI components</td><td style={tdStyle}>Polaris Web Components (s-*)</td></tr>
            <tr><td style={tdStyle}>Database</td><td style={tdStyle}>PostgreSQL + Prisma 6 ORM</td></tr>
            <tr><td style={tdStyle}>Build</td><td style={tdStyle}>Vite 6</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: "getting-started",
    title: "Getting Started",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    content: (
      <>
        <p style={paraStyle}>Follow these steps to install and configure Return Pro Max for the first time.</p>

        <div style={subheadingStyle}>Prerequisites</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Node.js 20.19+ installed</li>
          <li>Shopify Partner account with a development store</li>
          <li>PostgreSQL database (local, Neon, Supabase, or Railway)</li>
          <li>Fynd Partner credentials (optional, for logistics integration)</li>
        </ul>

        <div style={subheadingStyle}>Installation</div>
        <div style={stepStyle}><StepNumber n={1} /> Clone the repository and run <code style={codeStyle}>npm install</code></div>
        <div style={stepStyle}><StepNumber n={2} /> Create a PostgreSQL database and configure your <code style={codeStyle}>.env</code> file:
          <div style={{ marginTop: 6, padding: "8px 12px", background: "#F1F5F9", borderRadius: 6, fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.8 }}>
            DATABASE_URL="postgresql://user:pass@host:5432/returnpromax"<br/>
            PORTAL_JWT_SECRET="..."  <span style={{ color: "#94A3B8" }}># openssl rand -hex 32</span><br/>
            ENCRYPTION_KEY="..."  <span style={{ color: "#94A3B8" }}># 32-byte hex key</span>
          </div>
        </div>
        <div style={stepStyle}><StepNumber n={3} /> Run database migrations: <code style={codeStyle}>npx prisma migrate dev --name init</code></div>
        <div style={stepStyle}><StepNumber n={4} /> Start the dev server: <code style={codeStyle}>npm run dev</code></div>
        <div style={stepStyle}><StepNumber n={5} /> Install the app on your Shopify development store via the Partner dashboard URL.</div>

        <div style={subheadingStyle}>App Proxy (Customer Portal)</div>
        <p style={paraStyle}>
          The customer portal is served via Shopify's App Proxy feature. This makes it accessible at <code style={codeStyle}>https://your-store.myshopify.com/apps/returns</code>.
        </p>
        <div style={stepStyle}><StepNumber n={1} /> In your Shopify Partner dashboard, go to your app's configuration.</div>
        <div style={stepStyle}><StepNumber n={2} /> Under <strong>App Proxy</strong>, set: <strong>Sub path prefix</strong> = <code style={codeStyle}>apps</code>, <strong>Sub path</strong> = <code style={codeStyle}>returns</code></div>
        <div style={stepStyle}><StepNumber n={3} /> Set <strong>Proxy URL</strong> to <code style={codeStyle}>https://your-app-url/apps/returns</code> (your deployed app URL).</div>
        <div style={stepStyle}><StepNumber n={4} /> Save. The portal is now live at your store's <code style={codeStyle}>/apps/returns</code> path.</div>
      </>
    ),
  },
  {
    id: "customer-portal",
    title: "Customer Portal",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    content: (
      <>
        <p style={paraStyle}>
          The customer portal is the public-facing interface where your customers initiate and track returns. It's fully branded and embedded within your Shopify storefront via App Proxy.
        </p>

        <div style={subheadingStyle}>Portal tabs</div>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Tab</th><th style={thStyle}>Function</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}><strong>New Return</strong></td><td style={tdStyle}>Customer enters their order number (e.g. #1001) and email/phone. The app verifies the order via Shopify API and displays eligible items. Customer selects items, reason, quantity, optional notes, and submits the return request.</td></tr>
            <tr><td style={tdStyle}><strong>Track Return</strong></td><td style={tdStyle}>Customer looks up existing returns by order number, return number, forward AWB, return AWB, email, or phone. Shows return status, timeline, Fynd return number, and tracking details.</td></tr>
          </tbody>
        </table>

        <div style={subheadingStyle}>How customers create a return</div>
        <div style={stepStyle}><StepNumber n={1} /> Customer visits <code style={codeStyle}>https://your-store.com/apps/returns</code></div>
        <div style={stepStyle}><StepNumber n={2} /> Enters order number (with or without #) and the email or phone associated with the order.</div>
        <div style={stepStyle}><StepNumber n={3} /> System verifies via Shopify API. If the order exists and is within the return window, eligible line items are displayed.</div>
        <div style={stepStyle}><StepNumber n={4} /> Customer selects items to return, chooses a reason for each, sets quantity, and optionally adds notes or uploads photos.</div>
        <div style={stepStyle}><StepNumber n={5} /> Submits the return request. A confirmation is shown with the return request ID (e.g. RPM-A1B2C3D4).</div>

        <div style={subheadingStyle}>How customers track a return</div>
        <div style={stepStyle}><StepNumber n={1} /> Customer goes to the <strong>Track Return</strong> tab.</div>
        <div style={stepStyle}><StepNumber n={2} /> Enters one of: order number, return request ID, forward AWB, return AWB, email, or mobile number.</div>
        <div style={stepStyle}><StepNumber n={3} /> Matching returns are displayed with: status, order name, Fynd return number (if synced), AWB numbers, created date, and a full event timeline.</div>

        <div style={subheadingStyle}>Portal customization</div>
        <p style={paraStyle}>
          Go to <Link to="/app/settings/widget" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings → Portal Widget</Link> to customize:
        </p>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Theme color</strong> — Primary accent color for buttons and links</li>
          <li><strong>Font family</strong> — System, Inter, Poppins, or custom</li>
          <li><strong>Border radius</strong> — Rounded or sharp corners</li>
          <li><strong>Default tab</strong> — Which tab opens first (New Return or Track Return)</li>
          <li><strong>Enabled sections</strong> — Toggle New Return and/or Track Return tabs</li>
        </ul>
      </>
    ),
  },
  {
    id: "admin-returns",
    title: "Managing Returns (Admin)",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    content: (
      <>
        <div style={subheadingStyle}>Returns list</div>
        <p style={paraStyle}>
          The <Link to="/app/returns" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Returns</Link> page shows all return requests with:
        </p>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Column</th><th style={thStyle}>Description</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}><strong>Return ID</strong></td><td style={tdStyle}>Unique ID like RPM-A1B2C3D4. Click to open detail page.</td></tr>
            <tr><td style={tdStyle}><strong>Order</strong></td><td style={tdStyle}>Shopify order name (e.g. #1001). Shows Fynd Order ID below if synced.</td></tr>
            <tr><td style={tdStyle}><strong>Status</strong></td><td style={tdStyle}>Current status badge. Shows "Fynd synced" indicator when return is synced. Shows refund status below when applicable.</td></tr>
            <tr><td style={tdStyle}><strong>Fynd / AWB</strong></td><td style={tdStyle}>Fynd Shipment ID, Return Number, and/or Return AWB when available.</td></tr>
            <tr><td style={tdStyle}><strong>Customer</strong></td><td style={tdStyle}>Customer email (truncated).</td></tr>
            <tr><td style={tdStyle}><strong>Created</strong></td><td style={tdStyle}>Date the return was submitted.</td></tr>
          </tbody>
        </table>
        <p style={paraStyle}>
          Use the <strong>search bar</strong> to find returns by order number, return ID, AWB, Fynd IDs, email, or phone. Filter by status using the dropdown. Click the stat cards at the top to quick-filter. <strong>Export CSV</strong> downloads matching results.
        </p>

        <div style={subheadingStyle}>Return detail page</div>
        <p style={paraStyle}>Click any return to open its detail page. This is the central hub for managing a single return.</p>

        <div style={{ ...subheadingStyle, fontSize: 13 }}>Status lifecycle</div>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Status</th><th style={thStyle}>Meaning</th><th style={thStyle}>Next actions</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}><Chip color="#D97706">Pending</Chip></td><td style={tdStyle}>Customer submitted, awaiting admin review.</td><td style={tdStyle}>Approve or Reject</td></tr>
            <tr><td style={tdStyle}><Chip color="#3B82F6">Approved</Chip></td><td style={tdStyle}>Admin approved. Eligible for Fynd sync and refund.</td><td style={tdStyle}>Sync to Fynd, Process Refund</td></tr>
            <tr><td style={tdStyle}><Chip color="#059669">Completed</Chip></td><td style={tdStyle}>Return fully processed (refund issued).</td><td style={tdStyle}>None — final state</td></tr>
            <tr><td style={tdStyle}><Chip color="#DC2626">Rejected</Chip></td><td style={tdStyle}>Admin rejected with reason.</td><td style={tdStyle}>None (customer sees reason)</td></tr>
            <tr><td style={tdStyle}><Chip color="#6B7280">Cancelled</Chip></td><td style={tdStyle}>Return cancelled.</td><td style={tdStyle}>None</td></tr>
          </tbody>
        </table>

        <div style={{ ...subheadingStyle, fontSize: 13 }}>Actions available</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Approve</strong> — Marks the return as approved. If Fynd Platform API is configured, automatically syncs the return to Fynd.</li>
          <li><strong>Reject</strong> — Requires a rejection reason. Customer sees this reason in the portal.</li>
          <li><strong>Sync to Fynd / Retry Fynd sync</strong> — Manually triggers Fynd return creation. Appears when Fynd is configured but the return hasn't been synced yet.</li>
          <li><strong>Process refund</strong> — Opens a modal to confirm Shopify refund. Shows the restock location (fulfillment location as preferred). Refund goes to the customer's original payment method.</li>
          <li><strong>Add admin notes</strong> — Internal notes visible only to admins.</li>
          <li><strong>Add customer notes</strong> — Notes visible to the customer in the portal.</li>
        </ul>

        <div style={{ ...subheadingStyle, fontSize: 13 }}>Fynd details section</div>
        <p style={paraStyle}>When a return is synced to Fynd, the detail page shows:</p>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Fynd Order ID</strong> — The affiliate order ID used for Fynd API</li>
          <li><strong>Fynd Shipment ID</strong> — Main shipment identifier from Fynd</li>
          <li><strong>Fynd Return ID</strong> — Fynd's internal return identifier</li>
          <li><strong>Fynd Return #</strong> — Human-readable return number</li>
          <li><strong>Forward AWB</strong> — Forward logistics AWB number</li>
          <li><strong>Return AWB</strong> — Return shipment AWB number</li>
          <li><strong>Shipment details</strong> — Courier, tracking links, invoice, pricing, and per-item breakdown</li>
          <li><strong>Return journey</strong> — 6-step progress bar showing Fynd shipment lifecycle</li>
        </ul>
      </>
    ),
  },
  {
    id: "fynd-integration",
    title: "Fynd Integration",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
    content: (
      <>
        <p style={paraStyle}>
          Fynd integration enables reverse logistics — pickup scheduling, shipment tracking, and automatic refund processing when Fynd completes the return.
        </p>

        <div style={subheadingStyle}>Step 1: Configure credentials</div>
        <div style={stepStyle}><StepNumber n={1} /> Go to <Link to="/app/settings/integrations" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings → Partner Integrations</Link>.</div>
        <div style={stepStyle}><StepNumber n={2} /> Select the environment: <strong>UAT</strong> (sandbox testing) or <strong>Production</strong>.</div>
        <div style={stepStyle}><StepNumber n={3} /> Enter your <strong>Company ID</strong>, <strong>Application ID</strong>, <strong>Client ID</strong>, and <strong>Client Secret</strong>.</div>
        <div style={stepStyle}><StepNumber n={4} /> Click <strong>Save</strong>.</div>

        <div style={subheadingStyle}>Where to find Fynd credentials</div>
        <div style={stepStyle}><StepNumber n={1} /> Log in to <a href="https://platform.fynd.com" target="_blank" rel="noopener noreferrer" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>platform.fynd.com</a></div>
        <div style={stepStyle}><StepNumber n={2} /> Go to your <strong>Company → Settings → Developers</strong>.</div>
        <div style={stepStyle}><StepNumber n={3} /> Create or select an OAuth application with <strong>Platform API</strong> access.</div>
        <div style={stepStyle}><StepNumber n={4} /> Ensure these scopes are enabled: <code style={codeStyle}>company/orders/read</code>, <code style={codeStyle}>company/orders/write</code>, <code style={codeStyle}>company/settings</code></div>

        <div style={subheadingStyle}>Step 2: Test the connection</div>
        <div style={stepStyle}><StepNumber n={1} /> After saving, click <strong>Test Platform</strong> in the integrations page.</div>
        <div style={stepStyle}><StepNumber n={2} /> Success: "Platform API connection successful"</div>
        <div style={stepStyle}><StepNumber n={3} /> If 403: Check OAuth scopes in Fynd Partners. If 401: Verify Company ID and Client ID/Secret.</div>

        <div style={subheadingStyle}>Step 3: Webhook setup (for automatic refunds)</div>
        <p style={paraStyle}>
          The webhook lets Fynd notify Return Pro Max when a return is processed and refund is ready. Without it, you must manually process refunds.
        </p>
        <div style={stepStyle}><StepNumber n={1} /> Go to <Link to="/app/settings/setup" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings → Fynd Setup Guide</Link>.</div>
        <div style={stepStyle}><StepNumber n={2} /> Use <strong>Register webhook via Fynd API</strong> (automatic) or manually add the webhook URL in Fynd Partners dashboard.</div>
        <div style={stepStyle}><StepNumber n={3} /> Webhook URL: <code style={codeStyle}>POST https://YOUR_APP_URL/api/webhooks/fynd</code></div>
        <div style={stepStyle}><StepNumber n={4} /> Subscribe to events: <code style={codeStyle}>refund/refund_initiated</code>, <code style={codeStyle}>refund/refund_done</code>, <code style={codeStyle}>shipment/update</code></div>
        <div style={stepStyle}><StepNumber n={5} /> Click <strong>Test webhook</strong> to verify the endpoint is reachable.</div>

        <div style={subheadingStyle}>Step 4: End-to-end flow</div>
        <div style={stepStyle}><StepNumber n={1} /> Customer submits return via portal.</div>
        <div style={stepStyle}><StepNumber n={2} /> Admin approves → return is synced to Fynd (Fynd Shipment ID, Return #, etc. are stored).</div>
        <div style={stepStyle}><StepNumber n={3} /> Fynd arranges pickup, transit, and delivery of the returned item.</div>
        <div style={stepStyle}><StepNumber n={4} /> Fynd completes processing → sends webhook with <code style={codeStyle}>refund_done</code> status.</div>
        <div style={stepStyle}><StepNumber n={5} /> App automatically creates the refund in Shopify and marks the return as completed.</div>

        <div style={subheadingStyle}>Fynd status mapping</div>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Fynd status</th><th style={thStyle}>App action</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}><code style={codeStyle}>refund_initiated</code>, <code style={codeStyle}>refund_pending</code>, <code style={codeStyle}>UNDER PROCESS</code></td><td style={tdStyle}>Sets refund status to "in progress"</td></tr>
            <tr><td style={tdStyle}><code style={codeStyle}>credit_note_generated</code></td><td style={tdStyle}>If auto-refund is enabled, triggers Shopify refund automatically</td></tr>
            <tr><td style={tdStyle}><code style={codeStyle}>refund_done</code>, <code style={codeStyle}>refunded</code></td><td style={tdStyle}>Creates Shopify refund, marks return as completed</td></tr>
          </tbody>
        </table>
      </>
    ),
  },
  {
    id: "refunds",
    title: "Refunds & Restock",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
    content: (
      <>
        <p style={paraStyle}>Refunds can be processed manually from the admin or automatically via Fynd webhook.</p>

        <div style={subheadingStyle}>Manual refund (admin)</div>
        <div style={stepStyle}><StepNumber n={1} /> Open the return detail page for an approved return.</div>
        <div style={stepStyle}><StepNumber n={2} /> Click <strong>Process refund in Shopify</strong>.</div>
        <div style={stepStyle}><StepNumber n={3} /> The modal shows the refund amount and the <strong>restock location</strong>. The order's fulfillment location is pre-selected as "Preferred" to ensure inventory adjusts at the correct location.</div>
        <div style={stepStyle}><StepNumber n={4} /> Confirm. The refund is created via Shopify Admin API and the return is marked as completed.</div>

        <div style={subheadingStyle}>Automatic refund (Fynd webhook)</div>
        <p style={paraStyle}>
          When Fynd sends a <code style={codeStyle}>credit_note_generated</code> or <code style={codeStyle}>refund_done</code> webhook, the app automatically:
        </p>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Finds the return case by <code style={codeStyle}>fyndShipmentId</code> or <code style={codeStyle}>fyndOrderId</code></li>
          <li>Determines the restock location (from settings or order fulfillment location)</li>
          <li>Creates the refund via Shopify Admin API</li>
          <li>Marks the return as completed with <code style={codeStyle}>refundStatus = "refunded"</code></li>
        </ul>

        <div style={subheadingStyle}>Restock location settings</div>
        <p style={paraStyle}>
          Go to <Link to="/app/settings/return-settings" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings → Return Settings</Link> to configure:
        </p>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Automatic</strong> — Uses the order's fulfillment location (recommended). Falls back to the shop's primary location.</li>
          <li><strong>Manual</strong> — Admin selects the location during each refund from a dropdown of active Shopify locations.</li>
          <li><strong>Default fallback location</strong> — Used when the fulfillment location can't be determined.</li>
        </ul>
      </>
    ),
  },
  {
    id: "settings",
    title: "Settings Reference",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
    content: (
      <>
        <p style={paraStyle}>
          All settings are accessible from <Link to="/app/settings" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings</Link>. Here's a reference for each section.
        </p>

        <div style={subheadingStyle}>Policy Rules</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Return reasons</strong> — Define the list of reasons customers can choose from. Each reason has a label, optional description, and can be enabled/disabled.</li>
          <li><strong>Restricted regions</strong> — Block returns from specific regions or postal codes.</li>
        </ul>

        <div style={subheadingStyle}>Return Settings</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Return window</strong> — Number of days after delivery within which returns are accepted (e.g. 30 days).</li>
          <li><strong>Return fees</strong> — Optional restocking or shipping fee deducted from refund.</li>
          <li><strong>Photo requirement</strong> — Require customers to upload photos when submitting a return.</li>
          <li><strong>Auto-approve</strong> — Automatically approve return requests without manual review.</li>
          <li><strong>Auto-refund</strong> — Automatically process Shopify refund when Fynd sends <code style={codeStyle}>credit_note_generated</code>.</li>
          <li><strong>Refund restock location</strong> — Automatic (fulfillment location) or manual (admin picks each time).</li>
        </ul>

        <div style={subheadingStyle}>Partner Integrations (Fynd)</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Environment</strong> — UAT (sandbox) or Production</li>
          <li><strong>Company ID</strong> — Your Fynd company identifier</li>
          <li><strong>Application ID</strong> — Fynd sales channel / application</li>
          <li><strong>Client ID & Secret</strong> — OAuth credentials for Platform API</li>
          <li><strong>Test connection</strong> — Verify credentials work</li>
        </ul>

        <div style={subheadingStyle}>Notifications</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Email notifications</strong> — Enable/disable email alerts for return events (submitted, approved, rejected, refunded).</li>
        </ul>

        <div style={subheadingStyle}>Portal Widget</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Theme color</strong> — Primary accent for the customer portal</li>
          <li><strong>Font family</strong> — System, Inter, Poppins, or custom</li>
          <li><strong>Border radius</strong> — Controls roundness of UI elements</li>
          <li><strong>Default tab</strong> — New Return or Track Return</li>
          <li><strong>Enabled sections</strong> — Toggle which tabs are visible</li>
        </ul>

        <div style={subheadingStyle}>Permissions</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>read_all_orders</strong> — Required scope for looking up orders older than 60 days. Request this from Shopify via the Permissions page.</li>
        </ul>
      </>
    ),
  },
  {
    id: "reports",
    title: "Reports & Analytics",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    content: (
      <>
        <p style={paraStyle}>
          The <Link to="/app/reports" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Reports</Link> page provides a comprehensive analytics dashboard for return data.
        </p>

        <div style={subheadingStyle}>Available metrics</div>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Metric</th><th style={thStyle}>Description</th></tr></thead>
          <tbody>
            <tr><td style={tdStyle}><strong>Total Returns</strong></td><td style={tdStyle}>Number of returns in the selected period, with period-over-period change.</td></tr>
            <tr><td style={tdStyle}><strong>Approval Rate</strong></td><td style={tdStyle}>Percentage of returns that were approved (approved + completed / total).</td></tr>
            <tr><td style={tdStyle}><strong>Avg Processing</strong></td><td style={tdStyle}>Average days from return submission to approval.</td></tr>
            <tr><td style={tdStyle}><strong>Refund Rate</strong></td><td style={tdStyle}>Percentage of approved returns that have been refunded.</td></tr>
          </tbody>
        </table>

        <div style={subheadingStyle}>Charts and visualizations</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li><strong>Return volume trend</strong> — Daily area chart showing return request volume over time.</li>
          <li><strong>Status distribution</strong> — Donut chart showing breakdown by status.</li>
          <li><strong>Performance gauges</strong> — Ring charts for approval, rejection, refund, and Fynd sync rates.</li>
          <li><strong>Top return reasons</strong> — Horizontal bar chart of most common reasons.</li>
          <li><strong>Status breakdown table</strong> — Detailed table with counts, percentages, and progress bars. Click any status to filter the returns list.</li>
        </ul>

        <div style={subheadingStyle}>Date range</div>
        <p style={paraStyle}>
          Use the dropdown to select: Last 7 days, Last 30 days, Last 90 days, This month, Last month, This year, or a custom date range. All metrics and charts update based on the selected period.
        </p>

        <div style={subheadingStyle}>Export</div>
        <p style={paraStyle}>
          Click <strong>Export CSV</strong> to download return data for the selected period. The CSV includes all return fields: order name, status, Fynd IDs, AWBs, customer info, refund status, dates, and more.
        </p>
      </>
    ),
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
    content: (
      <>
        <div style={subheadingStyle}>Fynd sync fails (403 Forbidden)</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Ensure your Fynd OAuth app has <code style={codeStyle}>company/orders/read</code> and <code style={codeStyle}>company/orders/write</code> scopes.</li>
          <li>Verify you're using Platform API credentials (not Storefront).</li>
          <li>Check the environment (UAT vs Production) matches your Fynd account.</li>
        </ul>

        <div style={subheadingStyle}>Fynd sync fails (401 Unauthorized)</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Verify Company ID, Client ID, and Client Secret are correct.</li>
          <li>Regenerate credentials in Fynd Partners if needed.</li>
        </ul>

        <div style={subheadingStyle}>Refund fails: "You need to set a location to restock items"</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>This means the Shopify refund API requires a location ID. Go to <Link to="/app/settings/return-settings" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Return Settings</Link> and set a default fallback location.</li>
          <li>The app now auto-detects the fulfillment location, but setting a fallback ensures it always works.</li>
        </ul>

        <div style={subheadingStyle}>Webhook not receiving events from Fynd</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Confirm the webhook URL is correct and publicly reachable (not localhost).</li>
          <li>Use the <strong>Test webhook</strong> button in Settings → Fynd Setup Guide.</li>
          <li>Ensure <code style={codeStyle}>SHOPIFY_APP_URL</code> environment variable is set to your deployed URL.</li>
          <li>Check Fynd Partners dashboard for webhook delivery logs.</li>
        </ul>

        <div style={subheadingStyle}>Customer can't find their order in the portal</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>The order must exist in Shopify and be fulfilled.</li>
          <li>The email or phone entered must match the order's customer info.</li>
          <li>For orders older than 60 days, the app needs the <code style={codeStyle}>read_all_orders</code> scope. Go to <Link to="/app/settings/permissions" style={{ color: "var(--rpm-accent)", fontWeight: 600, textDecoration: "none" }}>Settings → Permissions</Link> to request it.</li>
          <li>Check that the return window hasn't expired for that order.</li>
        </ul>

        <div style={subheadingStyle}>Return AWB not showing</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>The return AWB is populated by Fynd when the pickup is scheduled and a courier is assigned.</li>
          <li>If the return is synced to Fynd but AWB is missing, the Fynd shipment may still be in the "return initiated" stage.</li>
          <li>Check the Fynd Shipment ID on the return detail page — AWB will appear once Fynd assigns a courier.</li>
        </ul>

        <div style={subheadingStyle}>App Proxy returns 404</div>
        <ul style={{ ...paraStyle, paddingLeft: 18 }}>
          <li>Verify App Proxy is configured in the Shopify Partner dashboard: sub path prefix = <code style={codeStyle}>apps</code>, sub path = <code style={codeStyle}>returns</code>.</li>
          <li>Verify the proxy URL points to your deployed app URL followed by <code style={codeStyle}>/apps/returns</code>.</li>
          <li>Ensure your app is installed on the store.</li>
        </ul>
      </>
    ),
  },
];

export default function Documentation() {
  const [activeSection, setActiveSection] = useState("overview");
  const section = SECTIONS.find((s) => s.id === activeSection) || SECTIONS[0];

  return (
    <s-page heading="Documentation">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {/* Navigation */}
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20, padding: "12px 16px",
          background: "var(--rpm-surface, white)", borderRadius: 12,
          border: "var(--rpm-border, 1px solid #e5e7eb)",
        }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                padding: "6px 14px", borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: activeSection === s.id ? "1px solid var(--rpm-accent, #3B82F6)" : "1px solid transparent",
                background: activeSection === s.id ? "var(--rpm-accent-subtle, #EFF6FF)" : "transparent",
                color: activeSection === s.id ? "var(--rpm-accent, #3B82F6)" : "var(--rpm-text-muted, #64748b)",
                cursor: "pointer", transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              {s.icon}
              {s.title}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={cardStyle}>
          <h2 style={{ ...headingStyle, fontSize: 18, marginBottom: 16 }}>
            {section.icon}
            {section.title}
          </h2>
          {section.content}
        </div>

        {/* Section navigation */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 8, padding: "12px 16px", borderRadius: 10,
          background: "#F8FAFC", border: "1px solid #E2E8F0",
        }}>
          {(() => {
            const idx = SECTIONS.findIndex((s) => s.id === activeSection);
            const prev = idx > 0 ? SECTIONS[idx - 1] : null;
            const next = idx < SECTIONS.length - 1 ? SECTIONS[idx + 1] : null;
            return (
              <>
                {prev ? (
                  <button onClick={() => setActiveSection(prev.id)} style={{
                    fontSize: 13, fontWeight: 600, color: "var(--rpm-accent, #3B82F6)",
                    background: "none", border: "none", cursor: "pointer", padding: 0,
                  }}>← {prev.title}</button>
                ) : <span />}
                <span style={{ fontSize: 11, color: "var(--rpm-text-muted)" }}>
                  {SECTIONS.findIndex((s) => s.id === activeSection) + 1} / {SECTIONS.length}
                </span>
                {next ? (
                  <button onClick={() => setActiveSection(next.id)} style={{
                    fontSize: 13, fontWeight: 600, color: "var(--rpm-accent, #3B82F6)",
                    background: "none", border: "none", cursor: "pointer", padding: 0,
                  }}>{next.title} →</button>
                ) : <span />}
              </>
            );
          })()}
        </div>
      </div>
    </s-page>
  );
}
