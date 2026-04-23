import React, { useState } from "react";
import { Link, useRouteError, isRouteErrorResponse } from "react-router";
import { AppPage } from "../components/AppPage";

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
const h3: React.CSSProperties = { fontSize: 16, fontWeight: 800, color: text, margin: "28px 0 10px", letterSpacing: "-0.01em" };
const h4: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: text, margin: "20px 0 8px", textTransform: "uppercase", letterSpacing: "0.06em" };
const p: React.CSSProperties = { fontSize: 14, color: "#475569", lineHeight: 1.75, margin: "0 0 12px" };
const ul: React.CSSProperties = { ...p, paddingLeft: 20, margin: "0 0 14px" };
const code: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, background: "#F1F5F9", padding: "2px 7px", borderRadius: 5, color: "#0F172A", border: "1px solid #E2E8F0" };

/* ── Reusable building blocks ── */

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: "12px 16px", background: "#F8FAFC", borderRadius: 12, border: "1px solid #E2E8F0", marginBottom: 8 }}>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, borderRadius: "50%", background: accent, color: "white", fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{n}</span>
      <div style={{ fontSize: 14, color: "#334155", lineHeight: 1.7, flex: 1 }}>{children}</div>
    </div>
  );
}

function Tip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <div style={{ fontSize: 13, color: "#1E40AF", lineHeight: 1.65, flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 3, color: "#1E3A8A" }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function Warning({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#FFFBEB", borderRadius: 10, border: "1px solid #FDE68A", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <div style={{ fontSize: 13, color: "#92400E", lineHeight: 1.65, flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 3, color: "#78350F" }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function Danger({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#FEF2F2", borderRadius: 10, border: "1px solid #FECACA", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <div style={{ fontSize: 13, color: "#991B1B", lineHeight: 1.65, flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 3, color: "#7F1D1D" }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function Success({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "12px 16px", background: "#ECFDF5", borderRadius: 10, border: "1px solid #A7F3D0", marginBottom: 12, marginTop: 8 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2" style={{ flexShrink: 0, marginTop: 2 }}><polyline points="20 6 9 17 4 12"/></svg>
      <div style={{ fontSize: 13, color: "#065F46", lineHeight: 1.65, flex: 1 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: 3, color: "#064E3B" }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

function Highlights({ items }: { items: { icon?: React.ReactNode; title: string; description: string }[] }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10,
      margin: "6px 0 18px",
    }}>
      {items.map((h, i) => (
        <div key={i} style={{
          padding: "14px 16px", borderRadius: 12,
          background: "linear-gradient(135deg, #F8FAFC, #F1F5F9)",
          border: "1px solid #E2E8F0",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            {h.icon ? (
              <span style={{ color: accent, display: "inline-flex" }}>{h.icon}</span>
            ) : (
              <span style={{
                width: 18, height: 18, borderRadius: 5, background: accent, color: "white",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontWeight: 700,
              }}>★</span>
            )}
            <span style={{ fontSize: 13, fontWeight: 700, color: text }}>{h.title}</span>
          </div>
          <div style={{ fontSize: 12, color: muted, lineHeight: 1.55 }}>{h.description}</div>
        </div>
      ))}
    </div>
  );
}

function KeyPoints({ points, title = "Key points" }: { points: React.ReactNode[]; title?: string }) {
  return (
    <div style={{
      padding: "14px 18px", borderRadius: 12,
      background: "#FAF5FF",
      border: "1px solid #E9D5FF",
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#7C3AED", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#4C1D95", lineHeight: 1.7 }}>
        {points.map((pt, i) => <li key={i} style={{ marginBottom: 4 }}>{pt}</li>)}
      </ul>
    </div>
  );
}

function FieldRow({ label, description, defaultValue, required }: { label: string; description: React.ReactNode; defaultValue?: string; required?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 14, padding: "12px 0", borderBottom: "1px solid #F1F5F9" }}>
      <div style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: text }}>{label}</span>
        {required && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: "#DC2626", background: "#FEF2F2", border: "1px solid #FECACA", padding: "1px 6px", borderRadius: 4 }}>REQ</span>}
        {defaultValue !== undefined && (
          <div style={{ marginTop: 3 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: muted, textTransform: "uppercase", letterSpacing: "0.05em", marginRight: 4 }}>default</span>
            <code style={code}>{defaultValue}</code>
          </div>
        )}
      </div>
      <span style={{ fontSize: 13, color: muted, lineHeight: 1.65 }}>{description}</span>
    </div>
  );
}

function CodeBlock({ children, lang }: { children: string; lang?: string }) {
  return (
    <div style={{ margin: "10px 0 14px", borderRadius: 10, overflow: "hidden", border: "1px solid #E2E8F0", background: "#0F172A" }}>
      {lang && (
        <div style={{ padding: "6px 14px", fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.08em", background: "#1E293B", borderBottom: "1px solid #334155" }}>
          {lang}
        </div>
      )}
      <pre style={{
        margin: 0, padding: "14px 18px", fontSize: 12, lineHeight: 1.65,
        color: "#E2E8F0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        overflowX: "auto", whiteSpace: "pre",
      }}>{children}</pre>
    </div>
  );
}

function StatusPill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 5,
      fontSize: 11, fontWeight: 700,
      background: `${color}14`, color,
      border: `1px solid ${color}30`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, display: "inline-block" }} />
      {children}
    </span>
  );
}

