import React, { useState } from "react";
import { Link, useRouteError, isRouteErrorResponse } from "react-router";

/* ── Design tokens ── */
const surface = "var(--rpm-surface, white)";
const border = "var(--rpm-border, 1px solid #e5e7eb)";
const text = "var(--rpm-text, #0f172a)";
const muted = "var(--rpm-text-muted, #64748b)";
const accent = "var(--rpm-accent, #005bd3)";

const card: React.CSSProperties = {
  background: surface, borderRadius: 16, padding: "28px 28px 24px",
  border, marginBottom: 20,
};
const h2: React.CSSProperties = { fontSize: 20, fontWeight: 800, color: text, margin: "0 0 6px", letterSpacing: "-0.02em" };
const h3: React.CSSProperties = { fontSize: 15, fontWeight: 700, color: text, margin: "28px 0 10px" };
const h4: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: text, margin: "20px 0 8px", textTransform: "uppercase", letterSpacing: "0.04em" };
const p: React.CSSProperties = { fontSize: 14, color: "#475569", lineHeight: 1.75, margin: "0 0 12px" };
const ul: React.CSSProperties = { ...p, paddingLeft: 20, margin: "0 0 14px" };
const code: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontSize: 12, background: "#F1F5F9", padding: "2px 7px", borderRadius: 5, color: "#0F172A", border: "1px solid #E2E8F0" };

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "12px 16px", background: "#F8FAFC", borderRadius: 12, border: "1px solid #E2E8F0", marginBottom: 8 }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", background: accent, color: "white", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{n}</span>
      <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.7, flex: 1 }}>{children}</div>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div style={{ fontSize: 13, color: "#1E40AF", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#FFFBEB", borderRadius: 10, border: "1px solid #FDE68A", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <div style={{ fontSize: 13, color: "#92400E", lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function FieldRow({ label, description }: { label: string; description: string }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid #F1F5F9" }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: text, minWidth: 160, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, color: muted, lineHeight: 1.6 }}>{description}</span>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} style={{ color: accent, fontWeight: 600, textDecoration: "none" }}>{children}</Link>;
}

/* ── Chapters ── */
type Chapter = { id: string; title: string; subtitle: string; icon: React.ReactNode; content: React.ReactNode };

const CHAPTERS: Chapter[] = [
  /* ────────────────── 1. WELCOME ────────────────── */
  {
    id: "welcome",
    title: "Welcome to Fynd Returns",
    subtitle: "Everything you need to know to get started",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    content: (
      <>
        <p style={p}>Fynd Returns is an enterprise-grade returns management app for Shopify stores. It gives your customers a beautiful self-service portal to request and track returns, while giving you full control over approvals, refunds, and reverse logistics via Fynd.</p>

        <div style={h3}>What you can do with this app</div>
        <ul style={ul}>
          <li><strong>Accept return requests</strong> — Customers submit returns through a branded portal on your storefront. They select items, choose a reason, and optionally upload photos.</li>
          <li><strong>Review and manage returns</strong> — Approve or reject each request from the admin panel. Add notes, process refunds, and track the full lifecycle.</li>
          <li><strong>Connect Fynd for logistics</strong> — Automatically sync approved returns to Fynd for pickup scheduling, shipment tracking, and delivery.</li>
          <li><strong>Process refunds</strong> — Refund customers directly to their original payment method via Shopify, with proper inventory restocking.</li>
          <li><strong>Track everything</strong> — Real-time dashboards, analytics, and a complete event timeline for every return.</li>
        </ul>

        <div style={h3}>How it works — the big picture</div>
        <Step n={1}><strong>Customer visits your portal</strong> — They go to your store's <code style={code}>/apps/returns</code> page, look up their order, and submit a return request.</Step>
        <Step n={2}><strong>You review the request</strong> — The return appears in your admin panel. You approve or reject it with one click.</Step>
        <Step n={3}><strong>Return is synced to Fynd</strong> — If Fynd is configured, the approved return is automatically sent to Fynd for reverse logistics (pickup, tracking).</Step>
        <Step n={4}><strong>You process the refund</strong> — Once the return is complete, process the refund to the customer's original payment method directly from the admin.</Step>
        <Step n={5}><strong>Customer is updated</strong> — The customer can track their return status in real time through the same portal.</Step>
      </>
    ),
  },

  /* ────────────────── 2. FIRST-TIME SETUP ────────────────── */
  {
    id: "setup",
    title: "First-Time Setup",
    subtitle: "Get your app up and running in minutes",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    content: (
      <>
        <p style={p}>After installing the app from the Shopify App Store, follow these steps to configure everything.</p>

        <div style={h3}>Step 1: Set up the Customer Portal (App Proxy)</div>
        <p style={p}>The customer portal is how your customers will access returns. It lives at <code style={code}>https://your-store.myshopify.com/apps/returns</code> and is served through Shopify's App Proxy feature.</p>
        <Step n={1}>In your <strong>Shopify Partner dashboard</strong>, go to your app's configuration.</Step>
        <Step n={2}>Find the <strong>App Proxy</strong> section.</Step>
        <Step n={3}>Set <strong>Sub path prefix</strong> to <code style={code}>apps</code></Step>
        <Step n={4}>Set <strong>Sub path</strong> to <code style={code}>returns</code></Step>
        <Step n={5}>Set <strong>Proxy URL</strong> to your deployed app URL followed by <code style={code}>/apps/returns</code> (e.g., <code style={code}>https://your-app.onrender.com/apps/returns</code>).</Step>
        <Step n={6}>Click <strong>Save</strong>. Your portal is now live.</Step>
        <Tip>You can verify by visiting <code style={code}>https://your-store.myshopify.com/apps/returns</code> in your browser.</Tip>

        <div style={h3}>Step 2: Configure return reasons</div>
        <p style={p}>These are the options your customers will see when selecting why they're returning an item.</p>
        <Step n={1}>Go to <NavLink to="/app/settings/rules">Settings → Policy Rules</NavLink>.</Step>
        <Step n={2}>In the <strong>Return Reasons</strong> section, review the default reasons. The app comes pre-loaded with common reasons like "Wrong Product Received", "Product is Damaged", etc.</Step>
        <Step n={3}>Add, remove, or reorder reasons as needed. Type a new reason in the search box and click <strong>Add</strong>.</Step>
        <Step n={4}>Click <strong>Save</strong> at the bottom.</Step>
        <Tip>You can also set up <strong>category-specific reasons</strong> — for example, clothing items might show "Too loose" and "Too tight" while electronics show "Defective" and "Missing parts".</Tip>

        <div style={h3}>Step 3: Set your return policy</div>
        <Step n={1}>Go to <NavLink to="/app/settings/return-settings">Settings → Return Settings</NavLink>.</Step>
        <Step n={2}>Set the <strong>return window</strong> — how many days after purchase customers can initiate a return (e.g., 30 days).</Step>
        <Step n={3}>Choose whether to <strong>require photos</strong> — if "Yes", customers must upload product photos when submitting a return.</Step>
        <Step n={4}>Set a <strong>return fee</strong> if you want to charge a restocking fee (this amount is deducted from the refund).</Step>
        <Step n={5}>Choose <strong>auto-approve</strong> — set to "Yes" if you want all returns automatically approved, or "No" to review each one manually.</Step>
        <Step n={6}>Click <strong>Save</strong>.</Step>

        <div style={h3}>Step 4: Customize the portal appearance</div>
        <Step n={1}>Go to <NavLink to="/app/settings/widget">Settings → Portal Widget</NavLink>.</Step>
        <Step n={2}>Set your <strong>primary color</strong> to match your brand.</Step>
        <Step n={3}>Choose a <strong>font</strong> (DM Sans, Inter, System UI, Georgia, or Playfair Display).</Step>
        <Step n={4}>Set the <strong>border radius</strong> (Minimal, Rounded, Soft, or Pill) to match your store's design.</Step>
        <Step n={5}>Enable or disable portal sections: <strong>Order tracking</strong>, <strong>Return tracking</strong>, <strong>Create return</strong>.</Step>
        <Step n={6}>Choose the <strong>default tab</strong> — which tab customers see first when they open the portal.</Step>
        <Step n={7}>Click <strong>Save</strong>, then <strong>Preview portal</strong> to see how it looks.</Step>

        <div style={h3}>Step 5: Add the portal link to your store navigation</div>
        <Step n={1}>In your Shopify admin, go to <strong>Online Store → Navigation</strong>.</Step>
        <Step n={2}>Edit your footer menu (or main menu).</Step>
        <Step n={3}>Click <strong>Add menu item</strong>. Set the name to "Returns" (or "Returns & Exchanges").</Step>
        <Step n={4}>Paste the portal URL: <code style={code}>https://your-store.myshopify.com/apps/returns</code></Step>
        <Step n={5}>Click <strong>Save</strong>. Customers can now find the returns page from your store navigation.</Step>
      </>
    ),
  },

  /* ────────────────── 3. CUSTOMER PORTAL ────────────────── */
  {
    id: "portal",
    title: "Customer Portal",
    subtitle: "How your customers create and track returns",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    content: (
      <>
        <p style={p}>The customer portal is a branded page embedded in your Shopify storefront. It lets customers look up orders, submit return requests, and track the status of existing returns — all without contacting support.</p>

        <div style={h3}>Creating a new return (customer experience)</div>
        <p style={p}>Here's exactly what your customer sees when they submit a return:</p>
        <Step n={1}>Customer opens the portal and clicks the <strong>"Create new return"</strong> tab.</Step>
        <Step n={2}>They enter their <strong>order number</strong> (e.g., #1001 or just 1001) and click <strong>"Find my order"</strong>.</Step>
        <Step n={3}>The app verifies the order via Shopify. If valid and within the return window, the order's line items are displayed.</Step>
        <Step n={4}>Customer <strong>selects the items</strong> they want to return by checking the boxes next to each item.</Step>
        <Step n={5}>For each selected item, they choose a <strong>return reason</strong> from the dropdown (e.g., "Product is Damaged") and set the <strong>quantity</strong>.</Step>
        <Step n={6}>Optionally, they enter their <strong>email</strong> for status updates and add any <strong>additional notes</strong>.</Step>
        <Step n={7}>If photo uploads are enabled, they can <strong>upload product photos</strong> (drag & drop or click to browse). Images up to 5MB each, videos up to 50MB.</Step>
        <Step n={8}>They click <strong>"Submit return request"</strong>.</Step>
        <Step n={9}>A confirmation screen shows the <strong>Return Request ID</strong> (e.g., RPM-A1B2C3D4) with a <strong>Copy</strong> button so they can save it.</Step>
        <Tip>Customers can also use <strong>"Submit manually without order lookup"</strong> to create a return by typing their order number, email, reason, and item description manually — useful if the order lookup doesn't find their order.</Tip>
        <Warning>If a return already exists for the same order, the customer sees a "Return already submitted" message with the existing return's details instead of the submission form.</Warning>

        <div style={h3}>Tracking an existing return</div>
        <Step n={1}>Customer opens the portal and clicks the <strong>"Track existing return"</strong> tab.</Step>
        <Step n={2}>They choose how to search: <strong>Order Number</strong>, <strong>Email Address</strong>, <strong>Phone Number</strong>, <strong>Return Request ID</strong>, <strong>Return Number</strong>, <strong>Forward AWB</strong>, or <strong>Return AWB</strong>.</Step>
        <Step n={3}>They enter their search value and click <strong>"Look Up"</strong>.</Step>
        <Step n={4}>Matching results appear in two sections: <strong>"Your orders"</strong> and <strong>"Your returns"</strong>.</Step>
        <Step n={5}>Each return shows: status (with colored badge), order name, Fynd return number (if synced), AWB numbers, created date, and a full <strong>event timeline</strong> with timestamps.</Step>
        <Step n={6}>If the return was rejected, the <strong>rejection reason</strong> is displayed.</Step>

        <div style={h3}>Customizing the portal</div>
        <p style={p}>You can fully customize the portal's look and behavior from <NavLink to="/app/settings/widget">Settings → Portal Widget</NavLink>:</p>
        <FieldRow label="Primary color" description="The accent color used for buttons, links, and active elements. Match it to your brand." />
        <FieldRow label="Background color" description="The page background color." />
        <FieldRow label="Card surface color" description="The background color of cards and panels within the portal." />
        <FieldRow label="Font" description="Choose from DM Sans (modern), Inter, System UI, Georgia (serif), or Playfair Display (elegant)." />
        <FieldRow label="Border radius" description="Controls the roundness of buttons and cards. Options: Minimal (8px), Rounded (12px), Soft (16px), Pill (24px)." />
        <FieldRow label="Default tab" description="Which tab opens when customers first visit: Order tracking, Return tracking, or Create return." />
        <FieldRow label="Order tracking" description="Toggle the 'Your orders' section on/off." />
        <FieldRow label="Return tracking" description="Toggle the 'Your returns' section on/off." />
        <FieldRow label="Create return" description="Toggle the 'Create new return' tab on/off." />
        <FieldRow label="Allow media uploads" description="Let customers attach photos/videos to their return requests." />
      </>
    ),
  },

  /* ────────────────── 4. MANAGING RETURNS ────────────────── */
  {
    id: "managing-returns",
    title: "Managing Returns",
    subtitle: "Review, approve, reject, and process returns",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    content: (
      <>
        <div style={h3}>The Returns list</div>
        <p style={p}>Go to <NavLink to="/app/returns">Returns</NavLink> to see all return requests. The page shows:</p>
        <FieldRow label="Stat cards" description="Quick-filter cards at the top showing Total, Pending, In Progress, Approved, and Rejected counts. Click any card to filter the list." />
        <FieldRow label="Search" description="Search by order number, return ID, AWB, Fynd IDs, email, or phone. Results update instantly." />
        <FieldRow label="Status filter" description="Dropdown to filter by: Initiated, Pending, Processing, Approved, Completed, Rejected, or Cancelled." />
        <FieldRow label="Export CSV" description="Download all matching returns as a CSV file for external reporting." />
        <p style={p}>The table shows each return's <strong>Return ID</strong>, <strong>Order</strong>, <strong>Status</strong> (with refund status and Fynd sync indicator), <strong>Fynd Return ID</strong>, <strong>Customer email</strong>, and <strong>Created date</strong>. Click any row to open the detail page.</p>

        <div style={h3}>Return detail page</div>
        <p style={p}>This is the central hub for managing a single return. Everything you need is on one page.</p>

        <div style={h4}>Return lifecycle</div>
        <FieldRow label="Pending" description="Customer has submitted a return request. It's waiting for your review." />
        <FieldRow label="Approved" description="You've approved the return. The return is eligible for Fynd sync and refund processing." />
        <FieldRow label="Completed" description="Return is fully processed — refund has been issued. This is the final state." />
        <FieldRow label="Rejected" description="You've rejected the return with a reason. The customer sees this reason in the portal." />
        <FieldRow label="Cancelled" description="The return has been cancelled." />

        <div style={h4}>Actions you can take</div>
        <FieldRow label="Approve" description="Marks the return as approved. If Fynd is configured, the return is automatically synced to Fynd for reverse logistics." />
        <FieldRow label="Reject" description="Opens a modal asking for a rejection reason. This reason is shown to the customer in the portal." />
        <FieldRow label="Sync to Fynd" description="Manually triggers the Fynd return creation. Appears when Fynd is configured but the return hasn't been synced yet." />
        <FieldRow label="Retry Fynd sync" description="Retries a failed Fynd sync. Shows the previous error message so you can troubleshoot." />
        <FieldRow label="Process refund" description="Opens a refund confirmation modal. Shows the refund amount and restock location. Click 'Yes, process refund' to create the refund in Shopify." />
        <FieldRow label="Admin notes" description="Internal notes only visible to your team. Use this for case tracking." />
        <FieldRow label="Customer notes" description="Notes that the customer can see in the portal when they track their return." />

        <div style={h4}>Fynd details section</div>
        <p style={p}>When a return is synced to Fynd, the detail page displays a complete logistics section:</p>
        <FieldRow label="Fynd Order ID" description="The affiliate order ID used by Fynd (usually your Shopify order name without #)." />
        <FieldRow label="Fynd Shipment ID" description="The main shipment identifier from Fynd." />
        <FieldRow label="Fynd Return ID" description="Fynd's internal return identifier." />
        <FieldRow label="Fynd Return #" description="The human-readable return number from Fynd." />
        <FieldRow label="Forward/Return AWB" description="Airway bill numbers for forward and return shipments." />
        <FieldRow label="Shipment details" description="Courier name, tracking links, invoice, pricing breakdown, and per-item detail." />
        <FieldRow label="Return journey" description="A 6-step progress bar showing the Fynd shipment lifecycle: Submitted → Confirmed → Pickup → In Transit → Received → Refunded." />
      </>
    ),
  },

  /* ────────────────── 5. PROCESSING REFUNDS ────────────────── */
  {
    id: "refunds",
    title: "Processing Refunds",
    subtitle: "Issue refunds and restock inventory correctly",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
    content: (
      <>
        <div style={h3}>Manual refund from the admin</div>
        <Step n={1}>Open the return detail page for an <strong>approved</strong> return.</Step>
        <Step n={2}>Click <strong>"Process refund in Shopify"</strong>.</Step>
        <Step n={3}>The refund modal appears showing:
          <ul style={{ ...ul, marginTop: 6, marginBottom: 0 }}>
            <li>The <strong>refund amount</strong> calculated from the returned line items</li>
            <li>The <strong>restock location</strong> — the order's original fulfillment location is pre-selected as "Preferred"</li>
          </ul>
        </Step>
        <Step n={4}>If you're using <strong>manual location mode</strong>, select the correct location from the dropdown.</Step>
        <Step n={5}>Click <strong>"Yes, process refund"</strong>. The refund is created via Shopify's Admin API and the customer is refunded to their original payment method.</Step>
        <Step n={6}>The return status changes to <strong>Completed</strong> and the refund details (amount, currency, date) are stored.</Step>

        <div style={h3}>Automatic refund via Fynd</div>
        <p style={p}>When Fynd finishes processing a return and generates a credit note, the app can automatically create the Shopify refund for you. Here's how to enable it:</p>
        <Step n={1}>Go to <NavLink to="/app/settings/return-settings">Settings → Return Settings</NavLink>.</Step>
        <Step n={2}>Under <strong>"Auto Refund on Credit Note"</strong>, select <strong>"Yes"</strong>.</Step>
        <Step n={3}>Save. Now, whenever Fynd sends a <code style={code}>credit_note_generated</code> webhook, the app will automatically:
          <ul style={{ ...ul, marginTop: 6, marginBottom: 0 }}>
            <li>Find the return by Fynd Shipment ID</li>
            <li>Determine the restock location</li>
            <li>Create the refund in Shopify</li>
            <li>Mark the return as completed</li>
          </ul>
        </Step>
        <Tip>The app uses the order's fulfillment location for restocking by default. You can set a fallback location in Return Settings if the fulfillment location can't be determined.</Tip>

        <div style={h3}>Restock location settings</div>
        <p style={p}>Shopify requires a location ID when restocking returned inventory. You can configure how this works:</p>
        <FieldRow label="Automatic (recommended)" description="Uses the order's original fulfillment location. This ensures inventory goes back to where it was shipped from. If the fulfillment location can't be determined, falls back to your default location." />
        <FieldRow label="Manual" description="You choose the restock location each time you process a refund. A dropdown of all your active Shopify locations appears in the refund modal." />
        <FieldRow label="Default fallback location" description="In Automatic mode: used when the fulfillment location is unavailable. In Manual mode: pre-selected in the dropdown for convenience." />
      </>
    ),
  },

  /* ────────────────── 6. FYND INTEGRATION ────────────────── */
  {
    id: "fynd",
    title: "Connecting Fynd",
    subtitle: "Set up reverse logistics and automatic refunds",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
    content: (
      <>
        <p style={p}>Fynd handles the physical logistics of returns — scheduling pickups, tracking shipments, and processing the return at the warehouse. Connecting Fynd is optional but highly recommended for automated return operations.</p>

        <div style={h3}>What you'll need from Fynd</div>
        <FieldRow label="Company ID" description="Found in your Fynd company settings." />
        <FieldRow label="Application ID" description="Found in Company → Settings → Developers (your sales channel)." />
        <FieldRow label="Client ID" description="From your OAuth application in Fynd Partners (Platform API)." />
        <FieldRow label="Client Secret" description="From the same OAuth application." />
        <Warning>You must use <strong>Platform API</strong> credentials (not Storefront). Your OAuth app needs these scopes: <code style={code}>company/orders/read</code>, <code style={code}>company/orders/write</code>, and <code style={code}>company/settings</code>.</Warning>

        <div style={h3}>Step-by-step setup</div>
        <Step n={1}>Go to <NavLink to="/app/settings/integrations">Settings → Partner Integrations</NavLink>.</Step>
        <Step n={2}>Select the <strong>environment</strong>: choose <strong>UAT (Sandbox)</strong> for testing or <strong>Production</strong> for live operations.</Step>
        <Step n={3}>Enter your <strong>Company ID</strong>, <strong>Application ID</strong>, <strong>Client ID</strong>, and <strong>Client Secret</strong>.</Step>
        <Step n={4}>Click <strong>Save</strong>.</Step>
        <Step n={5}>Click <strong>"Test Platform"</strong> to verify the connection. You should see "Platform API connection successful".</Step>

        <div style={h3}>Setting up the webhook (for automatic updates)</div>
        <p style={p}>The webhook lets Fynd notify this app when a return's refund status changes. Without it, you'd need to manually check Fynd and process refunds yourself.</p>
        <Step n={1}>Go to <NavLink to="/app/settings/setup">Settings → Fynd Setup Guide</NavLink>.</Step>
        <Step n={2}>Navigate to <strong>Step 3: Webhook setup</strong>.</Step>
        <Step n={3}>You'll see your webhook URL: <code style={code}>https://YOUR_APP_URL/api/webhooks/fynd</code></Step>
        <Step n={4}>Click <strong>"Register webhook via Fynd API"</strong> to automatically register it with Fynd.</Step>
        <Step n={5}>Alternatively, you can manually add this URL in the <a href="https://partners.fynd.com" target="_blank" rel="noopener noreferrer" style={{ color: accent, fontWeight: 600, textDecoration: "none" }}>Fynd Partners</a> dashboard under Webhooks.</Step>
        <Step n={6}>Go to <strong>Step 4</strong> and click <strong>"Test webhook"</strong> to verify the endpoint is reachable.</Step>

        <div style={h3}>How the end-to-end flow works</div>
        <Step n={1}><strong>Customer submits return</strong> — via your portal.</Step>
        <Step n={2}><strong>You approve</strong> — the app automatically creates the return on Fynd.</Step>
        <Step n={3}><strong>Fynd schedules pickup</strong> — courier is assigned, AWB is generated.</Step>
        <Step n={4}><strong>Shipment in transit</strong> — item is picked up and on its way back.</Step>
        <Step n={5}><strong>Fynd receives and processes</strong> — quality check completed, credit note generated.</Step>
        <Step n={6}><strong>Refund processed</strong> — app automatically creates Shopify refund (if auto-refund is enabled) and marks the return as completed.</Step>

        <div style={h3}>Fynd status mapping</div>
        <p style={p}>Here's how Fynd statuses translate to actions in the app:</p>
        <FieldRow label="refund_initiated / UNDER PROCESS" description="Refund is being processed. Return shows 'Refund in progress' status." />
        <FieldRow label="credit_note_generated" description="Fynd has approved the return. If auto-refund is enabled, the Shopify refund is created automatically." />
        <FieldRow label="refund_done / refunded" description="Refund is complete. The app creates the Shopify refund and marks the return as completed." />
      </>
    ),
  },

  /* ────────────────── 7. SETTINGS REFERENCE ────────────────── */
  {
    id: "settings",
    title: "All Settings Explained",
    subtitle: "Every option across all settings pages",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
    content: (
      <>
        <div style={h3}>Policy Rules <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Policy Rules</span></div>
        <FieldRow label="Return reasons" description="The list of reasons customers choose from. Add new reasons by typing in the search box and clicking Add. Remove by clicking × on any reason." />
        <FieldRow label="Category-specific reasons" description="Show different reasons per product type. Add a category (matching your Shopify product type), then assign specific reasons to it." />
        <FieldRow label="Restricted regions" description="Block returns from specific countries. Add country names — orders shipped to these regions won't be eligible for returns." />
        <FieldRow label="Return window" description="Number of days (1–365) after delivery within which returns are accepted." />
        <FieldRow label="Minimum price" description="Products below this price are not eligible for return." />
        <FieldRow label="Return offers" description="Offer discounts during the return process to encourage customers to keep the product instead of returning." />

        <div style={h3}>Return Settings <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Return Settings</span></div>
        <FieldRow label="No-return period" description="Block returns during specific dates (e.g., during a sale). Set start and end dates." />
        <FieldRow label="Restrict by product tags" description="Products with matching Shopify tags won't be eligible for returns." />
        <FieldRow label="Photo required" description="If Yes, customers must upload photos when submitting a return." />
        <FieldRow label="Return fee" description="A flat fee deducted from the refund amount. Set the currency (USD, EUR, GBP, INR) and amount." />
        <FieldRow label="Payment methods" description="Choose which refund methods are available for prepaid orders vs. COD/bank transfer orders. Options: Bank details, Original source, Others." />
        <FieldRow label="Auto-approve" description="If Yes, return requests are approved instantly without manual review." />
        <FieldRow label="Auto-refund on credit note" description="If Yes, automatically process the Shopify refund when Fynd sends a credit_note_generated webhook." />
        <FieldRow label="Refund restock location" description="Automatic (uses fulfillment location) or Manual (you pick each time). Set a fallback location for when the fulfillment location isn't available." />

        <div style={h3}>Partner Integrations <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Integrations</span></div>
        <FieldRow label="App mode" description="Dev (test mode, shows dev banner) or Prod (live mode). Use Dev with UAT credentials for testing." />
        <FieldRow label="Environment" description="UAT (Sandbox) for testing or Production for live operations." />
        <FieldRow label="Credentials" description="Application ID, Company ID, Client ID, and Client Secret from your Fynd Platform API OAuth app." />
        <FieldRow label="Advanced policy" description="Return window, minimum order value, restock fee %, exchange toggle, refund methods, excluded tags, and allowed categories." />

        <div style={h3}>Notifications <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Notifications</span></div>
        <FieldRow label="SMTP Server" description="Configure your SMTP host, port, username, and password to send emails from your own domain (Gmail, SendGrid, AWS SES, or any SMTP)." />
        <FieldRow label="New return request" description="Send a notification email to the admin when a customer submits a return." />
        <FieldRow label="Return approved" description="Notify the customer when their return is approved." />
        <FieldRow label="Return rejected" description="Notify the customer when their return is declined, including the reason." />
        <FieldRow label="Refund processed" description="Notify the customer when their refund has been processed." />
        <FieldRow label="Sound alerts" description="Play a notification sound in the admin panel when new returns arrive." />

        <div style={h3}>Permissions <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Permissions</span></div>
        <FieldRow label="read_all_orders" description="Enables access to orders older than 60 days. Without this, the portal can only look up recent orders. Required for full return functionality." />
      </>
    ),
  },

  /* ────────────────── 8. DASHBOARD & REPORTS ────────────────── */
  {
    id: "analytics",
    title: "Dashboard & Reports",
    subtitle: "Monitor return performance and trends",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    content: (
      <>
        <div style={h3}>Dashboard</div>
        <p style={p}>The <NavLink to="/app">Dashboard</NavLink> is your home screen. It shows a summary of return activity for the selected time period.</p>
        <FieldRow label="KPI cards" description="Total Returns (with period-over-period trend), Needs Review (pending count), Approved (with approval rate), and Refunded." />
        <FieldRow label="Return trend chart" description="An area chart showing daily return volume over the selected period." />
        <FieldRow label="Status breakdown" description="Visual breakdown of returns by status, with clickable links to filter the returns list." />
        <FieldRow label="Recent returns" description="Latest 8 returns with quick links to their detail pages." />
        <FieldRow label="Suggestions" description="Actionable insights — e.g., 'X returns pending review' or 'X returns not yet refunded'. Click the action link to jump to the relevant page." />
        <FieldRow label="Date range" description="Select Last 7 days, Last 30 days, Last 90 days, This month, Last month, This year, or a custom date range." />

        <div style={h3}>Reports & Analytics</div>
        <p style={p}>The <NavLink to="/app/reports">Reports</NavLink> page provides deeper analytics.</p>
        <FieldRow label="KPI cards" description="Total Returns (with trend), Approval Rate, Average Processing Time (days from submission to approval), and Refund Rate." />
        <FieldRow label="Return volume trend" description="Area chart with daily data. Dots appear for periods with fewer than 15 data points." />
        <FieldRow label="Status distribution" description="Donut chart showing the proportion of each status. Legend shows counts and percentages." />
        <FieldRow label="Performance gauges" description="Ring charts for Approval Rate, Rejection Rate, Refund Rate, and Fynd Sync Rate (when Fynd is connected)." />
        <FieldRow label="Top return reasons" description="Horizontal bar chart of the most common return reasons. Click 'Manage' to edit reasons." />
        <FieldRow label="Status breakdown table" description="Detailed table with counts, percentages, and progress bars. Click any status row to jump to filtered returns." />
        <FieldRow label="Key insights" description="Automated observations — high/low approval rate, processing speed, top reasons, and trend changes." />
        <FieldRow label="Export CSV" description="Download return data for the selected period as a CSV file." />
      </>
    ),
  },

  /* ────────────────── 9. TROUBLESHOOTING ────────────────── */
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    subtitle: "Common issues and how to fix them",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
    content: (
      <>
        <div style={h3}>Customer can't find their order</div>
        <ul style={ul}>
          <li>The order must exist in Shopify and have been <strong>fulfilled</strong>.</li>
          <li>The email or phone entered must <strong>match exactly</strong> what's on the Shopify order.</li>
          <li>For orders older than 60 days, you need the <code style={code}>read_all_orders</code> permission. Go to <NavLink to="/app/settings/permissions">Settings → Permissions</NavLink> to enable it.</li>
          <li>Check that the <strong>return window</strong> hasn't expired for that order (configured in <NavLink to="/app/settings/rules">Policy Rules</NavLink>).</li>
        </ul>

        <div style={h3}>"You need to set a location to restock items"</div>
        <ul style={ul}>
          <li>This error means Shopify requires a location for inventory restocking.</li>
          <li>Go to <NavLink to="/app/settings/return-settings">Return Settings</NavLink> and set a <strong>default fallback location</strong> under "Refund Restock Location".</li>
          <li>The app auto-detects the fulfillment location, but a fallback ensures it always works.</li>
        </ul>

        <div style={h3}>Fynd sync fails with 403 Forbidden</div>
        <ul style={ul}>
          <li>Your Fynd OAuth app needs these scopes: <code style={code}>company/orders/read</code>, <code style={code}>company/orders/write</code>.</li>
          <li>Make sure you're using <strong>Platform API</strong> credentials (not Storefront).</li>
          <li>Verify the <strong>environment</strong> (UAT vs Production) matches your Fynd account.</li>
        </ul>

        <div style={h3}>Fynd sync fails with 401 Unauthorized</div>
        <ul style={ul}>
          <li>Double-check your <strong>Company ID</strong>, <strong>Client ID</strong>, and <strong>Client Secret</strong>.</li>
          <li>Try regenerating credentials in Fynd Partners.</li>
        </ul>

        <div style={h3}>Webhook not receiving events from Fynd</div>
        <ul style={ul}>
          <li>The webhook URL must be <strong>publicly reachable</strong> (not localhost).</li>
          <li>Use the <strong>Test webhook</strong> button in <NavLink to="/app/settings/setup">Fynd Setup Guide</NavLink> to verify.</li>
          <li>Ensure <code style={code}>SHOPIFY_APP_URL</code> is set to your deployed URL.</li>
          <li>Check Fynd Partners dashboard for webhook delivery logs.</li>
        </ul>

        <div style={h3}>Return AWB not appearing</div>
        <ul style={ul}>
          <li>The AWB is assigned by Fynd <strong>after a courier is assigned</strong> for pickup.</li>
          <li>If the return is synced but AWB is missing, Fynd may still be in the "return initiated" stage.</li>
          <li>Check back later or verify the shipment status in your Fynd dashboard.</li>
        </ul>

        <div style={h3}>Portal returns 404</div>
        <ul style={ul}>
          <li>Verify the <strong>App Proxy</strong> is configured correctly in Shopify Partner dashboard: prefix = <code style={code}>apps</code>, sub path = <code style={code}>returns</code>.</li>
          <li>Verify the proxy URL points to <code style={code}>https://your-app-url/apps/returns</code>.</li>
          <li>Ensure the app is <strong>installed</strong> on the store.</li>
        </ul>

        <div style={h3}>Refund not being created automatically</div>
        <ul style={ul}>
          <li><strong>Auto-refund</strong> must be enabled in <NavLink to="/app/settings/return-settings">Return Settings</NavLink>.</li>
          <li>The return must have a <strong>Fynd Shipment ID</strong> (i.e., it was synced to Fynd).</li>
          <li>The return must be in <strong>approved</strong> or <strong>completed</strong> status.</li>
          <li>The webhook must be configured and receiving events (test it in <NavLink to="/app/settings/setup">Setup Guide</NavLink>).</li>
          <li>Check the return's <strong>event timeline</strong> for <code style={code}>fynd_webhook</code> entries to see what was received.</li>
        </ul>

        <div style={h3}>Emails not being sent</div>
        <ul style={ul}>
          <li>Email notifications require SMTP to be configured in <NavLink to="/app/settings/notifications">Settings → Notifications</NavLink>. Enter your SMTP host, port, username, and password.</li>
          <li>Click "Test connection" in the notifications settings to verify your SMTP server is reachable.</li>
          <li>Check that the relevant notification toggles are enabled.</li>
        </ul>
      </>
    ),
  },
];

/* ── Main Component ── */
export default function Documentation() {
  const [activeChapter, setActiveChapter] = useState("welcome");
  const chapter = CHAPTERS.find((c) => c.id === activeChapter) || CHAPTERS[0];
  const chapterIdx = CHAPTERS.findIndex((c) => c.id === activeChapter);
  const prev = chapterIdx > 0 ? CHAPTERS[chapterIdx - 1] : null;
  const next = chapterIdx < CHAPTERS.length - 1 ? CHAPTERS[chapterIdx + 1] : null;

  return (
    <s-page heading="Product Guide">
      <div className="app-content" style={{ paddingBottom: 48 }}>

        {/* ── Chapter sidebar + content layout ── */}
        <div className="docs-layout" style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 20, alignItems: "start" }}>

          {/* Sidebar */}
          <div className="docs-sidebar" style={{
            position: "sticky", top: 20,
            background: surface, borderRadius: 14, border, padding: "16px 12px",
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: "0.06em", padding: "0 8px 10px", borderBottom: "1px solid #F1F5F9" }}>
              Product Guide
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
              {CHAPTERS.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => setActiveChapter(c.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 10px", borderRadius: 8,
                    fontSize: 13, fontWeight: activeChapter === c.id ? 600 : 500,
                    color: activeChapter === c.id ? accent : "#64748B",
                    background: activeChapter === c.id ? "var(--rpm-accent-subtle, #EFF6FF)" : "transparent",
                    border: "none", cursor: "pointer", textAlign: "left",
                    transition: "all 0.12s",
                    width: "100%",
                  }}
                >
                  <span style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, borderRadius: 5,
                    background: activeChapter === c.id ? accent : "#E2E8F0",
                    color: activeChapter === c.id ? "white" : "#94A3B8",
                    fontSize: 10, fontWeight: 700, flexShrink: 0,
                  }}>
                    {i + 1}
                  </span>
                  {c.title.replace("Fynd Returns", "Welcome").length > 22 ? c.title.slice(0, 20) + "…" : c.title}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div>
            {/* Chapter header */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: accent, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Chapter {chapterIdx + 1} of {CHAPTERS.length}
                </span>
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 800, color: text, margin: "0 0 4px", letterSpacing: "-0.03em" }}>{chapter.title}</h1>
              <p style={{ fontSize: 15, color: muted, margin: 0 }}>{chapter.subtitle}</p>
            </div>

            {/* Chapter content */}
            <div style={card}>
              {chapter.content}
            </div>

            {/* Prev/Next nav */}
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "stretch", gap: 12,
            }}>
              {prev ? (
                <button onClick={() => setActiveChapter(prev.id)} style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "flex-start",
                  padding: "14px 18px", borderRadius: 12, background: "#F8FAFC", border: "1px solid #E2E8F0",
                  cursor: "pointer", transition: "all 0.12s",
                }}>
                  <span style={{ fontSize: 11, color: muted, fontWeight: 600, marginBottom: 4 }}>← Previous</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: text }}>{prev.title}</span>
                </button>
              ) : <div style={{ flex: 1 }} />}
              {next ? (
                <button onClick={() => setActiveChapter(next.id)} style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "flex-end",
                  padding: "14px 18px", borderRadius: 12, background: "#F8FAFC", border: "1px solid #E2E8F0",
                  cursor: "pointer", transition: "all 0.12s",
                }}>
                  <span style={{ fontSize: 11, color: muted, fontWeight: 600, marginBottom: 4 }}>Next →</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: text }}>{next.title}</span>
                </button>
              ) : <div style={{ flex: 1 }} />}
            </div>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <s-page heading="Product Guide">
      <div className="app-content">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a href="/app/docs" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</a>
        </div>
      </div>
    </s-page>
  );
}
