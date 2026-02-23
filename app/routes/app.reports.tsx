import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange, DATE_RANGE_OPTIONS, type DateRangePreset } from "../lib/dashboard-date-utils";
import { formatReturnRequestId } from "../lib/return-request-id";
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
  approved: "#008060",
  completed: "#008060",
  rejected: "#d72c0d",
  cancelled: "#6d7175",
  initiated: "#b98900",
};

const CHART_COLORS = ["#005bd3", "#008060", "#b98900", "#d72c0d", "#6d7175", "#7c3aed", "#0891b2", "#dc2626"];

function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#6d7175";
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
      recentReturns,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.groupBy({ by: ["status"], where, _count: true }),
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
      prisma.returnCase.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { items: { take: 2 } },
      }),
    ]);

    const statusMap = returnsByStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);
    const maxStatusCount = Math.max(...Object.values(statusMap), 1);
    const processingCount = (statusMap.processing ?? 0) + (statusMap["in progress"] ?? 0) + (statusMap.initiated ?? 0);
    const cancelledCount = statusMap.cancelled ?? 0;

    const topReasons = reasonAggregation
      .filter((r) => r.reasonCode != null && String(r.reasonCode).trim() !== "")
      .map((r) => ({ reason: String(r.reasonCode), count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

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

    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    return {
      totalReturns,
      statusMap,
      maxStatusCount,
      topReasons,
      refundedCount,
      fyndSyncedCount,
      pendingCount,
      rejectedCount,
      approvedCount,
      processingCount,
      cancelledCount,
      itemsCount,
      allTimeReturns,
      returnsOverTime,
      statusChartData,
      avgProcessingDays,
      periodChange,
      rangeLabel,
      range,
      from: from ?? undefined,
      to: to ?? undefined,
      recentReturns,
      hasFyndConfig,
      error: null,
    };
  } catch (err) {
    console.error("Reports loader error:", err);
    return {
      totalReturns: 0,
      statusMap: {} as Record<string, number>,
      maxStatusCount: 1,
      topReasons: [] as { reason: string; count: number }[],
      refundedCount: 0,
      fyndSyncedCount: 0,
      pendingCount: 0,
      rejectedCount: 0,
      approvedCount: 0,
      processingCount: 0,
      cancelledCount: 0,
      itemsCount: 0,
      allTimeReturns: 0,
      returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
      statusChartData: [] as { name: string; value: number }[],
      avgProcessingDays: null,
      periodChange: 0,
      rangeLabel: "Last 30 days",
      range: "last_30_days",
      from: undefined,
      to: undefined,
      recentReturns: [] as Awaited<ReturnType<typeof prisma.returnCase.findMany>>,
      hasFyndConfig: false,
      error: "Failed to load reports",
    };
  }
};

function MetricCard({
  label,
  value,
  subtext,
  color,
  icon,
  trend,
}: {
  label: string;
  value: number | string;
  subtext?: string;
  color?: string;
  icon?: string;
  trend?: number;
}) {
  return (
    <div
      style={{
        padding: 20,
        background: "var(--rpm-surface)",
        borderRadius: 14,
        border: "1px solid var(--rpm-border)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
        transition: "box-shadow 0.2s ease",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? "var(--rpm-text)", display: "flex", alignItems: "baseline", gap: 8 }}>
        {value}
        {trend !== undefined && trend !== 0 && (
          <span style={{ fontSize: 13, fontWeight: 600, color: trend > 0 ? "#d72c0d" : "#008060" }}>
            {trend > 0 ? `+${trend}%` : `${trend}%`}
          </span>
        )}
      </div>
      {subtext && <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginTop: 4 }}>{subtext}</div>}
    </div>
  );
}

