import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    let shop = await prisma.shop.findUnique({
      where: { shopDomain: session.shop },
      include: { settings: true },
    });
    if (!shop) {
      shop = await prisma.shop.create({
        data: { shopDomain: session.shop },
        include: { settings: true },
      });
    }
    const s = shop.settings;

    const hasFynd = !!(s?.fyndCompanyId && s?.fyndApplicationId);
    const hasReasons = !!(s?.returnReasonsJson && s.returnReasonsJson !== "[]");
    const hasPortalTheme = !!s?.portalThemeJson;
    const readAllOrders = s?.readAllOrdersEnabled ?? false;

    const notifCount = [s?.notificationNewReturn, s?.notificationApproved, s?.notificationRejected, s?.notificationRefunded].filter(Boolean).length;
    const smtpConfigured = !!(s?.smtpHost && s?.smtpUser && s?.smtpPass);

    const returnWindowDays = s?.returnWindowDays ?? 30;
    const autoApprove = s?.autoApproveEnabled ?? false;
    const autoRefund = s?.autoRefundEnabled ?? false;
    const photoRequired = s?.photoRequired ?? false;
    const hasReturnFee = s?.returnFeeAmount != null && Number(s.returnFeeAmount) > 0;
    const returnFeeCurrency = s?.returnFeeCurrency ?? "USD";
    const returnFeeAmount = s?.returnFeeAmount != null ? Number(s.returnFeeAmount) : 0;
    const fyndEnv = s?.fyndEnvironment ?? null;
    const refundPaymentMethod = s?.refundPaymentMethod ?? "original";

    let reasonCount = 0;
    try {
      const arr = JSON.parse(s?.returnReasonsJson ?? "[]");
      if (Array.isArray(arr)) reasonCount = arr.length;
    } catch { /* */ }

    let restrictedRegionCount = 0;
    try {
      const arr = JSON.parse(s?.restrictedRegionsJson ?? "[]");
      if (Array.isArray(arr)) restrictedRegionCount = arr.length;
    } catch { /* */ }

    const blocklistEnabled = s?.blocklistEnabled ?? false;
    let blocklistCount = 0;
    if (s) {
      blocklistCount = await prisma.blocklistEntry.count({ where: { settingsId: s.id } });
    }

    let autoRulesCount = 0;
    try {
      const arr = JSON.parse(s?.autoApproveRulesJson ?? "[]");
      if (Array.isArray(arr)) autoRulesCount = arr.length;
    } catch { /* */ }

    const bonusCreditEnabled = s?.bonusCreditEnabled ?? false;
    const bonusCreditPct = s?.bonusCreditPct ?? 10;
    const greenReturnsEnabled = s?.greenReturnsEnabled ?? false;
    const greenReturnsThreshold = s?.greenReturnsThreshold != null ? Number(s.greenReturnsThreshold) : 0;
    const hasDefaultReturnInstructions = !!(s?.defaultReturnInstructions && s.defaultReturnInstructions.trim().length > 0);
    const portalLanguage = s?.portalLanguage ?? "en";

    let productPolicyCount = 0;
    try {
      const arr = JSON.parse(s?.productPoliciesJson ?? "[]");
      if (Array.isArray(arr)) productPolicyCount = arr.length;
    } catch { /* */ }

    const discountCodeRefundEnabled = s?.discountCodeRefundEnabled ?? false;

    return {
      hasFynd, hasReasons, hasPortalTheme, readAllOrders,
      notifCount, smtpConfigured, returnWindowDays, autoApprove, autoRefund,
      photoRequired, hasReturnFee, returnFeeAmount, returnFeeCurrency,
      fyndEnv, reasonCount, restrictedRegionCount, refundPaymentMethod,
      blocklistEnabled, blocklistCount, autoRulesCount,
      bonusCreditEnabled, bonusCreditPct, greenReturnsEnabled,
      greenReturnsThreshold, hasDefaultReturnInstructions, portalLanguage,
      productPolicyCount, discountCodeRefundEnabled,
    };
  } catch (err) {
    console.error("[app.settings._index] Loader error:", err);
    return {
      hasFynd: false,
      hasReasons: false,
      hasPortalTheme: false,
      readAllOrders: false,
      notifCount: 0,
      smtpConfigured: false,
      returnWindowDays: 30,
      autoApprove: false,
      autoRefund: false,
      photoRequired: false,
      hasReturnFee: false,
      returnFeeAmount: 0,
      returnFeeCurrency: "USD",
      fyndEnv: null,
      reasonCount: 0,
      restrictedRegionCount: 0,
      refundPaymentMethod: "original",
      blocklistEnabled: false,
      blocklistCount: 0,
      autoRulesCount: 0,
      bonusCreditEnabled: false,
      bonusCreditPct: 10,
      greenReturnsEnabled: false,
      greenReturnsThreshold: 0,
      hasDefaultReturnInstructions: false,
      portalLanguage: "en",
      productPolicyCount: 0,
      discountCodeRefundEnabled: false,
    };
  }
};

