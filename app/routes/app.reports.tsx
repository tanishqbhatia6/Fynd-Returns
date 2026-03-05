import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange, DATE_RANGE_OPTIONS, type DateRangePreset } from "../lib/dashboard-date-utils";
import { getStatusColor } from "../lib/status-colors";
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

const CHART_PALETTE = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#94a3b8", "#8b5cf6", "#06b6d4", "#f43f5e"];

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
    const where = { shopId: shop.id, createdAt: { gte: rangeStart, lte: rangeEnd } };
    const whereAll = { shopId: shop.id };

    const approvedStatuses = ["approved", "completed"];
    const approvedWhere = { ...where, status: { in: approvedStatuses } };

    const [
      totalReturns,
      returnsByStatus,
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
      prisma.returnItem.groupBy({ by: ["reasonCode"], where: { returnCase: where }, _count: true }),
      prisma.returnCase.count({ where: { ...where, refundStatus: "refunded" } }),
      prisma.returnCase.count({ where: { ...where, fyndReturnNo: { not: null } } }),
      prisma.returnCase.count({ where: { ...where, status: "pending" } }),
      prisma.returnCase.count({ where: { ...where, status: "rejected" } }),
      prisma.returnItem.count({ where: { returnCase: where } }),
      prisma.returnCase.count({ where: whereAll }),
      prisma.returnCase.findMany({ where: approvedWhere, select: { createdAt: true, updatedAt: true } }),
      prisma.returnCase.findMany({ where, select: { createdAt: true, status: true } }),
    ]);

    const statusMap = returnsByStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);
    const processingCount = (statusMap.processing ?? 0) + (statusMap["in progress"] ?? 0) + (statusMap.initiated ?? 0);
    const cancelledCount = statusMap.cancelled ?? 0;

    const topReasons = reasonAggregation
      .filter((r) => r.reasonCode != null && String(r.reasonCode).trim() !== "")
      .map((r) => ({ reason: String(r.reasonCode), count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Daily data
    const dailyData: Record<string, number> = {};
    const daysDiff = Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000));
    const numDays = Math.min(Math.max(daysDiff, 1), 90);
    for (let d = 0; d < numDays; d++) {
      const date = new Date(rangeStart);
      date.setDate(date.getDate() + d);
      dailyData[date.toISOString().slice(0, 10)] = 0;
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
      const times = approvedWithEvents
        .map((rc) => (new Date(rc.updatedAt).getTime() - new Date(rc.createdAt).getTime()) / (24 * 60 * 60 * 1000))
        .filter((t) => t >= 0);
      if (times.length > 0) avgProcessingDays = times.reduce((a, b) => a + b, 0) / times.length;
    }

    // Previous period comparison
    const prevPeriodStart = new Date(rangeStart);
    prevPeriodStart.setTime(prevPeriodStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    const prevPeriodWhere = { shopId: shop.id, createdAt: { gte: prevPeriodStart, lt: rangeStart } };
    const prevPeriodCount = await prisma.returnCase.count({ where: prevPeriodWhere });
    const periodChange = totalReturns > 0 && prevPeriodCount >= 0
      ? Math.round(((totalReturns - prevPeriodCount) / Math.max(prevPeriodCount, 1)) * 100) : 0;

    // Daily status breakdown for stacked data
    const dailyStatusData: Record<string, Record<string, number>> = {};
    for (const key of Object.keys(dailyData)) {
      dailyStatusData[key] = {};
    }
    returnsForDaily.forEach((r) => {
      const key = new Date(r.createdAt).toISOString().slice(0, 10);
      const st = (r.status || "pending").toLowerCase();
      if (dailyStatusData[key]) {
        dailyStatusData[key][st] = (dailyStatusData[key][st] || 0) + 1;
      }
    });

    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    return {
      totalReturns, statusMap, topReasons, refundedCount, fyndSyncedCount,
      pendingCount, rejectedCount, approvedCount, processingCount, cancelledCount,
      itemsCount, allTimeReturns, returnsOverTime, statusChartData,
      avgProcessingDays, periodChange, rangeLabel, range,
      from: from ?? undefined, to: to ?? undefined, hasFyndConfig, error: null,
    };
  } catch (err) {
    console.error("Reports loader error:", err);
    return {
      totalReturns: 0, statusMap: {} as Record<string, number>,
      topReasons: [] as { reason: string; count: number }[],
      refundedCount: 0, fyndSyncedCount: 0, pendingCount: 0,
      rejectedCount: 0, approvedCount: 0, processingCount: 0, cancelledCount: 0,
      itemsCount: 0, allTimeReturns: 0,
      returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
      statusChartData: [] as { name: string; value: number }[],
      avgProcessingDays: null, periodChange: 0,
      rangeLabel: "Last 30 days", range: "last_30_days",
      from: undefined, to: undefined, hasFyndConfig: false,
      error: "Failed to load reports. Please try again.",
    };
  }
};

