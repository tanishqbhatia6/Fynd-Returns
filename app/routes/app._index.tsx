import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts";

const STATUS_COLORS: Record<string, string> = {
  pending: "#b98900",
  processing: "#005bd3",
  "in progress": "#005bd3",
  completed: "#008060",
  approved: "#008060",
  rejected: "#d72c0d",
  cancelled: "#6d7175",
  initiated: "#b98900",
};

const CHART_COLORS = ["#005bd3", "#008060", "#b98900", "#d72c0d", "#6d7175", "#7c3aed", "#0891b2", "#dc2626"];

function getStatusColor(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, " ");
  return STATUS_COLORS[key] ?? "#6d7175";
}

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

    const now = new Date();
    const fourteenDaysAgo = new Date(now);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const where = { shopId: shop.id };
    const whereLast7 = { ...where, createdAt: { gte: sevenDaysAgo } };
    const whereLast30 = { ...where, createdAt: { gte: thirtyDaysAgo } };
    const whereLast14 = { ...where, createdAt: { gte: fourteenDaysAgo } };

    const [
      totalReturns,
      returnsLast7,
      returnsLast30,
      returnsByStatus,
      recentReturns,
      reasonAggregation,
      refundedCount,
      fyndSyncedCount,
      pendingCount,
      rejectedCount,
      returnsLast14,
      itemsCount,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.count({ where: whereLast7 }),
      prisma.returnCase.count({ where: whereLast30 }),
      prisma.returnCase.groupBy({
        by: ["status"],
        where,
        _count: true,
      }),
      prisma.returnCase.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { items: { take: 3 } },
      }),
      prisma.returnItem.groupBy({
        by: ["reasonCode"],
        where: { returnCase: { shopId: shop.id } },
        _count: true,
      }),
      prisma.returnCase.count({ where: { ...where, refundStatus: "refunded" } }),
      prisma.returnCase.count({ where: { ...where, fyndReturnNo: { not: null } } }),
      prisma.returnCase.count({ where: { ...where, status: "pending" } }),
      prisma.returnCase.count({ where: { ...where, status: "rejected" } }),
      prisma.returnCase.findMany({
        where: whereLast14,
        select: { createdAt: true },
      }),
      prisma.returnItem.count({ where: { returnCase: { shopId: shop.id } } }),
    ]);

    const statusMap = returnsByStatus.reduce(
      (acc, x) => ({ ...acc, [x.status]: x._count }),
      {} as Record<string, number>
    );
    const maxStatusCount = Math.max(...Object.values(statusMap), 1);

    const topReasons = reasonAggregation
      .filter((r) => r.reasonCode && r.reasonCode.trim() !== "")
      .map((r) => ({ reason: r.reasonCode!, count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const dailyData: Record<string, number> = {};
    for (let d = 0; d < 14; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - (13 - d));
      const key = date.toISOString().slice(0, 10);
      dailyData[key] = 0;
    }
    returnsLast14.forEach((r) => {
      const key = new Date(r.createdAt).toISOString().slice(0, 10);
      if (dailyData[key] !== undefined) dailyData[key]++;
    });
    const returnsOverTime = Object.entries(dailyData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({
        date: new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        returns: count,
        fullDate: date,
      }));

    const statusChartData = Object.entries(statusMap)
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));

    const portalUrl = `https://${session.shop}/apps/returns`;
    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    const weekOverWeekChange =
      returnsLast7 > 0 && returnsLast30 > 0
        ? Math.round(((returnsLast7 - (returnsLast30 - returnsLast7) / 3) / Math.max(returnsLast7, 1)) * 100)
        : 0;

    return {
      totalReturns,
      returnsLast7,
      returnsLast30,
      statusMap,
      maxStatusCount,
      topReasons,
      recentReturns,
      portalUrl,
      hasFyndConfig,
      shopDomain: session.shop,
      refundedCount,
      fyndSyncedCount,
      pendingCount,
      rejectedCount,
      returnsOverTime,
      statusChartData,
      itemsCount,
      weekOverWeekChange,
      error: null,
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    return {
      totalReturns: 0,
      returnsLast7: 0,
      returnsLast30: 0,
      statusMap: {} as Record<string, number>,
      maxStatusCount: 1,
      topReasons: [] as { reason: string; count: number }[],
      recentReturns: [] as Awaited<ReturnType<typeof prisma.returnCase.findMany>>,
      portalUrl: `https://${session.shop}/apps/returns`,
      hasFyndConfig: false,
      shopDomain: session.shop,
      refundedCount: 0,
      fyndSyncedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
      returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
      statusChartData: [] as { name: string; value: number }[],
      itemsCount: 0,
      weekOverWeekChange: 0,
      error: "Failed to load dashboard data. Please refresh or try again later.",
    };
  }
};