type StatusChip = { label: string; variant: "ok" | "warn" | "off" | "info" };

function StatusDot({ variant }: { variant: "ok" | "warn" | "off" | "info" }) {
  const colors = { ok: "#059669", warn: "#D97706", off: "#9CA3AF", info: "#3B82F6" };
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: colors[variant], flexShrink: 0 }} />;
}

function MiniChip({ label, variant }: StatusChip) {
  const bg = { ok: "#ECFDF5", warn: "#FFFBEB", off: "#F9FAFB", info: "#EFF6FF" };
  const color = { ok: "#065F46", warn: "#92400E", off: "#6B7280", info: "#1E40AF" };
  const border = { ok: "#A7F3D0", warn: "#FDE68A", off: "#E5E7EB", info: "#BFDBFE" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 600, padding: "3px 9px",
      borderRadius: 5, background: bg[variant], color: color[variant],
      border: `1px solid ${border[variant]}`, whiteSpace: "nowrap",
    }}>
      <StatusDot variant={variant} />
      {label}
    </span>
  );
}

type CardDef = {
  to: string;
  icon: React.ReactNode;
  iconBg: string;
  iconStroke: string;
  title: string;
  desc: string;
  status: StatusChip[];
};

export default function SettingsDashboard() {
  const d = useLoaderData<typeof loader>();

  const groups: { title: string; cards: CardDef[] }[] = [
    {
      title: "Return Policies",
      cards: [
        {
          to: "/app/settings/rules",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>,
          iconBg: "#EFF6FF", iconStroke: "#3B82F6",
          title: "Policy Rules",
          desc: "Return reasons, restricted regions, no-return periods, and per-category rules.",
          status: [
            d.hasReasons
              ? { label: `${d.reasonCount} reason${d.reasonCount !== 1 ? "s" : ""}`, variant: "ok" }
              : { label: "No reasons", variant: "warn" },
            ...(d.restrictedRegionCount > 0
              ? [{ label: `${d.restrictedRegionCount} restricted region${d.restrictedRegionCount !== 1 ? "s" : ""}`, variant: "info" as const }]
              : []),
          ],
        },
        {
          to: "/app/settings/return-settings",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
          iconBg: "#F5F3FF", iconStroke: "#8B5CF6",
          title: "Return Settings",
          desc: "Return window, fees, photo requirements, auto-approve, auto-refund, and refund methods.",
          status: [
            { label: `${d.returnWindowDays}-day window`, variant: "info" },
            d.autoApprove ? { label: "Auto-approve", variant: "ok" } : { label: "Manual approve", variant: "off" },
            d.autoRefund ? { label: "Auto-refund", variant: "ok" } : { label: "Manual refund", variant: "off" },
            ...(d.hasReturnFee ? [{ label: `${d.returnFeeCurrency} ${d.returnFeeAmount} fee`, variant: "info" as const }] : []),
            ...(d.photoRequired ? [{ label: "Photo required", variant: "info" as const }] : []),
            { label: d.refundPaymentMethod === "store_credit" ? "Store credit" : d.refundPaymentMethod === "both" ? "Split refund" : d.refundPaymentMethod === "discount_code" ? "Discount code" : "Original payment", variant: "info" as const },
            ...(d.discountCodeRefundEnabled ? [{ label: "Discount codes", variant: "ok" as const }] : []),
          ],
        },
        {
          to: "/app/settings/product-policies",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
          iconBg: "#FDF2F8", iconStroke: "#DB2777",
          title: "Product Policies",
          desc: "Define per-product return policies based on tags, type, or collection. First matching rule overrides the global return window.",
          status: [
            d.productPolicyCount > 0
              ? { label: `${d.productPolicyCount} rule${d.productPolicyCount !== 1 ? "s" : ""}`, variant: "ok" }
              : { label: "No rules", variant: "off" },
          ],
        },
        {
          to: "/app/settings/blocklist",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
          iconBg: "#FEF2F2", iconStroke: "#DC2626",
          title: "Customer Blocklist",
          desc: "Block specific customers from submitting return requests by email, phone, or order name.",
          status: [
            d.blocklistEnabled
              ? { label: "Enabled", variant: "ok" }
              : { label: "Disabled", variant: "off" },
            ...(d.blocklistCount > 0
              ? [{ label: `${d.blocklistCount} blocked`, variant: "info" as const }]
              : []),
          ],
        },
      ],
    },
    {
      title: "Integrations & Automation",
      cards: [
        {
          to: "/app/settings/auto-rules",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
          iconBg: "#F0FDF4", iconStroke: "#16A34A",
          title: "Auto-Approve Rules",
          desc: "Configure advanced rules to auto-approve or flag returns for manual review based on order value, reason, tags, or customer history.",
          status: [
            d.autoApprove
              ? { label: "Auto-approve on", variant: "ok" }
              : { label: "Auto-approve off", variant: "off" },
            ...(d.autoRulesCount > 0
              ? [{ label: `${d.autoRulesCount} rule${d.autoRulesCount !== 1 ? "s" : ""}`, variant: "info" as const }]
              : []),
          ],
        },
        {
          to: "/app/settings/integrations",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
          iconBg: "#ECFDF5", iconStroke: "#059669",
          title: "Fynd Integration",
          desc: d.hasFynd
            ? "Fynd connected — manage credentials, test connection, and sync returns."
            : "Connect Fynd for reverse logistics, shipment tracking, and return sync.",
          status: [
            d.hasFynd
              ? { label: "Connected", variant: "ok" }
              : { label: "Not connected", variant: "warn" },
            ...(d.hasFynd && d.fyndEnv
              ? [{ label: d.fyndEnv === "prod" ? "Production" : "UAT", variant: d.fyndEnv === "prod" ? "ok" as const : "info" as const }]
              : []),
          ],
        },
        {
          to: "/app/settings/notifications",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
          iconBg: "#FEF3C7", iconStroke: "#D97706",
          title: "Notifications",
          desc: "SMTP email, sound alerts, and notification templates.",
          status: [
            d.smtpConfigured
              ? { label: "SMTP connected", variant: "ok" as const }
              : { label: "SMTP not configured", variant: "warn" as const },
            d.notifCount > 0
              ? { label: `${d.notifCount}/4 enabled`, variant: d.notifCount === 4 ? "ok" as const : "info" as const }
              : { label: "All disabled", variant: "warn" as const },
          ],
        },
        {
          to: "/app/settings/webhook-logs",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
          iconBg: "#EDE9FE", iconStroke: "#7C3AED",
          title: "Fynd Webhook Logs",
          desc: "View incoming Fynd webhook events, processing status, errors, and raw payloads with analytics.",
          status: [
            d.hasFynd
              ? { label: "Fynd active", variant: "ok" as const }
              : { label: "Fynd not connected", variant: "off" as const },
          ],
        },
        {
          to: "/app/settings/api-keys",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
          iconBg: "#FDF4FF", iconStroke: "#A855F7",
          title: "External API Keys",
          desc: "Generate API keys for ERP systems and external integrations. View API docs and download Postman collection.",
          status: [
            { label: "API access", variant: "info" as const },
          ],
        },
      ],
    },
    {
      title: "Revenue & Sustainability",
      cards: [
        {
          to: "/app/settings/return-settings",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
          iconBg: "#ECFDF5", iconStroke: "#059669",
          title: "Bonus Credit",
          desc: "Offer extra store credit when customers choose exchange or store credit over a refund.",
          status: [
            d.bonusCreditEnabled
              ? { label: `Enabled (+${d.bonusCreditPct}%)`, variant: "ok" }
              : { label: "Disabled", variant: "off" },
          ],
        },
        {
          to: "/app/settings/return-settings",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 22l1-1h3l9-9"/><path d="M9.5 7.5L14 3l7 7-4.5 4.5"/><circle cx="15" cy="15" r="5"/><path d="M15 13v4"/><path d="M13 15h4"/></svg>,
          iconBg: "#F0FDFA", iconStroke: "#0D9488",
          title: "Green Returns",
          desc: "Let customers keep low-value items instead of returning them, reducing shipping costs.",
          status: [
            d.greenReturnsEnabled
              ? { label: "Enabled", variant: "ok" }
              : { label: "Disabled", variant: "off" },
            ...(d.greenReturnsEnabled && d.greenReturnsThreshold > 0
              ? [{ label: `< $${d.greenReturnsThreshold} threshold`, variant: "info" as const }]
              : []),
          ],
        },
      ],
    },
    {
      title: "Customer Experience",
      cards: [
        {
          to: "/app/settings/widget",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.04-.23-.29-.38-.63-.38-1.04 0-.82.68-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-9.92-10-9.92z"/><circle cx="7.5" cy="11.5" r="1.5"/><circle cx="10.5" cy="7.5" r="1.5"/><circle cx="14.5" cy="7.5" r="1.5"/><circle cx="17.5" cy="11.5" r="1.5"/></svg>,
          iconBg: "#FDF2F8", iconStroke: "#EC4899",
          title: "Portal Appearance",
          desc: "Customize the customer portal — colors, fonts, layout, and which tabs to show.",
          status: [
            d.hasPortalTheme
              ? { label: "Theme customized", variant: "ok" }
              : { label: "Default theme", variant: "off" },
          ],
        },
        {
          to: "/app/settings/widget",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
          iconBg: "#EFF6FF", iconStroke: "#3B82F6",
          title: "Multi-Language",
          desc: "Configure the portal language and customize translated labels for the customer portal.",
          status: [
            { label: d.portalLanguage === "en" ? "English" : d.portalLanguage.toUpperCase(), variant: d.portalLanguage !== "en" ? "ok" as const : "info" as const },
          ],
        },
        {
          to: "/app/settings/return-settings",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
          iconBg: "#FFFBEB", iconStroke: "#D97706",
          title: "Return Labels",
          desc: "Set default return instructions shown to customers after their return is approved.",
          status: [
            d.hasDefaultReturnInstructions
              ? { label: "Instructions set", variant: "ok" }
              : { label: "No instructions", variant: "off" },
          ],
        },
        {
          to: "/app/settings/permissions",
          icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
          iconBg: "#FEF2F2", iconStroke: "#DC2626",
          title: "Permissions",
          desc: "Enable read_all_orders to access full order history for returns and refunds.",
          status: [
            d.readAllOrders
              ? { label: "read_all_orders enabled", variant: "ok" }
              : { label: "Limited access", variant: "warn" },
          ],
        },
      ],
    },
  ];

  const allCards = groups.flatMap((g) => g.cards);
  const configuredCount = allCards.filter((c) =>
    c.status.some((s) => s.variant === "ok")
  ).length;

  return (
    <s-page fullWidth heading="Settings">
      <div className="app-content layout-wide">

        {/* ── Summary Bar ── */}
        <div className="settings-summary-bar">
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)", marginBottom: 4 }}>
              Configuration
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {d.autoApprove && <MiniChip label="Auto-approve" variant="ok" />}
              {d.autoRefund && <MiniChip label="Auto-refund" variant="ok" />}
              {d.hasFynd && <MiniChip label="Fynd connected" variant="ok" />}
              {d.readAllOrders && <MiniChip label="Full order access" variant="ok" />}
              {d.blocklistEnabled && <MiniChip label="Blocklist active" variant="warn" />}
              {d.autoRulesCount > 0 && <MiniChip label={`${d.autoRulesCount} auto-rule${d.autoRulesCount !== 1 ? "s" : ""}`} variant="info" />}
              {!d.autoApprove && !d.autoRefund && !d.hasFynd && !d.readAllOrders && (
                <span style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)" }}>
                  Configure your return policies and integrations below.
                </span>
              )}
            </div>
          </div>

          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 14px", background: "#F8FAFC", borderRadius: 8,
            border: "1px solid #E2E8F0",
          }}>
            <div style={{ display: "flex", gap: 3 }}>
              {allCards.map((_, i) => (
                <div key={i} style={{
                  width: 16, height: 5, borderRadius: 2,
                  background: i < configuredCount ? "#059669" : "#E5E7EB",
                  transition: "background 0.3s",
                }} />
              ))}
            </div>
            <span style={{
              fontSize: 12, fontWeight: 700, whiteSpace: "nowrap",
              color: configuredCount === allCards.length ? "#059669" : "var(--rpm-text-muted, #64748b)",
            }}>
              {configuredCount}/{allCards.length}
            </span>
          </div>
        </div>

        {/* ── Grouped Cards ── */}
        {groups.map((group) => (
          <div key={group.title} style={{ marginBottom: 24 }}>
            <div className="app-overline" style={{ marginBottom: 10, paddingLeft: 2, fontSize: 12, fontWeight: 600 }}>
              {group.title}
            </div>
            <div className="settings-card-grid" style={group.cards.length === 1 ? { gridTemplateColumns: "1fr" } : undefined}>
              {group.cards.map((c, ci) => (
                <Link key={`${c.to}-${ci}`} to={c.to} className="app-settings-card" style={{ gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div className="app-settings-card-icon" style={{ background: c.iconBg, color: c.iconStroke, width: 40, height: 40, borderRadius: 10 }}>
                      {c.icon}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 4 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#C0C5CE" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>
                  <div>
                    <div className="app-settings-card-title" style={{ fontSize: 14, marginBottom: 3 }}>{c.title}</div>
                    <div className="app-settings-card-desc" style={{ fontSize: 12, lineHeight: 1.5 }}>{c.desc}</div>
                  </div>
                  {c.status.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
                      {c.status.map((s, i) => (
                        <MiniChip key={i} label={s.label} variant={s.variant} />
                      ))}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </div>
        ))}

        {/* ── Fynd Setup Guide (secondary) ── */}
        {!d.hasFynd && (
          <div className="dashboard-fynd-banner">
            <div className="banner-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="1.5"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>
            </div>
            <div className="banner-text">
              <div style={{ fontSize: 14, fontWeight: 600, color: "#92400E", marginBottom: 2 }}>
                Fynd Setup Guide
              </div>
              <div style={{ fontSize: 12, color: "#A16207", lineHeight: 1.5 }}>
                Step-by-step guided setup for credentials, webhook configuration, and testing.
              </div>
            </div>
            <Link to="/app/settings/setup" style={{ textDecoration: "none", flexShrink: 0 }}>
              <s-button variant="secondary">Start setup</s-button>
            </Link>
          </div>
        )}
      </div>
    </s-page>
  );
}
