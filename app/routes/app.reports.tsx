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
      totalReturns, returnsByStatus, reasonAggregation,
      refundedCount, fyndSyncedCount, pendingCount, rejectedCount,
      itemsCount, allTimeReturns, approvedWithEvents, returnsForDaily,
      approvedNotRefundedCount,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.groupBy({ by: ["status"], where, _count: true }),
      prisma.returnItem.groupBy({ by: ["reasonCode"], where: { returnCase: where }, _count: true }),
      prisma.returnCase.count({ where: { ...where, status: { in: ["approved", "completed"] }, refundStatus: "refunded" } }),
      prisma.returnCase.count({ where: { ...where, status: { in: ["approved", "completed"] }, OR: [{ fyndReturnNo: { not: null } }, { fyndReturnId: { not: null } }, { fyndShipmentId: { not: null } }] } }),
      prisma.returnCase.count({ where: { ...where, status: "pending" } }),
      prisma.returnCase.count({ where: { ...where, status: "rejected" } }),
      prisma.returnItem.count({ where: { returnCase: where } }),
      prisma.returnCase.count({ where: whereAll }),
      prisma.returnCase.findMany({ where: approvedWhere, select: { createdAt: true, updatedAt: true } }),
      prisma.returnCase.findMany({ where, select: { createdAt: true, status: true } }),
      prisma.returnCase.count({ where: { ...where, status: "approved", OR: [{ refundStatus: null }, { refundStatus: { not: "refunded" } }] } }),
    ]);

    const statusMap = returnsByStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);

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

    const prevPeriodStart = new Date(rangeStart);
    prevPeriodStart.setTime(prevPeriodStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    const prevPeriodCount = await prisma.returnCase.count({
      where: { shopId: shop.id, createdAt: { gte: prevPeriodStart, lt: rangeStart } },
    });
    const periodChange = totalReturns > 0 && prevPeriodCount >= 0
      ? Math.round(((totalReturns - prevPeriodCount) / Math.max(prevPeriodCount, 1)) * 100) : 0;

    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    return {
      totalReturns, statusMap, topReasons, refundedCount, fyndSyncedCount,
      pendingCount, rejectedCount, approvedCount, approvedNotRefundedCount,
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
      rejectedCount: 0, approvedCount: 0, approvedNotRefundedCount: 0,
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

function ProgressRing({ value, size = 80, strokeWidth = 7, color = "#3b82f6" }: {
  value: number; size?: number; strokeWidth?: number; color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="#F1F5F9" strokeWidth={strokeWidth} />
      <circle cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" style={{ transition: "stroke-dashoffset 0.6s ease" }} />
    </svg>
  );
}

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    totalReturns, statusMap, topReasons, refundedCount, fyndSyncedCount,
    pendingCount, rejectedCount, approvedCount, approvedNotRefundedCount,
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
  const refundRate = approvedCount > 0 ? Math.round((refundedCount / approvedCount) * 100) : 0;
  const avgItemsPerReturn = totalReturns > 0 ? (itemsCount / totalReturns).toFixed(1) : "0";
  const fyndSyncRate = approvedCount > 0 ? Math.round((fyndSyncedCount / approvedCount) * 100) : 0;

  const exportParams = new URLSearchParams({ range: range ?? "last_30_days" });
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  const exportUrl = `/api/returns/export?${exportParams.toString()}`;

  const maxReasonCount = topReasons.length > 0 ? Math.max(...topReasons.map((r) => r.count)) : 1;

  const cardStyle: React.CSSProperties = {
    background: "var(--rpm-surface, white)", borderRadius: 14, padding: 22,
    border: "var(--rpm-border, 1px solid #e5e7eb)",
  };

  return (
    <s-page heading="Reports & Analytics">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
            <p style={{ fontWeight: 600, fontSize: 14 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: "middle", marginRight: 4 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              {error}
            </p>
          </div>
        )}

        {/* ── Date range + Export ── */}
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10,
          marginBottom: 20, padding: "12px 18px",
          background: "var(--rpm-surface, white)", borderRadius: 12,
          border: "var(--rpm-border, 1px solid #e5e7eb)",
        }}>
          <select
            value={range}
            onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}
            style={{
              padding: "7px 12px", borderRadius: 8, border: "1px solid #E2E8F0",
              fontSize: 13, fontWeight: 500, background: "#F8FAFC", color: "var(--rpm-text, #0f172a)",
            }}
          >
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")}
                style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 13 }} />
              <span style={{ color: "var(--rpm-text-muted)", fontSize: 12 }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)}
                style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 13 }} />
            </>
          )}
          <span style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)" }}>{rangeLabel}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <a href={exportUrl} download style={{ textDecoration: "none" }}>
              <s-button variant="secondary">Export CSV</s-button>
            </a>
            <Link to="/app" style={{ textDecoration: "none" }}>
              <s-button variant="secondary">Dashboard</s-button>
            </Link>
          </div>
        </div>

        {/* ── KPI Cards — 4 columns ── */}
        <div className="dashboard-kpi-grid" style={{ marginBottom: 20 }}>
          <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#3B82F6", opacity: 0.7 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Total Returns</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 28, fontWeight: 800, color: "var(--rpm-text, #0f172a)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{totalReturns}</span>
              {periodChange !== 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 700,
                  color: periodChange > 0 ? "#DC2626" : "#059669",
                  background: periodChange > 0 ? "#FEF2F2" : "#ECFDF5",
                  padding: "2px 7px", borderRadius: 5,
                  border: `1px solid ${periodChange > 0 ? "#FECACA" : "#A7F3D0"}`,
                }}>
                  {periodChange > 0 ? "↑" : "↓"} {Math.abs(periodChange)}%
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>{rangeLabel}</div>
          </div>

          <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#10B981", opacity: 0.7 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Approval Rate</div>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#10B981", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{approvalRate}%</span>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>{approvedCount} of {totalReturns}</div>
          </div>

          <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#F59E0B", opacity: 0.7 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Avg Processing</div>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#F59E0B", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {avgProcessingDays != null ? `${avgProcessingDays.toFixed(1)}d` : "—"}
            </span>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>Request → Approval</div>
          </div>

          <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#8B5CF6", opacity: 0.7 }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Refund Rate</div>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#8B5CF6", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{refundRate}%</span>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>{refundedCount} refunded</div>
          </div>
        </div>

        {/* ── Charts: Trend + Distribution ── */}
        <div className="dashboard-chart-row" style={{ marginBottom: 20 }}>
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Return volume trend</h3>
            </div>
            <div style={{ height: 240 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                    <defs>
                      <linearGradient id="rptGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
                      formatter={(value: number | undefined) => [value ?? 0, "Returns"]}
                      labelFormatter={(label) => `${label}`}
                    />
                    <Area type="monotone" dataKey="returns" stroke="#3b82f6" strokeWidth={2} fill="url(#rptGrad)"
                      dot={returnsOverTime.length < 15 ? { r: 3, fill: "#3b82f6" } : false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
                  No returns during this period.
                </div>
              )}
            </div>
          </div>

          <div style={cardStyle}>
            <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Status distribution</h3>
            <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {statusChartData.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
                  <ResponsiveContainer width={160} height={160}>
                    <PieChart>
                      <Pie data={statusChartData} cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={2} dataKey="value" nameKey="name">
                        {statusChartData.map((entry, i) => (
                          <Cell key={i} fill={getStatusColor(entry.name.toLowerCase())} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 12 }}
                        formatter={((value: number | undefined, _: string | undefined, props: { payload?: { value: number } }) => {
                          const total = statusChartData.reduce((a, d) => a + d.value, 0);
                          const pct = total > 0 && props.payload ? Math.round((props.payload.value / total) * 100) : 0;
                          return [`${value ?? 0} (${pct}%)`, ""];
                        }) as never} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center" }}>
                    {statusChartData.map((d, i) => {
                      const total = statusChartData.reduce((a, x) => a + x.value, 0);
                      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: getStatusColor(d.name.toLowerCase()), flexShrink: 0 }} />
                          <span style={{ color: "var(--rpm-text-muted)" }}>{d.name}</span>
                          <span style={{ fontWeight: 700 }}>{d.value}</span>
                          <span style={{ color: "var(--rpm-text-muted)", fontSize: 11 }}>({pct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ color: "var(--rpm-text-muted)", fontSize: 13 }}>No data for this period.</div>
              )}
            </div>
          </div>
        </div>

        {/* ── Performance Gauges — fixed 4-column (or 3 if no Fynd) ── */}
        <div className="dashboard-gauge-grid" style={{
          display: "grid",
          gridTemplateColumns: hasFyndConfig ? "repeat(4, 1fr)" : "repeat(3, 1fr)",
          gap: 14, marginBottom: 20,
        }}>
          {[
            { label: "Approval", value: approvalRate, color: "#10B981", desc: `${approvedCount} of ${totalReturns}` },
            { label: "Rejection", value: rejectionRate, color: "#EF4444", desc: `${rejectedCount} of ${totalReturns}` },
            { label: "Refund", value: refundRate, color: "#8B5CF6", desc: `${refundedCount} of ${approvedCount} approved` },
            ...(hasFyndConfig ? [{ label: "Fynd Sync", value: fyndSyncRate, color: "#06B6D4", desc: `${fyndSyncedCount} of ${approvedCount}` }] : []),
          ].map((g, i) => (
            <div key={i} style={{
              ...cardStyle, display: "flex", alignItems: "center", gap: 16, padding: "18px 20px",
            }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <ProgressRing value={g.value} size={64} strokeWidth={6} color={g.color} />
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", fontSize: 16, fontWeight: 700, color: g.color,
                }}>{g.value}%</div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-text, #0f172a)", marginBottom: 2 }}>{g.label} rate</div>
                <div style={{ fontSize: 11, color: "var(--rpm-text-muted, #64748b)" }}>{g.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Top Reasons + Status Table — side by side ── */}
        <div className="dashboard-chart-row" style={{ marginBottom: 20 }}>
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Top return reasons</h3>
              <Link to="/app/settings/rules" style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none" }}>
                Manage →
              </Link>
            </div>
            {topReasons.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {topReasons.map((r, i) => {
                  const pct = Math.round((r.count / maxReasonCount) * 100);
                  return (
                    <div key={i}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{r.reason}</span>
                        <span style={{ fontWeight: 700, color: "var(--rpm-text, #0f172a)", fontVariantNumeric: "tabular-nums" }}>{r.count}</span>
                      </div>
                      <div style={{ height: 6, background: "#F1F5F9", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{
                          width: `${pct}%`, height: "100%", borderRadius: 3, minWidth: r.count > 0 ? 3 : 0,
                          background: CHART_PALETTE[i % CHART_PALETTE.length],
                          transition: "width 0.4s ease",
                        }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: 24, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
                No return reasons recorded. Add reasons in Settings → Policy Rules.
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Status breakdown</h3>
              <Link to="/app/returns" style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none" }}>
                View all →
              </Link>
            </div>
            {Object.keys(statusMap).length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
                No returns in this period.
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #F1F5F9" }}>
                      <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Status</th>
                      <th style={{ textAlign: "right", padding: "8px 10px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Count</th>
                      <th style={{ textAlign: "right", padding: "8px 10px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>%</th>
                      <th style={{ padding: "8px 10px", minWidth: 80 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(statusMap)
                      .sort(([, a], [, b]) => b - a)
                      .map(([status, count]) => {
                        const pct = totalReturns > 0 ? Math.round((count / totalReturns) * 100) : 0;
                        return (
                          <tr key={status} style={{ borderBottom: "1px solid #F8FAFC" }}>
                            <td style={{ padding: "10px" }}>
                              <Link to={`/app/returns?status=${encodeURIComponent(status)}`} style={{ textDecoration: "none", color: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: getStatusColor(status), flexShrink: 0 }} />
                                <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{status}</span>
                              </Link>
                            </td>
                            <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{count}</td>
                            <td style={{ padding: "10px", textAlign: "right", color: "var(--rpm-text-muted)", fontVariantNumeric: "tabular-nums" }}>{pct}%</td>
                            <td style={{ padding: "10px" }}>
                              <div style={{ height: 5, background: "#F1F5F9", borderRadius: 3, overflow: "hidden" }}>
                                <div style={{ width: `${pct}%`, height: "100%", background: getStatusColor(status), borderRadius: 3, minWidth: count > 0 ? 3 : 0, transition: "width 0.4s ease" }} />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    <tr style={{ borderTop: "2px solid #E2E8F0" }}>
                      <td style={{ padding: "10px", fontWeight: 700, fontSize: 12 }}>Total</td>
                      <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{totalReturns}</td>
                      <td style={{ padding: "10px", textAlign: "right", fontWeight: 700, color: "var(--rpm-text-muted)" }}>100%</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ── Key Insights ── */}
        {totalReturns > 0 && (
          <div style={cardStyle}>
            <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Key insights</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {approvalRate >= 80 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#ECFDF5", border: "1px solid #A7F3D0", fontSize: 13, color: "#047857" }}>
                  <strong>High approval rate ({approvalRate}%)</strong> — Return policy is well-calibrated.
                </div>
              )}
              {approvalRate > 0 && approvalRate < 50 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 13, color: "#B91C1C" }}>
                  <strong>Low approval rate ({approvalRate}%)</strong> — Review return policy to improve customer satisfaction.
                </div>
              )}
              {avgProcessingDays !== null && avgProcessingDays > 3 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#FFFBEB", border: "1px solid #FDE68A", fontSize: 13, color: "#92400E" }}>
                  <strong>Avg processing: {avgProcessingDays.toFixed(1)} days</strong> — Consider faster approvals for better retention.
                </div>
              )}
              {avgProcessingDays !== null && avgProcessingDays <= 1 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#ECFDF5", border: "1px solid #A7F3D0", fontSize: 13, color: "#047857" }}>
                  <strong>Fast processing ({avgProcessingDays.toFixed(1)}d)</strong> — Returns are being resolved quickly.
                </div>
              )}
              {approvedNotRefundedCount > 0 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#EFF6FF", border: "1px solid #BFDBFE", fontSize: 13, color: "#1E40AF" }}>
                  <strong>{approvedNotRefundedCount} approved return{approvedNotRefundedCount > 1 ? "s" : ""} awaiting refund</strong> — Process refunds to complete the cycle.
                </div>
              )}
              {topReasons.length > 0 && topReasons[0].count >= 2 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#EFF6FF", border: "1px solid #BFDBFE", fontSize: 13, color: "#1E40AF" }}>
                  <strong>Top reason: "{topReasons[0].reason}"</strong> ({topReasons[0].count}x) — Investigate potential product or description issue.
                </div>
              )}
              {periodChange > 50 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#FEF2F2", border: "1px solid #FECACA", fontSize: 13, color: "#B91C1C" }}>
                  <strong>Returns up {periodChange}%</strong> vs previous period — Monitor for product or fulfillment issues.
                </div>
              )}
              {periodChange < -20 && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "#ECFDF5", border: "1px solid #A7F3D0", fontSize: 13, color: "#047857" }}>
                  <strong>Returns down {Math.abs(periodChange)}%</strong> — Return rate is decreasing.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Summary footer ── */}
        <div style={{
          marginTop: 20, padding: "14px 18px", borderRadius: 12,
          background: "#F8FAFC", border: "1px solid #E2E8F0",
          display: "flex", flexWrap: "wrap", gap: "6px 20px", justifyContent: "center",
          fontSize: 12, color: "var(--rpm-text-muted, #64748b)",
        }}>
          <span><strong>{allTimeReturns}</strong> total returns (all time)</span>
          <span>·</span>
          <span><strong>{itemsCount}</strong> items returned ({rangeLabel})</span>
          <span>·</span>
          <span>~<strong>{avgItemsPerReturn}</strong> items per return</span>
        </div>
      </div>
    </s-page>
  );
}
