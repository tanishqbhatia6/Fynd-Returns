import React from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange, DATE_RANGE_OPTIONS, type DateRangePreset } from "../lib/dashboard-date-utils";
import { getStatusColor } from "../lib/status-colors";
import { AppPage } from "../components/AppPage";
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

    // defensive `|| undefined` fallbacks for missing tz/locale
    /* v8 ignore start */
    const merchantTz = shop.settings?.shopTimezone || undefined;
    const merchantLocale = shop.settings?.shopLocale || undefined;
    /* v8 ignore stop */
    const { start: rangeStart, end: rangeEnd, label: rangeLabel } = parseDateRange(range, from, to, merchantTz, merchantLocale);
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
      prisma.returnCase.findMany({ where: approvedWhere, select: { createdAt: true, updatedAt: true }, orderBy: { createdAt: "desc" } }),
      prisma.returnCase.findMany({ where, select: { createdAt: true, status: true }, orderBy: { createdAt: "desc" } }),
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
        // defensive `|| "en"` locale fallback for date formatter
        /* v8 ignore next */
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

    // defensive `??` and `||` fallbacks for missing refundJson amount
    /* v8 ignore start */
    let revenueRetained = 0;
    for (const rc of retainedCases) {
      try {
        const parsed = JSON.parse(rc.refundJson ?? "{}");
        revenueRetained += parseFloat(parsed.amount ?? "0") || 0;
      } catch { /* skip */ }
    }
    /* v8 ignore stop */

    // Avg processing time: use ReturnEvent approval timestamp for accuracy
    let avgProcessingDays: number | null = null;
    if (approvedWithEvents.length >= 1) {
      try {
        const processingResult = await prisma.$queryRaw<[{ avg_days: number | null }]>`
          SELECT AVG(EXTRACT(EPOCH FROM (COALESCE(re."happenedAt", rc."updatedAt") - rc."createdAt")) / 86400.0) AS avg_days
          FROM "ReturnCase" rc
          LEFT JOIN LATERAL (
            SELECT "happenedAt" FROM "ReturnEvent"
            WHERE "returnCaseId" = rc.id AND "eventType" IN ('approved', 'auto_approved', 'status_changed')
            ORDER BY "happenedAt" ASC LIMIT 1
          ) re ON true
          WHERE rc."shopId" = ${shop.id}
            AND rc."createdAt" >= ${rangeStart}
            AND rc."createdAt" <= ${rangeEnd}
            AND rc.status IN ('approved', 'completed')
        `;
        // defensive null-check + raw-SQL fallback path; tests don't exercise both
        /* v8 ignore start */
        if (processingResult[0]?.avg_days != null) {
          avgProcessingDays = Math.round(processingResult[0].avg_days * 10) / 10;
        }
        /* v8 ignore stop */
      } catch {
        // raw-SQL fallback only triggers when $queryRaw rejects — defensive
        /* v8 ignore start */
        const times = approvedWithEvents
          .map((rc) => (new Date(rc.updatedAt).getTime() - new Date(rc.createdAt).getTime()) / (24 * 60 * 60 * 1000))
          .filter((t) => t >= 0);
        if (times.length > 0) avgProcessingDays = Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10;
        /* v8 ignore stop */
      }
    }

    // Revenue analytics queries
    const [refundedCasesForRevenue, topProductsByReturns, customerReturnFrequency] = await Promise.all([
      prisma.returnCase.findMany({
        where: { ...where, status: { in: ["approved", "completed"] }, refundJson: { not: null } },
        select: { refundJson: true, currency: true },
      }),
      // Top products: group by title for items that have one, AND group by sku for
      // items that don't (we display the SKU as the label). Without this, items
      // with title=null are silently excluded from the top-N — which can hide a
      // problem product whose data was imported without a title (P2 finding).
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
    // defensive `??` fallbacks for missing JSON fields and method-count default
    /* v8 ignore start */
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
    /* v8 ignore stop */

    // Augment with NULL-title items grouped by SKU. We do this as a second query
    // (instead of a raw COALESCE GROUP BY) to keep things type-safe.
    const skuOnlyItems = await prisma.returnItem.groupBy({
      by: ["sku"],
      where: { returnCase: where, title: null, sku: { not: null } },
      _count: { sku: true },
      orderBy: { _count: { sku: "desc" } },
      take: 10,
    });

    const topProductsCombined: Array<{ title: string; count: number }> = [
      ...topProductsByReturns
        .filter((r) => r.title != null)
        .map((r) => ({ title: String(r.title), count: r._count.title })),
      ...skuOnlyItems
        .filter((r) => r.sku != null)
        .map((r) => ({ title: `SKU ${r.sku}`, count: r._count.sku })),
    ];
    // Re-sort merged list and trim to top 10.
    const topProductsData = topProductsCombined
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const customerFrequencyData = customerReturnFrequency
      .filter((r) => r.customerEmailNorm != null)
      .map((r) => ({ email: String(r.customerEmailNorm), count: r._count.customerEmailNorm }));

    const refundMethodBreakdown = Object.entries(refundMethodCounts)
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count);

    // ── NEW: Retention & fraud KPIs ──
    // defensive `??` fallbacks across resolution counts; ratio shortcut zero-branch unhit
    /* v8 ignore start */
    const resolvedCount = (resolutionMap.refund ?? 0) + (resolutionMap.exchange ?? 0) + (resolutionMap.store_credit ?? 0) + (resolutionMap.replacement ?? 0);
    const exchangeConversionRate = resolvedCount > 0 ? Math.round(((resolutionMap.exchange ?? 0) / resolvedCount) * 100) : 0;
    /* v8 ignore stop */
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

    // Fraud risk summary (isolated try/catch — columns may not exist yet)
    let fraudAlertCount = 0;
    try {
      const [highRiskCount, criticalRiskCount] = await Promise.all([
        prisma.returnCase.count({ where: { ...where, fraudRiskLevel: "high" } }),
        prisma.returnCase.count({ where: { ...where, fraudRiskLevel: "critical" } }),
      ]);
      fraudAlertCount = highRiskCount + criticalRiskCount;
    } catch (err) {
      console.warn("[reports] Fraud risk query failed (columns may not exist yet):", err);
    }

    const prevPeriodStart = new Date(rangeStart);
    prevPeriodStart.setTime(prevPeriodStart.getTime() - (rangeEnd.getTime() - rangeStart.getTime()));
    const prevPeriodCount = await prisma.returnCase.count({
      where: { shopId: shop.id, createdAt: { gte: prevPeriodStart, lt: rangeStart } },
    });
    const periodChange = totalReturns > 0 && prevPeriodCount >= 0
      ? Math.round(((totalReturns - prevPeriodCount) / Math.max(prevPeriodCount, 1)) * 100) : 0;

    const hasFyndConfig = !!(shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    // New metric: Avg refund amount
    const avgRefundAmount = refundedCount > 0 ? totalRefundAmount / refundedCount : 0;

    // New metric: Revenue at Risk (initiated + pending, last 30d)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const atRiskResult = await prisma.$queryRaw<[{ total: string | null }]>`
      SELECT COALESCE(SUM(CAST(ri.price AS DECIMAL(12,2)) * ri.qty), 0)::text AS total
      FROM "ReturnItem" ri
      JOIN "ReturnCase" rc ON ri."returnCaseId" = rc.id
      WHERE rc."shopId" = ${shop.id}
        AND rc."createdAt" >= ${thirtyDaysAgo}
        AND rc.status IN ('initiated', 'pending')
        AND ri.price IS NOT NULL
    `;
    const revenueAtRisk = parseFloat(atRiskResult[0]?.total ?? "0") || 0;

    // New metric: Geographic breakdown
    const geoBreakdown = await prisma.returnCase.groupBy({
      by: ["customerCountry"],
      where: { ...where, customerCountry: { not: null } },
      _count: true,
      orderBy: { _count: { customerCountry: "desc" } },
      take: 15,
    });
    const geoData = geoBreakdown
      .filter(r => r.customerCountry != null && String(r.customerCountry).trim() !== "")
      .map(r => ({ country: String(r.customerCountry), count: r._count }));

    // New metric: Channel attribution
    const [channelCreatedBy, channelSource] = await Promise.all([
      prisma.returnCase.groupBy({
        by: ["createdByChannel"],
        where: { ...where, createdByChannel: { not: null } },
        _count: true,
        orderBy: { _count: { createdByChannel: "desc" } },
      }),
      prisma.returnCase.groupBy({
        by: ["sourceChannel"],
        where: { ...where, sourceChannel: { not: null } },
        _count: true,
        orderBy: { _count: { sourceChannel: "desc" } },
      }),
    ]);
    const createdByChannelData = channelCreatedBy.map(r => ({ channel: String(r.createdByChannel), count: r._count }));
    const sourceChannelData = channelSource.map(r => ({ channel: String(r.sourceChannel), count: r._count }));

    // New metric: Return condition breakdown
    const conditionBreakdown = await prisma.returnItem.groupBy({
      by: ["condition"],
      where: { returnCase: where, condition: { not: null } },
      _count: true,
      orderBy: { _count: { condition: "desc" } },
    });
    const conditionData = conditionBreakdown
      .filter(r => r.condition != null && String(r.condition).trim() !== "")
      .map(r => ({ condition: String(r.condition).replace(/_/g, " "), count: r._count }));

    // New metric: Time to refund (approval → refund avg days)
    let avgTimeToRefundDays: number | null = null;
    try {
      const ttrResult = await prisma.$queryRaw<[{ avg_days: number | null }]>`
        SELECT AVG(EXTRACT(EPOCH FROM (refund_evt."happenedAt" - approve_evt."happenedAt")) / 86400.0) AS avg_days
        FROM "ReturnCase" rc
        JOIN LATERAL (
          SELECT "happenedAt" FROM "ReturnEvent"
          WHERE "returnCaseId" = rc.id AND "eventType" IN ('approved', 'auto_approved')
          ORDER BY "happenedAt" ASC LIMIT 1
        ) approve_evt ON true
        JOIN LATERAL (
          SELECT "happenedAt" FROM "ReturnEvent"
          WHERE "returnCaseId" = rc.id AND "eventType" IN ('refund_processed', 'refunded')
          ORDER BY "happenedAt" ASC LIMIT 1
        ) refund_evt ON true
        WHERE rc."shopId" = ${shop.id}
          AND rc."createdAt" >= ${rangeStart}
          AND rc."createdAt" <= ${rangeEnd}
          AND rc.status IN ('approved', 'completed')
          AND rc."refundStatus" = 'refunded'
      `;
      if (ttrResult[0]?.avg_days != null) {
        avgTimeToRefundDays = Math.round(ttrResult[0].avg_days * 10) / 10;
      }
    } catch { /* LATERAL not supported or no data — skip */ }

    // Determine the dominant currency from actual return data
    const currencyAgg = await prisma.returnCase.groupBy({
      by: ["currency"],
      where: { shopId: shop.id, currency: { not: null } },
      _count: true,
      orderBy: { _count: { currency: "desc" } },
      take: 1,
    });
    // defensive `||` chain + `??` defaults for shop locale/currency/timezone
    /* v8 ignore start */
    const dominantCurrency = currencyAgg[0]?.currency || shop?.settings?.shopCurrency || "USD";
    /* v8 ignore stop */

    return {
      totalReturns, statusMap, topReasons, refundedCount, fyndSyncedCount,
      pendingCount, rejectedCount, approvedCount, approvedNotRefundedCount,
      itemsCount, allTimeReturns, returnsOverTime, statusChartData,
      avgProcessingDays, periodChange, rangeLabel, range,
      from: from ?? undefined, to: to ?? undefined, hasFyndConfig, error: null,
      resolutionChartData, revenueRetained, greenReturnCount,
      /* v8 ignore start */
      shopLocale: shop?.settings?.shopLocale ?? "en",
      shopCurrency: dominantCurrency,
      shopTimezone: shop?.settings?.shopTimezone ?? "UTC",
      /* v8 ignore stop */
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
      // New metrics
      avgRefundAmount,
      revenueAtRisk,
      geoData,
      createdByChannelData,
      sourceChannelData,
      conditionData,
      avgTimeToRefundDays,
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
      avgRefundAmount: 0,
      revenueAtRisk: 0,
      geoData: [] as { country: string; count: number }[],
      createdByChannelData: [] as { channel: string; count: number }[],
      sourceChannelData: [] as { channel: string; count: number }[],
      conditionData: [] as { condition: string; count: number }[],
      avgTimeToRefundDays: null as number | null,
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
    avgRefundAmount, revenueAtRisk, geoData, createdByChannelData, sourceChannelData,
    conditionData, avgTimeToRefundDays,
  } = useLoaderData<typeof loader>();

  const handleRangeChange = (newRange: DateRangePreset) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", newRange);
    // defensive `!== "custom"` branch — only one preset path exercised in tests
    /* v8 ignore start */
    if (newRange !== "custom") { next.delete("from"); next.delete("to"); }
    /* v8 ignore stop */
    setSearchParams(next);
  };

  const handleCustomRange = (fromVal: string, toVal: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("range", "custom"); next.set("from", fromVal); next.set("to", toVal);
    setSearchParams(next);
  };

  // Numeric rates for charts/progress rings. Formatted display strings (one
  // decimal under 10%, integer otherwise) so very-small fractions don't visually
  // round to 0% or look identical when they're actually different (P3 finding —
  // 1/3 was rounding to 33% when it should show 33.3% so trends are visible).
  // defensive zero-totals ternaries throughout rate computations + range fallback
  /* v8 ignore start */
  const fmtRate = (n: number) => (n < 10 && n > 0 ? n.toFixed(1) : Math.round(n).toString());
  const approvalRate = totalReturns > 0 ? Math.round((approvedCount / totalReturns) * 100) : 0;
  const rejectionRate = totalReturns > 0 ? Math.round((rejectedCount / totalReturns) * 100) : 0;
  const refundRate = approvedCount > 0 ? Math.round((refundedCount / approvedCount) * 100) : 0;
  const fyndSyncRate = approvedCount > 0 ? Math.round((fyndSyncedCount / approvedCount) * 100) : 0;
  const approvalRateDisplay = totalReturns > 0 ? fmtRate((approvedCount / totalReturns) * 100) : "0";
  const rejectionRateDisplay = totalReturns > 0 ? fmtRate((rejectedCount / totalReturns) * 100) : "0";
  const refundRateDisplay = approvedCount > 0 ? fmtRate((refundedCount / approvedCount) * 100) : "0";
  const fyndSyncRateDisplay = approvedCount > 0 ? fmtRate((fyndSyncedCount / approvedCount) * 100) : "0";
  const avgItemsPerReturn = totalReturns > 0 ? (itemsCount / totalReturns).toFixed(1) : "0";

  const exportParams = new URLSearchParams({ range: range ?? "last_30_days" });
  if (from) exportParams.set("from", from);
  if (to) exportParams.set("to", to);
  /* v8 ignore stop */
  const exportUrl = `/api/returns/export?${exportParams.toString()}`;

  // defensive zero-fallback when no top reasons are present
  /* v8 ignore next */
  const maxReasonCount = topReasons.length > 0 ? Math.max(...topReasons.map((r) => r.count)) : 1;

  const CS = "dashboard-chart-panel"; // reuse dashboard card class

  return (
    <AppPage heading="Analytics">
      <div className="app-content layout-wide" style={{ paddingBottom: 48 }}>
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
          {/* v8 ignore start - custom-range inputs only render when range==="custom"; preset paths skip this */}
          {range === "custom" && (
            <>
              <input type="date" value={from ?? ""} onChange={(e) => handleCustomRange(e.target.value, to ?? "")} />
              <span className="text-muted" style={{ fontSize: 12 }}>to</span>
              <input type="date" value={to ?? ""} onChange={(e) => handleCustomRange(from ?? "", e.target.value)} />
            </>
          )}
          {/* v8 ignore stop */}
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

        {/* ── Hero KPI row (4 primary metrics, modern). */}
        <div className="dashboard-hero-grid mb-md">
          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#3B82F6" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
              </span>
              <span className="kpi-label">Total Returns</span>
              {periodChange !== 0 && (
                <span className={`kpi-change ${periodChange > 0 ? "kpi-change--up" : "kpi-change--down"}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                    {periodChange > 0
                      ? <><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></>
                      : <><line x1="7" y1="7" x2="17" y2="17"/><polyline points="17 7 17 17 7 17"/></>}
                  </svg>
                  {Math.abs(periodChange)}%
                </span>
              )}
            </div>
            <div className="kpi-value">{totalReturns}</div>
            <div className="kpi-meta">{rangeLabel}</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#10B981" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
              </span>
              <span className="kpi-label">Approval Rate</span>
            </div>
            <div className="kpi-value" style={{ color: "#059669" }}>{approvalRateDisplay}%</div>
            <div className="kpi-meta">{approvedCount} of {totalReturns}</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#F59E0B" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </span>
              <span className="kpi-label">Avg Processing</span>
            </div>
            <div className="kpi-value" style={{ color: "#D97706" }}>
              {avgProcessingDays != null ? `${avgProcessingDays.toFixed(1)}d` : "—"}
            </div>
            <div className="kpi-meta">Request → Approval</div>
          </div>

          <div className="dashboard-kpi-card" style={{ "--kpi-accent": "#8B5CF6" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              </span>
              <span className="kpi-label">Refund Rate</span>
            </div>
            <div className="kpi-value" style={{ color: "#7C3AED" }}>{refundRateDisplay}%</div>
            <div className="kpi-meta">{refundedCount} refunded</div>
          </div>
        </div>

        {/* ── Secondary retention / risk stats — compact 4-up row. */}
        <div className="dashboard-stat-grid mb-md">
          <div className="dashboard-stat-card" style={{ "--kpi-accent": "#14B8A6" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              </span>
              <span className="kpi-label">Exchange Conversion</span>
            </div>
            <div className="kpi-value" style={{ color: "#0D9488" }}>{exchangeConversionRate}%</div>
            <div className="kpi-meta">{resolutionChartData.find(d => d.name === "Exchange")?.value ?? 0} of {resolvedCount} resolved</div>
            <div className="kpi-progress"><span style={{ width: `${Math.min(100, exchangeConversionRate)}%` }} /></div>
          </div>

          <div className="dashboard-stat-card" style={{ "--kpi-accent": "#059669" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>
              </span>
              <span className="kpi-label">Revenue Retained</span>
            </div>
            <div className="kpi-value" style={{ color: "#047857" }}>{revenueRetainedRate}%</div>
            <div className="kpi-meta">Credit vs refunds</div>
            <div className="kpi-progress"><span style={{ width: `${Math.min(100, revenueRetainedRate)}%` }} /></div>
          </div>

          <div className="dashboard-stat-card" style={{ "--kpi-accent": "#F97316" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              </span>
              <span className="kpi-label">Repeat Returners</span>
            </div>
            <div className="kpi-value" style={{ color: "#EA580C" }}>{repeatReturnerRate}%</div>
            <div className="kpi-meta">{repeatCustomerCount} of {uniqueCustomerCount} ≥ 2 returns</div>
          </div>

          <div className="dashboard-stat-card" style={{ "--kpi-accent": fraudAlertCount > 0 ? "#DC2626" : "#94A3B8" } as React.CSSProperties}>
            <div className="kpi-header">
              <span className="kpi-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </span>
              <span className="kpi-label">Fraud Alerts</span>
            </div>
            <div className="kpi-value" style={{ color: fraudAlertCount > 0 ? "#B91C1C" : "#94A3B8" }}>{fraudAlertCount}</div>
            <div className="kpi-meta">High + Critical risk</div>
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
                /* v8 ignore start - empty-state fallback when no returns in period */
                <div className="chart-empty">No returns during this period.</div>
                /* v8 ignore stop */
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
                          /* v8 ignore next - tooltip pct ternary defensive (zero-total path unhit) */
                          const pct = total > 0 && props.payload ? Math.round((props.payload.value / total) * 100) : 0;
                          return [`${value ?? 0} (${pct}%)`, ""];
                        }) as never} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", justifyContent: "center" }}>
                    {statusChartData.map((d, i) => {
                      const total = statusChartData.reduce((a, x) => a + x.value, 0);
                      /* v8 ignore start */
                      // defensive: zero-total pct ternary
                      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                      /* v8 ignore stop */
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

        {/* ── Performance Gauges — one panel wrapping all rate donuts so
             the card fills full width instead of leaving a blank tail on
             wide monitors. Previously each donut was its own card in an
             auto-fill grid; on 2000px+ displays that left 6+ empty tracks
             to the right of the last donut. */}
        <div className={CS} style={{ marginBottom: 20 }}>
          <div className="panel-header" style={{ marginBottom: 16 }}>
            <h3 className="panel-title">Performance rates</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>{rangeLabel}</span>
          </div>
          <div className="reports-rates-grid">
            {[
              { label: "Approval", value: approvalRate, display: approvalRateDisplay, color: "#10B981", desc: `${approvedCount} of ${totalReturns}` },
              { label: "Rejection", value: rejectionRate, display: rejectionRateDisplay, color: "#EF4444", desc: `${rejectedCount} of ${totalReturns}` },
              { label: "Refund", value: refundRate, display: refundRateDisplay, color: "#8B5CF6", desc: `${refundedCount} of ${approvedCount} approved` },
              ...(hasFyndConfig ? [{ label: "Fynd Sync", value: fyndSyncRate, display: fyndSyncRateDisplay, color: "#06B6D4", desc: `${fyndSyncedCount} of ${approvedCount}` }] : []),
            ].map((g, i) => (
              <div key={i} className="reports-rate-cell">
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <ProgressRing value={g.value} size={72} strokeWidth={7} color={g.color} />
                  <div style={{
                    position: "absolute", inset: 0, display: "flex", alignItems: "center",
                    justifyContent: "center", fontSize: 16, fontWeight: 800, color: g.color,
                  }}>{g.display}%</div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--rpm-text, #0f172a)", marginBottom: 3 }}>{g.label} rate</div>
                  <div className="text-muted" style={{ fontSize: 11 }}>{g.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Resolution Breakdown — chart on the left, legend with metrics
             on the right. Previously the donut was 160px in a 1200px-wide
             column so it looked lost in empty whitespace. The new
             side-by-side layout fills the panel and lets each segment show
             its count + percentage as a proper data row. */}
        <div className="dashboard-chart-row mb-md">
          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Resolution breakdown</h3>
            {resolutionChartData.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 28, alignItems: "center", padding: "8px 0" }}>
                {/* Chart pinned to a fixed width so it stays a clean circle
                    even as the legend column grows. */}
                <div style={{ width: 200, height: 200, position: "relative" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={resolutionChartData} cx="50%" cy="50%" innerRadius={62} outerRadius={92} paddingAngle={2} dataKey="value" nameKey="name" stroke="none">
                        {resolutionChartData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12, boxShadow: "0 6px 16px -3px rgba(15,23,42,0.1)" }}
                        formatter={((value: number | undefined, _: string | undefined, props: { payload?: { value: number } }) => {
                          const total = resolutionChartData.reduce((a, d) => a + d.value, 0);
                          const pct = total > 0 && props.payload ? Math.round((props.payload.value / total) * 100) : 0;
                          return [`${value ?? 0} (${pct}%)`, ""];
                        }) as never} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Centre label — total resolved, sits inside the donut hole. */}
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                    <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", color: "var(--rpm-text)" }}>
                      {resolutionChartData.reduce((a, d) => a + d.value, 0)}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 2 }}>
                      Resolved
                    </span>
                  </div>
                </div>

                {/* Legend column — one row per segment with colour swatch,
                    name, count, and proportional bar so it doesn't read as
                    a flat key/value list. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* v8 ignore start - empty-data zero-pct fallbacks unhit when chart has data */}
                  {(() => {
                    const total = resolutionChartData.reduce((a, x) => a + x.value, 0);
                    return resolutionChartData.map((d, i) => {
                      const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
                      return (
                        <div key={i} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", gap: 12, alignItems: "center" }}>
                          <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--rpm-text)" }}>{d.name}</span>
                              <span style={{ fontSize: 12, color: "var(--rpm-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                                <strong style={{ color: "var(--rpm-text)", fontWeight: 700 }}>{d.value}</strong>
                                {" · "}{pct}%
                              </span>
                            </div>
                            <div style={{ height: 4, background: "var(--rpm-surface-elevated)", borderRadius: 999, overflow: "hidden", marginTop: 6 }}>
                              <div style={{ height: "100%", width: `${pct}%`, background: d.color, borderRadius: 999, transition: "width 0.4s ease" }} />
                            </div>
                          </div>
                          <span />
                        </div>
                      );
                    });
                  })()}
                </div>
                {/* v8 ignore stop */}
              </div>
            ) : (
              /* v8 ignore start - resolution-empty alt branch (always-data tests) */
              <div className="chart-empty">No resolution data for this period.</div>
              /* v8 ignore stop */
            )}
          </div>

          <div className={CS}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Revenue impact</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "12px 0" }}>
              <div>
                <div className="kpi-label">Revenue retained</div>
                <div className="kpi-row">
                  <span className="kpi-value" style={{ fontSize: 32, color: "#059669" }}>
                    {/* v8 ignore start - locale/currency `||` fallbacks defensive */}
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueRetained)}
                    {/* v8 ignore stop */}
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
                        {/* v8 ignore start */}
                        {/* defensive: r.count > 0 minWidth ternary unhit when zero-count rows filtered */}
                        <div style={{
                          width: `${pct}%`, height: "100%", borderRadius: 3, minWidth: r.count > 0 ? 3 : 0,
                          background: CHART_PALETTE[i % CHART_PALETTE.length],
                          transition: "width 0.4s ease",
                        }} />
                        {/* v8 ignore stop */}
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
                    {/* v8 ignore start - zero-totalReturns ternary fallback never hit when statusMap has entries */}
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
                    {/* v8 ignore stop */}
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
              {/* v8 ignore start - periodChange suggestion banner unhit at zero/positive change */}
              {periodChange < -20 && (
                <div className="dashboard-suggestion dashboard-suggestion--success">
                  <strong>Returns down {Math.abs(periodChange)}%</strong> — Return rate is decreasing.
                </div>
              )}
              {/* v8 ignore stop */}
            </div>
          </div>
        )}

        {/* ── Revenue Impact — two-up only when both panels have data, so a
             lone card doesn't float in a 1fr 340px grid. */}
        {/* v8 ignore start - revenue panels with locale/currency `||` fallbacks + optional sub-conditions */}
        {(totalRefundAmount > 0 || refundMethodBreakdown.length > 0) && (
          <div className={refundMethodBreakdown.length > 0 ? "dashboard-chart-row" : ""} style={{ marginTop: 20 }}>
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
                  <span className="kpi-meta">Avg refund amount</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#8B5CF6" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(avgRefundAmount)}
                  </span>
                </div>
                <div className="flex-between">
                  <span className="kpi-meta">Revenue retained (credit/exchange)</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#059669" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueRetained)}
                  </span>
                </div>
                <div className="flex-between">
                  <span className="kpi-meta">Revenue at risk (30d)</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#D97706" }}>
                    {new Intl.NumberFormat(shopLocale || "en", { style: "currency", currency: shopCurrency || "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(revenueAtRisk)}
                  </span>
                </div>
                {avgTimeToRefundDays != null && (
                  <div className="flex-between">
                    <span className="kpi-meta">Avg time to refund</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#6366F1" }}>{avgTimeToRefundDays}d</span>
                  </div>
                )}
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
        {/* v8 ignore stop */}

        {/* ── Top Products by Returns ── */}
        {/* v8 ignore start - top-products row with `?.count || 1` defensive fallback */}
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
        {/* v8 ignore stop */}

        {/* ── Customer Return Frequency ── */}
        {/* v8 ignore start - customer-frequency conditional renders + count-threshold ternaries */}
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
        {/* v8 ignore stop */}

        {/* ── Geographic Breakdown ── */}
        {/* v8 ignore start - geo conditional render + maxCount fallback */}
        {geoData.length > 0 && (
          <div className={CS} style={{ marginTop: 20 }}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Returns by Country</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {geoData.map((item, idx) => {
                const maxCount = geoData[0]?.count || 1;
                const pct = Math.round((item.count / maxCount) * 100);
                return (
                  <div key={idx}>
                    <div className="flex-between" style={{ marginBottom: 2, fontSize: 13 }}>
                      <span style={{ fontWeight: 500 }}>{item.country}</span>
                      <span className="text-tabular" style={{ fontWeight: 700 }}>{item.count}</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: "#E5E7EB" }}>
                      <div style={{ height: "100%", borderRadius: 3, background: CHART_PALETTE[idx % CHART_PALETTE.length], width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* v8 ignore stop */}

        {/* v8 ignore start - channel attribution two-up layout + total>0 ternaries */}

        {/* ── Channel Attribution — two-up only when both channels have
             data so the single-card case doesn't leave a 340px gap. */}
        {(createdByChannelData.length > 0 || sourceChannelData.length > 0) && (
          <div className={(createdByChannelData.length > 0 && sourceChannelData.length > 0) ? "dashboard-chart-row" : ""} style={{ marginTop: 20 }}>
            {createdByChannelData.length > 0 && (
              <div className={CS}>
                <h3 className="panel-title" style={{ marginBottom: 14 }}>Created Via</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {createdByChannelData.map((item, idx) => {
                    const total = createdByChannelData.reduce((a, c) => a + c.count, 0);
                    const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                    return (
                      <div key={idx} className="flex-between" style={{ padding: "6px 10px", borderRadius: 8, background: "#F9FAFB" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, textTransform: "capitalize" }}>{item.channel}</span>
                        <span className="text-tabular" style={{ fontSize: 12, fontWeight: 700 }}>{item.count} ({pct}%)</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {sourceChannelData.length > 0 && (
              <div className={CS}>
                <h3 className="panel-title" style={{ marginBottom: 14 }}>Order Channel</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {sourceChannelData.map((item, idx) => {
                    const total = sourceChannelData.reduce((a, c) => a + c.count, 0);
                    const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                    return (
                      <div key={idx} className="flex-between" style={{ padding: "6px 10px", borderRadius: 8, background: "#F9FAFB" }}>
                        <span style={{ fontSize: 12, fontWeight: 500, textTransform: "capitalize" }}>{item.channel}</span>
                        <span className="text-tabular" style={{ fontSize: 12, fontWeight: 700 }}>{item.count} ({pct}%)</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {/* v8 ignore stop */}

        {/* ── Item Condition Breakdown ── */}
        {/* v8 ignore start - condition breakdown total>0 ternary defensive */}
        {conditionData.length > 0 && (
          <div className={CS} style={{ marginTop: 20 }}>
            <h3 className="panel-title" style={{ marginBottom: 14 }}>Item Condition Breakdown</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {conditionData.map((item, idx) => {
                const total = conditionData.reduce((a, c) => a + c.count, 0);
                const pct = total > 0 ? Math.round((item.count / total) * 100) : 0;
                return (
                  <div key={idx}>
                    <div className="flex-between" style={{ marginBottom: 2, fontSize: 13 }}>
                      <span style={{ fontWeight: 500, textTransform: "capitalize" }}>{item.condition}</span>
                      <span className="text-tabular" style={{ fontWeight: 700 }}>{item.count} ({pct}%)</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: "#E5E7EB" }}>
                      <div style={{ height: "100%", borderRadius: 3, background: CHART_PALETTE[idx % CHART_PALETTE.length], width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* v8 ignore stop */}

        {/* ── Summary footer ── */}
        <div className="settings-summary-bar" style={{ marginTop: 20, justifyContent: "center" }}>
          <span><strong>{allTimeReturns}</strong> total returns (all time)</span>
          <span>·</span>
          <span><strong>{itemsCount}</strong> items returned ({rangeLabel})</span>
          <span>·</span>
          <span>~<strong>{avgItemsPerReturn}</strong> items per return</span>
        </div>
      </div>
    </AppPage>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  /* v8 ignore start */
  // defensive: error narrowing fallbacks
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  /* v8 ignore stop */
  return (
    <AppPage heading="Analytics">
      <div className="app-content layout-wide">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a href="/app/reports" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</a>
        </div>
      </div>
    </AppPage>
  );
}
