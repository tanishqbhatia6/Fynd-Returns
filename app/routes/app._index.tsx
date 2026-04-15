import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, isRouteErrorResponse, useRouteError } from "react-router";
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
} from "recharts";

function buildSuggestions(data: {
  totalReturns: number;
  pendingCount: number;
  rejectedCount: number;
  approvedCount: number;
  approvedNotRefundedCount: number;
  topReasons: { reason: string; count: number }[];
  hasFyndConfig: boolean;
  fyndSyncedCount: number;
  refundedCount: number;
  avgProcessingDays: number | null;
  rangeLabel: string;
}): { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[] {
  const suggestions: { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[] = [];

  if (data.totalReturns === 0) return suggestions;

  if (data.pendingCount > 0) {
    suggestions.push({
      type: "warning",
      message: `${data.pendingCount} return${data.pendingCount > 1 ? "s" : ""} pending review.`,
      action: "Review now",
      actionUrl: "/app/returns?status=pending",
    });
  }

  if (data.hasFyndConfig && data.approvedCount > 0 && data.fyndSyncedCount < data.approvedCount) {
    suggestions.push({
      type: "warning",
      message: `${data.approvedCount - data.fyndSyncedCount} approved return${data.approvedCount - data.fyndSyncedCount > 1 ? "s" : ""} not synced to Fynd.`,
      action: "View returns",
      actionUrl: "/app/returns",
    });
  }

  if (data.approvedNotRefundedCount > 0) {
    suggestions.push({
      type: "info",
      message: `${data.approvedNotRefundedCount} approved return${data.approvedNotRefundedCount > 1 ? "s" : ""} awaiting refund.`,
      action: "View returns",
      actionUrl: "/app/returns?status=approved",
    });
  }

  if (data.avgProcessingDays !== null && data.avgProcessingDays > 5 && data.approvedCount >= 2) {
    suggestions.push({
      type: "warning",
      message: `Average processing time is ${Math.round(data.avgProcessingDays)} days.`,
      action: "View pending",
      actionUrl: "/app/returns?status=pending",
    });
  }

  const topReason = data.topReasons[0];
  if (topReason && (topReason.reason === "Other" || topReason.reason === "other") && data.totalReturns >= 2) {
    suggestions.push({
      type: "info",
      message: "Many returns use 'Other' as reason. Add specific reasons in settings.",
      action: "Settings",
      actionUrl: "/app/settings/return-settings",
    });
  }

  return suggestions.slice(0, 3);
}

let lastSessionCleanup = 0;
const SESSION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const range = url.searchParams.get("range") || "last_30_days";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (Date.now() - lastSessionCleanup > SESSION_CLEANUP_INTERVAL_MS) {
    lastSessionCleanup = Date.now();
    prisma.lookupSession.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    }).catch((err: unknown) => console.warn("[cleanup] Failed to clean expired sessions:", err));
    prisma.fyndWebhookLog.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
    }).catch((err: unknown) => console.warn("[cleanup] Failed to clean old webhook logs:", err));
  }

  import("../lib/fynd-retry.server").then(({ runFyndRetryQueue }) =>
    runFyndRetryQueue().catch((err: unknown) => console.warn("[retry] Queue error:", err))
  );
  import("../lib/fynd-status-poll.server").then(({ pollStaleReturns }) =>
    pollStaleReturns().catch((err: unknown) => console.warn("[poll] Status poll error:", err))
  );

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
      totalReturns, returnsByStatus, recentReturns, reasonAggregation,
      refundedCount, fyndSyncedCount, pendingCount, rejectedCount,
      allTimeReturns, approvedWithEvents, returnsForDaily, approvedNotRefundedCount,
      greenReturnCount, resolutionAgg, retainedCases, blocklistCount,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.groupBy({ by: ["status"], where, _count: true }),
      prisma.returnCase.findMany({ where, orderBy: { createdAt: "desc" }, take: 8, include: { items: { take: 3 } } }),
      prisma.returnItem.groupBy({ by: ["reasonCode"], where: { returnCase: where }, _count: true }),
      prisma.returnCase.count({ where: { ...where, status: { in: ["approved", "completed"] }, refundStatus: "refunded" } }),
      prisma.returnCase.count({ where: { ...where, status: { in: ["approved", "completed"] }, OR: [{ fyndReturnNo: { not: null } }, { fyndReturnId: { not: null } }, { fyndShipmentId: { not: null } }] } }),
      prisma.returnCase.count({ where: { ...where, status: "pending" } }),
      prisma.returnCase.count({ where: { ...where, status: "rejected" } }),
      prisma.returnCase.count({ where: whereAll }),
      prisma.returnCase.findMany({ where: approvedWhere, select: { createdAt: true, updatedAt: true }, take: 500, orderBy: { createdAt: "desc" } }),
      prisma.returnCase.findMany({ where, select: { createdAt: true }, take: 5000, orderBy: { createdAt: "desc" } }),
      prisma.returnCase.count({ where: { ...where, status: "approved", OR: [{ refundStatus: null }, { refundStatus: { not: "refunded" } }] } }),
      prisma.returnCase.count({ where: { ...where, isGreenReturn: true } }),
      prisma.returnCase.groupBy({ by: ["resolutionType"], where, _count: true }),
      prisma.returnCase.findMany({
        where: { ...where, resolutionType: { in: ["exchange", "store_credit"] }, refundJson: { not: null } },
        select: { refundJson: true },
        take: 2000,
        orderBy: { createdAt: "desc" },
      }),
      shop.settings ? prisma.blocklistEntry.count({ where: { settingsId: shop.settings.id } }) : Promise.resolve(0),
    ]);

    // Determine the dominant currency from actual return data (not shop settings which may be wrong)
    const currencyAgg = await prisma.returnCase.groupBy({
      by: ["currency"],
      where: { shopId: shop.id, currency: { not: null } },
      _count: true,
      orderBy: { _count: { currency: "desc" } },
      take: 1,
    });
    const dominantCurrency = currencyAgg[0]?.currency || shop?.settings?.shopCurrency || "USD";

    // Revenue at Risk: sum price*qty for items in initiated/pending/approved cases last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const atRiskItems = await prisma.returnItem.findMany({
      where: {
        returnCase: {
          shopId: shop.id,
          createdAt: { gte: thirtyDaysAgo },
          status: { in: ["initiated", "pending", "approved"] },
        },
      },
      select: { price: true, qty: true },
      take: 3000,
    });
    let revenueAtRisk = 0;
    for (const item of atRiskItems) {
      const p = item.price ? parseFloat(item.price) : 0;
      if (Number.isFinite(p) && p > 0) revenueAtRisk += p * item.qty;
    }

    const statusMap = returnsByStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);

    let revenueRetained = 0;
    for (const rc of retainedCases) {
      try {
        const parsed = JSON.parse(rc.refundJson ?? "{}");
        revenueRetained += parseFloat(parsed.amount ?? "0") || 0;
      } catch { /* skip */ }
    }

    const resolutionMap = resolutionAgg.reduce(
      (acc, x) => ({ ...acc, [x.resolutionType]: x._count }),
      {} as Record<string, number>,
    );
    const resolvedTotal = Object.values(resolutionMap).reduce((a, b) => a + b, 0);
    const exchangeRate = resolvedTotal > 0
      ? Math.round(((resolutionMap.exchange ?? 0) / resolvedTotal) * 100)
      : 0;

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

    let avgProcessingDays: number | null = null;
    if (approvedWithEvents.length >= 1) {
      const times = approvedWithEvents
        .map((rc) => (new Date(rc.updatedAt).getTime() - new Date(rc.createdAt).getTime()) / (24 * 60 * 60 * 1000))
        .filter((t) => t >= 0);
      if (times.length > 0) avgProcessingDays = times.reduce((a, b) => a + b, 0) / times.length;
    }

    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    const prevPeriodStart = new Date(rangeStart);
    prevPeriodStart.setTime(prevPeriodStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    const prevPeriodCount = await prisma.returnCase.count({
      where: { shopId: shop.id, createdAt: { gte: prevPeriodStart, lt: rangeStart } },
    });
    const periodChange = totalReturns > 0 && prevPeriodCount >= 0
      ? Math.round(((totalReturns - prevPeriodCount) / Math.max(prevPeriodCount, 1)) * 100)
      : 0;

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const overdueCount = await prisma.returnCase.count({
      where: { shopId: shop.id, status: { in: ["initiated", "pending"] }, createdAt: { lt: threeDaysAgo } },
    });

    // Fraud alerts: returns from high/critical risk customers in the period
    // Wrapped in try/catch so a missing column doesn't crash the entire dashboard
    let fraudAlertReturns: { id: string; customerName: string | null; customerEmailNorm: string | null; fraudRiskLevel: string | null; fraudRiskScore: number | null; shopifyOrderName: string | null }[] = [];
    let fraudAlertCount = 0;
    try {
      fraudAlertReturns = await prisma.returnCase.findMany({
        where: { ...where, fraudRiskLevel: { in: ["high", "critical"] } },
        select: { id: true, customerName: true, customerEmailNorm: true, fraudRiskLevel: true, fraudRiskScore: true, shopifyOrderName: true },
        orderBy: { fraudRiskScore: "desc" },
        take: 5,
      });
      fraudAlertCount = await prisma.returnCase.count({
        where: { ...where, fraudRiskLevel: { in: ["high", "critical"] } },
      });
    } catch (err) {
      console.warn("[dashboard] Fraud alert query failed (columns may not exist yet):", err);
    }

    const suggestions = buildSuggestions({
      totalReturns, pendingCount, rejectedCount, approvedCount,
      approvedNotRefundedCount,
      topReasons, hasFyndConfig, fyndSyncedCount, refundedCount,
      avgProcessingDays, rangeLabel,
    });

    return {
      totalReturns, statusMap, approvedCount, topReasons, recentReturns,
      hasFyndConfig, shopDomain: session.shop, refundedCount, pendingCount,
      rejectedCount, returnsOverTime, periodChange, rangeLabel, range,
      from: from ?? undefined, to: to ?? undefined, allTimeReturns,
      suggestions, error: null,
      revenueRetained, exchangeRate, greenReturnCount, blocklistCount,
      resolutionMap, revenueAtRisk, overdueCount,
      shopLocale: shop?.settings?.shopLocale ?? "en",
      shopCurrency: dominantCurrency,
      shopTimezone: shop?.settings?.shopTimezone ?? "UTC",
      fraudAlertCount,
      fraudAlertReturns: fraudAlertReturns as { id: string; customerName: string | null; customerEmailNorm: string | null; fraudRiskLevel: string | null; fraudRiskScore: number | null; shopifyOrderName: string | null }[],
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    return {
      totalReturns: 0, statusMap: {} as Record<string, number>, approvedCount: 0,
      topReasons: [] as { reason: string; count: number }[],
      recentReturns: [] as Awaited<ReturnType<typeof prisma.returnCase.findMany>>,
      hasFyndConfig: false, shopDomain: session.shop, refundedCount: 0,
      pendingCount: 0, rejectedCount: 0,
      returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
      periodChange: 0, rangeLabel: "Last 30 days", range: "last_30_days",
      from: undefined, to: undefined, allTimeReturns: 0,
      suggestions: [] as { type: "info" | "warning" | "success"; message: string; action?: string; actionUrl?: string }[],
      error: "Failed to load dashboard data. Please refresh or try again later.",
      revenueRetained: 0, exchangeRate: 0, greenReturnCount: 0, blocklistCount: 0,
      resolutionMap: {} as Record<string, number>, revenueAtRisk: 0, overdueCount: 0,
      shopLocale: "en", shopCurrency: "USD", shopTimezone: "UTC",
      fraudAlertCount: 0,
      fraudAlertReturns: [] as { id: string; customerName: string | null; customerEmailNorm: string | null; fraudRiskLevel: string | null; fraudRiskScore: number | null; shopifyOrderName: string | null }[],
    };
  }
};