const MetricCard = ({
  label,
  value,
  subtext,
  trend,
  color,
  icon,
}: {
  label: string;
  value: number | string;
  subtext?: string;
  trend?: number;
  color?: string;
  icon?: string;
}) => (
  <div
    className="dashboard-metric-card"
    style={{
      background: "var(--rpm-surface)",
      borderRadius: 14,
      padding: "20px 22px",
      border: "1px solid var(--rpm-border)",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      transition: "box-shadow 0.2s, transform 0.2s",
    }}
  >
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--rpm-text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </span>
      {icon && (
        <span style={{ fontSize: 20, opacity: 0.6 }} role="img" aria-hidden>
          {icon}
        </span>
      )}
    </div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: 32,
          fontWeight: 700,
          color: color ?? "var(--rpm-text)",
          letterSpacing: "-0.02em",
          lineHeight: 1.1,
        }}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
      {trend !== undefined && trend !== 0 && (
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: trend > 0 ? "#dc2626" : "#059669",
          }}
        >
          {trend > 0 ? "↑" : "↓"} {Math.abs(trend)}%
        </span>
      )}
    </div>
    {subtext && (
      <div style={{ fontSize: 13, color: "var(--rpm-text-muted)", marginTop: 6 }}>{subtext}</div>
    )}
  </div>
);