export default function Reports() {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    totalReturns,
    statusMap,
    maxStatusCount,
    topReasons,
    refundedCount,
    fyndSyncedCount,
    pendingCount,
    rejectedCount,
    approvedCount,
    processingCount,
    cancelledCount,
    itemsCount,
    allTimeReturns,
    returnsOverTime,
    statusChartData,
    avgProcessingDays,
    periodChange,
    rangeLabel,
    range,
    from,
    to,
    recentReturns,
    hasFyndConfig,
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
  const rejectionRate = totalReturns > 0 ? Math.round((rejectedCount / totalReturns) * 100) : 0;
  const avgItemsPerReturn = totalReturns > 0 ? (itemsCount / totalReturns).toFixed(1) : "0";
  const fyndSyncRate = approvedCount > 0 ? Math.round((fyndSyncedCount / approvedCount) * 100) : 0;

  const exportParams = new URLSearchParams({ range: range ?? "last_30_days" });
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  const exportUrl = `/api/returns/export?${exportParams.toString()}`;

  return (
    <s-page heading="Reports">
      <div className="app-content" style={{ paddingBottom: 48 }}>
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            {error}
          </div>
        )}

        {/* Date range filter */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 12,
            marginBottom: 24,
            padding: "16px 20px",
            background: "var(--rpm-surface)",
            borderRadius: 14,
            border: "1px solid var(--rpm-border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--rpm-text)" }}>Date range:</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <select
              value={range}
              onChange={(e) => handleRangeChange(e.target.value as DateRangePreset)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid var(--rpm-border)",
                fontSize: 14,
                fontWeight: 500,
                background: "var(--rpm-surface)",
                color: "var(--rpm-text)",
                minWidth: 160,
              }}
            >
              {DATE_RANGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {range === "custom" && (
              <>
                <input
                  type="date"
                  value={from ?? ""}
                  onChange={(e) => handleCustomRange(e.target.value, to ?? "")}
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border)", fontSize: 14 }}
                />
                <span style={{ color: "var(--rpm-text-muted)" }}>to</span>
                <input
                  type="date"
                  value={to ?? ""}
                  onChange={(e) => handleCustomRange(from ?? "", e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--rpm-border)", fontSize: 14 }}
                />
              </>
            )}
          </div>
          <span style={{ fontSize: 13, color: "var(--rpm-text-muted)", marginLeft: 8 }}>{rangeLabel}</span>
          <Link to="/app" style={{ marginLeft: "auto", fontSize: 14, color: "var(--rpm-accent)", textDecoration: "none", fontWeight: 500 }}>
            ← Back to Dashboard
          </Link>
        </div>

        {/* Hero metrics */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 20,
            marginBottom: 32,
          }}
        >
          <Link to="/app/returns" style={{ textDecoration: "none" }}>
            <MetricCard label="Total returns" value={totalReturns} subtext={rangeLabel} trend={periodChange} icon="📦" />
          </Link>
          <MetricCard label="Approved" value={approvedCount} color="#059669" subtext={`${approvalRate}% of total`} icon="✓" />
          <MetricCard label="Pending" value={pendingCount} color="#b98900" subtext="Awaiting review" icon="⏳" />
          <MetricCard label="Processing" value={processingCount} color="#005bd3" subtext="In progress" icon="🔄" />
          <MetricCard label="Rejected" value={rejectedCount} color="#d72c0d" subtext={`${rejectionRate}% of total`} icon="✕" />
          <MetricCard label="Refunded" value={refundedCount} color="#059669" subtext="Processed" icon="💰" />
          {hasFyndConfig && (
            <MetricCard label="Fynd synced" value={fyndSyncedCount} subtext={`${fyndSyncRate}% of approved`} icon="🔄" />
          )}
          <MetricCard label="Items returned" value={itemsCount} subtext={`~${avgItemsPerReturn} per return`} icon="📋" />
          <MetricCard
            label="Avg processing"
            value={avgProcessingDays != null ? `${avgProcessingDays.toFixed(1)} days` : "—"}
            subtext="Initiated → Approved"
            icon="⏱"
          />
          <MetricCard label="Cancelled" value={cancelledCount} color="#6d7175" subtext="Voided" icon="⊘" />
          <MetricCard label="All time" value={allTimeReturns} subtext="Total ever" icon="📊" />
        </div>

        {/* Charts row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
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
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
              Returns over time
            </h3>
            <div style={{ height: 260 }}>
              {returnsOverTime.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={returnsOverTime} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="reportsReturnsGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#005bd3" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#005bd3" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 13 }}
                      formatter={(value: number) => [value, "Returns"]}
                      labelFormatter={(label) => `Date: ${label}`}
                    />
                    <Area type="monotone" dataKey="returns" stroke="#005bd3" strokeWidth={2} fill="url(#reportsReturnsGradient)" />
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
                    textAlign: "center",
                    padding: 24,
                  }}
                >
                  No returns in selected period. Try a different date range.
                </div>
              )}
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
            <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
              Returns by status
            </h3>
            <div style={{ height: 260, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
                      contentStyle={{ borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 13 }}
                      formatter={(value: number, _: string, props: { payload: { value: number } }) => {
                        const total = statusChartData.reduce((a, d) => a + d.value, 0);
                        const pct = total > 0 ? Math.round((props.payload.value / total) * 100) : 0;
                        return [`${value} (${pct}%)`, ""];
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div style={{ color: "var(--rpm-text-muted)", fontSize: 14, textAlign: "center" }}>
                  No status data in selected period
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Top return reasons */}
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
          <h3 style={{ margin: "0 0 20px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
            Top return reasons
          </h3>
          <div style={{ height: Math.max(200, topReasons.length * 32) }}>
            {topReasons.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={topReasons.map((r) => ({
                    name: r.reason.length > 28 ? r.reason.slice(0, 28) + "…" : r.reason,
                    count: r.count,
                    fullName: r.reason,
                  }))}
                  layout="vertical"
                  margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 12, fill: "#64748b" }} width={140} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 13 }}
                    formatter={(value: number, _: unknown, props: { payload?: { fullName?: string } }) => [
                      value,
                      props.payload?.fullName ?? "Returns",
                    ]}
                  />
                  <Bar dataKey="count" fill="#005bd3" radius={[0, 4, 4, 0]} name="Returns" />
                </BarChart>
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
                  textAlign: "center",
                  padding: 24,
                }}
              >
                No return reasons recorded yet.
              </div>
            )}
          </div>
        </div>

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
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
              Status breakdown
            </h3>
            {Object.keys(statusMap).length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 14 }}>
                No returns in selected period.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {Object.entries(statusMap)
                  .sort(([, a], [, b]) => b - a)
                  .map(([status, count]) => (
                    <Link
                      key={status}
                      to={`/app/returns?status=${encodeURIComponent(status)}`}
                      style={{ textDecoration: "none", color: "inherit" }}
                    >
                      <div>
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
                    </Link>
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
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
                Recent returns
              </h3>
              <Link to="/app/returns" style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
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
                <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8, color: "var(--rpm-text)" }}>No returns yet</p>
                <p style={{ color: "var(--rpm-text-muted)", fontSize: 14 }}>Returns will appear when customers initiate them via the portal.</p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--rpm-border)" }}>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>
                        Return ID
                      </th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>
                        Order
                      </th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>
                        Status
                      </th>
                      <th style={{ textAlign: "left", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}>
                        Created
                      </th>
                      <th style={{ textAlign: "right", padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "var(--rpm-text-muted)", textTransform: "uppercase" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentReturns.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid var(--rpm-surface-elevated)" }}>
                        <td style={{ padding: "12px", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>
                          <Link to={`/app/returns/${r.id}`} style={{ color: "var(--rpm-text)", textDecoration: "none" }}>
                            {(r as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(r.id)}
                          </Link>
                        </td>
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
                          {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                        <td style={{ padding: "12px", textAlign: "right" }}>
                          <Link to={`/app/returns/${r.id}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-accent)", textDecoration: "none" }}>
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

        {/* Quick actions & Export */}
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
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
              Quick links
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <Link to="/app/returns">
                <s-button variant="primary">View all returns</s-button>
              </Link>
              <Link to="/app/returns?status=pending">
                <s-button variant="secondary">Pending returns</s-button>
              </Link>
              <Link to="/app/returns?status=approved">
                <s-button variant="secondary">Approved returns</s-button>
              </Link>
              <Link to="/app/returns?status=rejected">
                <s-button variant="secondary">Rejected returns</s-button>
              </Link>
              <Link to="/app">
                <s-button variant="secondary">Dashboard</s-button>
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
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600, color: "var(--rpm-text)" }}>
              Export
            </h3>
            <p style={{ marginBottom: 16, color: "var(--rpm-text-muted)", fontSize: 14 }}>
              Download returns data as CSV for the selected date range.
            </p>
            <a href={exportUrl} download style={{ textDecoration: "none" }}>
              <s-button variant="secondary">Export to CSV</s-button>
            </a>
          </div>
        </div>
      </div>
    </s-page>
  );
}
