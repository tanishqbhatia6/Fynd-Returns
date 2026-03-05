import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
  const hasFynd = !!(shop.settings?.fyndCompanyId && shop.settings?.fyndApplicationId);
  const hasReasons = !!(shop.settings?.returnReasonsJson && shop.settings.returnReasonsJson !== "[]");
  const hasNotifications = !!(shop.settings?.notificationNewReturn || shop.settings?.notificationApproved || shop.settings?.notificationRejected);
  const hasPortalTheme = !!shop.settings?.portalThemeJson;
  const completedSteps = [hasFynd, hasReasons, hasNotifications, hasPortalTheme].filter(Boolean).length;
  return { hasFynd, hasReasons, hasNotifications, hasPortalTheme, completedSteps, portalUrl: `https://${session.shop}/apps/returns` };
};

export default function SettingsDashboard() {
  const { hasFynd, hasReasons, completedSteps } = useLoaderData<typeof loader>();
  const totalSteps = 4;
  const progressPct = Math.round((completedSteps / totalSteps) * 100);

  const cards = [
    {
      to: "/app/settings/rules",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>,
      iconBg: "#eff6ff",
      title: "Policy Rules",
      desc: "Configure return reasons, restricted regions, no-return periods, and per-category rules.",
      badge: hasReasons ? null : "Setup needed",
    },
    {
      to: "/app/settings/return-settings",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
      iconBg: "#f5f3ff",
      title: "Return Settings",
      desc: "Return window, minimum price, return fees, photo requirements, and refund methods.",
    },
    {
      to: "/app/settings/notifications",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>,
      iconBg: "#fef3c7",
      title: "Notifications",
      desc: "Control email notifications for new returns, approvals, and rejections.",
    },
    {
      to: "/app/settings/integrations",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
      iconBg: "#ecfdf5",
      title: "Partner Integrations",
      desc: hasFynd ? "Fynd connected — manage credentials, test connection, and sync returns." : "Connect Fynd for reverse logistics, shipment tracking, and return sync.",
      badge: hasFynd ? "Connected" : "Not connected",
      badgeColor: hasFynd ? "#059669" : "#d97706",
    },
    {
      to: "/app/settings/setup",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>,
      iconBg: "#eff6ff",
      title: "Fynd Setup Guide",
      desc: "Step-by-step guided setup with credential configuration, webhook setup, and testing.",
    },
    {
      to: "/app/settings/widget",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="1.5"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.04-.23-.29-.38-.63-.38-1.04 0-.82.68-1.5 1.5-1.5H16c3.31 0 6-2.69 6-6 0-5.5-4.5-9.92-10-9.92z"/><circle cx="7.5" cy="11.5" r="1.5"/><circle cx="10.5" cy="7.5" r="1.5"/><circle cx="14.5" cy="7.5" r="1.5"/><circle cx="17.5" cy="11.5" r="1.5"/></svg>,
      iconBg: "#fdf2f8",
      title: "Customer Portal Widget",
      desc: "Customize portal appearance — colors, fonts, layout — and configure which tabs to show.",
    },
    {
      to: "/app/settings/permissions",
      icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>,
      iconBg: "#fef2f2",
      title: "Permissions",
      desc: "Enable read_all_orders to access full order history for returns and refunds.",
    },
  ];

  return (
    <s-page heading="Settings">
      <div className="app-content">
        <div style={{
          marginBottom: 28, padding: "22px 24px",
          background: "var(--rpm-surface)", borderRadius: 14,
          border: "var(--rpm-border)",
          display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
        }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center" }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg></div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Configuration</h2>
            <p style={{ margin: "4px 0 0", color: "var(--rpm-text-muted)", fontSize: 13, lineHeight: 1.5 }}>
              Configure your return policies, integrations, notifications, and customer portal.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", background: "var(--rpm-surface-subtle)", borderRadius: 10 }}>
            <div style={{ width: 100, height: 6, background: "var(--rpm-surface-elevated)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ width: `${progressPct}%`, height: "100%", background: progressPct === 100 ? "var(--rpm-success)" : "var(--rpm-accent)", borderRadius: 3, transition: "width 0.5s ease" }} />
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, color: progressPct === 100 ? "var(--rpm-success)" : "var(--rpm-accent)", whiteSpace: "nowrap" }}>
              {completedSteps}/{totalSteps} done
            </span>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
          {cards.map((c) => (
            <Link key={c.to} to={c.to} className="app-settings-card">
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
                <div className="app-settings-card-icon" style={{ background: c.iconBg }}>
                  {c.icon}
                </div>
                {c.badge && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 10px",
                      borderRadius: 20,
                      background: c.badgeColor ? `${c.badgeColor}15` : "var(--rpm-warning-bg)",
                      color: c.badgeColor || "var(--rpm-warning)",
                      border: `1px solid ${c.badgeColor ? `${c.badgeColor}30` : "var(--rpm-warning-border)"}` as string,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {c.badge}
                  </span>
                )}
              </div>
              <div className="app-settings-card-title">{c.title}</div>
              <div className="app-settings-card-desc">{c.desc}</div>
            </Link>
          ))}
        </div>
      </div>
    </s-page>
  );
}