// ── Reusable Components ──

function KpiCard({ label, value, subtext, icon, trend, accent }: {
  label: string; value: string | number; subtext?: string; icon: React.ReactNode; trend?: number; accent?: string;
}) {
  const col = accent || "var(--rpm-accent, #3b82f6)";
  return (
    <div style={{
      padding: "20px 18px", background: "var(--rpm-surface, white)", borderRadius: 14,
      border: "1px solid var(--rpm-border, #e5e7eb)", position: "relative", overflow: "hidden",
      boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: col, opacity: 0.7 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ display: "flex", alignItems: "center" }}>{icon}</span>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--rpm-text-muted, #64748b)" }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: col, display: "flex", alignItems: "baseline", gap: 8 }}>
        {value}
        {trend !== undefined && trend !== 0 && (
          <span style={{ fontSize: 12, fontWeight: 600, color: trend > 0 ? "#ef4444" : "#10b981", background: trend > 0 ? "#fef2f2" : "#ecfdf5", padding: "2px 8px", borderRadius: 6 }}>
            {trend > 0 ? `↑ ${trend}%` : `↓ ${Math.abs(trend)}%`}
          </span>
        )}
      </div>
      {subtext && <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)", marginTop: 4 }}>{subtext}</div>}
    </div>
  );
}

