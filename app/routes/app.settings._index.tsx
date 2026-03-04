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
      icon: "📋",
      iconBg: "#eff6ff",
      title: "Policy Rules",
      desc: "Configure return reasons, restricted regions, no-return periods, and per-category rules.",
      badge: hasReasons ? null : "Setup needed",
    },
    {
      to: "/app/settings/return-settings",
      icon: "⚙️",
      iconBg: "#f5f3ff",
      title: "Return Settings",
      desc: "Return window, minimum price, return fees, photo requirements, and refund methods.",
    },
    {
      to: "/app/settings/notifications",
      icon: "🔔",
      iconBg: "#fef3c7",
      title: "Notifications",
      desc: "Control email notifications for new returns, approvals, and rejections.",
    },
    {
      to: "/app/settings/integrations",
      icon: "🔗",
      iconBg: "#ecfdf5",
      title: "Partner Integrations",
      desc: hasFynd ? "Fynd connected — manage credentials, test connection, and sync returns." : "Connect Fynd for reverse logistics, shipment tracking, and return sync.",
      badge: hasFynd ? "Connected" : "Not connected",
      badgeColor: hasFynd ? "#059669" : "#d97706",
    },
    {
      to: "/app/settings/setup",
      icon: "🚀",
      iconBg: "#eff6ff",
      title: "Fynd Setup Guide",
      desc: "Step-by-step guided setup with credential configuration, webhook setup, and testing.",
    },
    {
      to: "/app/settings/widget",
      icon: "🎨",
      iconBg: "#fdf2f8",
      title: "Customer Portal Widget",
      desc: "Customize portal appearance — colors, fonts, layout — and configure which tabs to show.",
    },
    {
      to: "/app/settings/permissions",
      icon: "🔐",
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
          <div style={{ width: 46, height: 46, borderRadius: 12, background: "#eff6ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>⚙️</div>
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