export default function Dashboard() {
  const {
    totalReturns,
    returnsLast7,
    returnsLast30,
    statusMap,
    maxStatusCount,
    topReasons,
    recentReturns,
    portalUrl,
    hasFyndConfig,
    refundedCount,
    fyndSyncedCount,
    pendingCount,
    rejectedCount,
    returnsOverTime,
    statusChartData,
    itemsCount,
    weekOverWeekChange,
    error,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Dashboard">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            <p style={{ marginBottom: 8, fontWeight: 500 }}>{error}</p>
            <p style={{ fontSize: 14, opacity: 0.9 }}>
              Some metrics may be unavailable. You can still use Returns, Settings, and the Customer Portal.
            </p>
          </div>
        )}

        {/* Hero metrics */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            gap: 20,
            marginBottom: 32,
          }}
        >
          <Link to="/app/returns" style={{ textDecoration: "none" }}>
            <MetricCard
              label="Total returns"
              value={totalReturns}
              subtext="All time"
              trend={weekOverWeekChange}
              icon="📦"
            />
          </Link>
          <MetricCard label="Last 7 days" value={returnsLast7} subtext="This week" icon="📅" />
          <MetricCard label="Last 30 days" value={returnsLast30} subtext="This month" icon="📆" />
          <MetricCard
            label="Approved"
            value={(statusMap.approved ?? 0) + (statusMap.completed ?? 0)}
            color="#059669"
            icon="✓"
          />
          <MetricCard label="Pending" value={pendingCount} color="#b98900" icon="⏳" />
          <MetricCard label="Refunded" value={refundedCount} color="#059669" subtext="Processed" icon="💰" />
          {hasFyndConfig && (
            <MetricCard label="Fynd synced" value={fyndSyncedCount} subtext="With return #" icon="🔄" />
          )}
          <MetricCard label="Items returned" value={itemsCount} subtext="Total units" icon="📋" />
        </div>

        {/* Charts row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))",
            gap: 24,
            marginBottom: 32,
          }}
        >
          {/* Returns over time */}
          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              style={{
                margin: "0 0 20px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Returns over time
            </h3>
            <div style={{ height: 240 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="returnsGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#005bd3" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#005bd3" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: 10,
                        border: "1px solid #e5e7eb",
                        fontSize: 13,
                      }}
                      formatter={(value: number) => [value, "Returns"]}
                      labelFormatter={(label) => `Date: ${label}`}
                    />
                    <Area
                      type="monotone"
                      dataKey="returns"
                      stroke="#005bd3"
                      strokeWidth={2}
                      fill="url(#returnsGradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--rpm-text-muted)",
                    fontSize: 14,
                  }}
                >
                  No returns in the last 14 days
                </div>
              )}
            </div>
          </div>

          {/* Status distribution */}
          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              style={{
                margin: "0 0 20px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Returns by status
            </h3>
            <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {statusChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={statusChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={2}
                      dataKey="value"
                      nameKey="name"
                    >
                      {statusChartData.map((_, index) => (
                        <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        borderRadius: 10,
                        border: "1px solid #e5e7eb",
                        fontSize: 13,
                      }}
                      formatter={(value: number, name: string, props: { payload: { value: number } }) => {
                        const total = statusChartData.reduce((a, d) => a + d.value, 0);
                        const pct = total > 0 ? Math.round((props.payload.value / total) * 100) : 0;
                        return [`${value} (${pct}%)`, name];
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: "var(--rpm-text-muted)", fontSize: 14 }}>No status data yet</div>
              )}
            </div>
          </div>
        </div>

        {/* Return reasons bar chart */}
        {topReasons.length > 0 && (
          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              marginBottom: 32,
            }}
          >
            <h3
              style={{
                margin: "0 0 20px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Top return reasons
            </h3>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={topReasons.map((r) => ({ name: r.reason.length > 20 ? r.reason.slice(0, 20) + "…" : r.reason, count: r.count, fullName: r.reason }))}
                  layout="vertical"
                  margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} width={100} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 10,
                      border: "1px solid #e5e7eb",
                      fontSize: 13,
                    }}
                    formatter={(value: number, _: unknown, props: { payload?: { fullName?: string } }) => [
                      value,
                      props.payload?.fullName ?? "Returns",
                    ]}
                  />
                  <Bar dataKey="count" fill="#005bd3" radius={[0, 4, 4, 0]} name="Returns" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Status breakdown + Recent returns */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 24,
            marginBottom: 32,
          }}
        >
          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              style={{
                margin: "0 0 16px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Status breakdown
            </h3>
            {Object.keys(statusMap).length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 14 }}>
                No returns yet. Status breakdown will appear when customers initiate returns.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {Object.entries(statusMap)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => (
                    <div key={status}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 14 }}>
                        <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{status}</span>
                        <span style={{ color: "var(--rpm-text-muted)", fontWeight: 600 }}>{count}</span>
                      </div>
                      <div
                        style={{
                          height: 8,
                          background: "var(--rpm-surface-elevated)",
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            width: `${(count / maxStatusCount) * 100}%`,
                            height: "100%",
                            background: getStatusColor(status),
                            borderRadius: 4,
                            minWidth: count > 0 ? 4 : 0,
                          }}
                        />
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              gridColumn: "span 1",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--rpm-text)",
                  letterSpacing: "-0.01em",
                }}
              >
                Recent returns
              </h3>
              <Link
                to="/app/returns"
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--rpm-accent)",
                  textDecoration: "none",
                }}
              >
                View all →
              </Link>
            </div>
            {recentReturns.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  background: "var(--rpm-surface-subtle)",
                  borderRadius: 10,
                  border: "1px dashed var(--rpm-border)",
                }}
              >
                <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8, color: "var(--rpm-text)" }}>
                  No returns yet
                </p>
                <p style={{ color: "var(--rpm-text-muted)", marginBottom: 16, fontSize: 14 }}>
                  Returns will appear here when customers initiate them via the portal.
                </p>
                <Link to="/app/portal">
                  <s-button variant="primary">Share portal URL</s-button>
                </Link>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--rpm-border)" }}>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Order</th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Return #</th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Created</th>
                      <th style={{ textAlign: "right", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentReturns.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid var(--rpm-surface-elevated)" }}>
                        <td style={{ padding: "12px" }}>
                          <Link to={`/app/returns/${r.id}`} style={{ fontWeight: 500, color: "var(--rpm-text)", textDecoration: "none" }}>
                            {r.shopifyOrderName || r.id}
                          </Link>
                        </td>
                        <td style={{ padding: "12px" }}>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "4px 10px",
                              borderRadius: 6,
                              fontSize: 12,
                              fontWeight: 600,
                              background: `${getStatusColor(r.status)}18`,
                              color: getStatusColor(r.status),
                              textTransform: "capitalize",
                            }}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td style={{ padding: "12px", color: "var(--rpm-text-muted)" }}>
                          {r.fyndReturnNo || "—"}
                        </td>
                        <td style={{ padding: "12px", color: "var(--rpm-text-muted)" }}>
                          {new Date(r.createdAt).toLocaleDateString(undefined, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </td>
                        <td style={{ padding: "12px", textAlign: "right" }}>
                          <Link
                            to={`/app/returns/${r.id}`}
                            style={{
                              fontSize: 13,
                              fontWeight: 600,
                              color: "var(--rpm-accent)",
                              textDecoration: "none",
                            }}
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Quick actions + Portal */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 24,
          }}
        >
          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              style={{
                margin: "0 0 16px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Quick actions
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <Link to="/app/returns">
                <s-button variant="primary">View all returns</s-button>
              </Link>
              <Link to={hasFyndConfig ? "/app/settings" : "/app/settings/integrations"}>
                <s-button variant="secondary">{hasFyndConfig ? "Settings" : "Configure Fynd"}</s-button>
              </Link>
              <Link to="/app/reports">
                <s-button variant="secondary">Reports</s-button>
              </Link>
              <Link to="/app/portal">
                <s-button variant="secondary">Customer portal</s-button>
              </Link>
            </div>
          </div>

          <div
            style={{
              background: "var(--rpm-surface)",
              borderRadius: 14,
              padding: 24,
              border: "1px solid var(--rpm-border)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <h3
              style={{
                margin: "0 0 8px",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--rpm-text)",
                letterSpacing: "-0.01em",
              }}
            >
              Customer portal URL
            </h3>
            <p style={{ marginBottom: 14, color: "var(--rpm-text-muted)", fontSize: 14 }}>
              Share this URL so customers can initiate and track returns.
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <code
                style={{
                  padding: "12px 16px",
                  background: "var(--rpm-surface-subtle)",
                  borderRadius: 10,
                  fontSize: 13,
                  flex: "1 1 260px",
                  overflow: "auto",
                  border: "1px solid var(--rpm-border)",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {portalUrl}
              </code>
              <s-button variant="secondary" onClick={() => navigator.clipboard.writeText(portalUrl)}>
                Copy URL
              </s-button>
            </div>
          </div>
        </div>

        {!hasFyndConfig && (
          <div
            style={{
              marginTop: 32,
              padding: 24,
              background: "var(--rpm-warning-bg)",
              borderRadius: 14,
              border: "1px solid #fcd34d",
            }}
          >
            <p style={{ marginBottom: 8, fontWeight: 600, color: "#b45309", fontSize: 15 }}>
              Connect your Fynd account to enable full return management
            </p>
            <p style={{ marginBottom: 16, color: "#92400e", fontSize: 14 }}>
              Fynd handles reverse logistics. Configure your credentials to sync returns and tracking.
            </p>
            <Link to="/app/settings/integrations">
              <s-button variant="primary">Configure Fynd</s-button>
            </Link>
          </div>
        )}
      </div>
    </s-page>
  );
}