export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    totalReturns, statusMap, approvedCount, recentReturns,
    hasFyndConfig, refundedCount, pendingCount, rejectedCount,
    returnsOverTime, periodChange, rangeLabel, range, from, to,
    allTimeReturns, suggestions, error,
    revenueRetained, exchangeRate, greenReturnCount, blocklistCount,
    resolutionMap, revenueAtRisk, overdueCount, shopLocale, shopCurrency, shopTimezone,
    fraudAlertCount, fraudAlertReturns,
  } = useLoaderData<typeof loader>();

  const handleRangeChange = (newRange: DateRangePreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", newRange);
    if (newRange !== "custom") { next.delete("from"); next.delete("to"); }
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
    <s-page fullWidth heading="Dashboard">
      <div className="app-content layout-wide" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error mb-md">
            <p style={{ fontWeight: 600, fontSize: 14 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: "middle", marginRight: 4 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              {error}
            </p>
          </div>
        )}

        {/* ── Dashboard Toolbar ── */}
        <div className="dashboard-date-bar">
          <div className="dashboard-toolbar-context">
            <span className="dashboard-toolbar-label">Overview</span>
            <span className="dashboard-toolbar-separator" />
          </div>
          <select value={range} onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}>
            {DATE_RANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")} />
              <span style={{ color: "var(--rpm-text-muted)", fontSize: 12 }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)} />
            </>
          )}
          <span style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>{rangeLabel}</span>
          <Link to="/app/reports" className="panel-link" style={{ marginLeft: "auto", fontSize: 13 }}>
            Full reports →
          </Link>
        </div>

        {/* ── Suggestions ── */}
        {suggestions.length > 0 && (
          <div className="dashboard-suggestions">
            {suggestions.map((s, i) => (
              <div key={i} className={`dashboard-suggestion dashboard-suggestion--${s.type}`}>
                <span className="suggestion-icon">
                  {s.type === "warning" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  )}
                  {s.message}
                </span>
                {s.action && s.actionUrl && (
                  <Link to={s.actionUrl} className="suggestion-action">
                    {s.action} →
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── KPI Cards Row 1 ── */}
        <div className="dashboard-kpi-grid mb-md">
          <Link to="/app/returns" className="dashboard-kpi-card" style={{ "--kpi-accent": "var(--rpm-accent, #3B82F6)" } as React.CSSProperties}>
            <div className="kpi-label">Total returns</div>
            <div className="kpi-row">
              <span className="kpi-value">{new Intl.NumberFormat(shopLocale || "en").format(totalReturns)}</span>
              {periodChange !== 0 && (
                <span className={`kpi-change ${periodChange > 0 ? "kpi-change--up" : "kpi-change--down"}`}>
                  {periodChange > 0 ? "↑" : "↓"} {Math.abs(periodChange)}%
                </span>
              )}
            </div>
            <div className="kpi-meta">{rangeLabel}</div>
          </Link>

          <Link to="/app/returns?status=pending" className="dashboard-kpi-card" style={{ "--kpi-accent": "#EAB308" } as React.CSSProperties}>
            <div className="kpi-label">Needs review</div>
            <span className="kpi-value" style={{ color: pendingCount > 0 ? "#EAB308" : undefined }}>{pendingCount}</span>
            <div className="kpi-meta">{pendingCount > 0 ? "Awaiting action" : "All clear"}</div>
          </Link>

          <Link to="/app/returns?status=approved" className="dashboard-kpi-card" style={{ "--kpi-accent": "#10B981" } as React.CSSProperties}>
            <div className="kpi-label">Approved</div>
            <div className="kpi-row">
              <span className="kpi-value" style={{ color: "#10B981" }}>{approvedCount}</span>
              <span className="kpi-meta" style={{ marginTop: 0 }}>{approvalRate}% rate</span>
            </div>
            <div className="kpi-meta">Approved + completed</div>
          </Link>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#8B5CF6" } as React.CSSProperties}>
            <div className="kpi-label">Refunded</div>
            <span className="kpi-value" style={{ color: "#8B5CF6" }}>{refundedCount}</span>
            <div className="kpi-meta">
              {allTimeReturns > 0 ? `${allTimeReturns} all time` : "No refunds yet"}
            </div>
          </div>
        </div>

        {/* ── KPI Cards Row 2 ── */}
        <div className="dashboard-kpi-grid mb-md">
          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#059669" } as React.CSSProperties}>
            <div className="kpi-label">Revenue retained</div>
            <span className="kpi-value" style={{ color: "#059669" }}>
              {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueRetained)}
            </span>
            <div className="kpi-meta">Via exchanges & store credit</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#3B82F6" } as React.CSSProperties}>
            <div className="kpi-label">Exchange rate</div>
            <span className="kpi-value" style={{ color: "#3B82F6" }}>{exchangeRate}%</span>
            <div className="kpi-meta">{resolutionMap.exchange ?? 0} of {Object.values(resolutionMap).reduce((a, b) => a + b, 0)} resolved</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#06B6D4" } as React.CSSProperties}>
            <div className="kpi-label">Green returns</div>
            <span className="kpi-value" style={{ color: "#06B6D4" }}>{greenReturnCount}</span>
            <div className="kpi-meta">Customer kept item</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#DC2626" } as React.CSSProperties}>
            <div className="kpi-label">Blocked attempts</div>
            <span className="kpi-value" style={{ color: blocklistCount > 0 ? "#DC2626" : undefined }}>{blocklistCount}</span>
            <div className="kpi-meta">
              <Link to="/app/settings/blocklist" className="panel-link" style={{ fontSize: 11 }}>Manage blocklist</Link>
            </div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#F59E0B" } as React.CSSProperties}>
            <div className="kpi-label">Revenue at risk</div>
            <span className="kpi-value" style={{ color: revenueAtRisk > 0 ? "#D97706" : undefined }}>
              {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueAtRisk)}
            </span>
            <div className="kpi-meta">Pending/active returns (30d)</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": overdueCount > 0 ? "#DC2626" : "#10B981" } as React.CSSProperties}>
            <div className="kpi-label">Overdue returns</div>
            <span className="kpi-value" style={{ color: overdueCount > 0 ? "#DC2626" : undefined }}>
              {overdueCount}
            </span>
            <div className="kpi-meta">Pending &gt; 3 days</div>
          </div>
        </div>

        {/* ── Chart + Status ── */}
        <div className="dashboard-chart-row mb-md">
          {/* Return trend */}
          <div className="dashboard-chart-panel">
            <div className="panel-header">
              <h3>Return trend</h3>
              <Link to="/app/reports" className="panel-link">Analytics →</Link>
            </div>
            <div style={{ height: 180 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
                    <defs>
                      <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: "1px solid #E2E8F0", fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.06)" }}
                      formatter={(value: number | undefined) => [value ?? 0, "Returns"]}
                    />
                    <Area type="monotone" dataKey="returns" stroke="#3b82f6" strokeWidth={2} fill="url(#dashGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="chart-empty">No return data for this period.</div>
              )}
            </div>
          </div>

          {/* Status breakdown */}
          <div className="dashboard-chart-panel">
            <h3>Status breakdown</h3>
            {Object.keys(statusMap).length === 0 ? (
              <div className="chart-empty" style={{ padding: 24 }}>No returns in this period.</div>
            ) : (
              <div className="dashboard-status-list">
                {Object.entries(statusMap)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => {
                    const pct = totalReturns > 0 ? Math.round((count / totalReturns) * 100) : 0;
                    return (
                      <Link key={status} to={`/app/returns?status=${encodeURIComponent(status)}`} className="dashboard-status-item">
                        <div className="dashboard-status-row">
                          <span className="status-name">
                            <span className="status-dot" style={{ background: getStatusColor(status) }} />
                            {status}
                          </span>
                          <span className="status-count">{count} ({pct}%)</span>
                        </div>
                        <div className="dashboard-status-bar">
                          <div style={{ width: `${pct}%`, height: "100%", background: getStatusColor(status), borderRadius: 3, minWidth: count > 0 ? 3 : 0, transition: "width 0.4s ease" }} />
                        </div>
                      </Link>
                    );
                  })}
              </div>
            )}
          </div>
        </div>

        {/* ── Resolution Distribution ── */}
        {Object.keys(resolutionMap).length > 0 && (
          <div className="dashboard-chart-panel mb-md">
            <div className="panel-header">
              <h3>Resolution breakdown</h3>
              <Link to="/app/reports" className="panel-link">Full report →</Link>
            </div>
            <div className="dashboard-resolution-grid">
              {[
                { key: "refund", label: "Refunds", color: "#8B5CF6" },
                { key: "exchange", label: "Exchanges", color: "#3B82F6" },
                { key: "store_credit", label: "Store credits", color: "#14b8a6" },
                { key: "replacement", label: "Replacements", color: "#F59E0B" },
              ].map((r) => {
                const count = resolutionMap[r.key] ?? 0;
                const resolvedTotal = Object.values(resolutionMap).reduce((a: number, b: number) => a + b, 0);
                const pct = resolvedTotal > 0 ? Math.round((count / resolvedTotal) * 100) : 0;
                return (
                  <div key={r.key} className="dashboard-resolution-card" style={{ "--res-color": r.color } as React.CSSProperties}>
                    <div className="flex-center" style={{ marginBottom: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: r.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)" }}>{r.label}</span>
                    </div>
                    <div className="kpi-row">
                      <span className="text-tabular" style={{ fontSize: 22, fontWeight: 800, color: "var(--rpm-text)" }}>{count}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: r.color }}>{pct}%</span>
                    </div>
                    <div className="dashboard-resolution-bar">
                      <div style={{ width: `${pct}%`, height: "100%", background: r.color, borderRadius: 2, minWidth: count > 0 ? 3 : 0, transition: "width 0.4s ease" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Recent Returns ── */}
        <div className="dashboard-chart-panel">
          <div className="panel-header">
            <h3>Recent returns</h3>
            <Link to="/app/returns" className="panel-link">View all →</Link>
          </div>
          {recentReturns.length === 0 ? (
            <div className="dashboard-empty-state">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5" style={{ marginBottom: 12 }}>
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text)", marginBottom: 4 }}>No returns yet</div>
              <div style={{ fontSize: 13, color: "var(--rpm-text-muted)", marginBottom: 14 }}>Returns will appear here when customers submit them.</div>
              <Link to="/app/portal"><s-button variant="primary">Share portal URL</s-button></Link>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="dashboard-recent-table">
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Return #</th>
                    <th>Created</th>
                    <th style={{ width: 48 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {recentReturns.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link to={`/app/returns/${r.id}`} style={{ fontWeight: 600, color: "var(--rpm-text)", textDecoration: "none" }}>
                          {r.shopifyOrderName || r.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td>
                        <span className="status-badge" style={{ background: `${getStatusColor(r.status)}14`, color: getStatusColor(r.status) }}>
                          <span className="status-dot--sm" style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                          {r.status}
                        </span>
                      </td>
                      <td className="text-mono" style={{ color: "var(--rpm-text-muted)", fontSize: 12 }}>
                        {(r as { returnRequestNo?: string | null }).returnRequestNo || r.fyndReturnNo || "—"}
                      </td>
                      <td className="text-tabular nowrap" style={{ fontSize: 12 }}>
                        <div style={{ color: "var(--rpm-text-muted)", fontWeight: 500 }}>{new Intl.DateTimeFormat(shopLocale || "en", { day: "numeric", month: "short", year: "2-digit" }).format(new Date(r.createdAt))}</div>
                        <div style={{ color: "#9ca3af", fontSize: 11 }}>{new Intl.DateTimeFormat(shopLocale || "en", { hour: "2-digit", minute: "2-digit" }).format(new Date(r.createdAt))}</div>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link to={`/app/returns/${r.id}`} style={{ color: "var(--rpm-accent)" }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Fraud Alerts Widget ── */}
        {fraudAlertCount > 0 && (
          <div className="dashboard-chart-panel mb-md" style={{ borderLeft: "3px solid #DC2626" }}>
            <div className="panel-header">
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Fraud Alerts ({fraudAlertCount})
              </h3>
              <Link to="/app/returns" className="panel-link">View all →</Link>
            </div>
            <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 12 }}>
              Returns from high/critical risk customers in this period
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {fraudAlertReturns.map((fr) => (
                <Link
                  key={fr.id}
                  to={`/app/returns/${fr.id}`}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", borderRadius: 8,
                    background: fr.fraudRiskLevel === "critical" ? "#FEF2F2" : "#FFFBEB",
                    border: `1px solid ${fr.fraudRiskLevel === "critical" ? "#FECACA" : "#FDE68A"}`,
                    textDecoration: "none", fontSize: 13,
                  }}
                >
                  <span style={{
                    display: "inline-block", padding: "2px 6px", borderRadius: 4,
                    fontSize: 10, fontWeight: 700,
                    background: fr.fraudRiskLevel === "critical" ? "#FEE2E2" : "#FFEDD5",
                    color: fr.fraudRiskLevel === "critical" ? "#DC2626" : "#EA580C",
                  }}>
                    {(fr.fraudRiskLevel || "high").toUpperCase()}
                  </span>
                  <span style={{ flex: 1, fontWeight: 500, color: "var(--rpm-text)" }}>
                    {fr.customerName || fr.customerEmailNorm || "Unknown"}
                  </span>
                  <span style={{ fontSize: 11, color: "#6B7280" }}>{fr.shopifyOrderName}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "#DC2626" }}>
                    Score: {fr.fraudRiskScore ?? "—"}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* ── Fynd banner (only when not configured) ── */}
        {!hasFyndConfig && (
          <div className="dashboard-fynd-banner">
            <div className="banner-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            </div>
            <div className="banner-text">
              <div style={{ fontSize: 14, fontWeight: 600, color: "#92400E" }}>Connect Fynd for reverse logistics</div>
              <div style={{ fontSize: 12, color: "#A16207" }}>Automate return pickups, tracking, and delivery.</div>
            </div>
            <Link to="/app/settings/integrations" style={{ textDecoration: "none", flexShrink: 0 }}>
              <s-button variant="secondary">Configure</s-button>
            </Link>
          </div>
        )}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const message = isResponse
    ? (error.data || `Error ${isResponse ? error.status : 500}`)
    : error instanceof Error ? error.message : "An unexpected error occurred.";

  return (
    <s-page fullWidth heading="Dashboard">
      <div className="app-content layout-wide" style={{ paddingBottom: 48 }}>
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: "middle", marginRight: 4 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            {typeof message === "string" ? message : "Failed to load dashboard."}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <Link to="/app/returns"><s-button variant="primary">View Returns</s-button></Link>
          <Link to="/app/settings"><s-button variant="secondary">Settings</s-button></Link>
          <Link to="/app/portal"><s-button variant="secondary">Portal</s-button></Link>
        </div>
      </div>
    </s-page>
  );
}
