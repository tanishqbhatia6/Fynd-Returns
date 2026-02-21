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
  return { hasFynd, portalUrl: `https://${session.shop}/apps/returns` };
};

const cardStyle = {
  padding: 24,
  background: "#fff",
  borderRadius: 12,
  border: "1px solid #e1e3e5",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  textDecoration: "none" as const,
  color: "inherit",
  display: "block",
  transition: "border-color 0.2s, box-shadow 0.2s",
};

export default function SettingsDashboard() {
  const { hasFynd } = useLoaderData<typeof loader>();

  const cards = [
    {
      to: "/app/settings/rules",
      icon: "📋",
      title: "Policy Rules",
      desc: "Easily edit and add dynamic rules to your policies with simplicity.",
    },
    {
      to: "/app/settings/return-settings",
      icon: "⚙️",
      title: "Return Settings",
      desc: "No-return periods, product tags, photo requirements, fees, and refund methods.",
    },
    {
      to: "/app/settings/notifications",
      icon: "🔔",
      title: "Notification",
      desc: "Manage your notifications as needed.",
    },
    {
      to: "/app/settings/integrations",
      icon: "🔗",
      title: "Partner Integrations",
      desc: hasFynd ? "Manage your Fynd integration." : "Connect Fynd for reverse logistics.",
    },
    {
      to: "/app/settings/widget",
      icon: "📦",
      title: "Return Widget",
      desc: "Manage your return portal widget settings and theme.",
    },
    {
      to: "/app/settings/permissions",
      icon: "🔐",
      title: "All orders permission",
      desc: "Approve the read_all_orders permission to fetch every past order.",
    },
  ];

  return (
    <s-page heading="Settings">
      <div className="app-content">
      <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
        Manage your settings like rules, notifications and integrations for customers.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 20,
        }}
      >
        {cards.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            style={cardStyle}
            onMouseOver={(e) => {
              e.currentTarget.style.borderColor = "#005bd3";
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,91,211,0.12)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.borderColor = "#e1e3e5";
              e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04)";
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 12 }}>{c.icon}</div>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>{c.title}</div>
            <div style={{ color: "#6d7175", fontSize: 14, lineHeight: 1.5 }}>{c.desc}</div>
          </Link>
        ))}
      </div>
      </div>
    </s-page>
  );
}