function ChartCard({ title, subtitle, children, action }: {
  title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div style={{
      background: "var(--rpm-surface, white)", borderRadius: 16, padding: "24px 20px",
      border: "1px solid var(--rpm-border, #e5e7eb)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>{title}</h3>
          {subtitle && <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--rpm-text-muted, #64748b)" }}>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div style={{
      height: "100%", minHeight: 200, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", color: "var(--rpm-text-muted, #64748b)",
      fontSize: 14, textAlign: "center", padding: 32,
    }}>
      <span style={{ marginBottom: 12, opacity: 0.5, display: "flex", alignItems: "center", justifyContent: "center" }}>{icon}</span>
      <p style={{ margin: 0, maxWidth: 260 }}>{message}</p>
    </div>
  );
}

function ProgressRing({ value, size = 90, strokeWidth = 8, color = "#3b82f6" }: {
  value: number; size?: number; strokeWidth?: number; color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="var(--rpm-surface-elevated, #f1f5f9)" strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.6s ease" }} />
    </svg>
  );
}

// ── Main Component ──

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    totalReturns, statusMap, topReasons, refundedCount, fyndSyncedCount,
    pendingCount, rejectedCount, approvedCount, processingCount, cancelledCount,
    itemsCount, allTimeReturns, returnsOverTime, statusChartData,
    avgProcessingDays, periodChange, rangeLabel, range, from, to,
    hasFyndConfig, error,
  } = useLoaderData<typeof loader>();

  const handleRangeChange = (newRange: DateRangePreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", newRange);
    if (newRange !== "custom") { next.delete("from"); next.delete("to"); }
    setSearchParams(next);
  };

  const handleCustomRange = (fromVal: string, toVal: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", "custom"); next.set("from", fromVal); next.set("to", toVal);
    setSearchParams(next);
  };

  const approvalRate = totalReturns > 0 ? Math.round((approvedCount / totalReturns) * 100) : 0;
  const rejectionRate = totalReturns > 0 ? Math.round((rejectedCount / totalReturns) * 100) : 0;
  const refundRate = totalReturns > 0 ? Math.round((refundedCount / totalReturns) * 100) : 0;
  const avgItemsPerReturn = totalReturns > 0 ? (itemsCount / totalReturns).toFixed(1) : "0";
  const fyndSyncRate = approvedCount > 0 ? Math.round((fyndSyncedCount / approvedCount) * 100) : 0;

  const exportParams = new URLSearchParams({ range: range ?? "last_30_days" });
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  const exportUrl = `/api/returns/export?${exportParams.toString()}`;

  const maxReasonCount = topReasons.length > 0 ? Math.max(...topReasons.map((r) => r.count)) : 1;

  return (
    <s-page heading="Reports & Analytics">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            <p style={{ fontWeight: 600, marginBottom: 4 }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:"middle",marginRight:4}}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> {error}</p>
            <p style={{ fontSize: 13, opacity: 0.9 }}>Some charts may not load. You can still use Returns, Settings, and the Customer Portal.</p>
          </div>
        )}

        {/* ─── Date range + Export bar ─── */}
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
          marginBottom: 28, padding: "14px 20px", background: "var(--rpm-surface, white)",
          borderRadius: 14, border: "1px solid var(--rpm-border, #e5e7eb)",
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--rpm-text, #0f172a)" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{verticalAlign:"middle",marginRight:4}}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> Reporting period:</span>
          <select
            value={range}
            onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}
            style={{
              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--rpm-border, #e5e7eb)",
              fontSize: 14, fontWeight: 500, background: "var(--rpm-surface, white)",
              color: "var(--rpm-text, #0f172a)", minWidth: 160,
            }}
          >
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border, #e5e7eb)", fontSize: 14 }} />
              <span style={{ color: "var(--rpm-text-muted, #64748b)" }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border, #e5e7eb)", fontSize: 14 }} />
            </>
          )}
          <span style={{ fontSize: 13, color: "var(--rpm-text-muted, #64748b)" }}>{rangeLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <a href={exportUrl} download style={{ textDecoration: "none" }}>
              <s-button variant="secondary">Export CSV</s-button>
            </a>
            <Link to="/app" style={{ textDecoration: "none" }}>
              <s-button variant="secondary">← Dashboard</s-button>
            </Link>
          </div>
        </div>

        {/* ─── KPI Summary Row ─── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 16, marginBottom: 28 }}>
          <KpiCard label="Total Returns" value={totalReturns} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>} trend={periodChange} subtext={rangeLabel} accent="#3b82f6" />
          <KpiCard label="Approval Rate" value={`${approvalRate}%`} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>} subtext={`${approvedCount} of ${totalReturns}`} accent="#10b981" />
          <KpiCard label="Avg Processing" value={avgProcessingDays != null ? `${avgProcessingDays.toFixed(1)}d` : "—"} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} subtext="Request → Approval" accent="#f59e0b" />
          <KpiCard label="Refund Rate" value={`${refundRate}%`} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>} subtext={`${refundedCount} refunded`} accent="#8b5cf6" />
          <KpiCard label="Items Returned" value={itemsCount} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>} subtext={`~${avgItemsPerReturn} per return`} accent="#06b6d4" />
        </div>

        {/* ─── Charts: Trend + Distribution ─── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 20, marginBottom: 28 }}>
          <ChartCard title="Return volume trend" subtitle="Daily return requests over the selected period">
            <div style={{ height: 280 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rptGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 13, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}
                      formatter={(value: number | undefined) => [value ?? 0, "Returns"]}
                      labelFormatter={(label) => `Date: ${label}`}
                    />
                    <Area type="monotone" dataKey="returns" stroke="#3b82f6" strokeWidth={2.5} fill="url(#rptGrad)" dot={returnsOverTime.length < 15 ? { r: 3, fill: "#3b82f6" } : false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>} message="No returns during this period. Adjust the date range to see trends." />
              )}
            </div>
          </ChartCard>

          <ChartCard title="Status distribution" subtitle="Breakdown of return statuses">
            <div style={{ height: 280, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {statusChartData.length > 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 24, width: "100%" }}>
                  <div style={{ flex: "0 0 180px" }}>
                    <ResponsiveContainer width={180} height={180}>
                      <PieChart>
                        <Pie data={statusChartData} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={2} dataKey="value" nameKey="name">
                          {statusChartData.map((entry, i) => (
                            <Cell key={i} fill={getStatusColor(entry.name.toLowerCase())} />
                          ))}
                        </Pie>
                        <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 13 }}
                          formatter={((value: number | undefined, _: string | undefined, props: { payload?: { value: number } }) => {
                            const total = statusChartData.reduce((a, d) => a + d.value, 0);
                            const pct = total > 0 && props.payload ? Math.round((props.payload.value / total) * 100) : 0;
                            return [`${value ?? 0} (${pct}%)`, ""];
                          }) as never} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                    {statusChartData.map((d, i) => {
                      const total = statusChartData.reduce((a, x) => a + x.value, 0);
                      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: getStatusColor(d.name.toLowerCase()), flexShrink: 0 }} />
                          <span style={{ fontSize: 13, flex: 1 }}>{d.name}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, minWidth: 28, textAlign: "right" }}>{d.value}</span>
                          <span style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)", minWidth: 36, textAlign: "right" }}>{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <EmptyState icon={<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>} message="No status data available for this period." />
              )}
            </div>
          </ChartCard>
        </div>

        {/* ─── Performance Gauges ─── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 20, marginBottom: 28 }}>
          {[
            { label: "Approval Rate", value: approvalRate, color: "#10b981", desc: `${approvedCount} approved of ${totalReturns}` },
            { label: "Rejection Rate", value: rejectionRate, color: "#ef4444", desc: `${rejectedCount} rejected of ${totalReturns}` },
            { label: "Refund Rate", value: refundRate, color: "#8b5cf6", desc: `${refundedCount} refunded of ${totalReturns}` },
            ...(hasFyndConfig ? [{ label: "Fynd Sync Rate", value: fyndSyncRate, color: "#06b6d4", desc: `${fyndSyncedCount} synced of ${approvedCount} approved` }] : []),
          ].map((g, i) => (
            <div key={i} style={{
              background: "var(--rpm-surface, white)", borderRadius: 14,
              border: "1px solid var(--rpm-border, #e5e7eb)", padding: "24px 20px",
              display: "flex", flexDirection: "column", alignItems: "center",
              textAlign: "center", boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}>
              <div style={{ position: "relative", marginBottom: 12 }}>
                <ProgressRing value={g.value} color={g.color} />
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", fontSize: 20, fontWeight: 700, color: g.color,
                }}>{g.value}%</div>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{g.label}</div>
              <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)" }}>{g.desc}</div>
            </div>
          ))}
        </div>

        {/* ─── Top Return Reasons ─── */}
        <ChartCard
          title="Top return reasons"
          subtitle="Most common reasons customers request returns"
          action={
            <Link to="/app/settings/rules" style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent, #3b82f6)", textDecoration: "none" }}>
              Manage reasons →
            </Link>
          }
        >
          {topReasons.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {topReasons.map((r, i) => {
                const pct = Math.round((r.count / maxReasonCount) * 100);
                return (
                  <div key={i}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{r.reason}</span>
                      <span style={{ fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>{r.count}</span>
                    </div>
                    <div style={{ height: 8, background: "var(--rpm-surface-elevated, #f1f5f9)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        width: `${pct}%`, height: "100%", borderRadius: 4, minWidth: r.count > 0 ? 4 : 0,
                        background: `linear-gradient(90deg, ${CHART_PALETTE[i % CHART_PALETTE.length]}, ${CHART_PALETTE[(i + 1) % CHART_PALETTE.length]})`,
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState icon={<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>} message="No return reasons recorded yet. Add specific reasons in Settings → Policy Rules for better insights." />
          )}
        </ChartCard>

        <div style={{ height: 28 }} />

        {/* ─── Detailed Status Table ─── */}
        <ChartCard
          title="Status breakdown"
          subtitle="Click any status to view those returns"
          action={
            <Link to="/app/returns" style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent, #3b82f6)", textDecoration: "none" }}>
              View all returns →
            </Link>
          }
        >
          {Object.keys(statusMap).length === 0 ? (
            <EmptyState icon={<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>} message="No returns in the selected period. Try expanding the date range." />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--rpm-border, #e5e7eb)" }}>
                    <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Status</th>
                    <th style={{ textAlign: "right", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>Count</th>
                    <th style={{ textAlign: "right", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>% of Total</th>
                    <th style={{ padding: "10px 12px", minWidth: 180 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(statusMap)
                    .sort(([, a], [, b]) => b - a)
                    .map(([status, count]) => {
                      const pct = totalReturns > 0 ? Math.round((count / totalReturns) * 100) : 0;
                      return (
                        <tr key={status} style={{ borderBottom: "1px solid var(--rpm-surface-elevated, #f1f5f9)" }}>
                          <td style={{ padding: "12px" }}>
                            <Link to={`/app/returns?status=${encodeURIComponent(status)}`} style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: getStatusColor(status) }} />
                              <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{status}</span>
                            </Link>
                          </td>
                          <td style={{ padding: "12px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{count}</td>
                          <td style={{ padding: "12px", textAlign: "right", color: "var(--rpm-text-muted)", fontVariantNumeric: "tabular-nums" }}>{pct}%</td>
                          <td style={{ padding: "12px" }}>
                            <div style={{ height: 6, background: "var(--rpm-surface-elevated, #f1f5f9)", borderRadius: 3, overflow: "hidden" }}>
                              <div style={{ width: `${pct}%`, height: "100%", background: getStatusColor(status), borderRadius: 3, minWidth: count > 0 ? 3 : 0, transition: "width 0.4s ease" }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  <tr style={{ borderTop: "2px solid var(--rpm-border, #e5e7eb)", fontWeight: 700 }}>
                    <td style={{ padding: "12px" }}>Total</td>
                    <td style={{ padding: "12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{totalReturns}</td>
                    <td style={{ padding: "12px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>100%</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </ChartCard>

        <div style={{ height: 28 }} />

        {/* ─── Key Insights ─── */}
        <ChartCard title="Key insights" subtitle="Automated observations based on your data">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {totalReturns === 0 ? (
              <EmptyState icon={<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14"/></svg>} message="No data to generate insights. Returns will be analyzed as they come in." />
            ) : (
              <>
                {approvalRate >= 80 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", fontSize: 14, color: "#047857" }}>
                    <strong>High approval rate ({approvalRate}%)</strong> — Your return policy is well-calibrated. Customers are submitting valid requests.
                  </div>
                )}
                {approvalRate > 0 && approvalRate < 50 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 14, color: "#b91c1c" }}>
                    <strong>Low approval rate ({approvalRate}%)</strong> — Consider reviewing your return policy. A high rejection rate may hurt customer satisfaction.
                  </div>
                )}
                {avgProcessingDays !== null && avgProcessingDays > 3 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fffbeb", border: "1px solid #fde68a", fontSize: 14, color: "#92400e" }}>
                    <strong>Avg processing: {avgProcessingDays.toFixed(1)} days</strong> — Consider speeding up approvals. Faster processing improves customer retention.
                  </div>
                )}
                {avgProcessingDays !== null && avgProcessingDays <= 1 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", fontSize: 14, color: "#047857" }}>
                    <strong>Fast processing ({avgProcessingDays.toFixed(1)} days)</strong> — Great job! Your team is resolving returns quickly.
                  </div>
                )}
                {refundedCount === 0 && approvedCount > 0 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: 14, color: "#1e40af" }}>
                    <strong>{approvedCount} approved returns awaiting refund</strong> — Process refunds in Shopify to complete the return cycle.
                  </div>
                )}
                {topReasons.length > 0 && topReasons[0].count >= 2 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: 14, color: "#1e40af" }}>
                    <strong>Top reason: "{topReasons[0].reason}"</strong> ({topReasons[0].count} times) — This might indicate a product quality or description issue worth investigating.
                  </div>
                )}
                {periodChange > 50 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 14, color: "#b91c1c" }}>
                    <strong>Returns up {periodChange}% vs previous period</strong> — Monitor if this trend continues. Could indicate a product or fulfillment issue.
                  </div>
                )}
                {periodChange < -20 && (
                  <div style={{ padding: "12px 16px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", fontSize: 14, color: "#047857" }}>
                    <strong>Returns down {Math.abs(periodChange)}%</strong> — Great trend! Your return rate is decreasing compared to the previous period.
                  </div>
                )}
              </>
            )}
          </div>
        </ChartCard>
      </div>
    </s-page>
  );
}