function DoDont({ doo, dont }: { doo: string[]; dont: string[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
      <div style={{ padding: "12px 16px", borderRadius: 10, background: "#ECFDF5", border: "1px solid #A7F3D0" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#065F46", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>✓ Do</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#065F46", lineHeight: 1.65 }}>
          {doo.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      </div>
      <div style={{ padding: "12px 16px", borderRadius: 10, background: "#FEF2F2", border: "1px solid #FECACA" }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "#991B1B", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>✗ Don't</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#991B1B", lineHeight: 1.65 }}>
          {dont.map((d, i) => <li key={i}>{d}</li>)}
        </ul>
      </div>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details style={{
      border: "1px solid #E2E8F0", borderRadius: 10,
      background: "#FFFFFF", marginBottom: 8, padding: "10px 16px",
    }}>
      <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 700, color: text, listStyle: "none" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          {q}
        </span>
      </summary>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #F1F5F9", fontSize: 13, color: muted, lineHeight: 1.7 }}>
        {children}
      </div>
    </details>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return <Link to={to} style={{ color: accent, fontWeight: 600, textDecoration: "none" }}>{children}</Link>;
}

function InlineKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd style={{
      fontFamily: "ui-monospace, monospace", fontSize: 11, padding: "2px 6px",
      background: "#F8FAFC", border: "1px solid #CBD5E1", borderBottom: "2px solid #CBD5E1",
      borderRadius: 4, color: "#334155", fontWeight: 600,
    }}>{children}</kbd>
  );
}

/* ── Chapters ── */
type Chapter = { id: string; title: string; subtitle: string; icon: React.ReactNode; content: React.ReactNode };

const CHAPTERS: Chapter[] = [

  /* ────────────────── 1. WELCOME ────────────────── */
  {
    id: "welcome",
    title: "Welcome to Fynd Returns",
    subtitle: "The complete guide to your returns management platform",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    content: (
      <>
        <p style={p}>
          <strong>Fynd Returns</strong> is an enterprise-grade returns management app for Shopify stores.
          It gives your customers a beautiful self-service portal to request and track returns, and gives
          your team a powerful admin with full control over approvals, refunds, exchanges, and reverse
          logistics through Fynd's pickup &amp; delivery network.
        </p>

        <Highlights
          items={[
            { title: "Self-service portal", description: "Branded, embedded in your storefront. No theme edits needed — lives at /apps/returns via Shopify App Proxy." },
            { title: "Full lifecycle control", description: "Approve, reject, sync, refund, exchange — every action is logged with a complete event timeline." },
            { title: "Reverse logistics built in", description: "One-click sync to Fynd for pickups, AWBs, tracking, quality check and credit-note automation." },
            { title: "Smart automation", description: "Auto-approve by rules, auto-refund on credit-note webhook, fraud scoring, blocklist enforcement." },
            { title: "Revenue retention", description: "Exchanges, store credit, and green-return resolutions to keep revenue instead of refunding it." },
            { title: "Enterprise analytics", description: "13+ KPIs, trend charts, funnel, fraud, channel attribution, geo breakdown, and CSV export." },
          ]}
        />

        <KeyPoints
          title="Why teams choose Fynd Returns"
          points={[
            <><strong>Zero theme changes required.</strong> The portal is served via App Proxy — nothing gets injected into your Shopify theme code.</>,
            <><strong>Multi-channel ready.</strong> Works with orders from Shopify, Fynd OMS, or manually-submitted orders with email/phone OTP verification.</>,
            <><strong>Merchant timezone &amp; locale aware.</strong> All date ranges, dashboards, and notifications honour the shop's configured timezone and locale.</>,
            <><strong>Audit-grade logging.</strong> Every state change, webhook, admin action and system event is persisted as a <code style={code}>ReturnEvent</code> row.</>,
            <><strong>REST API + webhooks.</strong> Build your own integrations with Gorgias, Zendesk, Slack, or any internal tool.</>,
          ]}
        />

        <div style={h3}>What you can do with this app</div>
        <ul style={ul}>
          <li><strong>Accept return requests</strong> — Customers submit returns through a branded portal on your storefront. They select items, choose a reason, and optionally upload photos or videos as proof.</li>
          <li><strong>Review and manage returns</strong> — Approve or reject each request from the admin panel. Add admin notes, customer-visible notes, process refunds, and track the full lifecycle on a single detail page.</li>
          <li><strong>Connect Fynd for logistics</strong> — Automatically sync approved returns to Fynd for pickup scheduling, AWB generation, shipment tracking, warehouse QC, and credit-note delivery.</li>
          <li><strong>Process refunds</strong> — Refund customers directly to their original payment method via Shopify, with proper inventory restocking to the correct location.</li>
          <li><strong>Offer exchanges &amp; store credit</strong> — Let customers choose a replacement item or a store credit code instead of taking cash back.</li>
          <li><strong>Automate everything</strong> — Rule-based auto-approve, auto-refund on credit-note, blocklist enforcement, fraud scoring, and scheduled reports.</li>
          <li><strong>Track everything</strong> — Real-time dashboards, 13+ KPIs, funnel analytics, geographic breakdown, channel attribution, and a complete event timeline for every return.</li>
        </ul>

        <div style={h3}>How it works — the big picture</div>
        <Step n={1}><strong>Customer visits your portal</strong> — They go to your store's <code style={code}>/apps/returns</code> page, look up their order by order number (or email/phone + OTP for manual submissions), and submit a return request with reasons, quantities, and optional photos.</Step>
        <Step n={2}><strong>Your admin reviews the request</strong> — The return appears in <NavLink to="/app/returns">Returns</NavLink>. You approve (with one click or auto-rule), reject (with a reason that's shown to the customer), or ask for more info via the customer-visible notes field.</Step>
        <Step n={3}><strong>Return syncs to Fynd</strong> — If Fynd is configured, the approved return is automatically created on Fynd. You get back AWB numbers, courier assignment, and a live tracking link.</Step>
        <Step n={4}><strong>Customer drops off / courier picks up</strong> — Customer either self-ships (with forward AWB) or a courier is scheduled to pick up at the customer's address. Fynd tracks every status update.</Step>
        <Step n={5}><strong>Warehouse QC &amp; credit note</strong> — Fynd's warehouse receives the item, runs QC, and issues a credit note when it passes. A webhook fires to your app.</Step>
        <Step n={6}><strong>Refund processed</strong> — If auto-refund is enabled, the app creates the Shopify refund automatically. Otherwise, you click "Process refund" from the return detail page.</Step>
        <Step n={7}><strong>Customer tracks &amp; is notified</strong> — The customer can track the status in real time through the same portal, and receives email/SMS notifications at each milestone.</Step>

        <div style={h3}>Who this documentation is for</div>
        <ul style={ul}>
          <li><strong>Store owners &amp; operations staff</strong> — approving returns, processing refunds, configuring policies.</li>
          <li><strong>Customer support teams</strong> — looking up returns, communicating status, resolving disputes.</li>
          <li><strong>Developers &amp; integrators</strong> — building custom automations via the REST API and webhooks.</li>
          <li><strong>Logistics / reverse-logistics managers</strong> — connecting Fynd, monitoring pickups and credit notes.</li>
        </ul>

        <Success title="Tip: Use the sidebar to jump around">
          Every chapter is self-contained. Start with <strong>First-Time Setup</strong> if you're installing,
          or jump straight to <strong>Troubleshooting</strong> or <strong>API Reference</strong> if you already
          know the basics.
        </Success>
      </>
    ),
  },

  /* ────────────────── 2. FIRST-TIME SETUP ────────────────── */
  {
    id: "setup",
    title: "First-Time Setup",
    subtitle: "Get your app production-ready in under 30 minutes",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    content: (
      <>
        <p style={p}>
          After installing the app from the Shopify App Store, follow these five steps to configure
          everything end-to-end. You can complete the minimum (steps 1–3) in under 10 minutes; the full
          setup including Fynd takes about 30 minutes.
        </p>

        <Highlights
          items={[
            { title: "1 · App Proxy", description: "Exposes /apps/returns on your storefront — no theme edits." },
            { title: "2 · Return reasons", description: "Pre-loaded; customize per category if needed." },
            { title: "3 · Return policy", description: "Window, photo requirements, fee, auto-approve." },
            { title: "4 · Portal branding", description: "Colours, fonts, radius, enabled tabs." },
            { title: "5 · Storefront link", description: "Add 'Returns' to your footer or main menu." },
            { title: "6 · Fynd (optional)", description: "Credentials, webhook registration, test connection." },
          ]}
        />

        <div style={h3}>Step 1: Set up the Customer Portal (App Proxy)</div>
        <p style={p}>
          The customer portal is how your customers will access returns. It lives at
          <code style={code}>https://your-store.myshopify.com/apps/returns</code> and is served through
          Shopify's <strong>App Proxy</strong> feature. This is a zero-code embed — no theme edits,
          no Liquid snippets — the page is rendered by this app and proxied through Shopify.
        </p>
        <Step n={1}>In your <strong>Shopify Partner dashboard</strong>, open the app's configuration page.</Step>
        <Step n={2}>Scroll to the <strong>App Proxy</strong> section (under "App setup" → "App proxy").</Step>
        <Step n={3}>Set <strong>Sub path prefix</strong> to <code style={code}>apps</code></Step>
        <Step n={4}>Set <strong>Sub path</strong> to <code style={code}>returns</code></Step>
        <Step n={5}>Set <strong>Proxy URL</strong> to your deployed app URL followed by <code style={code}>/apps/returns</code> — e.g. <code style={code}>https://your-app.onrender.com/apps/returns</code>.</Step>
        <Step n={6}>Click <strong>Save</strong>. Your portal is now live at <code style={code}>/apps/returns</code>.</Step>

        <Tip title="Verify the proxy">
          Open <code style={code}>https://your-store.myshopify.com/apps/returns</code> in a browser.
          You should see the portal with the tabs you configured. If you see a Shopify 404 page, the
          proxy is misconfigured — re-check the sub-path and URL.
        </Tip>

        <Danger title="The Proxy URL must end in /apps/returns">
          The proxy URL is appended to, not replaced. Setting it to just your app URL (without
          <code style={code}>/apps/returns</code>) will pass the request straight to the admin router
          and return 404. Always include the full path.
        </Danger>

        <div style={h3}>Step 2: Configure return reasons</div>
        <p style={p}>
          Return reasons are the options your customers see when selecting why they're returning an
          item. The app comes pre-loaded with seven common reasons: <em>Wrong Product Received,
          Product is Damaged, Product is Defective, Too Big, Too Small, Not as Described,</em> and
          <em>Changed my mind</em>.
        </p>
        <Step n={1}>Go to <NavLink to="/app/settings/rules">Settings → Policy Rules</NavLink>.</Step>
        <Step n={2}>In the <strong>Return Reasons</strong> section, review the defaults.</Step>
        <Step n={3}>Add a new reason by typing in the search box and clicking <strong>Add</strong>.</Step>
        <Step n={4}>Remove by clicking the <InlineKey>×</InlineKey> next to any reason. Reorder by dragging.</Step>
        <Step n={5}>Click <strong>Save</strong> at the bottom.</Step>

        <Tip title="Category-specific reasons">
          Want clothing to show "Too loose" / "Too tight" and electronics to show "Defective" / "Missing parts"?
          Use <strong>Category-specific reasons</strong> in the same page. Map Shopify product types to
          dedicated reason sets — the portal will show the correct list automatically.
        </Tip>

        <div style={h3}>Step 3: Set your return policy</div>
        <Step n={1}>Go to <NavLink to="/app/settings/return-settings">Settings → Return Settings</NavLink>.</Step>
        <Step n={2}>Set the <strong>return window</strong> — days after delivery a return can be initiated (common: 14, 30, or 60 days).</Step>
        <Step n={3}>Decide whether to <strong>require photos</strong>. If Yes, customers cannot submit without uploading at least one photo.</Step>
        <Step n={4}>Set a <strong>return fee</strong> if you charge a restocking fee. The fee is deducted from the refund amount.</Step>
        <Step n={5}>Choose <strong>auto-approve</strong>: Yes = instant approval for every return, No = manual review.</Step>
        <Step n={6}>Configure <strong>refund restock location</strong> (Automatic uses the fulfillment location; Manual lets you pick each time).</Step>
        <Step n={7}>Click <strong>Save</strong>.</Step>

        <Warning title="Auto-approve caveat">
          Auto-approve skips human review but does <em>not</em> skip policy rules — blocklist entries,
          restricted regions, excluded tags, and outside-window requests are still blocked. Use with
          fraud scoring (see Chapter 9) to catch abuse automatically.
        </Warning>

        <div style={h3}>Step 4: Customize the portal appearance</div>
        <Step n={1}>Go to <NavLink to="/app/settings/widget">Settings → Portal Widget</NavLink>.</Step>
        <Step n={2}>Set your <strong>primary color</strong> to match your brand.</Step>
        <Step n={3}>Pick a <strong>font</strong>: DM Sans, Inter, System UI, Georgia, or Playfair Display.</Step>
        <Step n={4}>Set the <strong>border radius</strong>: Minimal (8 px), Rounded (12 px), Soft (16 px), or Pill (24 px).</Step>
        <Step n={5}>Enable or disable portal tabs: <strong>Order tracking</strong>, <strong>Return tracking</strong>, <strong>Create return</strong>.</Step>
        <Step n={6}>Choose the <strong>default tab</strong> — whichever one customers should see first.</Step>
        <Step n={7}>Click <strong>Save</strong>, then <strong>Open portal</strong> to preview.</Step>

        <div style={h3}>Step 5: Add the portal link to your store navigation</div>
        <Step n={1}>In Shopify admin, go to <strong>Online Store → Navigation</strong>.</Step>
        <Step n={2}>Open your <strong>Footer menu</strong> (or main menu).</Step>
        <Step n={3}>Click <strong>Add menu item</strong>. Name it <em>"Returns"</em> or <em>"Returns &amp; Exchanges"</em>.</Step>
        <Step n={4}>Paste the portal URL: <code style={code}>/apps/returns</code> (relative) or the full absolute URL.</Step>
        <Step n={5}>Click <strong>Save</strong>. Customers can now reach returns from any page.</Step>

        <Success title="Minimum setup done">
          Steps 1–5 give you a fully functional self-service returns portal. The next chapter covers
          what the customer actually sees and does. Step 6 (Fynd) is only needed if you want automated
          reverse logistics.
        </Success>

        <div style={h3}>Step 6 (optional): Connect Fynd for reverse logistics</div>
        <p style={p}>This is covered in detail in Chapter <strong>Connecting Fynd</strong>. At a high level:</p>
        <ol style={ul}>
          <li>Get your Company ID, Application ID, Client ID, and Client Secret from Fynd Partners.</li>
          <li>Enter them in <NavLink to="/app/settings/integrations">Settings → Integrations</NavLink>.</li>
          <li>Click <strong>Test Platform</strong> to verify.</li>
          <li>Register the webhook from <NavLink to="/app/settings/setup">Settings → Setup Guide</NavLink>.</li>
        </ol>
      </>
    ),
  },

  /* ────────────────── 3. CUSTOMER PORTAL ────────────────── */
  {
    id: "portal",
    title: "Customer Portal",
    subtitle: "Exactly what your customers see, step by step",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    content: (
      <>
        <p style={p}>
          The customer portal is a branded page embedded in your Shopify storefront at
          <code style={code}>/apps/returns</code>. It has three tabs:
          <strong> Create new return</strong>, <strong>Track existing return</strong>, and
          <strong> Your orders</strong>. Each can be enabled/disabled independently.
        </p>

        <Highlights
          items={[
            { title: "Order-based lookup", description: "Customers enter their order number to pull line items directly from Shopify." },
            { title: "OTP manual flow", description: "No order number? Email or phone OTP lets verified customers still submit a return." },
            { title: "Rich media uploads", description: "Up to 5 MB images and 50 MB videos per item as photo evidence." },
            { title: "Smart reason dropdown", description: "Category-aware — clothing sees fit reasons, electronics see defect reasons, etc." },
            { title: "Real-time tracking", description: "Every status change, AWB update, and admin note appears in the customer's timeline." },
            { title: "Full branding control", description: "Colours, fonts, radius, and per-section toggles — rendered from your Portal Widget settings." },
          ]}
        />

        <div style={h3}>Tab 1 — Create a new return (order-based)</div>
        <p style={p}>The default happy path: customer has their order number and wants to submit a return.</p>
        <Step n={1}>Customer opens the portal and clicks <strong>Create new return</strong>.</Step>
        <Step n={2}>They enter their <strong>order number</strong> (e.g. <code style={code}>#1001</code> or <code style={code}>1001</code>) and click <strong>Find my order</strong>.</Step>
        <Step n={3}>The app verifies the order via Shopify. If it's valid, <em>fulfilled</em>, and within the return window, the line items are displayed with thumbnails, prices, and quantities.</Step>
        <Step n={4}>Customer <strong>selects items</strong> by checking the boxes. They can select multiple items and partial quantities.</Step>
        <Step n={5}>For each selected item, they choose a <strong>return reason</strong> and set the <strong>quantity</strong> (up to the purchased quantity).</Step>
        <Step n={6}>Optionally, they enter their <strong>email</strong> for status updates and add <strong>notes</strong>.</Step>
        <Step n={7}>If photo uploads are enabled, they can <strong>drag-drop or click to browse</strong>. Images up to 5 MB, videos up to 50 MB. Files are uploaded to secure storage and linked to the return item.</Step>
        <Step n={8}>They click <strong>Submit return request</strong>.</Step>
        <Step n={9}>A confirmation screen shows the <strong>Return Request ID</strong> (e.g. <code style={code}>RPM-A1B2C3D4</code>) with a <strong>Copy</strong> button. The customer should save this.</Step>

        <Warning title="Duplicate-return protection">
          If a return already exists for the same order + items, the portal shows the existing
          return's status instead of the submit form. This prevents accidental double-submissions.
        </Warning>

        <div style={h3}>Tab 1b — Manual submission (no order lookup)</div>
        <p style={p}>
          Some customers don't have their order handy or the order was imported from another system.
          The portal offers an OTP-verified manual submission path:
        </p>
        <Step n={1}>Customer clicks <strong>Submit manually without order lookup</strong>.</Step>
        <Step n={2}>They enter their <strong>email</strong> or <strong>phone</strong>.</Step>
        <Step n={3}>The app sends a <strong>6-digit OTP</strong> via email (SMTP) or SMS. OTPs are valid for 10 minutes.</Step>
        <Step n={4}>After verification, they fill in: order number, item description, reason, and optional photo.</Step>
        <Step n={5}>Submission creates the return with <code style={code}>sourceChannel = "manual"</code> for auditability.</Step>

        <Tip title="Why this matters">
          Manual submissions are useful for orders placed pre-install, orders from Fynd OMS without
          a matching Shopify order, or wholesale B2B orders that aren't in Shopify at all.
        </Tip>

        <div style={h3}>Tab 2 — Track an existing return</div>
        <Step n={1}>Customer clicks <strong>Track existing return</strong>.</Step>
        <Step n={2}>They select a search method: <strong>Order Number</strong>, <strong>Email</strong>, <strong>Phone</strong>, <strong>Return Request ID</strong>, <strong>Return Number</strong>, <strong>Forward AWB</strong>, or <strong>Return AWB</strong>.</Step>
        <Step n={3}>They enter the value and click <strong>Look up</strong>.</Step>
        <Step n={4}>Matching returns appear grouped under <strong>Your orders</strong> and <strong>Your returns</strong>.</Step>
        <Step n={5}>Each card shows: status badge, order name, Fynd return number (if synced), AWB numbers, created date, and a <strong>6-step journey progress bar</strong>.</Step>
        <Step n={6}>Expanding a return reveals the full <strong>event timeline</strong> with timestamps: created, approved, synced to Fynd, AWB assigned, picked up, in transit, received, QC passed, credit note, refunded.</Step>

        <Success title="If a return was rejected">
          The rejection reason you entered in the admin is shown to the customer in this timeline,
          so they know exactly why — reducing support tickets.
        </Success>

        <div style={h3}>Tab 3 — Order tracking</div>
        <p style={p}>
          A simple order-lookup flow that lets the customer see fulfillment status, tracking numbers,
          and item details — handy as an "all-in-one" status page when paired with Return tracking.
        </p>

        <div style={h3}>Portal customization reference</div>
        <p style={p}>All options live in <NavLink to="/app/settings/widget">Settings → Portal Widget</NavLink>:</p>
        <FieldRow label="Primary color" description="The accent used for buttons, links, active states, and progress bars. Set to your brand's main colour." defaultValue="#1F8A4C" />
        <FieldRow label="Background color" description="The page background — usually a neutral light colour." defaultValue="#FFFFFF" />
        <FieldRow label="Card surface color" description="Background of cards/panels within the portal. Often equal to background for a flat look." defaultValue="#FFFFFF" />
        <FieldRow label="Text color" description="Body text colour. Keep high-contrast with the background." defaultValue="#0F172A" />
        <FieldRow label="Font" description={<>DM Sans (modern), Inter (neutral), System UI (platform-native), Georgia (classic serif), or Playfair Display (editorial serif).</>} defaultValue="DM Sans" />
        <FieldRow label="Border radius" description="Roundness of buttons and cards. Options map to 8/12/16/24 px." defaultValue="Rounded (12px)" />
        <FieldRow label="Default tab" description="Which tab opens first: Order tracking, Return tracking, or Create return." defaultValue="Return tracking" />
        <FieldRow label="Order tracking toggle" description="Show/hide the 'Your orders' tab." defaultValue="On" />
        <FieldRow label="Return tracking toggle" description="Show/hide the 'Track existing return' tab." defaultValue="On" />
        <FieldRow label="Create return toggle" description="Show/hide the 'Create new return' tab." defaultValue="On" />
        <FieldRow label="Allow media uploads" description="Enables the photo/video upload area in the return form." defaultValue="On" />

        <div style={h3}>UX principles the portal follows</div>
        <DoDont
          doo={[
            "Shows reasons as a short, scannable dropdown — not free text.",
            "Keeps the submit button disabled until required fields are valid.",
            "Shows inventory thumbnails so the customer picks the right variant.",
            "Gives a confirmation page with a copyable Return ID (not an email-only confirmation).",
            "Falls back to manual + OTP if the order isn't in Shopify.",
          ]}
          dont={[
            "Doesn't require account login — order-based lookup is enough.",
            "Doesn't let the customer edit an already-submitted return (they'd need to contact support).",
            "Doesn't let blocklist or outside-window orders through, even if the URL is crafted.",
            "Doesn't leak order data — lookups match on order-number + email/phone for shared-device safety.",
          ]}
        />

        <div style={h3}>Frequently asked — from customers</div>
        <Faq q="Can customers create a return without an account?">
          Yes. Order-based lookup uses the order number alone for authentication. The OTP path
          verifies the email or phone before accepting a manual submission.
        </Faq>
        <Faq q="What file types are accepted for photo uploads?">
          JPG, PNG, WebP, HEIC for images. MP4 and MOV for videos. Max size is 5 MB per image and
          50 MB per video. Files are uploaded to secure object storage and served via signed URLs.
        </Faq>
        <Faq q="Can a customer track multiple returns at once?">
          Yes. Searching by email or phone returns every return tied to that contact. The list is
          grouped by order.
        </Faq>
        <Faq q="What happens if the return window has expired?">
          The portal shows a friendly message: <em>"This order is outside the return window"</em>.
          Customers can still contact support, but the automated submission is blocked.
        </Faq>
      </>
    ),
  },

  /* ────────────────── 4. MANAGING RETURNS ────────────────── */
  {
    id: "managing-returns",
    title: "Managing Returns",
    subtitle: "Review, approve, reject, and process — the complete admin playbook",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    content: (
      <>
        <p style={p}>
          The <NavLink to="/app/returns">Returns list</NavLink> is your operational hub. Everything
          you do — approve, reject, sync, refund, annotate — happens either inline from this list
          or in the detail page behind each return.
        </p>

        <div style={h3}>Status lifecycle at a glance</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <StatusPill color="#64748B">initiated</StatusPill>
          <span style={{ color: muted, fontSize: 13 }}>→</span>
          <StatusPill color="#F59E0B">pending</StatusPill>
          <span style={{ color: muted, fontSize: 13 }}>→</span>
          <StatusPill color="#3B82F6">processing</StatusPill>
          <span style={{ color: muted, fontSize: 13 }}>→</span>
          <StatusPill color="#10B981">approved</StatusPill>
          <span style={{ color: muted, fontSize: 13 }}>→</span>
          <StatusPill color="#059669">completed</StatusPill>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <StatusPill color="#EF4444">rejected</StatusPill>
          <StatusPill color="#94A3B8">cancelled</StatusPill>
        </div>

        <FieldRow label="initiated" description={<>Customer started submission but it was saved server-side (rare — usually auto-promoted to pending).</>} />
        <FieldRow label="pending" description={<>Customer submitted. Waiting for your review. Appears in <strong>Needs review</strong> KPI.</>} />
        <FieldRow label="processing" description={<>Transitional state used when Fynd sync is in-flight or a long-running operation is queued.</>} />
        <FieldRow label="approved" description={<>You approved. Eligible for Fynd sync (auto or manual) and refund processing.</>} />
        <FieldRow label="completed" description={<>Refund has been issued and settled. Terminal state.</>} />
        <FieldRow label="rejected" description={<>You rejected. Reason is shown to the customer in the portal. Terminal state.</>} />
        <FieldRow label="cancelled" description={<>Return was cancelled (by customer or admin). Terminal state.</>} />

        <div style={h3}>The Returns list page</div>
        <p style={p}>Go to <NavLink to="/app/returns">Returns</NavLink>. The page has five parts:</p>
        <FieldRow label="Stat chips" description="Quick-filter cards at the top: Total, Pending, In Progress, Approved, Rejected, Refunded. Click any chip to filter the list." />
        <FieldRow label="Search box" description="Search by order name, return ID, AWB, Fynd IDs, customer email, or phone. Debounced at 250 ms, case-insensitive." />
        <FieldRow label="Toolbar filters" description="Status dropdown · Resolution type dropdown · Date range picker · Fynd sync toggle · Fraud risk filter. All filters combine with AND." />
        <FieldRow label="Bulk actions" description="Select multiple rows via the header checkbox. Bulk-approve, bulk-reject, or bulk-sync to Fynd. See Chapter 11 for details." />
        <FieldRow label="Export CSV" description="Download the currently-filtered list as CSV with all fields including items, amounts, and statuses." />

        <Tip title="Power user trick">
          All filter state lives in the URL query string — bookmark specific views like
          <code style={code}>/app/returns?status=pending&amp;fraud=high</code>, or share them with teammates.
        </Tip>

        <div style={h3}>Return detail page</div>
        <p style={p}>
          Clicking a return row opens the detail page. This is the single source of truth for that
          return — everything you need is on one scroll.
        </p>

        <div style={h4}>1 · Header &amp; actions bar</div>
        <ul style={ul}>
          <li><strong>Title &amp; status badge</strong> with refund-status sub-badge.</li>
          <li><strong>Primary actions</strong> — context-sensitive: "Approve" / "Reject" on pending; "Sync to Fynd" / "Process refund" on approved; "Retry sync" if a Fynd sync failed.</li>
          <li><strong>More menu</strong> — Cancel, Diagnose (runs order/Fynd checks and logs to the timeline), Download invoice, Copy share link.</li>
        </ul>

        <div style={h4}>2 · Customer &amp; order summary</div>
        <ul style={ul}>
          <li>Customer name, email (with verification badge), phone.</li>
          <li>Shopify order name with deep-link to the order in Shopify admin.</li>
          <li>Fulfillment status, shipping address, delivery date.</li>
          <li><strong>Fraud risk indicator</strong> if the customer or return scored high.</li>
        </ul>

        <div style={h4}>3 · Items table</div>
        <ul style={ul}>
          <li>Each returned line item with thumbnail, title, SKU, variant, quantity, unit price, and subtotal.</li>
          <li>Return reason per item (inline, editable by admin).</li>
          <li>Condition: <em>new, used, damaged, defective</em> — used for QC expectations and analytics.</li>
          <li>Customer photos / videos (click to expand into lightbox).</li>
        </ul>

        <div style={h4}>4 · Fynd logistics panel</div>
        <p style={p}>Appears after a successful Fynd sync:</p>
        <FieldRow label="Fynd Order ID" description="Affiliate order ID sent to Fynd (usually your Shopify order name without the # prefix)." />
        <FieldRow label="Fynd Shipment ID" description="The main shipment identifier from Fynd. Used for webhook matching." />
        <FieldRow label="Fynd Return ID" description="Fynd's internal return identifier — required for most Fynd API calls." />
        <FieldRow label="Fynd Return #" description="The human-readable return number from Fynd. Shown to the customer in the portal." />
        <FieldRow label="Forward AWB" description="The AWB for the original shipment (used to match against warehouse inbound)." />
        <FieldRow label="Return AWB" description="The AWB assigned once a courier accepts the return pickup." />
        <FieldRow label="Shipment details" description="Courier name, tracking link, current stage, invoice PDF, pricing breakdown, and per-item QC state." />
        <FieldRow label="Return journey" description="A 6-step progress bar: Submitted → Confirmed → Pickup → In Transit → Received → Refunded." />

        <div style={h4}>5 · Notes</div>
        <FieldRow label="Admin notes" description={<>Internal only. Visible to your team, <strong>never</strong> to the customer. Use for case tracking, context, and handoffs.</>} />
        <FieldRow label="Customer notes" description={<>Shown to the customer in the portal. Use for status updates, rejection explanations, next-step instructions.</>} />

        <div style={h4}>6 · Event timeline</div>
        <p style={p}>
          A full audit log — every state change, webhook event, admin action, and automated step is
          stored as a <code style={code}>ReturnEvent</code> and rendered in reverse chronological
          order. Each event has a type (<em>created, approved, fynd_sync, fynd_webhook, refunded,…</em>),
          an actor (customer/admin/system), a timestamp, and a payload.
        </p>

        <div style={h3}>Approving a return</div>
        <Step n={1}>Open a <em>pending</em> return.</Step>
        <Step n={2}>Review the items, reasons, and photos.</Step>
        <Step n={3}>(Optional) add an internal admin note.</Step>
        <Step n={4}>Click <strong>Approve</strong>.</Step>
        <Step n={5}>The status flips to <em>approved</em> and a <code style={code}>ReturnEvent</code> of type <code style={code}>approved</code> is logged.</Step>
        <Step n={6}>If Fynd is configured, the app auto-creates the Fynd return and assigns AWBs.</Step>

        <div style={h3}>Rejecting a return</div>
        <Step n={1}>Click <strong>Reject</strong> on a pending return.</Step>
        <Step n={2}>A modal asks for a <strong>rejection reason</strong>. This is <em>required</em> and will be shown to the customer.</Step>
        <Step n={3}>Pick from presets ("Outside return window", "Evidence insufficient", "Product not eligible", "Customer abuse") or type a custom reason.</Step>
        <Step n={4}>Click <strong>Confirm rejection</strong>.</Step>
        <Step n={5}>The customer sees the reason when they track the return in the portal.</Step>

        <Warning title="Rejections are terminal">
          Once rejected, a return cannot be re-opened — create a new return if the situation changes.
          Use rejection sparingly; requesting more information via customer notes is often better.
        </Warning>

        <div style={h3}>Bulk actions</div>
        <p style={p}>
          For high-volume stores, use bulk actions on the Returns list. Select multiple rows via the
          header checkbox, then pick an action from the bulk action bar.
        </p>
        <ul style={ul}>
          <li><strong>Bulk approve</strong> — approve every selected return. Fynd sync runs per row.</li>
          <li><strong>Bulk reject</strong> — a single reason applies to all selected returns.</li>
          <li><strong>Bulk sync to Fynd</strong> — only for approved returns that haven't synced yet.</li>
          <li><strong>Bulk export</strong> — CSV of just the selection.</li>
        </ul>

        <div style={h3}>Common operational workflows</div>
        <Faq q="Morning triage — triaging overnight returns">
          1) Open <NavLink to="/app/returns?status=pending">Returns → Pending</NavLink>.<br/>
          2) Sort by oldest first.<br/>
          3) Use bulk-approve for any that auto-rules missed but clearly pass policy.<br/>
          4) Hand-review anything with a fraud-risk flag or missing photos.<br/>
          5) Reject outside-window or policy violations with a preset reason.
        </Faq>
        <Faq q="Weekly review — returns ageing in processing">
          The <strong>Overdue returns</strong> KPI on the dashboard surfaces anything stuck in
          <em>pending</em> or <em>processing</em> &gt; 3 days. Click it to see the list. For each,
          check the Fynd panel — usually it's waiting on courier assignment or customer drop-off.
        </Faq>
        <Faq q="Reconciliation — matching Shopify refunds to Fynd credit notes">
          Filter <NavLink to="/app/returns?refundStatus=refunded">Returns → Refunded</NavLink> by date,
          export CSV, and match on <code style={code}>fyndShipmentId</code> and
          <code style={code}>refundAmount</code>. All refund timestamps and amounts are on the row.
        </Faq>
      </>
    ),
  },

  /* ────────────────── 5. PROCESSING REFUNDS ────────────────── */
  {
    id: "refunds",
    title: "Processing Refunds",
    subtitle: "Issue refunds correctly, restock inventory, stay reconciled",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
    content: (
      <>
        <p style={p}>
          Refunds go back to the customer's <strong>original payment method</strong> through Shopify's
          Admin API — never through a manual bank transfer. This keeps reconciliation easy and
          ensures Shopify Payments / Stripe / PayPal see the refund correctly.
        </p>

        <Highlights
          items={[
            { title: "Manual refund", description: "You click 'Process refund' from the detail page — full control." },
            { title: "Auto-refund", description: "Toggle on: Fynd credit-note webhook triggers the Shopify refund." },
            { title: "Partial refunds", description: "Refund amount is computed from the actual returned items — handles partial qty." },
            { title: "Restock automation", description: "Inventory returns to the original fulfillment location by default." },
            { title: "Restock fees", description: "Set a flat fee or % to deduct from the refund before processing." },
            { title: "Reconciliation-ready", description: "Amount, currency, method, and timestamp are logged on the return row." },
          ]}
        />

        <div style={h3}>Manual refund from the admin</div>
        <Step n={1}>Open a return in <em>approved</em> status.</Step>
        <Step n={2}>Click <strong>Process refund in Shopify</strong>.</Step>
        <Step n={3}>The refund modal appears, showing:
          <ul style={{ ...ul, marginTop: 6, marginBottom: 0 }}>
            <li>Refund amount — computed from returned line items (with optional restock fee applied).</li>
            <li>Restock location — the order's fulfillment location is pre-selected.</li>
            <li>A note field for the refund reason (shown in Shopify's order timeline).</li>
          </ul>
        </Step>
        <Step n={4}>If you're in <strong>manual location mode</strong>, pick a location from the dropdown.</Step>
        <Step n={5}>Click <strong>Yes, process refund</strong>. The app calls Shopify's <code style={code}>refundCreate</code> mutation.</Step>
        <Step n={6}>On success: return status flips to <em>completed</em>; <code style={code}>refundStatus = "refunded"</code>; a <code style={code}>refund_processed</code> event is logged with amount &amp; method.</Step>

        <Warning title="Once issued, a Shopify refund can't be undone here">
          If you need to reverse a refund, you have to do it directly in Shopify's order page.
          Make sure the amount and restock location are right before clicking confirm.
        </Warning>

        <div style={h3}>Automatic refund via Fynd credit note</div>
        <p style={p}>
          When Fynd finishes QC and issues a credit note, the app can automatically create the Shopify
          refund. This eliminates a manual step for every return.
        </p>
        <Step n={1}>Go to <NavLink to="/app/settings/return-settings">Settings → Return Settings</NavLink>.</Step>
        <Step n={2}>Under <strong>Auto-Refund on Credit Note</strong>, select <strong>Yes</strong>.</Step>
        <Step n={3}>Save. From now on, every <code style={code}>credit_note_generated</code> (or <code style={code}>refund_done</code>) webhook from Fynd will trigger a Shopify refund.</Step>

        <div style={h4}>What happens behind the scenes</div>
        <ol style={ul}>
          <li>Fynd POSTs the webhook to <code style={code}>/api/webhooks/fynd/$shopId</code>.</li>
          <li>The app looks up the return by Fynd Shipment ID.</li>
          <li>It determines the restock location (automatic = fulfillment location; manual = the setting fallback).</li>
          <li>It calls Shopify's <code style={code}>refundCreate</code> with the credit-note amount.</li>
          <li>It marks the return as <em>completed</em> and writes a <code style={code}>fynd_webhook</code> + <code style={code}>refund_processed</code> event pair.</li>
          <li>If SMTP is configured, it emails the customer the refund confirmation.</li>
        </ol>

        <Tip title="Auto-refund won't fire if…">
          — Fynd Shipment ID isn't linked to the return (sync failed).<br/>
          — Return status isn't <em>approved</em> or <em>completed</em>.<br/>
          — Refund is already <em>refunded</em> (idempotency protection).<br/>
          — The credit-note amount is zero or missing.
        </Tip>

        <div style={h3}>Restock location modes</div>
        <FieldRow
          label="Automatic"
          required
          description={<>Uses the order's <strong>original fulfillment location</strong>. This is what you want 95% of the time — inventory goes back where it shipped from. Falls back to your default location if unavailable.</>}
        />
        <FieldRow
          label="Manual"
          description={<>You pick a location every time. A location dropdown appears in the refund modal. Useful if you have a dedicated returns-processing warehouse separate from outbound.</>}
        />
        <FieldRow
          label="Default fallback"
          description={<>In automatic mode: used when fulfillment location can't be determined. In manual mode: pre-selected in the dropdown.</>}
        />

        <Danger title="Shopify REQUIRES a location for restocking">
          If neither automatic nor manual finds a location, the refund fails with
          <em>"You need to set a location to restock items"</em>. Always set a default fallback.
        </Danger>

        <div style={h3}>Restock fees</div>
        <p style={p}>
          Set a flat restocking fee in <NavLink to="/app/settings/return-settings">Return Settings</NavLink>
          (currency-specific, e.g. $5 or ₹50). The fee is <strong>deducted from the refund amount</strong>
          before it's sent to Shopify. Restock fees are recorded separately for reporting.
        </p>

        <div style={h3}>Refund methods reference</div>
        <FieldRow label="Original source" description="Refund to the same method the customer paid with (card, PayPal, Shopify Pay)." defaultValue="Default" />
        <FieldRow label="Store credit" description="Create a store-credit code instead of refunding cash. See Chapter 'Exchanges &amp; Store Credit'." />
        <FieldRow label="Bank details" description="For COD orders — marks the refund as pending manual bank transfer (not processed by Shopify)." />
        <FieldRow label="Exchange" description="No cash refund; a replacement order is created. See Chapter 'Exchanges &amp; Store Credit'." />

        <div style={h3}>Common refund issues</div>
        <Faq q="Refund button says 'No refundable amount'">
          Either the order has been fully refunded already, or the line items in the return don't
          have a refundable price (rare — check <code style={code}>ri.price</code> on the items).
        </Faq>
        <Faq q="Shopify returns 'Cannot refund more than paid'">
          The computed refund amount exceeds the net payable. Usually caused by a restock fee being
          negative, discount codes, or refunds on already-refunded items. Check the Shopify order's
          refund history.
        </Faq>
        <Faq q="Auto-refund didn't fire even though the credit note was generated">
          Open <NavLink to="/app/settings/webhook-logs">Settings → Webhook Logs</NavLink>.
          Filter by the return's Fynd Shipment ID. You'll see the delivery attempt, response, and
          any error. The return's own event timeline also shows a <code style={code}>fynd_webhook</code>
          entry with the payload.
        </Faq>
      </>
    ),
  },

  /* ────────────────── 6. FYND INTEGRATION ────────────────── */
  {
    id: "fynd",
    title: "Connecting Fynd",
    subtitle: "Reverse logistics, AWB tracking, and credit-note automation",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
    content: (
      <>
        <p style={p}>
          Fynd handles the <strong>physical logistics</strong> of returns — scheduling pickups,
          assigning couriers, tracking shipments, and issuing credit notes after warehouse QC.
          Connecting Fynd is optional, but highly recommended for any store that does more than a
          handful of returns per week.
        </p>

        <Highlights
          items={[
            { title: "Automatic pickup", description: "On approval, the app creates the return on Fynd and schedules pickup at the customer's address." },
            { title: "AWB tracking", description: "Courier AWBs appear in both admin and portal with real-time status." },
            { title: "Warehouse QC", description: "Fynd's team inspects the item. Pass → credit note; fail → customer dispute flow." },
            { title: "Credit-note webhooks", description: "Fires to your app; auto-refund toggles whether Shopify refunds instantly." },
            { title: "UAT sandbox", description: "Test the full flow without touching production orders." },
            { title: "Self-ship orders", description: "Support for self-ship returns with forward AWB tracking." },
          ]}
        />

        <div style={h3}>What you'll need from Fynd</div>
        <FieldRow label="Company ID" required description="Numeric — found in Fynd Partners → Company settings. Identifies your tenant." />
        <FieldRow label="Application ID" required description="Your sales channel / application. Found in Company → Settings → Developers → Applications." />
        <FieldRow label="Client ID" required description="From your Platform-API OAuth app in Fynd Partners. Do NOT use Storefront credentials." />
        <FieldRow label="Client Secret" required description="Paired secret for the Client ID. Stored encrypted in this app." />

        <Warning title="Platform API credentials only">
          Fynd has two API sets: <strong>Storefront</strong> (for customer-facing web apps) and
          <strong> Platform</strong> (for back-office integrations). This app uses <strong>Platform API</strong>.
          Make sure your OAuth app has scopes: <code style={code}>company/orders/read</code>,
          <code style={code}> company/orders/write</code>, <code style={code}>company/settings</code>.
        </Warning>

        <div style={h3}>Step-by-step setup</div>
        <Step n={1}>Go to <NavLink to="/app/settings/integrations">Settings → Partner Integrations</NavLink>.</Step>
        <Step n={2}>Pick the environment: <strong>UAT</strong> for testing or <strong>Production</strong> for live orders.</Step>
        <Step n={3}>Enter Company ID, Application ID, Client ID, and Client Secret.</Step>
        <Step n={4}>Click <strong>Save</strong>.</Step>
        <Step n={5}>Click <strong>Test Platform</strong>. You should see <em>"Platform API connection successful"</em>.</Step>

        <div style={h3}>Webhook registration</div>
        <p style={p}>
          Webhooks are how Fynd notifies <em>your</em> app when a return's status changes at their
          end (pickup scheduled, in transit, delivered to warehouse, credit note generated…).
          Without webhooks you'd have to poll — which is slow and wastes API calls.
        </p>
        <Step n={1}>Go to <NavLink to="/app/settings/setup">Settings → Fynd Setup Guide</NavLink>.</Step>
        <Step n={2}>Navigate to <strong>Step 3: Webhook setup</strong>.</Step>
        <Step n={3}>Your webhook URL is <code style={code}>https://YOUR_APP_URL/api/webhooks/fynd/$shopId</code>.</Step>
        <Step n={4}>Click <strong>Register webhook via Fynd API</strong> to auto-register it.</Step>
        <Step n={5}>Alternatively, add the URL manually in <a href="https://partners.fynd.com" target="_blank" rel="noopener noreferrer" style={{ color: accent, fontWeight: 600, textDecoration: "none" }}>Fynd Partners</a> → Webhooks.</Step>
        <Step n={6}>Go to Step 4 and click <strong>Test webhook</strong> to verify the endpoint.</Step>

        <Tip title="Shop-scoped endpoint">
          The <code style={code}>$shopId</code> in the URL path lets the same app serve multiple shops.
          Each shop registers its own webhook — no cross-tenant leakage.
        </Tip>

        <div style={h3}>End-to-end flow</div>
        <Step n={1}><strong>Customer submits</strong> — via your portal.</Step>
        <Step n={2}><strong>You approve</strong> — app calls Fynd's <code style={code}>createReturn</code> endpoint with items, reason, and pickup address.</Step>
        <Step n={3}><strong>Fynd schedules pickup</strong> — courier is assigned; a return AWB is generated.</Step>
        <Step n={4}><strong>Shipment in transit</strong> — webhook fires with each status update (<em>picked_up, in_transit, delivered_to_warehouse</em>).</Step>
        <Step n={5}><strong>Warehouse QC</strong> — item is inspected. If passed, Fynd issues a credit note.</Step>
        <Step n={6}><strong>Credit note webhook</strong> — fires to your app.</Step>
        <Step n={7}><strong>Shopify refund</strong> — if auto-refund is on, the app creates the refund; otherwise you click a button.</Step>

        <div style={h3}>Fynd status → app action mapping</div>
        <FieldRow label="submitted / pending_pickup" description="Return created on Fynd. Waiting for courier assignment." />
        <FieldRow label="pickup_scheduled" description="Courier assigned. Return AWB populated. Customer informed." />
        <FieldRow label="picked_up" description="Courier has collected the item. Tracking is live." />
        <FieldRow label="in_transit" description="Shipment is moving. Webhook includes current location updates." />
        <FieldRow label="delivered_to_warehouse" description="Item received at Fynd warehouse. QC queue." />
        <FieldRow label="qc_passed / credit_note_generated" description={<>Fynd has approved. <strong>Auto-refund fires if enabled.</strong></>} />
        <FieldRow label="qc_failed" description="Item rejected at warehouse. Return goes into dispute flow — admin needs to contact customer." />
        <FieldRow label="refund_initiated / UNDER_PROCESS" description="Refund is being processed at Fynd's end." />
        <FieldRow label="refund_done / refunded" description={<>Terminal. App marks return <em>completed</em> and the Shopify refund is created.</>} />

        <div style={h3}>Self-ship returns</div>
        <p style={p}>
          Some customers prefer to drop the item at a courier themselves (especially for high-value
          items where they trust the courier less than their own handling). The app supports this:
        </p>
        <ul style={ul}>
          <li>On approval, instead of scheduling a pickup, the app generates a <strong>forward AWB</strong> that the customer prints and attaches.</li>
          <li>The customer drops at a courier hub within a configurable number of days.</li>
          <li>The AWB scan at drop-off triggers the normal in-transit flow.</li>
        </ul>
        <p style={p}>
          Enable self-ship in <NavLink to="/app/settings/return-settings">Return Settings → Self-ship</NavLink>.
          You can make it the default or an opt-in choice the customer sees at submission time.
        </p>

        <div style={h3}>UAT vs Production</div>
        <DoDont
          doo={[
            "Start in UAT with a disposable Shopify dev store and a disposable Fynd sandbox account.",
            "Submit 2–3 test returns end-to-end (submit → approve → sync → credit-note webhook → refund).",
            "Verify the webhook is landing and the event timeline is populated.",
            "Switch to Production only after a clean UAT run.",
          ]}
          dont={[
            "Don't mix UAT and Prod credentials — the environment selector must match the credentials.",
            "Don't skip the Test Platform button after switching environments.",
            "Don't re-use UAT Fynd IDs when testing in Production — they won't exist.",
          ]}
        />
      </>
    ),
  },

  /* ────────────────── 7. EXCHANGES & STORE CREDIT ────────────────── */
  {
    id: "exchanges",
    title: "Exchanges & Store Credit",
    subtitle: "Keep the revenue instead of refunding it",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>,
    content: (
      <>
        <p style={p}>
          Every refund is revenue walking out the door. Offering <strong>exchanges</strong> or
          <strong> store credit</strong> as resolution options keeps the revenue inside your store.
          The <em>Revenue Retained</em> KPI on the dashboard tracks exactly how much you've saved
          this way.
        </p>

        <Highlights
          items={[
            { title: "Exchange", description: "Customer picks a different item (size, color, or entirely different product)." },
            { title: "Store credit", description: "A one-time code issued via Shopify discount API that the customer can redeem at checkout." },
            { title: "Replacement", description: "Same item re-shipped — for damaged or lost packages where the customer still wants the original." },
            { title: "Refund", description: "Cash back to original payment method — the fall-back option." },
          ]}
        />

        <div style={h3}>How a customer chooses a resolution</div>
        <p style={p}>
          At submission time, if resolutions are enabled, the portal shows a choice screen:
          <em> "How would you like to resolve this return?"</em> with tiles for Refund, Exchange,
          Store credit, and Replacement (depending on what you've enabled).
        </p>
        <ul style={ul}>
          <li><strong>Refund</strong> — no follow-up questions; standard flow.</li>
          <li><strong>Exchange</strong> — customer picks the replacement variant (or product) from a searchable list.</li>
          <li><strong>Store credit</strong> — no further action; the credit is issued when you approve.</li>
          <li><strong>Replacement</strong> — exactly the same SKU is re-shipped; inventory is reserved at approval.</li>
        </ul>

        <div style={h3}>Configuring resolutions</div>
        <Step n={1}>Go to <NavLink to="/app/settings/return-settings">Settings → Return Settings</NavLink>.</Step>
        <Step n={2}>In the <strong>Resolution types</strong> section, tick the ones you want to offer.</Step>
        <Step n={3}>Set the <strong>store credit bonus</strong> (optional) — e.g. "+10% if customer chooses store credit over cash refund" — as an incentive.</Step>
        <Step n={4}>Set the <strong>exchange window</strong> — how long the customer has to pick a replacement before the return auto-converts to a refund.</Step>
        <Step n={5}>Save.</Step>

        <Tip title="Store credit bonus is a proven retention lever">
          Offering a 10% bonus on store credit over cash refund converts a significant share of
          refund-preferers into credit-takers. The Revenue Retained KPI surfaces the impact.
        </Tip>

        <div style={h3}>Exchange flow details</div>
        <Step n={1}>Customer selects "Exchange" as resolution.</Step>
        <Step n={2}>Portal shows a variant picker — size/color of the same product by default, or a <em>"Browse other products"</em> link if enabled.</Step>
        <Step n={3}>Customer confirms the replacement. The return now has <code style={code}>resolutionType = "exchange"</code> and a <code style={code}>replacementVariantId</code>.</Step>
        <Step n={4}>On approval, the app creates a <strong>draft order</strong> in Shopify for the replacement at $0 (covered by the return).</Step>
        <Step n={5}>Once Fynd receives and QCs the original, the draft is converted to a real order and shipped.</Step>

        <div style={h3}>Store credit flow details</div>
        <Step n={1}>Customer picks "Store credit".</Step>
        <Step n={2}>On approval, the app calls Shopify's <code style={code}>discountCodeBasicCreate</code> with a unique code and the refund amount (plus any bonus).</Step>
        <Step n={3}>The code is stored on the return and emailed to the customer.</Step>
        <Step n={4}>Customer applies the code at checkout next time they shop.</Step>

        <Warning title="Store credit codes are one-time use">
          The app generates single-use codes by default. If you want re-usable credit across multiple
          purchases, use Shopify's native gift card product — but that's a bigger integration change.
        </Warning>

        <div style={h3}>Replacement flow details</div>
        <p style={p}>
          Replacement is a <em>like-for-like</em> resend. The app reserves inventory at approval
          time and creates a fulfillment record tied to the return. Useful for:
        </p>
        <ul style={ul}>
          <li>Damaged-in-transit items where the customer still wants the original.</li>
          <li>Lost parcels (shipment never arrived).</li>
          <li>Defective items where you'll QC the returned one at your warehouse.</li>
        </ul>

        <div style={h3}>Reporting on resolutions</div>
        <p style={p}>
          The <NavLink to="/app/reports">Analytics page</NavLink> has a <strong>Resolution breakdown</strong>
          donut showing the split between refund / exchange / store credit / replacement. Next to it
          is a <strong>Revenue retained</strong> card that sums the amounts that <em>didn't</em>
          walk out as cash refunds. This is the single most important retention KPI.
        </p>
      </>
    ),
  },

  /* ────────────────── 8. AUTOMATION & RULES ────────────────── */
  {
    id: "automation",
    title: "Automation & Rules",
    subtitle: "Auto-approve, auto-refund, blocklist, and fraud scoring",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
    content: (
      <>
        <p style={p}>
          Manual review doesn't scale past a few dozen returns a day. The app has four automation
          layers that handle the boring cases so your team only touches exceptions.
        </p>

        <Highlights
          items={[
            { title: "Auto-approve", description: "Every matching return is approved instantly with no human review." },
            { title: "Auto-reject rules", description: "Returns matching blocklist / outside window / restricted region are rejected." },
            { title: "Fraud scoring", description: "Risk score per return; high / critical returns flagged for manual review." },
            { title: "Auto-refund on credit note", description: "Fynd credit-note webhook → Shopify refund, no admin click required." },
            { title: "Scheduled reports", description: "Daily / weekly / monthly email digests to stakeholders." },
            { title: "Notification events", description: "Email on new-return, approval, rejection, refund; sound alerts in admin." },
          ]}
        />

        <div style={h3}>Auto-approve</div>
        <p style={p}>
          Toggle <strong>auto-approve</strong> in <NavLink to="/app/settings/return-settings">Return Settings</NavLink>.
          When enabled, every newly-submitted return is immediately approved (and synced to Fynd if
          configured). Use with fraud scoring to catch abusive patterns.
        </p>
        <DoDont
          doo={[
            "Use with a conservative return window (30 days or less).",
            "Use with fraud scoring enabled and blocklist active.",
            "Require photo uploads to create friction for frivolous returns.",
            "Monitor the Rejection rate KPI weekly — a spike means rules need tightening.",
          ]}
          dont={[
            "Don't enable auto-approve without some friction (photos, reason enforcement).",
            "Don't combine auto-approve with an aggressive store-credit bonus — abuse risk.",
            "Don't skip weekly fraud KPI review if auto-approve is on.",
          ]}
        />

        <div style={h3}>Policy rules (auto-reject)</div>
        <p style={p}>
          These rules run <em>before</em> auto-approve and can block a return even when auto-approve
          is on. Configure in <NavLink to="/app/settings/rules">Settings → Policy Rules</NavLink>.
        </p>
        <FieldRow label="Return window" description="Hard rejection if order delivery date + window &lt; today." />
        <FieldRow label="Minimum price" description="Rejects if the item's price is below this threshold." />
        <FieldRow label="Restricted regions" description="Rejects if the shipping address is in a blocked country." />
        <FieldRow label="Restricted tags" description="Rejects if any of the product's Shopify tags match the excluded list (e.g. 'final-sale')." />
        <FieldRow label="Blocklist" description="Rejects if the customer email, phone, or IP is on the blocklist." />
        <FieldRow label="No-return period" description="Blocks all returns during specific date ranges (e.g. Black Friday week)." />

        <div style={h3}>Blocklist management</div>
        <p style={p}>
          The blocklist stops known bad actors from even starting a return. Managed from
          <NavLink to="/app/settings/blocklist"> Settings → Blocklist</NavLink>.
        </p>
        <ul style={ul}>
          <li>Add an <strong>email</strong>, <strong>phone</strong>, or <strong>IP</strong> with a reason.</li>
          <li>Entries have a "reason" and an "added by" actor for audit.</li>
          <li>Blocked attempts are counted and surfaced in the dashboard's <em>Blocked attempts</em> KPI.</li>
          <li>Temporary blocks — set an expiry date for time-boxed bans.</li>
        </ul>

        <Warning title="Blocklist != rejection history">
          Rejecting a return doesn't auto-add the customer to the blocklist. Blocklist is an explicit
          decision. Use when you have evidence of abuse (multiple rejected returns, wardrobing, etc.).
        </Warning>

        <div style={h3}>Fraud scoring</div>
        <p style={p}>
          Every return is scored on a <strong>0–100</strong> scale. The score is based on signals like:
        </p>
        <ul style={ul}>
          <li>Customer return history (frequency, return rate vs. purchase rate).</li>
          <li>Return value vs. customer LTV.</li>
          <li>Time from delivery to return request (very fast or very slow both raise the score).</li>
          <li>IP / device reputation (shared IP with blocked accounts, mismatched location).</li>
          <li>Reason code (generic "changed my mind" scores higher than "damaged with photos").</li>
          <li>Photo evidence quality (present, absent, or flagged by simple heuristics).</li>
        </ul>
        <p style={p}>Returns are bucketed into <strong>risk levels</strong>:</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <StatusPill color="#10B981">low (0–24)</StatusPill>
          <StatusPill color="#F59E0B">medium (25–49)</StatusPill>
          <StatusPill color="#F97316">high (50–74)</StatusPill>
          <StatusPill color="#DC2626">critical (75–100)</StatusPill>
        </div>
        <p style={p}>
          <strong>High</strong> and <strong>critical</strong> returns are surfaced on the dashboard's
          Fraud Alerts widget. They're always excluded from auto-approve (even if the toggle is on)
          and highlighted in the returns list.
        </p>

        <div style={h3}>Auto-rules (custom)</div>
        <p style={p}>
          Beyond the built-in rules, you can write custom auto-rules in
          <NavLink to="/app/settings/auto-rules"> Settings → Auto-rules</NavLink>. Each rule has:
        </p>
        <FieldRow label="Trigger" description="When the rule evaluates: on-submit, on-approval, on-refund, or on-webhook." />
        <FieldRow label="Condition" description={<>A simple boolean expression over return fields. Example: <code style={code}>reasonCode == "damaged" &amp;&amp; fraudRiskLevel != "critical"</code>.</>} />
        <FieldRow label="Action" description="auto_approve · auto_reject (with reason) · notify_admin · add_tag · force_manual_review · sync_to_fynd." />
        <FieldRow label="Priority" description="Rules run in priority order. First match wins unless the action is non-terminal (like add_tag)." />

        <Tip title="Recipe: auto-approve damaged photos">
          Trigger: on-submit<br/>
          Condition: <code style={code}>reasonCode == "damaged" &amp;&amp; photoCount &gt;= 2 &amp;&amp; fraudRiskLevel in ["low","medium"]</code><br/>
          Action: <code style={code}>auto_approve</code><br/>
          Result: damaged-item claims with 2+ photos and low risk are approved instantly; everything else goes to manual review.
        </Tip>

        <div style={h3}>Channel policies</div>
        <p style={p}>
          If orders come from multiple sales channels (online store, POS, wholesale, Fynd OMS), you
          may want per-channel return policies. Configure in
          <NavLink to="/app/settings/channel-policies"> Settings → Channel policies</NavLink>.
          Each channel can override: return window, auto-approve, excluded tags, and refund methods.
        </p>

        <div style={h3}>Product-specific policies</div>
        <p style={p}>
          Even finer-grained control: override policies per product or product-type via
          <NavLink to="/app/settings/product-policies"> Settings → Product policies</NavLink>.
          Example: a custom-printed t-shirt with a 7-day window instead of the default 30.
        </p>
      </>
    ),
  },

  /* ────────────────── 9. NOTIFICATIONS ────────────────── */
  {
    id: "notifications",
    title: "Notifications",
    subtitle: "Email, SMS, sound, and scheduled reports",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
    content: (
      <>
        <p style={p}>
          Customers get email updates at each return milestone. Your team gets admin alerts for new
          submissions. Both channels are configurable and use your own SMTP so emails come from
          your domain.
        </p>

        <div style={h3}>SMTP setup</div>
        <Step n={1}>Go to <NavLink to="/app/settings/notifications">Settings → Notifications</NavLink>.</Step>
        <Step n={2}>Enter SMTP <strong>host</strong>, <strong>port</strong> (usually 587 for TLS or 465 for SSL), <strong>username</strong>, and <strong>password</strong>.</Step>
        <Step n={3}>Set the <strong>From address</strong> (e.g. <code style={code}>returns@your-store.com</code>) and <strong>reply-to</strong>.</Step>
        <Step n={4}>Click <strong>Test connection</strong>. A test email is sent to your admin account.</Step>
        <Step n={5}>Save.</Step>

        <Tip title="Recommended SMTP providers">
          SendGrid, AWS SES, Postmark, and Mailgun are reliable and cheap. Gmail works for dev but
          has low daily limits. Always verify your sending domain (SPF, DKIM, DMARC) for good
          deliverability.
        </Tip>

        <div style={h3}>Customer notification events</div>
        <FieldRow label="Return submitted" description="Confirmation to the customer with the Return Request ID and next steps." />
        <FieldRow label="Return approved" description="Tells them the return was approved; if synced to Fynd, includes the pickup date and AWB." />
        <FieldRow label="Return rejected" description="Includes the rejection reason you entered, so the customer knows why." />
        <FieldRow label="Pickup scheduled" description="Courier name, pickup date, and instructions." />
        <FieldRow label="In transit" description="Tracking link for the return shipment." />
        <FieldRow label="Received at warehouse" description="Confirms the item arrived at Fynd's warehouse." />
        <FieldRow label="Refund processed" description="Includes the refund amount, method, and expected bank posting time." />
        <FieldRow label="Store credit issued" description="Includes the credit code and expiry." />
        <FieldRow label="Exchange shipped" description="Tracking for the replacement shipment." />

        <div style={h3}>Admin notification events</div>
        <FieldRow label="New return request" description="To admins when a customer submits. Respects the 'quiet hours' setting." />
        <FieldRow label="Fraud alert" description="When a return scores high or critical." />
        <FieldRow label="Fynd sync failure" description="When a sync to Fynd fails more than N times (default 3)." />
        <FieldRow label="Webhook delivery failure" description="When an outgoing webhook to your own endpoints keeps failing." />

        <div style={h3}>Sound alerts</div>
        <p style={p}>
          Enable <strong>Sound alerts</strong> in notification settings to play a chime whenever a
          new return arrives while the admin is open. Great for ops teams with the app on a wall
          dashboard. Chime volume and tone are configurable.
        </p>

        <div style={h3}>Scheduled reports</div>
        <p style={p}>
          Get a summary email on a schedule without having to open the app:
        </p>
        <FieldRow label="Daily digest" description="Previous-day counts, trends, and the top-5 returns needing attention." />
        <FieldRow label="Weekly digest" description="7-day KPI snapshot, trend chart, top reasons, revenue retained." />
        <FieldRow label="Monthly digest" description="Month-over-month comparison, fraud summary, and a CSV attachment." />
        <FieldRow label="Recipients" description="Multiple addresses, with per-recipient digest selection." />

        <Success title="Webhooks > email for real-time integrations">
          If you need sub-second automation (Slack ping, create Zendesk ticket), use outgoing
          webhooks (Chapter: Webhook reference) instead of parsing emails.
        </Success>
      </>
    ),
  },

  /* ────────────────── 10. DASHBOARD & ANALYTICS ────────────────── */
  {
    id: "analytics",
    title: "Dashboard & Analytics",
    subtitle: "Every KPI explained, with formulas and business meaning",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    content: (
      <>
        <p style={p}>
          The <NavLink to="/app">Dashboard</NavLink> is your operational home. The
          <NavLink to="/app/reports"> Analytics page</NavLink> is the deep-dive. Every metric here
          is computed live from the data — nothing is cached beyond a few seconds.
        </p>

        <div style={h3}>Dashboard — Hero KPIs</div>
        <FieldRow label="Total returns" description={<>Count of returns created in the selected range. Includes a period-over-period arrow showing % change vs. the previous equal-length window.</>} />
        <FieldRow label="Needs review" description="Returns in status=pending awaiting admin action. Click the card to jump to the filtered list." />
        <FieldRow label="Approved" description={<>Count of approved + completed. Shows the approval rate as a sub-metric.</>} />
        <FieldRow label="Refunded" description={<>Count of returns with refundStatus=refunded. <em>all-time</em> count shown below for context.</>} />

        <div style={h3}>Dashboard — Secondary stats</div>
        <FieldRow label="Revenue retained" description={<>Sum of exchange + store-credit refund amounts. <strong>Formula:</strong> <code style={code}>Σ refundJson.amount WHERE resolutionType IN (exchange, store_credit)</code>.</>} />
        <FieldRow label="Revenue at risk" description={<>Sum of price × qty of items on open returns (last 30 days). <strong>Formula:</strong> <code style={code}>Σ(price × qty) WHERE status IN (initiated, pending)</code>.</>} />
        <FieldRow label="Avg refund" description={<>Average refund amount across <em>contributors only</em> — excludes rows with null or zero refund amounts. Prevents division-by-inflated-N.</>} />
        <FieldRow label="Refund rate" description={<><code style={code}>refunded / approved</code>. High = low retention; pair with Exchange rate to see where revenue is retained.</>} />
        <FieldRow label="Exchange rate" description={<><code style={code}>exchanges / total resolved</code>. Higher is better for revenue retention.</>} />
        <FieldRow label="Green returns" description={<>Count of returns flagged <code style={code}>isGreenReturn=true</code> (customer kept the item; no physical return).</>} />
        <FieldRow label="Blocked attempts" description="Count of blocklist entries — proxy for abuse prevention." />
        <FieldRow label="Overdue returns" description={<>Count of returns in pending/processing &gt; 3 days. Operational urgency signal.</>} />

        <div style={h3}>Dashboard — Highlight strip</div>
        <p style={p}>
          A single-row info strip shows the top 2 return reasons, approval rate, and fraud alert
          count — a quick-look for the morning huddle. The strip fills the row so there's never
          empty space.
        </p>

        <div style={h3}>Return trend chart</div>
        <p style={p}>
          Daily return volume over the selected range. Area chart with a subtle gradient. Dots
          appear when there are fewer than 15 data points. Clickthrough takes you to the full
          Analytics page.
        </p>

        <div style={h3}>Status breakdown</div>
        <p style={p}>
          Every status with its count, percentage, and a proportional bar. Click any row to filter
          the Returns list by that status.
        </p>

        <div style={h3}>Analytics page — in depth</div>

        <div style={h4}>Performance rates (donut rings)</div>
        <ul style={ul}>
          <li><strong>Approval rate</strong> = approved / total.</li>
          <li><strong>Rejection rate</strong> = rejected / total.</li>
          <li><strong>Refund rate</strong> = refunded / approved.</li>
          <li><strong>Fynd sync rate</strong> = returns with a Fynd Shipment ID / approved (only shows when Fynd is configured).</li>
        </ul>

        <div style={h4}>Revenue impact</div>
        <ul style={ul}>
          <li><strong>Total refunds issued</strong> — money out, as cash.</li>
          <li><strong>Avg refund amount</strong> — per refund, useful for AOV-adjusted comparisons.</li>
          <li><strong>Revenue retained</strong> — via exchange + store credit.</li>
          <li><strong>Revenue at risk</strong> — open returns, 30-day window.</li>
          <li><strong>Avg time to refund</strong> — submission → refund processed (in days).</li>
        </ul>

        <div style={h4}>Top products by return count</div>
        <p style={p}>
          Horizontal bar chart of the 10 most-returned products. Groups by <code style={code}>title</code>
          when available; falls back to <code style={code}>SKU</code> for items without titles (which
          would otherwise be silently dropped). Investigate the top entry for product-description
          issues or defect patterns.
        </p>

        <div style={h4}>Top customers by return frequency</div>
        <p style={p}>
          Shown only when customers have ≥ 2 returns. High-frequency repeat returners (3+) are
          highlighted in red — these are the candidates for blocklist review.
        </p>

        <div style={h4}>Geographic breakdown</div>
        <p style={p}>
          Returns by country, sorted descending. Useful for spotting regional fulfillment issues
          (e.g. a spike in returns from a single state usually means a carrier problem).
        </p>

        <div style={h4}>Channel attribution</div>
        <p style={p}>
          Splits returns by <em>where the return was created</em> (<code style={code}>createdByChannel</code>:
          portal / admin / api) and by <em>where the original order came from</em>
          (<code style={code}>sourceChannel</code>: web / pos / fynd). Helps you attribute return
          rate per sales channel.
        </p>

        <div style={h4}>Item condition breakdown</div>
        <p style={p}>
          New / used / damaged / defective — distribution across the range. "Damaged" spikes mean
          investigate packaging; "used" spikes mean investigate wardrobing patterns.
        </p>

        <div style={h3}>Date range options</div>
        <FieldRow label="Last 7 days" description="Rolling 7-day window." />
        <FieldRow label="Last 30 days" description="Default. Rolling 30-day window." />
        <FieldRow label="Last 90 days" description="Quarterly view. Useful for seasonality." />
        <FieldRow label="This month" description="Calendar month to date." />
        <FieldRow label="Last month" description="Previous calendar month — fixed." />
        <FieldRow label="This year" description="Calendar year to date." />
        <FieldRow label="Custom" description="Pick any start &amp; end date. Respects the shop's timezone for day boundaries." />

        <Tip title="All date boundaries use merchant timezone">
          If your shop is in IST and you pick "Today", the query uses IST midnight, not server UTC.
          Same for "Last 30 days" — it's 30 merchant-local days, not 30 UTC days.
        </Tip>

        <div style={h3}>Export CSV</div>
        <p style={p}>
          Every list and report page has an Export CSV button. The CSV contains one row per return
          with columns for every field on the row (status, refund status, Fynd IDs, AWBs, customer
          email, amounts, etc.). Items are stringified into a single column as a JSON array for
          programmatic re-parsing.
        </p>
      </>
    ),
  },

  /* ────────────────── 11. SETTINGS REFERENCE ────────────────── */
  {
    id: "settings",
    title: "All Settings Explained",
    subtitle: "Every option, every default, every gotcha",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.32 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
    content: (
      <>
        <p style={p}>
          The settings area has <strong>13 pages</strong>. Here's every one with every field, the
          default, and why it matters.
        </p>

        <div style={h3}>Policy Rules <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Policy Rules</span></div>
        <FieldRow label="Return reasons" description="The list of reasons customers see. Supports search-to-add and drag-to-reorder." />
        <FieldRow label="Category-specific reasons" description="Per Shopify product-type reason sets. Clothing can show fit reasons; electronics defect reasons." />
        <FieldRow label="Restricted regions" description="Country allowlist/blocklist. Orders shipped to blocked regions can't be returned." />
        <FieldRow label="Return window" description="Days post-delivery within which returns are accepted." defaultValue="30" />
        <FieldRow label="Minimum price" description="Items below this price are ineligible. Useful for low-margin accessories." defaultValue="0" />
        <FieldRow label="Return offers" description="Discount codes offered during the return flow to keep customers (e.g., 10% off if you keep it)." />

        <div style={h3}>Return Settings <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Return Settings</span></div>
        <FieldRow label="No-return period" description="Blackout windows — e.g. during BFCM — when no returns are accepted." />
        <FieldRow label="Restrict by product tags" description="Items with matching Shopify tags are ineligible (e.g. 'final-sale')." />
        <FieldRow label="Photo required" description="If Yes, customers must upload at least one photo to submit." defaultValue="No" />
        <FieldRow label="Return fee" description="Flat restocking fee in the configured currency. Deducted from the refund." defaultValue="0" />
        <FieldRow label="Payment methods" description="Which refund methods appear per order type. Prepaid orders usually refund to original source; COD orders use bank transfer." />
        <FieldRow label="Auto-approve" description="All matching returns are approved instantly." defaultValue="No" />
        <FieldRow label="Auto-refund on credit note" description="Fynd credit-note webhook → Shopify refund. Removes the manual click." defaultValue="No" />
        <FieldRow label="Refund restock location" description="Automatic (fulfillment location) or Manual (pick each time)." defaultValue="Automatic" />
        <FieldRow label="Default fallback location" description="Used when automatic can't determine the location, or pre-selected in manual mode." />
        <FieldRow label="Self-ship enabled" description="Generates forward AWBs; customer drops at courier hub." defaultValue="Off" />
        <FieldRow label="Exchange window" description="Days customer has to pick a replacement before the return converts to a refund." defaultValue="14" />
        <FieldRow label="Store credit bonus" description="Extra % on store-credit resolution over cash refund — retention incentive." defaultValue="0" />

        <div style={h3}>Partner Integrations <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Integrations</span></div>
        <FieldRow label="App mode" description="Dev (shows dev banner, allows test data) or Prod (live)." defaultValue="Dev" />
        <FieldRow label="Environment" description="UAT (Fynd sandbox) or Production (Fynd live)." />
        <FieldRow label="Credentials" description="Application ID, Company ID, Client ID, Client Secret — Platform API only." />
        <FieldRow label="Advanced policy" description="Overrides for return window, min order value, restock fee %, exchange toggle, excluded tags, allowed categories." />

        <div style={h3}>Notifications <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Notifications</span></div>
        <FieldRow label="SMTP server" description="Host, port, username, password, From address, Reply-to." />
        <FieldRow label="New return request" description="Notify admin on every new submission." />
        <FieldRow label="Return approved" description="Notify customer on approval." />
        <FieldRow label="Return rejected" description="Notify customer on rejection with your reason." />
        <FieldRow label="Refund processed" description="Notify customer when the refund posts." />
        <FieldRow label="Sound alerts" description="Play a chime in the admin when new returns arrive." />
        <FieldRow label="Scheduled reports" description="Daily / weekly / monthly digest recipients and schedule." />

        <div style={h3}>Permissions <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Permissions</span></div>
        <FieldRow
          label="read_all_orders"
          description={<>Required whenever your return window exceeds 60 days, for historical analytics, for Fynd↔Shopify order matching on legacy orders, and for retroactive policy changes. <strong>Opt-in</strong> per merchant. Privacy: order data never leaves this app; PII deleted within 30 days of <code style={code}>customers/redact</code>; full wipe on <code style={code}>shop/redact</code>.</>}
          defaultValue="Off"
          required
        />
        <FieldRow label="read_product_listings" description="Needed for variant picker in exchange flow." />
        <FieldRow label="write_discounts" description="Needed to issue store credit codes." />

        <div style={h3}>API keys <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → API keys</span></div>
        <FieldRow label="Public key" description="Identifier sent with each request. Safe to include in client-side code." />
        <FieldRow label="Secret key" description="Used to sign requests (HMAC). Never expose client-side." />
        <FieldRow label="Scopes" description="Per-key: returns:read, returns:write, refunds:write, webhooks:*." />
        <FieldRow label="Rotate" description="Generate a new secret; old one invalidates immediately." />
        <FieldRow label="Revoke" description="Permanent. Any integration using this key will stop working." />

        <div style={h3}>Portal Widget <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Portal Widget</span></div>
        <FieldRow label="Primary color" description="Accent for buttons/links." defaultValue="#1F8A4C" />
        <FieldRow label="Background" description="Page background colour." defaultValue="#FFFFFF" />
        <FieldRow label="Card surface" description="Cards/panels background." defaultValue="#FFFFFF" />
        <FieldRow label="Font" description="DM Sans / Inter / System UI / Georgia / Playfair Display." defaultValue="DM Sans" />
        <FieldRow label="Radius" description="Minimal (8) / Rounded (12) / Soft (16) / Pill (24)." defaultValue="Rounded" />
        <FieldRow label="Default tab" description="Order tracking / Return tracking / Create return." defaultValue="Return tracking" />
        <FieldRow label="Section toggles" description="Enable or disable each tab." />

        <div style={h3}>Webhook Logs <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Webhook Logs</span></div>
        <FieldRow label="Incoming webhooks" description="Every Fynd webhook receipt with payload, signature-verification result, and parsing outcome." />
        <FieldRow label="Outgoing webhooks" description="Every outbound delivery to your configured endpoints with response code and retry state." />
        <FieldRow label="Search &amp; filter" description="By action, status, date range, and free-text search in payload." />

        <div style={h3}>Auto-rules <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Auto-rules</span></div>
        <p style={p}>Covered in Chapter <em>Automation &amp; Rules</em>.</p>

        <div style={h3}>Blocklist <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Blocklist</span></div>
        <p style={p}>Covered in Chapter <em>Automation &amp; Rules</em>.</p>

        <div style={h3}>Channel policies <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Channel policies</span></div>
        <FieldRow label="Channel" description="online-store, pos, wholesale, fynd, api, manual" />
        <FieldRow label="Policy overrides" description="Window, auto-approve, excluded tags, refund methods." />

        <div style={h3}>Product policies <span style={{ fontWeight: 400, fontSize: 12, color: muted, marginLeft: 4 }}>Settings → Product policies</span></div>
        <FieldRow label="Product or product-type" description="Match key." />
        <FieldRow label="Override" description="Return window, min price, require photos, excluded variants." />
      </>
    ),
  },

  /* ────────────────── 12. API REFERENCE ────────────────── */
  {
    id: "api",
    title: "REST API Reference",
    subtitle: "Integrate Fynd Returns with your own systems",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    content: (
      <>
        <p style={p}>
          The app exposes a versioned REST API under <code style={code}>/api/v1/external/*</code>.
          Use it to list and act on returns from Zendesk, Gorgias, Slack bots, internal ops tools,
          or anything else.
        </p>

        <div style={h3}>Authentication</div>
        <p style={p}>
          Every request must include two headers: <code style={code}>X-Api-Key</code> and
          <code style={code}> X-Api-Signature</code>.
        </p>
        <ul style={ul}>
          <li><strong>X-Api-Key</strong>: the public key from <NavLink to="/app/settings/api-keys">Settings → API keys</NavLink>.</li>
          <li><strong>X-Api-Signature</strong>: HMAC-SHA256 of the request body (or empty string for GETs) using the secret key, hex-encoded.</li>
        </ul>
        <CodeBlock lang="bash">{`curl -H "X-Api-Key: pk_live_..." \\
     -H "X-Api-Signature: $(echo -n '' | openssl dgst -sha256 -hmac sk_live_... | awk '{print $2}')" \\
     https://your-app.com/api/v1/external/returns`}</CodeBlock>

        <div style={h3}>Endpoints</div>
        <FieldRow label="GET /returns" description="List returns. Supports pageSize, cursor, status, dateFrom, dateTo, resolutionType, fraudRiskLevel." />
        <FieldRow label="GET /returns/:id" description="Return detail including items, events, Fynd IDs, refund info." />
        <FieldRow label="POST /returns/:id/approve" description="Approve a return. Optional body: { adminNote, skipFyndSync: false }." />
        <FieldRow label="POST /returns/:id/reject" description="Reject a return. Required body: { reason }." />
        <FieldRow label="POST /returns/:id/refund" description="Trigger a Shopify refund. Optional: { amount, locationId, reason }." />
        <FieldRow label="GET /settings" description="Read current policy, notification, and widget settings." />
        <FieldRow label="GET /webhooks" description="List configured outbound webhooks." />
        <FieldRow label="POST /webhooks" description="Create an outbound webhook." />
        <FieldRow label="DELETE /webhooks/:id" description="Remove an outbound webhook." />

        <div style={h3}>Response shape</div>
        <CodeBlock lang="json">{`{
  "id": "clxxx0001",
  "returnRequestNo": "RPM-A1B2C3D4",
  "shopifyOrderName": "#1001",
  "status": "approved",
  "refundStatus": "pending",
  "resolutionType": "refund",
  "fyndShipmentId": "16834....",
  "fyndReturnNo": "RET-2026-00123",
  "forwardAwb": "AWB123456",
  "returnAwb": "AWB789012",
  "fraudRiskLevel": "low",
  "fraudRiskScore": 12,
  "currency": "INR",
  "customer": { "email": "...", "phone": "..." },
  "items": [ {"title": "...", "sku": "...", "qty": 1, "price": "1299", "reasonCode": "damaged"} ],
  "events": [ {"type": "approved", "happenedAt": "2026-04-22T10:15:00Z", "actor": "admin:42"} ],
  "createdAt": "2026-04-20T08:00:00Z"
}`}</CodeBlock>

        <div style={h3}>Pagination</div>
        <p style={p}>
          Cursor-based. Include <code style={code}>?cursor=</code> in subsequent requests; the
          response returns <code style={code}>nextCursor</code> until the list is exhausted. Page
          size is capped at 100.
        </p>

        <div style={h3}>Rate limits</div>
        <p style={p}>
          Per key: <strong>60 req/min</strong> sustained, burst up to 120. Soft-limit returns HTTP
          429 with <code style={code}>Retry-After</code> header. List endpoints are cached for 2 s
          per identical query.
        </p>

        <div style={h3}>Errors</div>
        <FieldRow label="400 Bad Request" description="Malformed body or invalid filter. Error detail in JSON body." />
        <FieldRow label="401 Unauthorized" description="Missing/invalid X-Api-Key or signature." />
        <FieldRow label="403 Forbidden" description="Key is valid but lacks the required scope." />
        <FieldRow label="404 Not Found" description="Return ID doesn't exist or belongs to a different shop." />
        <FieldRow label="409 Conflict" description="Action not allowed in current state (e.g. approving an already-approved return)." />
        <FieldRow label="429 Too Many Requests" description="Rate limited. Back off and respect Retry-After." />
        <FieldRow label="5xx Server Error" description="Retry with exponential backoff. Durable actions (approve, refund) are idempotent on request ID." />

        <div style={h3}>Postman collection</div>
        <p style={p}>
          A ready-to-import Postman collection is available at <NavLink to="/app/api-docs">API Docs</NavLink>.
          It ships with environment variables for key, secret, and base URL.
        </p>
      </>
    ),
  },

  /* ────────────────── 13. WEBHOOKS ────────────────── */
  {
    id: "webhooks",
    title: "Webhooks Reference",
    subtitle: "Incoming (from Fynd) and outgoing (to your systems)",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7 0-.24-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>,
    content: (
      <>
        <p style={p}>
          The app has <strong>two webhook surfaces</strong>: inbound (Fynd → your app) and outbound
          (your app → your own systems like Slack, Zapier, Gorgias).
        </p>

        <div style={h3}>Inbound: Fynd → your app</div>
        <FieldRow label="Endpoint" description={<><code style={code}>POST /api/webhooks/fynd/:shopId</code></>} />
        <FieldRow label="Signature" description={<>Fynd signs payloads; the app verifies using the Client Secret. Invalid signatures are logged and rejected with 401.</>} />
        <FieldRow label="Retry" description="Fynd retries with exponential backoff for 24 h if the app returns 5xx. All attempts are logged in Webhook Logs." />
        <FieldRow label="Idempotency" description="Each webhook has a delivery ID; replays are detected and ignored." />

        <div style={h4}>Events supported</div>
        <FieldRow label="return.pickup_scheduled" description="Courier assigned; return AWB generated." />
        <FieldRow label="return.picked_up" description="Courier collected the item." />
        <FieldRow label="return.in_transit" description="Shipment location updates." />
        <FieldRow label="return.delivered_to_warehouse" description="Received at Fynd warehouse." />
        <FieldRow label="return.qc_passed" description="QC passed — next step is credit note." />
        <FieldRow label="return.qc_failed" description="QC failed — return goes into dispute." />
        <FieldRow label="credit_note_generated" description="Credit note issued; triggers auto-refund if enabled." />
        <FieldRow label="refund_done" description="Refund confirmed complete at Fynd's end." />

        <div style={h3}>Outbound: your app → your systems</div>
        <p style={p}>
          Register outbound webhooks from the API (<code style={code}>POST /api/v1/external/webhooks</code>)
          or the admin. Each webhook has a URL, a secret (for HMAC signing), and a list of event types
          to subscribe to.
        </p>

        <div style={h4}>Events supported</div>
        <FieldRow label="return.created" description="Customer submitted a new return." />
        <FieldRow label="return.approved" description="Return was approved (by admin or auto-rule)." />
        <FieldRow label="return.rejected" description="Return was rejected. Payload includes reason." />
        <FieldRow label="return.cancelled" description="Return was cancelled (by admin or customer)." />
        <FieldRow label="return.synced" description="Return was synced to Fynd." />
        <FieldRow label="return.sync_failed" description="Sync attempt failed. Payload includes error detail." />
        <FieldRow label="refund.processed" description="Shopify refund was created. Payload includes amount + method." />
        <FieldRow label="fraud.alert" description="A return scored high/critical risk." />

        <div style={h4}>Payload shape</div>
        <CodeBlock lang="json">{`{
  "id": "evt_01HXAZ...",
  "type": "return.approved",
  "happenedAt": "2026-04-22T10:15:00Z",
  "shop": "your-store.myshopify.com",
  "data": {
    "returnId": "clxxx0001",
    "returnRequestNo": "RPM-A1B2C3D4",
    "status": "approved",
    "approvedBy": "admin:42",
    "items": [...]
  }
}`}</CodeBlock>

        <div style={h4}>Signing &amp; verification</div>
        <p style={p}>
          The app sends <code style={code}>X-Signature</code> (hex HMAC-SHA256 of the raw body with
          your endpoint secret). Your receiver should verify before trusting the payload.
        </p>
        <CodeBlock lang="javascript">{`const crypto = require("crypto");
function verify(req, secret) {
  const expected = crypto.createHmac("sha256", secret)
    .update(req.rawBody).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(req.headers["x-signature"]),
    Buffer.from(expected)
  );
}`}</CodeBlock>

        <div style={h4}>Retry &amp; backoff</div>
        <p style={p}>
          On 5xx or timeout, the app retries with exponential backoff for up to <strong>24 hours</strong>.
          After that the webhook is marked <em>dead-lettered</em> and visible in Webhook Logs for
          manual replay.
        </p>
      </>
    ),
  },

  /* ────────────────── 14. SECURITY & PERMISSIONS ────────────────── */
  {
    id: "security",
    title: "Security & Permissions",
    subtitle: "What data is stored, who can see it, how to stay compliant",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    content: (
      <>
        <p style={p}>
          The app stores only what's needed to operate returns, encrypts sensitive fields, and gives
          you fine-grained control over access.
        </p>

        <Highlights
          items={[
            { title: "Encrypted at rest", description: "All secrets (Fynd credentials, SMTP passwords, API secret keys) are encrypted in the DB." },
            { title: "Encrypted in transit", description: "TLS everywhere — app ↔ Shopify ↔ Fynd ↔ webhooks." },
            { title: "Per-shop isolation", description: "Every query is scoped by shopId; no tenant can ever read another tenant's data." },
            { title: "Role-based access (admin)", description: "Shopify staff roles via the OAuth session — no separate user DB." },
            { title: "Audit log", description: "Every admin action is recorded as a ReturnEvent with actor + timestamp." },
            { title: "PII minimisation", description: "Email/phone stored hashed + normalised for lookup; raw forms only where needed." },
          ]}
        />

        <div style={h3}>Shopify access scopes</div>
        <p style={p}>The app requests these scopes at install time:</p>
        <FieldRow label="read_orders" description="Required to look up customer orders for return creation." required />
        <FieldRow label="write_orders" description="Required to create refunds." required />
        <FieldRow label="read_products" description="Thumbnails + variant data in the portal." required />
        <FieldRow label="read_fulfillments" description="Fulfillment location for accurate restock." required />
        <FieldRow label="write_fulfillments" description="Restock inventory on refund." />
        <FieldRow label="read_customers" description="Customer lookup for fraud scoring &amp; blocklist." required />
        <FieldRow label="read_all_orders" description={<>Enables orders older than 60 days. <strong>Opt-in</strong> — request from Shopify after install.</>} />
        <FieldRow label="write_discounts" description="Creates one-time codes for store credit resolutions." />

        <div style={h3}>PII handling</div>
        <FieldRow label="Email" description="Stored both raw (for sending) and normalised (lowercased, trimmed) for lookups. Raw is dropped 90 days after the return is completed unless legal-hold is set." />
        <FieldRow label="Phone" description="Normalised to E.164 where possible for cross-channel matching." />
        <FieldRow label="IP" description="Captured at portal submission for fraud-signal correlation. Truncated to /24 after 30 days." />
        <FieldRow label="Photos / videos" description="Served via signed URLs with short TTL. Source objects expire 180 days after the return closes." />

        <div style={h3}>GDPR &amp; data subject rights</div>
        <p style={p}>
          The app responds to Shopify's GDPR compliance webhooks:
        </p>
        <FieldRow label="customers/data_request" description="Produces a JSON export of the customer's returns &amp; events within 30 days." />
        <FieldRow label="customers/redact" description="Erases all PII for the customer across returns, events, and logs. Aggregates are preserved." />
        <FieldRow label="shop/redact" description="On uninstall (after 48 h), every record for the shop is permanently deleted." />

        <div style={h3}>Secret management</div>
        <DoDont
          doo={[
            "Rotate API secrets quarterly or after any suspected exposure.",
            "Store your Fynd Client Secret only in the app settings — never in code or exported CSV.",
            "Use environment-scoped credentials (UAT separate from Prod).",
            "Give each integration its own API key with least-privilege scopes.",
          ]}
          dont={[
            "Don't log the raw X-Api-Signature or SMTP password in your own systems.",
            "Don't share a single API key across multiple integrations — makes revocation painful.",
            "Don't re-use UAT secrets in Production.",
          ]}
        />

        <div style={h3}>Rate limits &amp; abuse prevention</div>
        <ul style={ul}>
          <li><strong>Portal</strong>: 20 submissions per IP per hour. 5 OTP requests per email per hour.</li>
          <li><strong>API</strong>: 60 req/min per key with burst to 120.</li>
          <li><strong>Webhook receipt</strong>: 100 req/sec with HMAC verification before any work.</li>
          <li><strong>Login sessions</strong>: Shopify-managed; app never stores plaintext tokens.</li>
        </ul>
      </>
    ),
  },

  /* ────────────────── 15. CUSTOMER MANAGEMENT ────────────────── */
  {
    id: "customers",
    title: "Customer Management",
    subtitle: "Lookup, history, lifetime value, and blocklist actions",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>,
    content: (
      <>
        <p style={p}>
          The <NavLink to="/app/customers">Customers page</NavLink> aggregates per-customer return
          history — one row per normalised email, with the return count, total refund value, most
          recent return, and a blocklist action.
        </p>

        <div style={h3}>What you see per customer</div>
        <FieldRow label="Name / Email / Phone" description="From the most recent return. Email is the primary match key." />
        <FieldRow label="Return count" description="Total returns across all orders." />
        <FieldRow label="Total refunded" description="Sum of refund amounts (dominant currency)." />
        <FieldRow label="First &amp; last return" description="Date range — useful for spotting repeat offenders clustered in a short window." />
        <FieldRow label="Fraud risk" description="Max risk level across their returns." />
        <FieldRow label="Actions" description="View all returns · Add to blocklist · Reset risk · Export history." />

        <div style={h3}>Sort &amp; search</div>
        <FieldRow label="Sort by" description="Most returns (default) · Highest refund · Most recent · Highest risk." />
        <FieldRow label="Search" description="Matches on name, email, phone, or any of their order numbers." />

        <div style={h3}>Per-customer detail</div>
        <p style={p}>
          Click a customer row to see every return they've submitted. The panel shows each return's
          status, items, and amount, with direct links to the detail pages. You can also see their
          pattern: reason distribution, photo-upload compliance, and timing between purchase and
          return.
        </p>

        <div style={h3}>Blocklisting from the customer page</div>
        <Step n={1}>Open a customer detail page.</Step>
        <Step n={2}>Click <strong>Add to blocklist</strong>.</Step>
        <Step n={3}>Choose the block key: <em>email</em>, <em>phone</em>, or <em>both</em>.</Step>
        <Step n={4}>Enter a reason. (Shown to your team, never to the customer.)</Step>
        <Step n={5}>Optionally set an expiry date for a temporary ban.</Step>
        <Step n={6}>Save.</Step>
      </>
    ),
  },

  /* ────────────────── 16. INTERNATIONALIZATION ────────────────── */
  {
    id: "i18n",
    title: "Internationalisation",
    subtitle: "Languages, currencies, timezones",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
    content: (
      <>
        <p style={p}>
          The app honours your Shopify shop's <strong>locale</strong>, <strong>currency</strong>,
          and <strong>timezone</strong> automatically — no manual configuration needed.
        </p>

        <div style={h3}>Locale</div>
        <ul style={ul}>
          <li>Dashboard date formats (<em>"22 Apr"</em> vs <em>"Apr 22"</em>) use the shop locale.</li>
          <li>Number formatting (thousands separator, decimal character) follows the locale.</li>
          <li>Portal strings are translated in supported locales; untranslated strings fall back to English.</li>
        </ul>

        <div style={h3}>Currency</div>
        <ul style={ul}>
          <li>Refund amounts use the <em>dominant currency</em> from actual returns (not the shop-settings default, which can be stale for multi-currency stores).</li>
          <li>Per-return currency is stored on the row — multi-currency stores see accurate per-row totals.</li>
          <li>Dashboard aggregates display the dominant currency with a note when multiple currencies are mixed.</li>
        </ul>

        <div style={h3}>Timezone</div>
        <ul style={ul}>
          <li>Date range filters (today, last 30 days, this month) use merchant-local day boundaries.</li>
          <li>Notifications reference merchant-local timestamps in the email body.</li>
          <li>Scheduled reports fire at the merchant-local time you pick, not UTC.</li>
          <li>Webhook timestamps are always ISO-8601 UTC — for portability.</li>
        </ul>

        <Tip title="Set these once, forget forever">
          Configure shop locale, currency, and timezone in Shopify admin → Settings → Store details
          once. The app reads them on every request and stays in sync automatically.
        </Tip>
      </>
    ),
  },

  /* ────────────────── 17. PAGINATION & PERFORMANCE ────────────────── */
  {
    id: "pagination",
    title: "Pagination & Performance",
    subtitle: "How list pages scale to high-volume stores",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
    content: (
      <>
        <p style={p}>
          Every list page uses server-side pagination, indexed queries, and analytical-only LATERAL
          joins to stay fast regardless of data volume.
        </p>

        <div style={h3}>Page sizes</div>
        <FieldRow label="Returns list" description="25 per page. Filters persist across pages." />
        <FieldRow label="Customers" description="50 per page. Default sort: most returns." />
        <FieldRow label="Webhook Logs" description="50 per page. Full filter support." />

        <div style={h3}>URL query params</div>
        <FieldRow label="Returns" description="?page=2&status=pending&from=2026-01-01&to=2026-03-31" />
        <FieldRow label="Customers" description="?page=3&sort=amount&q=john" />
        <FieldRow label="Webhook Logs" description="?page=2&action=refund_completed&dateFrom=2026-03-01" />

        <div style={h3}>Chart &amp; KPI limits</div>
        <FieldRow label="Return trend chart" description="Up to 5,000 most recent returns in range." />
        <FieldRow label="Avg processing time" description="Most recent 500 approved returns." />
        <FieldRow label="Revenue retained" description="Most recent 2,000 exchange/credit returns." />
        <FieldRow label="Revenue at risk" description="Most recent 3,000 open-return items (30 days)." />

        <Tip title="Need everything in one shot?">
          Use the CSV export (on any list page) or the REST API with pagination for bulk extract
          without chart-level caps.
        </Tip>

        <div style={h3}>Tips for large stores</div>
        <ul style={ul}>
          <li>Narrow dashboards with date filters (Last 30 days is the fastest).</li>
          <li>Filter the Returns list by status before searching — hits indexes first.</li>
          <li>Use the API with <code style={code}>pageSize</code> and filters for bulk programmatic access.</li>
          <li>The <em>Overdue returns</em> KPI is a fast path to operational focus — use it first thing every morning.</li>
        </ul>
      </>
    ),
  },

  /* ────────────────── 18. TROUBLESHOOTING ────────────────── */
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    subtitle: "Every error message and its fix",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>,
    content: (
      <>

        <div style={h3}>Portal issues</div>

        <Faq q="Customer can't find their order">
          The order must exist in Shopify and be <strong>fulfilled</strong>. Email/phone must match
          exactly what's on the Shopify order. For orders &gt; 60 days old, enable
          <NavLink to="/app/settings/permissions"> read_all_orders</NavLink>.
          Also check the return window hasn't expired.
        </Faq>

        <Faq q="Portal returns 404">
          The App Proxy is misconfigured. In Shopify Partner dashboard:
          prefix = <code style={code}>apps</code>, sub-path = <code style={code}>returns</code>,
          URL = <code style={code}>https://your-app-url/apps/returns</code>. Also confirm the app is
          installed on the store.
        </Faq>

        <Faq q="Photo upload fails with 'File too large'">
          Images are capped at 5 MB, videos at 50 MB. Ask the customer to compress or pick fewer
          files. Large files are rejected client-side before upload.
        </Faq>

        <Faq q="OTP email not arriving (manual submission)">
          Check SMTP configuration in <NavLink to="/app/settings/notifications">Notifications</NavLink>.
          Use the <strong>Test connection</strong> button. Also check spam folders; verify SPF/DKIM
          for your sending domain.
        </Faq>

        <div style={h3}>Refund issues</div>

        <Faq q="'You need to set a location to restock items'">
          Shopify requires a location when restocking. Go to
          <NavLink to="/app/settings/return-settings"> Return Settings</NavLink> and set a
          <strong> default fallback location</strong>. Automatic mode uses fulfillment location
          when available, falls back when not.
        </Faq>

        <Faq q="'Cannot refund more than paid'">
          The computed refund exceeds the net paid. Check: already-issued partial refunds, discount
          codes, restock fees, currency mismatch. Inspect the order's refund history in Shopify.
        </Faq>

        <Faq q="Refund not created automatically">
          Four conditions must hold: <strong>Auto-refund</strong> enabled, return has a
          <strong> Fynd Shipment ID</strong>, return is in <strong>approved/completed</strong>,
          webhook is receiving events. Check the return's event timeline for a
          <code style={code}>fynd_webhook</code> entry.
        </Faq>

        <div style={h3}>Fynd issues</div>

        <Faq q="'Fynd sync failed with 403 Forbidden'">
          OAuth app needs scopes <code style={code}>company/orders/read</code>,
          <code style={code}> company/orders/write</code>. Confirm Platform API (not Storefront).
          Check environment matches credentials.
        </Faq>

        <Faq q="'Fynd sync failed with 401 Unauthorized'">
          Credentials invalid. Double-check Company ID, Client ID, Client Secret. Try regenerating
          from Fynd Partners and saving again.
        </Faq>

        <Faq q="Webhook not receiving events from Fynd">
          URL must be publicly reachable (not localhost). Use <strong>Test webhook</strong> in
          <NavLink to="/app/settings/setup"> Fynd Setup Guide</NavLink>. Ensure
          <code style={code}> SHOPIFY_APP_URL</code> is set to your deployed URL. Check Fynd
          Partners' webhook delivery log.
        </Faq>

        <Faq q="Return AWB not appearing">
          Fynd assigns AWBs <em>after</em> courier is assigned. If it's stuck at "pending_pickup"
          &gt; 24 h, check the Fynd dashboard for courier-side issues or contact Fynd support.
        </Faq>

        <div style={h3}>Notifications</div>

        <Faq q="Emails not being sent">
          SMTP must be configured in <NavLink to="/app/settings/notifications">Notifications</NavLink>.
          Use <strong>Test connection</strong>. Verify that the event toggle is on. Check SPF/DKIM
          on your sending domain for deliverability.
        </Faq>

        <Faq q="Customer says they got 3 emails for the same return">
          That's expected — submitted + approved + refunded. If they got more than that, check the
          event timeline for multiple <code style={code}>refund_processed</code> events (possible
          Fynd webhook replay). Idempotency normally catches this; open a support ticket if you
          see duplicates.
        </Faq>

        <div style={h3}>API &amp; webhooks</div>

        <Faq q="401 Unauthorized on every API call">
          <code style={code}>X-Api-Key</code> or <code style={code}>X-Api-Signature</code> is wrong.
          Recompute the HMAC with the <em>exact raw body</em> (including whitespace). Empty string
          for GET requests. Use the Postman collection for a reference impl.
        </Faq>

        <Faq q="429 Too Many Requests">
          Respect the <code style={code}>Retry-After</code> header. Batch your reads (larger
          pageSize, fewer calls). Cache on your side where possible.
        </Faq>

        <Faq q="Outbound webhook never delivered">
          Open <NavLink to="/app/settings/webhook-logs">Webhook Logs</NavLink> — you'll see the
          attempt history, HTTP response, and retry state. If dead-lettered, fix the receiving
          endpoint and replay.
        </Faq>
      </>
    ),
  },

  /* ────────────────── 19. GLOSSARY ────────────────── */
  {
    id: "glossary",
    title: "Glossary",
    subtitle: "Terminology used across the app and documentation",
    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>,
    content: (
      <>
        <FieldRow label="AWB" description="Airway Bill — a courier's unique identifier for a shipment. Forward AWB = original outbound; Return AWB = back-to-warehouse." />
        <FieldRow label="App Proxy" description="Shopify feature that lets the app serve content on the store's own domain (e.g. /apps/returns) with no theme changes." />
        <FieldRow label="Auto-approve" description="Policy that approves every matching return without human review." />
        <FieldRow label="Auto-refund" description="Policy that issues a Shopify refund automatically when Fynd generates a credit note." />
        <FieldRow label="Blocklist" description="List of emails / phones / IPs that can't submit returns." />
        <FieldRow label="Credit note" description="Fynd's internal document confirming QC passed and refund is due." />
        <FieldRow label="Dominant currency" description="The most common currency on a shop's actual returns, preferred over the shop-settings currency." />
        <FieldRow label="Fraud risk level" description="Bucketed score: low (0–24), medium (25–49), high (50–74), critical (75–100)." />
        <FieldRow label="Fynd Shipment ID" description="Fynd's main identifier for a return shipment. Used to match incoming webhooks." />
        <FieldRow label="Green return" description="A return where the customer keeps the item — no physical return. Often cheaper to process." />
        <FieldRow label="Platform API" description="Fynd's back-office API surface, used by this integration. Not Storefront API." />
        <FieldRow label="Return Request ID (RPM-xxxxxxxx)" description="Human-friendly ID shown to the customer. Copied on submit confirmation." />
        <FieldRow label="Resolution type" description="How the return ends: refund, exchange, store_credit, or replacement." />
        <FieldRow label="Restock location" description="Shopify location inventory is returned to on refund. Required by Shopify." />
        <FieldRow label="ReturnCase" description="The top-level return record (one per submitted return)." />
        <FieldRow label="ReturnItem" description="A single line item within a ReturnCase. A case can have many items." />
        <FieldRow label="ReturnEvent" description="An audit log entry: status change, webhook received, admin action, etc." />
        <FieldRow label="UAT" description="User Acceptance Testing — Fynd's sandbox environment. Mirrors Production without real orders." />
      </>
    ),
  },
];

/* ── Main Component ── */
export default function Documentation() {
  const [activeChapter, setActiveChapter] = useState("welcome");
  const [search, setSearch] = useState("");
  const chapter = CHAPTERS.find((c) => c.id === activeChapter) || CHAPTERS[0];
  const chapterIdx = CHAPTERS.findIndex((c) => c.id === activeChapter);
  const prev = chapterIdx > 0 ? CHAPTERS[chapterIdx - 1] : null;
  const next = chapterIdx < CHAPTERS.length - 1 ? CHAPTERS[chapterIdx + 1] : null;

  const filteredChapters = search.trim()
    ? CHAPTERS.filter((c) =>
      c.title.toLowerCase().includes(search.toLowerCase())
      || c.subtitle.toLowerCase().includes(search.toLowerCase())
    )
    : CHAPTERS;

  return (
    <AppPage heading="Documentation">
      <div className="app-content layout-medium" style={{ paddingBottom: 48 }}>

        {/* ── Chapter sidebar + content layout ── */}
        <div className="docs-layout" style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 20, alignItems: "start" }}>

          {/* Sidebar */}
          <div className="docs-sidebar" style={{
            position: "sticky", top: 20,
            background: surface, borderRadius: 14, border, padding: "14px 10px",
          }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: "0.08em", padding: "0 8px 8px" }}>
              Product Guide
            </div>

            {/* Search */}
            <div style={{ padding: "0 6px 10px" }}>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search chapters…"
                style={{
                  width: "100%", padding: "7px 10px", fontSize: 12,
                  border: "1px solid #E2E8F0", borderRadius: 8,
                  background: "#F8FAFC", outline: "none",
                  color: text,
                }}
              />
            </div>

            <div style={{ borderTop: "1px solid #F1F5F9", paddingTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {filteredChapters.length === 0 && (
                <div style={{ padding: "12px 10px", fontSize: 12, color: muted, fontStyle: "italic" }}>
                  No chapters match "{search}"
                </div>
              )}
              {filteredChapters.map((c) => {
                const i = CHAPTERS.findIndex((x) => x.id === c.id);
                return (
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
                      width: 22, height: 22, borderRadius: 5,
                      background: activeChapter === c.id ? accent : "#E2E8F0",
                      color: activeChapter === c.id ? "white" : "#94A3B8",
                      fontSize: 10, fontWeight: 700, flexShrink: 0,
                    }}>
                      {i + 1}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.title}
                    </span>
                  </button>
                );
              })}
            </div>

            <div style={{ borderTop: "1px solid #F1F5F9", marginTop: 10, paddingTop: 10, paddingLeft: 8, paddingRight: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                Quick links
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <NavLink to="/app">Dashboard</NavLink>
                <NavLink to="/app/returns">Returns</NavLink>
                <NavLink to="/app/settings">Settings</NavLink>
                <NavLink to="/app/api-docs">API Docs</NavLink>
              </div>
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
              <h1 style={{ fontSize: 28, fontWeight: 800, color: text, margin: "0 0 4px", letterSpacing: "-0.03em" }}>{chapter.title}</h1>
              <p style={{ fontSize: 15, color: muted, margin: 0, lineHeight: 1.55 }}>{chapter.subtitle}</p>
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
    </AppPage>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <AppPage heading="Documentation">
      <div className="app-content layout-medium">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a href="/app/docs" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</a>
        </div>
      </div>
    </AppPage>
  );
}
