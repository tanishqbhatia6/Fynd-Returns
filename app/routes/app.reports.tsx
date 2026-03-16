import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, useRouteError, isRouteErrorResponse } from "react-router";
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
      approvedNotRefundedCount, resolutionAgg, retainedCases, greenReturnCount,
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
      prisma.returnCase.groupBy({ by: ["resolutionType"], where, _count: true }),
      prisma.returnCase.findMany({
        where: { ...where, resolutionType: { in: ["exchange", "store_credit"] }, refundJson: { not: null } },
        select: { refundJson: true },
      }),
      prisma.returnCase.count({ where: { ...where, isGreenReturn: true } }),
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
        date: new Intl.DateTimeFormat(shop?.settings?.shopLocale || "en", { month: "short", day: "numeric", year: "2-digit" }).format(new Date(date)),
        returns: count,
        fullDate: date,
      }));

    const statusChartData = Object.entries(statusMap)
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));

    const resolutionMap = resolutionAgg.reduce(
      (acc, x) => ({ ...acc, [x.resolutionType]: x._count }),
      {} as Record<string, number>,
    );
    const resolutionChartData = [
      { name: "Refund", value: resolutionMap.refund ?? 0, color: "#8B5CF6" },
      { name: "Exchange", value: resolutionMap.exchange ?? 0, color: "#3B82F6" },
      { name: "Store Credit", value: resolutionMap.store_credit ?? 0, color: "#14b8a6" },
      { name: "Replacement", value: resolutionMap.replacement ?? 0, color: "#F59E0B" },
    ].filter((d) => d.value > 0);

    let revenueRetained = 0;
    for (const rc of retainedCases) {
      try {
        const parsed = JSON.parse(rc.refundJson ?? "{}");
        revenueRetained += parseFloat(parsed.amount ?? "0") || 0;
      } catch { /* skip */ }
    }

    let avgProcessingDays: number | null = null;
    if (approvedWithEvents.length >= 1) {
      const times = approvedWithEvents
        .map((rc) => (new Date(rc.updatedAt).getTime() - new Date(rc.createdAt).getTime()) / (24 * 60 * 60 * 1000))
        .filter((t) => t >= 0);
      if (times.length > 0) avgProcessingDays = times.reduce((a, b) => a + b, 0) / times.length;
    }

    // Revenue analytics queries
    const [refundedCasesForRevenue, topProductsByReturns, customerReturnFrequency] = await Promise.all([
      prisma.returnCase.findMany({
        where: { ...where, status: { in: ["approved", "completed"] }, refundJson: { not: null } },
        select: { refundJson: true, currency: true },
      }),
      prisma.returnItem.groupBy({
        by: ["title"],
        where: { returnCase: where, title: { not: null } },
        _count: { title: true },
        orderBy: { _count: { title: "desc" } },
        take: 10,
      }),
      prisma.returnCase.groupBy({
        by: ["customerEmailNorm"],
        where: { ...where, customerEmailNorm: { not: null } },
        _count: { customerEmailNorm: true },
        orderBy: { _count: { customerEmailNorm: "desc" } },
        take: 10,
      }),
    ]);

    // Sum refund amounts
    let totalRefundAmount = 0;
    const refundMethodCounts: Record<string, number> = {};
    for (const rc of refundedCasesForRevenue) {
      try {
        const parsed = JSON.parse(rc.refundJson ?? "{}");
        const amt = parseFloat(parsed.amount ?? "0");
        if (Number.isFinite(amt) && amt > 0) totalRefundAmount += amt;
        const method = String(parsed.method ?? "unknown");
        refundMethodCounts[method] = (refundMethodCounts[method] ?? 0) + 1;
      } catch { /* skip */ }
    }

    const topProductsData = topProductsByReturns
      .filter((r) => r.title != null)
      .map((r) => ({ title: String(r.title), count: r._count.title }));

    const customerFrequencyData = customerReturnFrequency
      .filter((r) => r.customerEmailNorm != null)
      .map((r) => ({ email: String(r.customerEmailNorm), count: r._count.customerEmailNorm }));

    const refundMethodBreakdown = Object.entries(refundMethodCounts)
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count);

    // ── NEW: Retention & fraud KPIs ──
    const resolvedCount = (resolutionMap.refund ?? 0) + (resolutionMap.exchange ?? 0) + (resolutionMap.store_credit ?? 0) + (resolutionMap.replacement ?? 0);
    const exchangeConversionRate = resolvedCount > 0 ? Math.round(((resolutionMap.exchange ?? 0) / resolvedCount) * 100) : 0;
    const revenueRetainedRate = (revenueRetained + totalRefundAmount) > 0
      ? Math.round((revenueRetained / (revenueRetained + totalRefundAmount)) * 100) : 0;

    const [uniqueCustomerCount, repeatCustomerCases] = await Promise.all([
      prisma.returnCase.groupBy({ by: ["customerEmailNorm"], where: { ...where, customerEmailNorm: { not: null } }, _count: true }).then(r => r.length),
      prisma.returnCase.groupBy({
        by: ["customerEmailNorm"],
        where: { ...where, customerEmailNorm: { not: null } },
        _count: true,
        having: { customerEmailNorm: { _count: { gt: 1 } } },
      }),
    ]);
    const repeatCustomerCount = repeatCustomerCases.length;
    const repeatReturnerRate = uniqueCustomerCount > 0 ? Math.round((repeatCustomerCount / uniqueCustomerCount) * 100) : 0;

    // Fraud risk summary
    const [highRiskCount, criticalRiskCount] = await Promise.all([
      prisma.returnCase.count({ where: { ...where, fraudRiskLevel: "high" } }),
      prisma.returnCase.count({ where: { ...where, fraudRiskLevel: "critical" } }),
    ]);
    const fraudAlertCount = highRiskCount + criticalRiskCount;

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
      resolutionChartData, revenueRetained, greenReturnCount,
      shopLocale: shop?.settings?.shopLocale ?? "en",
      shopCurrency: shop?.settings?.shopCurrency ?? "USD",
      shopTimezone: shop?.settings?.shopTimezone ?? "UTC",
      // Revenue analytics
      totalRefundAmount,
      topProductsData,
      customerFrequencyData,
      refundMethodBreakdown,
      // Phase 1 new KPIs
      exchangeConversionRate,
      revenueRetainedRate,
      repeatReturnerRate,
      uniqueCustomerCount,
      repeatCustomerCount,
      resolvedCount,
      fraudAlertCount,
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
      resolutionChartData: [] as { name: string; value: number; color: string }[],
      revenueRetained: 0, greenReturnCount: 0,
      shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC",
      totalRefundAmount: 0,
      topProductsData: [] as { title: string; count: number }[],
      customerFrequencyData: [] as { email: string; count: number }[],
      refundMethodBreakdown: [] as { method: string; count: number }[],
      exchangeConversionRate: 0,
      revenueRetainedRate: 0,
      repeatReturnerRate: 0,
      uniqueCustomerCount: 0,
      repeatCustomerCount: 0,
      resolvedCount: 0,
      fraudAlertCount: 0,
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
    resolutionChartData, revenueRetained, greenReturnCount,
    shopLocale, shopCurrency, shopTimezone,
    totalRefundAmount, topProductsData, customerFrequencyData, refundMethodBreakdown,
    exchangeConversionRate, revenueRetainedRate, repeatReturnerRate,
    uniqueCustomerCount, repeatCustomerCount, resolvedCount, fraudAlertCount,
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

  const CS = "dashboard-chart-panel"; // reuse dashboard card class

  return (
    <s-page fullWidth heading="Reports & Analytics">
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
        <div className="dashboard-date-bar">
          <select value={range} onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}>
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")} />
              <span className="text-muted" style={{ fontSize: 12 }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)} />
            </>
          )}
          <span className="text-muted" style={{ fontSize: 12 }}>{rangeLabel}</span>
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
        <div className="dashboard-kpi-grid mb-md">
          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#3B82F6" } as React.CSSProperties}>
            <div className="kpi-label">Total Returns</div>
            <div className="kpi-row">
              <span className="kpi-value">{totalReturns}</span>
              {periodChange !== 0 && (
                <span className={`kpi-change ${periodChange > 0 ? "kpi-change--up" : "kpi-change--down"}`}>
                  {periodChange > 0 ? "↑" : "↓"} {Math.abs(periodChange)}%
                </span>
              )}
            </div>
            <div className="kpi-meta">{rangeLabel}</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#10B981" } as React.CSSProperties}>
            <div className="kpi-label">Approval Rate</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#10B981" }}>{approvalRate}%</span>
            </div>
            <div className="kpi-meta">{approvedCount} of {totalReturns}</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#F59E0B" } as React.CSSProperties}>
            <div className="kpi-label">Avg Processing</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#F59E0B" }}>
                {avgProcessingDays != null ? `${avgProcessingDays.toFixed(1)}d` : "—"}
              </span>
            </div>
            <div className="kpi-meta">Request → Approval</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#8B5CF6" } as React.CSSProperties}>
            <div className="kpi-label">Refund Rate</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#8B5CF6" }}>{refundRate}%</span>
            </div>
            <div className="kpi-meta">{refundedCount} refunded</div>
          </div>
        </div>

        {/* ── Retention Performance KPIs ── */}
        <div className="dashboard-kpi-grid mb-md">
          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#14b8a6" } as React.CSSProperties}>
            <div className="kpi-label">Exchange Conversion</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#14b8a6" }}>{exchangeConversionRate}%</span>
            </div>
            <div className="kpi-meta">{resolutionChartData.find(d => d.name === "Exchange")?.value ?? 0} of {resolvedCount} resolved</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#059669" } as React.CSSProperties}>
            <div className="kpi-label">Revenue Retained</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#059669" }}>{revenueRetainedRate}%</span>
            </div>
            <div className="kpi-meta">Exchanges + store credit vs refunds</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#f97316" } as React.CSSProperties}>
            <div className="kpi-label">Repeat Returners</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#f97316" }}>{repeatReturnerRate}%</span>
            </div>
            <div className="kpi-meta">{repeatCustomerCount} of {uniqueCustomerCount} customers</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": fraudAlertCount > 0 ? "#DC2626" : "#94a3b8" } as React.CSSProperties}>
            <div className="kpi-label">Fraud Alerts</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: fraudAlertCount > 0 ? "#DC2626" : "#94a3b8" }}>{fraudAlertCount}</span>
            </div>
            <div className="kpi-meta">High + Critical risk returns</div>
          </div>
        </div>

        {/* ── Charts: Trend + Distribution ── */}
        <div className="dashboard-chart-row mb-md">
          <div className={CS}>
            <div className="panel-header">
              <h3 className="panel-title">Return volume trend</h3>
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
                <div className="chart-empty">No returns during this period.</div>
              )}
            </div>
          </div>

          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Status distribution</h3>
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
                <div className="chart-empty">No data for this period.</div>
              )}
            </div>
          </div>
        </div>

        {/* ── Performance Gauges — fixed 4-column (or 3 if no Fynd) ── */}
        <div style={{
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
            <div key={i} className={CS} style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 20px" }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <ProgressRing value={g.value} size={64} strokeWidth={6} color={g.color} />
                <div style={{
                  position: "absolute", inset: 0, display: "flex", alignItems: "center",
                  justifyContent: "center", fontSize: 16, fontWeight: 700, color: g.color,
                }}>{g.value}%</div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-text, #0f172a)", marginBottom: 2 }}>{g.label} rate</div>
                <div className="text-muted" style={{ fontSize: 11 }}>{g.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Resolution Breakdown ── */}
        <div className="dashboard-chart-row mb-md">
          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Resolution breakdown</h3>
            <div style={{ height: 240, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {resolutionChartData.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: "100%" }}>
                  <ResponsiveContainer width={160} height={160}>
                    <PieChart>
                      <Pie data={resolutionChartData} cx="50%" cy="50%" innerRadius={48} outerRadius={72} paddingAngle={2} dataKey="value" nameKey="name">
                        {resolutionChartData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 12 }}
                        formatter={((value: number | undefined, _: string | undefined, props: { payload?: { value: number } }) => {
                          const total = resolutionChartData.reduce((a, d) => a + d.value, 0);
                          const pct = total > 0 && props.payload ? Math.round((props.payload.value / total) * 100) : 0;
                          return [`${value ?? 0} (${pct}%)`, ""];
                        }) as never} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center" }}>
                    {resolutionChartData.map((d, i) => {
                      const total = resolutionChartData.reduce((a, x) => a + x.value, 0);
                      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 }} />
                          <span style={{ color: "var(--rpm-text-muted)" }}>{d.name}</span>
                          <span style={{ fontWeight: 700 }}>{d.value}</span>
                          <span style={{ color: "var(--rpm-text-muted)", fontSize: 11 }}>({pct}%)</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="chart-empty">No resolution data for this period.</div>
              )}
            </div>
          </div>

          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Revenue impact</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "12px 0" }}>
              <div>
                <div className="kpi-label">Revenue retained</div>
                <div className="kpi-row">
                  <span className="kpi-value" style={{ fontSize: 32, color: "#059669" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueRetained)}
                  </span>
                </div>
                <div className="kpi-meta" style={{ marginTop: 4 }}>
                  From exchanges and store credit resolutions instead of refunds
                </div>
              </div>

              <div style={{ borderTop: "1px solid #E2E8F0", paddingTop: 16 }}>
                <div className="kpi-label">Green returns</div>
                <div className="kpi-row">
                  <span className="kpi-value" style={{ color: "#06B6D4" }}>{greenReturnCount}</span>
                  <span className="kpi-meta">
                    {totalReturns > 0 ? `${Math.round((greenReturnCount / totalReturns) * 100)}% of total` : ""}
                  </span>
                </div>
                <div className="kpi-meta" style={{ marginTop: 4 }}>
                  Returns where customer kept the item
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Top Reasons + Status Table — side by side ── */}
        <div className="dashboard-chart-row mb-md">
          <div className={CS}>
            <div className="panel-header">
              <h3 className="panel-title">Top return reasons</h3>
              <Link to="/app/settings/rules" className="panel-link">Manage →</Link>
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
              <div className="chart-empty">
                No return reasons recorded. Add reasons in Settings → Policy Rules.
              </div>
            )}
          </div>

          <div className={CS}>
            <div className="panel-header">
              <h3 className="panel-title">Status breakdown</h3>
              <Link to="/app/returns" className="panel-link">View all →</Link>
            </div>
            {Object.keys(statusMap).length === 0 ? (
              <div className="chart-empty">No returns in this period.</div>
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
          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Key insights</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {approvalRate >= 80 && (
                <div className="dashboard-suggestion dashboard-suggestion--success">
                  <strong>High approval rate ({approvalRate}%)</strong> — Return policy is well-calibrated.
                </div>
              )}
              {approvalRate > 0 && approvalRate < 50 && (
                <div className="dashboard-suggestion dashboard-suggestion--warning">
                  <strong>Low approval rate ({approvalRate}%)</strong> — Review return policy to improve customer satisfaction.
                </div>
              )}
              {avgProcessingDays !== null && avgProcessingDays > 3 && (
                <div className="dashboard-suggestion dashboard-suggestion--warning">
                  <strong>Avg processing: {avgProcessingDays.toFixed(1)} days</strong> — Consider faster approvals for better retention.
                </div>
              )}
              {avgProcessingDays !== null && avgProcessingDays <= 1 && (
                <div className="dashboard-suggestion dashboard-suggestion--success">
                  <strong>Fast processing ({avgProcessingDays.toFixed(1)}d)</strong> — Returns are being resolved quickly.
                </div>
              )}
              {approvedNotRefundedCount > 0 && (
                <div className="dashboard-suggestion dashboard-suggestion--info">
                  <strong>{approvedNotRefundedCount} approved return{approvedNotRefundedCount > 1 ? "s" : ""} awaiting refund</strong> — Process refunds to complete the cycle.
                </div>
              )}
              {topReasons.length > 0 && topReasons[0].count >= 2 && (
                <div className="dashboard-suggestion dashboard-suggestion--info">
                  <strong>Top reason: &ldquo;{topReasons[0].reason}&rdquo;</strong> ({topReasons[0].count}x) — Investigate potential product or description issue.
                </div>
              )}
              {periodChange > 50 && (
                <div className="dashboard-suggestion dashboard-suggestion--warning">
                  <strong>Returns up {periodChange}%</strong> vs previous period — Monitor for product or fulfillment issues.
                </div>
              )}
              {periodChange < -20 && (
                <div className="dashboard-suggestion dashboard-suggestion--success">
                  <strong>Returns down {Math.abs(periodChange)}%</strong> — Return rate is decreasing.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Revenue Impact ── */}
        {(totalRefundAmount > 0 || refundMethodBreakdown.length > 0) && (
          <div className="dashboard-chart-row" style={{ marginTop: 20 }}>
            <div className={CS}>
              <h3 className="panel-title" style={{ marginBottom: 14 }}>Revenue Impact</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div className="flex-between">
                  <span className="kpi-meta">Total refunds issued</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#DC2626" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(totalRefundAmount)}
                  </span>
                </div>
                <div className="flex-between">
                  <span className="kpi-meta">Revenue retained (credit/exchange)</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#059669" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueRetained)}
                  </span>
                </div>
              </div>
            </div>
            {refundMethodBreakdown.length > 0 && (
              <div className={CS}>
                <h3 className="panel-title" style={{ marginBottom: 14 }}>Refund Method Breakdown</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {refundMethodBreakdown.map((item) => (
                    <div key={item.method} className="flex-between">
                      <span className="kpi-meta" style={{ textTransform: "capitalize" }}>{item.method.replace(/_/g, " ")}</span>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{item.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Top Products by Returns ── */}
        {topProductsData.length > 0 && (
          <div className={CS} style={{ marginTop: 20 }}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Top 10 Products by Return Count</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topProductsData.map((item, idx) => {
                const maxCount = topProductsData[0]?.count || 1;
                const pct = Math.round((item.count / maxCount) * 100);
                return (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="text-muted text-tabular" style={{ fontSize: 11, fontWeight: 700, width: 18, textAlign: "right" }}>{idx + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex-between" style={{ marginBottom: 2 }}>
                        <span className="text-truncate" style={{ fontSize: 12, fontWeight: 500, maxWidth: "70%" }}>{item.title}</span>
                        <span className="text-tabular" style={{ fontSize: 12, fontWeight: 700 }}>{item.count}</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 3, background: "#E5E7EB" }}>
                        <div style={{ height: "100%", borderRadius: 3, background: "#3B82F6", width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Customer Return Frequency ── */}
        {customerFrequencyData.length > 0 && customerFrequencyData[0].count >= 2 && (
          <div className={CS} style={{ marginTop: 20 }}>
            <h3 className="panel-title" style={{ marginBottom: 4 }}>Top Customers by Return Frequency</h3>
            <div className="kpi-meta" style={{ marginBottom: 12 }}>Customers with the highest return counts in this period</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {customerFrequencyData.filter(c => c.count >= 2).map((item, idx) => (
                <div key={idx} className="flex-between" style={{ padding: "6px 10px", borderRadius: 8, background: item.count >= 3 ? "#FEF2F2" : "#F9FAFB" }}>
                  <span style={{ fontSize: 12, color: item.count >= 3 ? "#DC2626" : "var(--rpm-text-muted)" }}>{item.email}</span>
                  <span className="status-badge" style={{ color: item.count >= 3 ? "#DC2626" : "#374151", background: item.count >= 3 ? "#FEE2E2" : "#E5E7EB" }}>{item.count} returns</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Summary footer ── */}
        <div className="settings-summary-bar" style={{ marginTop: 20, justifyContent: "center" }}>
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

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <s-page fullWidth heading="Reports">
      <div className="app-content">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a href="/app/reports" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</a>
        </div>
      </div>
    </s-page>
  );
}
