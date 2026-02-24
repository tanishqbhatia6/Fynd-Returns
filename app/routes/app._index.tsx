import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange, DATE_RANGE_OPTIONS, type DateRangePreset } from "../lib/dashboard-date-utils";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
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



function getStatusColor(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, " ");
  return STATUS_COLORS[key] ?? "#6d7175";
}

function buildSuggestions(data: {
  totalReturns: number;
  pendingCount: number;
  rejectedCount: number;
  approvedCount: number;
  topReasons: { reason: string; count: number }[];
  hasFyndConfig: boolean;
  fyndSyncedCount: number;
  refundedCount: number;
  avgProcessingDays: number | null;
  rangeLabel: string;
}): { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[] {
  const suggestions: { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[] = [];

  if (data.totalReturns === 0) {
    suggestions.push({
      type: "info",
      message: `No returns in ${data.rangeLabel}. Share your customer portal URL to let customers initiate returns.`,
      action: "Share portal",
      actionUrl: "/app/portal",
    });
    return suggestions;
  }

  if (data.pendingCount > 0) {
    suggestions.push({
      type: "warning",
      message: `${data.pendingCount} return${data.pendingCount > 1 ? "s" : ""} pending review. Process them to improve customer satisfaction.`,
      action: "View pending",
      actionUrl: "/app/returns?status=pending",
    });
  }

  if (!data.hasFyndConfig && data.approvedCount > 0) {
    suggestions.push({
      type: "info",
      message: "Connect Fynd to sync returns with your logistics partner and track return numbers.",
      action: "Configure Fynd",
      actionUrl: "/app/settings/integrations",
    });
  }

  if (data.hasFyndConfig && data.approvedCount > 0 && data.fyndSyncedCount < data.approvedCount) {
    suggestions.push({
      type: "warning",
      message: `${data.approvedCount - data.fyndSyncedCount} approved return${data.approvedCount - data.fyndSyncedCount > 1 ? "s" : ""} not yet synced to Fynd. Use "Retry Fynd sync" on each return.`,
      action: "View returns",
      actionUrl: "/app/returns",
    });
  }

  if (data.hasFyndConfig && data.fyndSyncedCount > 0) {
    suggestions.push({
      type: "info",
      message: "Setup Fynd webhook for automatic refunds when Fynd processes returns.",
      action: "Fynd Setup Guide",
      actionUrl: "/app/settings/setup",
    });
  }

  const topReason = data.topReasons[0];
  if (topReason && (topReason.reason === "Other" || topReason.reason === "other") && data.totalReturns >= 2) {
    suggestions.push({
      type: "info",
      message: "Many returns use 'Other' as the reason. Consider adding more specific return reasons in Settings to get better insights.",
      action: "Return settings",
      actionUrl: "/app/settings/return-settings",
    });
  }

  if (data.rejectedCount > 0 && data.totalReturns >= 3) {
    const rejectRate = Math.round((data.rejectedCount / data.totalReturns) * 100);
    if (rejectRate > 30) {
      suggestions.push({
        type: "warning",
        message: `Rejection rate is ${rejectRate}%. Review your return policy and approval criteria.`,
        action: "View rejected",
        actionUrl: "/app/returns?status=rejected",
      });
    }
  }

  if (data.refundedCount < data.approvedCount && data.approvedCount > 0) {
    suggestions.push({
      type: "info",
      message: `${data.approvedCount - data.refundedCount} approved return${data.approvedCount - data.refundedCount > 1 ? "s" : ""} not yet refunded. Process refunds in Shopify.`,
      action: "View returns",
      actionUrl: "/app/returns",
    });
  }

  if (data.avgProcessingDays !== null && data.avgProcessingDays > 5 && data.approvedCount >= 2) {
    suggestions.push({
      type: "warning",
      message: `Average processing time is ${Math.round(data.avgProcessingDays)} days. Consider faster approval to improve customer experience.`,
      action: "View pending",
      actionUrl: "/app/returns?status=pending",
    });
  }

  if (suggestions.length === 0 && data.totalReturns > 0) {
    suggestions.push({
      type: "success",
      message: `All returns in ${data.rangeLabel} are processed. Keep up the good work.`,
    });
  }

  return suggestions;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "last_30_days";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

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

    const { start: rangeStart, end: rangeEnd, label: rangeLabel } = parseDateRange(range, from, to);
    const where = {
      shopId: shop.id,
      createdAt: { gte: rangeStart, lte: rangeEnd },
    };
    const whereAll = { shopId: shop.id };

    const approvedStatuses = ["approved", "completed"];
    const approvedWhere = {
      ...where,
      status: { in: approvedStatuses },
    };

    const [
      totalReturns,
      returnsByStatus,
      recentReturns,
      reasonAggregation,
      refundedCount,
      fyndSyncedCount,
      pendingCount,
      rejectedCount,
      itemsCount,
      allTimeReturns,
      approvedWithEvents,
      returnsForDaily,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.groupBy({ by: ["status"], where, _count: true }),
      prisma.returnCase.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { items: { take: 3 } },
      }),
      prisma.returnItem.groupBy({
        by: ["reasonCode"],
        where: { returnCase: where },
        _count: true,
      }),
      prisma.returnCase.count({ where: { ...where, refundStatus: "refunded" } }),
      prisma.returnCase.count({ where: { ...where, fyndReturnNo: { not: null } } }),
      prisma.returnCase.count({ where: { ...where, status: "pending" } }),
      prisma.returnCase.count({ where: { ...where, status: "rejected" } }),
      prisma.returnItem.count({ where: { returnCase: where } }),
      prisma.returnCase.count({ where: whereAll }),
      prisma.returnCase.findMany({
        where: approvedWhere,
        select: { createdAt: true, updatedAt: true },
      }),
      prisma.returnCase.findMany({ where, select: { createdAt: true } }),
    ]);

    const statusMap = returnsByStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);
    const maxStatusCount = Math.max(...Object.values(statusMap), 1);

    const topReasons = reasonAggregation
      .filter((r) => r.reasonCode != null && String(r.reasonCode).trim() !== "")
      .map((r) => ({ reason: String(r.reasonCode), count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const dailyData: Record<string, number> = {};
    const daysDiff = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000));
    const numDays = Math.min(Math.max(daysDiff, 1), 90);
    for (let d = 0; d < numDays; d++) {
      const date = new Date(rangeStart);
      date.setDate(date.getDate() + d);
      const key = date.toISOString().slice(0, 10);
      dailyData[key] = 0;
    }
    returnsForDaily.forEach((r) => {
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

    let avgProcessingDays: number | null = null;
    if (approvedWithEvents.length >= 1) {
      const times: number[] = approvedWithEvents
        .map((rc) => {
          const created = new Date(rc.createdAt).getTime();
          const updated = new Date(rc.updatedAt).getTime();
          return (updated - created) / (24 * 60 * 60 * 1000);
        })
        .filter((t) => t >= 0);
      if (times.length > 0) {
        avgProcessingDays = times.reduce((a, b) => a + b, 0) / times.length;
      }
    }

    const portalUrl = `https://${session.shop}/apps/returns`;
    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    const prevPeriodStart = new Date(rangeStart);
    prevPeriodStart.setTime(prevPeriodStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    const prevPeriodWhere = {
      shopId: shop.id,
      createdAt: { gte: prevPeriodStart, lt: rangeStart },
    };
    const prevPeriodCount = await prisma.returnCase.count({ where: prevPeriodWhere });
    const periodChange =
      totalReturns > 0 && prevPeriodCount >= 0
        ? Math.round(((totalReturns - prevPeriodCount) / Math.max(prevPeriodCount, 1)) * 100)
        : 0;

    const suggestions = buildSuggestions({
      totalReturns,
      pendingCount,
      rejectedCount,
      approvedCount,
      topReasons,
      hasFyndConfig,
      fyndSyncedCount,
      refundedCount,
      avgProcessingDays,
      rangeLabel,
    });

    return {
      totalReturns,
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
      approvedCount,
      returnsOverTime,
      statusChartData,
      itemsCount,
      periodChange,
      rangeLabel,
      range,
      from: from ?? undefined,
      to: to ?? undefined,
      allTimeReturns,
      processingCount: (statusMap.processing ?? 0) + (statusMap["in progress"] ?? 0) + (statusMap.initiated ?? 0),
      cancelledCount: statusMap.cancelled ?? 0,
      suggestions,
      error: null,
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    return {
      totalReturns: 0,
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
      approvedCount: 0,
      returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
      statusChartData: [] as { name: string; value: number }[],
      itemsCount: 0,
      periodChange: 0,
      rangeLabel: "Last 30 days",
      range: "last_30_days",
      from: undefined,
      to: undefined,
      allTimeReturns: 0,
      processingCount: 0,
      cancelledCount: 0,
      suggestions: [] as { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[],
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
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    totalReturns,
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
    approvedCount,
    returnsOverTime,
    statusChartData,
    itemsCount,
    periodChange,
    rangeLabel,
    range,
    from,
    to,
    allTimeReturns,
    processingCount,
    cancelledCount,
    suggestions,
    error,
  } = useLoaderData<typeof loader>();

  const handleRangeChange = (newRange: DateRangePreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", newRange);
    if (newRange !== "custom") {
      next.delete("from");
      next.delete("to");
    }
    setSearchParams(next);
  };

  const handleCustomRange = (fromVal: string, toVal: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", "custom");
    next.set("from", fromVal);
    next.set("to", toVal);
    setSearchParams(next);
  };

  const approvalRate = totalReturns > 0 ? Math.round((approvedCount / totalReturns) * 100) : 0;

  return (
    <s-page heading="Dashboard">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            <p style={{ marginBottom: 8, fontWeight: 600 }}>⚠️ {error}</p>
            <p style={{ fontSize: 13, opacity: 0.9 }}>Some data may be unavailable. You can still use Returns, Settings, and the Customer Portal.</p>
          </div>
        )}

        {/* ─── Date range ─── */}
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
          marginBottom: 24, padding: "14px 20px",
          background: "var(--rpm-surface)", borderRadius: 14, border: "1px solid var(--rpm-border)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--rpm-text)" }}>📅 Period:</span>
          <select
            value={range}
            onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}
            style={{
              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--rpm-border)",
              fontSize: 14, fontWeight: 500, background: "var(--rpm-surface)",
              color: "var(--rpm-text)", minWidth: 160,
            }}
          >
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border)", fontSize: 14 }} />
              <span style={{ color: "var(--rpm-text-muted)" }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border)", fontSize: 14 }} />
            </>
          )}
          <span style={{ fontSize: 13, color: "var(--rpm-text-muted)" }}>{rangeLabel}</span>
          <Link to="/app/reports" style={{ marginLeft: "auto", fontSize: 14, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
            📊 View detailed reports →
          </Link>
        </div>

        {/* ─── Actionable Suggestions ─── */}
        {suggestions.length > 0 && (
          <div style={{ marginBottom: 24, display: "flex", flexDirection: "column", gap: 10 }}>
            {suggestions.map((s, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                flexWrap: "wrap", gap: 12, padding: "14px 18px", borderRadius: 12,
                background: s.type === "success" ? "#ecfdf5" : s.type === "warning" ? "#fffbeb" : "#eff6ff",
                border: `1px solid ${s.type === "success" ? "#a7f3d0" : s.type === "warning" ? "#fde68a" : "#bfdbfe"}`,
              }}>
                <span style={{
                  fontSize: 14, fontWeight: 500,
                  color: s.type === "success" ? "#047857" : s.type === "warning" ? "#92400e" : "#1e40af",
                }}>
                  {s.type === "success" ? "✅" : s.type === "warning" ? "⚠️" : "💡"} {s.message}
                </span>
                {s.action && s.actionUrl && (
                  <Link to={s.actionUrl} style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none", whiteSpace: "nowrap" }}>
                    {s.action} →
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ─── 5 Hero KPI Cards ─── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))", gap: 16, marginBottom: 28 }}>
          <Link to="/app/returns" style={{ textDecoration: "none" }}>
            <MetricCard label="Total returns" value={totalReturns} subtext={rangeLabel} trend={periodChange} icon="📦" />
          </Link>
          <Link to="/app/returns?status=pending" style={{ textDecoration: "none" }}>
            <MetricCard label="Needs review" value={pendingCount} color="#eab308" subtext="Awaiting action" icon="⏳" />
          </Link>
          <Link to="/app/returns?status=approved" style={{ textDecoration: "none" }}>
            <MetricCard label="Approved" value={approvedCount} color="#10b981" subtext={`${approvalRate}% rate`} icon="✅" />
          </Link>
          <MetricCard label="Refunded" value={refundedCount} color="#8b5cf6" subtext="Completed" icon="💰" />
          <MetricCard label="All time" value={allTimeReturns} subtext="Total ever" icon="📊" />
        </div>

        {/* ─── Quick Chart + Status at a Glance ─── */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 20, marginBottom: 28,
        }}>
          {/* Returns trend mini */}
          <div style={{
            background: "var(--rpm-surface)", borderRadius: 14, padding: 24,
            border: "1px solid var(--rpm-border)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Return trend</h3>
              <Link to="/app/reports" style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
                Full analytics →
              </Link>
            </div>
            <div style={{ height: 200 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
                      formatter={(value: number | undefined) => [value ?? 0, "Returns"]} />
                    <Area type="monotone" dataKey="returns" stroke="#3b82f6" strokeWidth={2} fill="url(#dashGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div style={{
                  height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--rpm-text-muted)", fontSize: 14, textAlign: "center", padding: 24
                }}>
                  <div>
                    <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.4 }}>📈</div>
                    No returns yet. Share your <Link to="/app/portal" style={{ color: "var(--rpm-accent)" }}>portal URL</Link> to get started.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Status at a glance */}
          <div style={{
            background: "var(--rpm-surface)", borderRadius: 14, padding: 24,
            border: "1px solid var(--rpm-border)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Status at a glance</h3>
            {Object.keys(statusMap).length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 14 }}>
                No returns in this period.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {Object.entries(statusMap)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => {
                    const pct = totalReturns > 0 ? Math.round((count / totalReturns) * 100) : 0;
                    return (
                      <Link key={status} to={`/app/returns?status=${encodeURIComponent(status)}`} style={{ textDecoration: "none", color: "inherit" }}>
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                            <span style={{ fontWeight: 600, textTransform: "capitalize", display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ width: 8, height: 8, borderRadius: "50%", background: getStatusColor(status), display: "inline-block" }} />
                              {status}
                            </span>
                            <span style={{ color: "var(--rpm-text-muted)", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{count} ({pct}%)</span>
                          </div>
                          <div style={{ height: 6, background: "var(--rpm-surface-elevated)", borderRadius: 3, overflow: "hidden" }}>
                            <div style={{
                              width: `${pct}%`, height: "100%", background: getStatusColor(status),
                              borderRadius: 3, minWidth: count > 0 ? 3 : 0, transition: "width 0.4s ease",
                            }} />
                          </div>
                        </div>
                      </Link>
                    );
                  })}
              </div>
            )}
          </div>
        </div>

        {/* ─── Recent Returns ─── */}
        <div style={{
          background: "var(--rpm-surface)", borderRadius: 14, padding: 24,
          border: "1px solid var(--rpm-border)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", marginBottom: 28,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Recent returns</h3>
            <Link to="/app/returns" style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
              View all →
            </Link>
          </div>
          {recentReturns.length === 0 ? (
            <div style={{
              padding: 40, textAlign: "center", background: "var(--rpm-surface-subtle)", borderRadius: 12,
              border: "1px dashed var(--rpm-border)",
            }}>
              <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }}>📦</div>
              <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: "var(--rpm-text)" }}>No returns yet</p>
              <p style={{ color: "var(--rpm-text-muted)", marginBottom: 16, fontSize: 14 }}>Returns will appear here when customers submit them via the portal.</p>
              <Link to="/app/portal"><s-button variant="primary">Share portal URL</s-button></Link>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--rpm-border)" }}>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Order</th>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Return #</th>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Created</th>
                    <th style={{ textAlign: "right", padding: "10px 12px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {recentReturns.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--rpm-surface-elevated)" }}>
                      <td style={{ padding: "12px" }}>
                        <Link to={`/app/returns/${r.id}`} style={{ fontWeight: 600, color: "var(--rpm-text)", textDecoration: "none" }}>
                          {r.shopifyOrderName || r.id}
                        </Link>
                      </td>
                      <td style={{ padding: "12px" }}>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600,
                          background: `${getStatusColor(r.status)}18`, color: getStatusColor(r.status),
                          textTransform: "capitalize",
                        }}>
                          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: "12px", color: "var(--rpm-text-muted)", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                        {(r as { returnRequestNo?: string | null }).returnRequestNo || r.fyndReturnNo || "—"}
                      </td>
                      <td style={{ padding: "12px", color: "var(--rpm-text-muted)" }}>
                        {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                      </td>
                      <td style={{ padding: "12px", textAlign: "right" }}>
                        <Link to={`/app/returns/${r.id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
                          View →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ─── Quick Actions + Portal URL ─── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20 }}>
          <div style={{
            background: "var(--rpm-surface)", borderRadius: 14, padding: 24,
            border: "1px solid var(--rpm-border)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Quick actions</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <Link to="/app/returns"><s-button variant="primary">View all returns</s-button></Link>
              <Link to="/app/reports"><s-button variant="secondary">📊 Reports</s-button></Link>
              <Link to={hasFyndConfig ? "/app/settings" : "/app/settings/integrations"}>
                <s-button variant="secondary">{hasFyndConfig ? "⚙️ Settings" : "🔗 Configure Fynd"}</s-button>
              </Link>
              <Link to="/app/portal"><s-button variant="secondary">🌐 Portal</s-button></Link>
            </div>
          </div>

          <div style={{
            background: "var(--rpm-surface)", borderRadius: 14, padding: 24,
            border: "1px solid var(--rpm-border)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}>
            <h3 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 700, color: "var(--rpm-text)" }}>Customer portal</h3>
            <p style={{ marginBottom: 14, color: "var(--rpm-text-muted)", fontSize: 13 }}>Share this URL so customers can initiate and track returns.</p>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <code style={{
                padding: "10px 14px", background: "var(--rpm-surface-subtle)", borderRadius: 8,
                fontSize: 12, flex: "1 1 240px", overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", border: "1px solid var(--rpm-border)",
                fontFamily: "ui-monospace, monospace", color: "var(--rpm-accent)",
              }}>{portalUrl}</code>
              <s-button variant="secondary" onClick={() => navigator.clipboard.writeText(portalUrl)}>Copy</s-button>
            </div>
          </div>
        </div>

        {/* ─── Fynd Integration Notice ─── */}
        {!hasFyndConfig && (
          <div style={{
            marginTop: 28, padding: 24, background: "#fffbeb", borderRadius: 14,
            border: "1px solid #fcd34d",
          }}>
            <p style={{ marginBottom: 8, fontWeight: 700, color: "#92400e", fontSize: 15 }}>
              🔗 Connect Fynd for reverse logistics
            </p>
            <p style={{ marginBottom: 16, color: "#92400e", fontSize: 14, opacity: 0.9 }}>
              Fynd handles return pickups, tracking, and delivery. Configure your credentials to automate the entire return flow.
            </p>
            <Link to="/app/settings/integrations"><s-button variant="primary">Configure Fynd</s-button></Link>
          </div>
        )}
      </div>
    </s-page>
  );
}
