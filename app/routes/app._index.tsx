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

  if (data.refundedCount < data.approvedCount && data.approvedCount > 0) {
    suggestions.push({
      type: "info",
      message: `${data.approvedCount - data.refundedCount} approved return${data.approvedCount - data.refundedCount > 1 ? "s" : ""} not yet refunded.`,
      action: "View returns",
      actionUrl: "/app/returns",
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
      allTimeReturns, approvedWithEvents, returnsForDaily,
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
      prisma.returnCase.findMany({ where: approvedWhere, select: { createdAt: true, updatedAt: true } }),
      prisma.returnCase.findMany({ where, select: { createdAt: true } }),
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

    const suggestions = buildSuggestions({
      totalReturns, pendingCount, rejectedCount, approvedCount,
      topReasons, hasFyndConfig, fyndSyncedCount, refundedCount,
      avgProcessingDays, rangeLabel,
    });

    return {
      totalReturns, statusMap, approvedCount, topReasons, recentReturns,
      hasFyndConfig, shopDomain: session.shop, refundedCount, pendingCount,
      rejectedCount, returnsOverTime, periodChange, rangeLabel, range,
      from: from ?? undefined, to: to ?? undefined, allTimeReturns,
      suggestions, error: null,
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
    <s-page heading="Dashboard">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
            <p style={{ fontWeight: 600, fontSize: 14 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: "middle", marginRight: 4 }}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              {error}
            </p>
          </div>
        )}

        {/* ── Date Range + Suggestions row ── */}
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
          <Link to="/app/reports" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none" }}>
            Full reports →
          </Link>
        </div>

        {/* ── Suggestions (max 3, compact) ── */}
        {suggestions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {suggestions.map((s, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                gap: 10, padding: "10px 16px", borderRadius: 10,
                background: s.type === "success" ? "#ECFDF5" : s.type === "warning" ? "#FFFBEB" : "#EFF6FF",
                border: `1px solid ${s.type === "success" ? "#A7F3D0" : s.type === "warning" ? "#FDE68A" : "#BFDBFE"}`,
              }}>
                <span style={{
                  fontSize: 13, fontWeight: 500,
                  color: s.type === "success" ? "#047857" : s.type === "warning" ? "#92400E" : "#1E40AF",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  {s.type === "warning" ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  )}
                  {s.message}
                </span>
                {s.action && s.actionUrl && (
                  <Link to={s.actionUrl} style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none", whiteSpace: "nowrap" }}>
                    {s.action} →
                  </Link>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── KPI Cards ── */}
        <div className="dashboard-kpi-grid" style={{ marginBottom: 20 }}>
          <Link to="/app/returns" style={{ textDecoration: "none" }}>
            <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "var(--rpm-accent, #3B82F6)", opacity: 0.6, borderRadius: "14px 14px 0 0" }} />
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Total returns</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: "var(--rpm-text, #0f172a)", letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{totalReturns.toLocaleString()}</span>
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
          </Link>

          <Link to="/app/returns?status=pending" style={{ textDecoration: "none" }}>
            <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#EAB308", opacity: 0.6, borderRadius: "14px 14px 0 0" }} />
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Needs review</div>
              <span style={{ fontSize: 28, fontWeight: 800, color: pendingCount > 0 ? "#EAB308" : "var(--rpm-text, #0f172a)", letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{pendingCount}</span>
              <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>{pendingCount > 0 ? "Awaiting action" : "All clear"}</div>
            </div>
          </Link>

          <Link to="/app/returns?status=approved" style={{ textDecoration: "none" }}>
            <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#10B981", opacity: 0.6, borderRadius: "14px 14px 0 0" }} />
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Approved</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 28, fontWeight: 800, color: "#10B981", letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{approvedCount}</span>
                <span style={{ fontSize: 11, color: "var(--rpm-text-muted)" }}>{approvalRate}% rate</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>Approved + completed</div>
            </div>
          </Link>

          <div className="dashboard-metric-card" style={{ position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "#8B5CF6", opacity: 0.6, borderRadius: "14px 14px 0 0" }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Refunded</div>
            <span style={{ fontSize: 28, fontWeight: 800, color: "#8B5CF6", letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{refundedCount}</span>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 6 }}>
              {allTimeReturns > 0 ? `${allTimeReturns} all time` : "No refunds yet"}
            </div>
          </div>
        </div>

        {/* ── Chart + Status ── */}
        <div className="dashboard-chart-row" style={{ marginBottom: 20 }}>
          {/* Return trend */}
          <div style={{
            background: "var(--rpm-surface, white)", borderRadius: 14, padding: 22,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Return trend</h3>
              <Link to="/app/reports" style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none" }}>
                Analytics →
              </Link>
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
                <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
                  No return data for this period.
                </div>
              )}
            </div>
          </div>

          {/* Status breakdown */}
          <div style={{
            background: "var(--rpm-surface, white)", borderRadius: 14, padding: 22,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}>
            <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Status breakdown</h3>
            {Object.keys(statusMap).length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
                No returns in this period.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {Object.entries(statusMap)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => {
                    const pct = totalReturns > 0 ? Math.round((count / totalReturns) * 100) : 0;
                    return (
                      <Link key={status} to={`/app/returns?status=${encodeURIComponent(status)}`} style={{ textDecoration: "none", color: "inherit" }}>
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5, fontSize: 13 }}>
                            <span style={{ fontWeight: 600, textTransform: "capitalize", display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ width: 7, height: 7, borderRadius: "50%", background: getStatusColor(status), display: "inline-block" }} />
                              {status}
                            </span>
                            <span style={{ color: "var(--rpm-text-muted)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: 12 }}>{count} ({pct}%)</span>
                          </div>
                          <div style={{ height: 5, background: "#F1F5F9", borderRadius: 3, overflow: "hidden" }}>
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

        {/* ── Recent Returns ── */}
        <div style={{
          background: "var(--rpm-surface, white)", borderRadius: 14, padding: 22,
          border: "var(--rpm-border, 1px solid #e5e7eb)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>Recent returns</h3>
            <Link to="/app/returns" style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-accent, #005bd3)", textDecoration: "none" }}>
              View all →
            </Link>
          </div>
          {recentReturns.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center" }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#CBD5E1" strokeWidth="1.5" style={{ marginBottom: 12 }}>
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
              <div style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text, #0f172a)", marginBottom: 4 }}>No returns yet</div>
              <div style={{ fontSize: 13, color: "var(--rpm-text-muted)", marginBottom: 14 }}>Returns will appear here when customers submit them.</div>
              <Link to="/app/portal"><s-button variant="primary">Share portal URL</s-button></Link>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #F1F5F9" }}>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Order</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Return #</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Created</th>
                    <th style={{ width: 48 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {recentReturns.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid #F8FAFC" }}>
                      <td style={{ padding: "10px 12px" }}>
                        <Link to={`/app/returns/${r.id}`} style={{ fontWeight: 600, color: "var(--rpm-text)", textDecoration: "none" }}>
                          {r.shopifyOrderName || r.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td style={{ padding: "10px 12px" }}>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 4,
                          padding: "3px 9px", borderRadius: 5, fontSize: 11, fontWeight: 600,
                          background: `${getStatusColor(r.status)}14`, color: getStatusColor(r.status),
                          textTransform: "capitalize",
                        }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                          {r.status}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--rpm-text-muted)", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                        {(r as { returnRequestNo?: string | null }).returnRequestNo || r.fyndReturnNo || "—"}
                      </td>
                      <td style={{ padding: "10px 12px", color: "var(--rpm-text-muted)", fontSize: 12 }}>
                        {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                      </td>
                      <td style={{ padding: "10px 12px", textAlign: "right" }}>
                        <Link to={`/app/returns/${r.id}`} style={{ color: "var(--rpm-accent, #005bd3)" }}>
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

        {/* ── Fynd banner (only when not configured) ── */}
        {!hasFyndConfig && (
          <div style={{
            marginTop: 20, padding: "16px 20px",
            background: "#FFFBEB", borderRadius: 12, border: "1px solid #FDE68A",
            display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: "#FEF3C7",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
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
    <s-page heading="Dashboard">
      <div className="app-content" style={{ paddingBottom: 48 }}>
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
