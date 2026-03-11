import React, { useState, useCallback } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const actionFilter = url.searchParams.get("action") ?? "";
  const statusFilter = url.searchParams.get("status") ?? "";
  const shipmentSearch = (url.searchParams.get("shipment") ?? "").trim();
  const orderSearch = (url.searchParams.get("order") ?? "").trim();
  const carrierFilter = url.searchParams.get("carrier") ?? "";
  const eventTypeFilter = url.searchParams.get("eventType") ?? "";
  const customerSearch = (url.searchParams.get("customer") ?? "").trim();
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? "";

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  if (actionFilter) where.action = actionFilter;
  if (statusFilter) where.refundStatus = statusFilter;
  if (shipmentSearch) where.shipmentId = { contains: shipmentSearch, mode: "insensitive" };
  if (orderSearch) {
    where.OR = [
      { orderId: { contains: orderSearch, mode: "insensitive" } },
      { affiliateOrderId: { contains: orderSearch, mode: "insensitive" } },
    ];
  }
  if (carrierFilter) where.carrier = carrierFilter;
  if (eventTypeFilter) where.eventType = eventTypeFilter;
  if (customerSearch) {
    where.OR = [
      ...(where.OR ?? []),
      { customerName: { contains: customerSearch, mode: "insensitive" } },
      { customerEmail: { contains: customerSearch, mode: "insensitive" } },
      { customerPhone: { contains: customerSearch, mode: "insensitive" } },
    ];
  }

  if (dateFrom || dateTo) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (dateTo) {
      const d = new Date(dateTo);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        dateFilter.lte = d;
      }
    }
    if (dateFilter.gte || dateFilter.lte) where.createdAt = dateFilter;
  }

  try {
    const [totalCount, logs, allLogs, distinctActions, distinctStatuses, distinctCarriers, distinctEventTypes] = await Promise.all([
      prisma.fyndWebhookLog.count({ where }),
      prisma.fyndWebhookLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.fyndWebhookLog.findMany({
        select: { action: true },
      }),
      prisma.fyndWebhookLog.findMany({
        select: { action: true },
        distinct: ["action"],
        where: { action: { not: null } },
      }),
      prisma.fyndWebhookLog.findMany({
        select: { refundStatus: true },
        distinct: ["refundStatus"],
        where: { refundStatus: { not: null } },
      }),
      prisma.fyndWebhookLog.findMany({
        select: { carrier: true },
        distinct: ["carrier"],
        where: { carrier: { not: null } },
      }),
      prisma.fyndWebhookLog.findMany({
        select: { eventType: true },
        distinct: ["eventType"],
        where: { eventType: { not: null } },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    const actionCounts: Record<string, number> = {};
    let totalAll = 0;
    for (const row of allLogs) {
      const key = row.action ?? "unknown";
      actionCounts[key] = (actionCounts[key] ?? 0) + 1;
      totalAll++;
    }

    const successCount = (actionCounts["refund_in_progress"] ?? 0) + (actionCounts["refund_completed"] ?? 0);
    const errorCount = actionCounts["error"] ?? 0;
    const ignoredCount = actionCounts["ignored"] ?? 0;
    const duplicateCount = actionCounts["duplicate_ignored"] ?? 0;
    const successRate = totalAll > 0 ? Math.round(((totalAll - errorCount) / totalAll) * 100) : 100;

    const makeOptions = (items: string[], allLabel: string) => [
      { value: "", label: allLabel },
      ...items.sort().map((s) => ({
        value: s,
        label: s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    ];

    const actionOptions = makeOptions(
      distinctActions.map((r) => r.action).filter((a): a is string => !!a),
      "All actions",
    );
    const statusOptions = makeOptions(
      distinctStatuses.map((r) => r.refundStatus).filter((s): s is string => !!s),
      "All statuses",
    );
    const carrierOptions = makeOptions(
      distinctCarriers.map((r) => r.carrier).filter((c): c is string => !!c),
      "All carriers",
    );
    const eventTypeOptions = makeOptions(
      distinctEventTypes.map((r) => r.eventType).filter((e): e is string => !!e),
      "All event types",
    );

    return {
      logs: logs.map((l) => ({
        id: l.id,
        shipmentId: l.shipmentId,
        orderId: l.orderId,
        affiliateOrderId: l.affiliateOrderId,
        refundStatus: l.refundStatus,
        fyndStatus: l.fyndStatus,
        eventType: l.eventType,
        action: l.action,
        returnCaseId: l.returnCaseId,
        carrier: l.carrier,
        awbNumber: l.awbNumber,
        trackingUrl: l.trackingUrl,
        customerName: l.customerName,
        customerEmail: l.customerEmail,
        customerPhone: l.customerPhone,
        shopDomain: l.shopDomain,
        error: l.error,
        rawPayload: l.rawPayload,
        createdAt: l.createdAt.toISOString(),
      })),
      page,
      totalPages,
      totalCount,
      analytics: {
        total: totalAll,
        successCount,
        errorCount,
        ignoredCount,
        duplicateCount,
        successRate,
        actionCounts,
      },
      filters: { actionFilter, statusFilter, shipmentSearch, orderSearch, carrierFilter, eventTypeFilter, customerSearch, dateFrom, dateTo },
      actionOptions,
      statusOptions,
      carrierOptions,
      eventTypeOptions,
      loaderError: null,
    };
  } catch (err) {
    console.error("[webhook-logs] Loader error:", err);
    return {
      logs: [],
      page: 1,
      totalPages: 1,
      totalCount: 0,
      analytics: { total: 0, successCount: 0, errorCount: 0, ignoredCount: 0, duplicateCount: 0, successRate: 100, actionCounts: {} },
      filters: { actionFilter, statusFilter, shipmentSearch, orderSearch, carrierFilter, eventTypeFilter, customerSearch, dateFrom, dateTo },
      actionOptions: [{ value: "", label: "All actions" }],
      statusOptions: [{ value: "", label: "All statuses" }],
      carrierOptions: [{ value: "", label: "All carriers" }],
      eventTypeOptions: [{ value: "", label: "All event types" }],
      loaderError: err instanceof Error ? err.message : "Failed to load webhook logs",
    };
  }
};

function ActionBadge({ action }: { action: string | null }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    refund_in_progress: { bg: "#DBEAFE", color: "#1E40AF", label: "Refund In Progress" },
    refund_completed: { bg: "#D1FAE5", color: "#065F46", label: "Refund Completed" },
    ignored: { bg: "#F3F4F6", color: "#6B7280", label: "Ignored" },
    error: { bg: "#FEE2E2", color: "#991B1B", label: "Error" },
    duplicate_ignored: { bg: "#FEF3C7", color: "#92400E", label: "Duplicate" },
  };
  const a = action ?? "unknown";
  const style = map[a] ?? { bg: "#F3F4F6", color: "#6B7280", label: a };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, fontWeight: 600, padding: "3px 8px",
      borderRadius: 5, background: style.bg, color: style.color,
      whiteSpace: "nowrap",
    }}>
      {a === "error" && <span style={{ fontSize: 12 }}>!</span>}
      {style.label}
    </span>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: number | string; color: string; sub?: string }) {
  return (
    <div style={{
      flex: "1 1 120px", padding: "14px 16px",
      background: "white", borderRadius: 10,
      border: "1px solid #E5E7EB",
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** Recursive JSON tree viewer with collapsible nodes and syntax highlighting */
function JsonTreeViewer({ data, depth = 0, defaultExpanded = true }: { data: unknown; depth?: number; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded && depth < 2);

  if (data === null) return <span style={{ color: "#A78BFA" }}>null</span>;
  if (data === undefined) return <span style={{ color: "#A78BFA" }}>undefined</span>;
  if (typeof data === "boolean") return <span style={{ color: "#F59E0B" }}>{String(data)}</span>;
  if (typeof data === "number") return <span style={{ color: "#10B981" }}>{data}</span>;
  if (typeof data === "string") {
    if (data.length > 200) {
      return <span style={{ color: "#F87171" }}>&quot;{data.slice(0, 200)}...&quot;</span>;
    }
    return <span style={{ color: "#F87171" }}>&quot;{data}&quot;</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span style={{ color: "#9CA3AF" }}>[]</span>;
    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 11, padding: 0 }}
        >
          {expanded ? "[-]" : "[+]"} Array({data.length})
        </button>
        {expanded && (
          <div style={{ paddingLeft: 16, borderLeft: "1px solid #334155" }}>
            {data.map((item, i) => (
              <div key={i} style={{ marginTop: 2 }}>
                <span style={{ color: "#6B7280", fontSize: 11 }}>{i}: </span>
                <JsonTreeViewer data={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span style={{ color: "#9CA3AF" }}>{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: 11, padding: 0 }}
        >
          {expanded ? "{-}" : "{+}"} Object({entries.length})
        </button>
        {expanded && (
          <div style={{ paddingLeft: 16, borderLeft: "1px solid #334155" }}>
            {entries.map(([key, val]) => (
              <div key={key} style={{ marginTop: 2 }}>
                <span style={{ color: "#93C5FD", fontWeight: 600, fontSize: 11 }}>{key}</span>
                <span style={{ color: "#6B7280" }}>: </span>
                <JsonTreeViewer data={val} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </span>
    );
  }

  return <span style={{ color: "#9CA3AF" }}>{String(data)}</span>;
}

/** JSON payload viewer with tree view, raw view toggle, copy, and search */
function PayloadViewer({ rawPayload }: { rawPayload: string | null }) {
  const [viewMode, setViewMode] = useState<"tree" | "raw">("tree");
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");

  if (!rawPayload) {
    return <div style={{ padding: 12, color: "#6B7280", fontSize: 12 }}>No payload data</div>;
  }

  let parsed: unknown = null;
  let isValidJson = false;
  try {
    parsed = JSON.parse(rawPayload);
    isValidJson = true;
  } catch {
    // Invalid JSON — show as raw text
  }

  const formatted = isValidJson ? JSON.stringify(parsed, null, 2) : rawPayload;
  const displayRaw = search
    ? formatted.split("\n").filter((line) => line.toLowerCase().includes(search.toLowerCase())).join("\n")
    : formatted;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(formatted).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [formatted]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>Payload</span>
        <div style={{ flex: 1 }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search in payload..."
          style={{
            padding: "4px 8px", fontSize: 11, borderRadius: 4,
            border: "1px solid #475569", background: "#0F172A", color: "#E2E8F0",
            width: 160,
          }}
        />
        {isValidJson && (
          <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #475569" }}>
            <button
              onClick={() => setViewMode("tree")}
              style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer",
                background: viewMode === "tree" ? "#3B82F6" : "#1E293B",
                color: viewMode === "tree" ? "white" : "#9CA3AF",
              }}
            >
              Tree
            </button>
            <button
              onClick={() => setViewMode("raw")}
              style={{
                padding: "3px 8px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer",
                background: viewMode === "raw" ? "#3B82F6" : "#1E293B",
                color: viewMode === "raw" ? "white" : "#9CA3AF",
              }}
            >
              Raw
            </button>
          </div>
        )}
        <button
          onClick={handleCopy}
          style={{
            padding: "3px 8px", fontSize: 10, fontWeight: 600,
            borderRadius: 4, border: "1px solid #475569",
            background: copied ? "#059669" : "#1E293B",
            color: copied ? "white" : "#9CA3AF",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <div style={{
        background: "#0F172A", borderRadius: 6, padding: "10px 12px",
        maxHeight: 400, overflow: "auto", fontSize: 11, lineHeight: 1.6,
        fontFamily: "monospace", color: "#E2E8F0",
      }}>
        {viewMode === "tree" && isValidJson ? (
          <JsonTreeViewer data={parsed} />
        ) : (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {displayRaw}
          </pre>
        )}
      </div>
    </div>
  );
}

function InfoItem({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div style={{ minWidth: 120 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>{label}</span>
      <div style={{
        fontSize: 12, color: value ? "#374151" : "#D1D5DB", marginTop: 2,
        fontFamily: mono ? "monospace" : "inherit",
        wordBreak: "break-all",
      }}>
        {value || "—"}
      </div>
    </div>
  );
}

export default function WebhookLogsPage() {
  const {
    logs, page, totalPages, totalCount, analytics, filters,
    actionOptions, statusOptions, carrierOptions, eventTypeOptions, loaderError,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const [actionFilter, setActionFilter] = useState(filters.actionFilter);
  const [statusFilter, setStatusFilter] = useState(filters.statusFilter);
  const [shipmentSearch, setShipmentSearch] = useState(filters.shipmentSearch);
  const [orderSearch, setOrderSearch] = useState(filters.orderSearch);
  const [carrierFilter, setCarrierFilter] = useState(filters.carrierFilter);
  const [eventTypeFilter, setEventTypeFilter] = useState(filters.eventTypeFilter);
  const [customerSearch, setCustomerSearch] = useState(filters.customerSearch);
  const [dateFrom, setDateFrom] = useState(filters.dateFrom);
  const [dateTo, setDateTo] = useState(filters.dateTo);

  function applyFilters() {
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (shipmentSearch) params.set("shipment", shipmentSearch);
    if (orderSearch) params.set("order", orderSearch);
    if (carrierFilter) params.set("carrier", carrierFilter);
    if (eventTypeFilter) params.set("eventType", eventTypeFilter);
    if (customerSearch) params.set("customer", customerSearch);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    params.set("page", "1");
    setSearchParams(params);
  }

  function clearFilters() {
    setActionFilter("");
    setStatusFilter("");
    setShipmentSearch("");
    setOrderSearch("");
    setCarrierFilter("");
    setEventTypeFilter("");
    setCustomerSearch("");
    setDateFrom("");
    setDateTo("");
    setSearchParams({ page: "1" });
  }

  function goToPage(p: number) {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(p));
    setSearchParams(params);
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function formatTimestamp(iso: string) {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true,
    }).format(d);
  }

  const hasActiveFilters = !!(actionFilter || statusFilter || shipmentSearch || orderSearch || carrierFilter || eventTypeFilter || customerSearch || dateFrom || dateTo);

  const TOTAL_COLUMNS = 12;

  return (
    <s-page heading="Fynd Webhook Logs">
      <div className="app-content">

        {loaderError && (
          <div style={{
            padding: "14px 18px", marginBottom: 16,
            background: "#FEF2F2", border: "1px solid #FECACA",
            borderRadius: 10, color: "#991B1B", fontSize: 13,
          }}>
            Failed to load webhook logs: {loaderError}
          </div>
        )}

        {/* Analytics Summary */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <StatCard label="Total Webhooks" value={analytics.total} color="#0F172A" />
          <StatCard label="Processed" value={analytics.successCount} color="#059669" sub="refund actions" />
          <StatCard label="Errors" value={analytics.errorCount} color={analytics.errorCount > 0 ? "#DC2626" : "#059669"} />
          <StatCard label="Ignored" value={analytics.ignoredCount} color="#6B7280" sub={analytics.duplicateCount > 0 ? `+ ${analytics.duplicateCount} duplicates` : undefined} />
          <StatCard label="Success Rate" value={`${analytics.successRate}%`} color={analytics.successRate >= 95 ? "#059669" : analytics.successRate >= 80 ? "#D97706" : "#DC2626"} />
        </div>

        {/* Action Breakdown */}
        {analytics.total > 0 && (
          <div style={{
            marginBottom: 20, padding: "14px 18px",
            background: "white", borderRadius: 10,
            border: "1px solid #E5E7EB",
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 10, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
              Action Breakdown
            </div>
            <div style={{ display: "flex", gap: 6, height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
              {analytics.actionCounts && Object.entries(analytics.actionCounts).map(([action, count]) => {
                const pct = analytics.total > 0 ? (count / analytics.total) * 100 : 0;
                const colors: Record<string, string> = {
                  refund_completed: "#059669", refund_in_progress: "#3B82F6",
                  ignored: "#D1D5DB", error: "#DC2626", duplicate_ignored: "#F59E0B",
                };
                return (
                  <div key={action} style={{
                    width: `${pct}%`, minWidth: pct > 0 ? 4 : 0,
                    background: colors[action] ?? "#9CA3AF", borderRadius: 2,
                  }} title={`${action}: ${count}`} />
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {Object.entries(analytics.actionCounts).map(([action, count]) => {
                const colors: Record<string, string> = {
                  refund_completed: "#059669", refund_in_progress: "#3B82F6",
                  ignored: "#9CA3AF", error: "#DC2626", duplicate_ignored: "#F59E0B",
                };
                return (
                  <div key={action} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: colors[action] ?? "#9CA3AF" }} />
                    <span style={{ color: "#374151", fontWeight: 500 }}>{action.replace(/_/g, " ")}</span>
                    <span style={{ color: "#9CA3AF" }}>({count})</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end",
          marginBottom: 16, padding: "14px 18px",
          background: "white", borderRadius: 10,
          border: "1px solid #E5E7EB",
        }}>
          <FilterSelect label="Action" value={actionFilter} onChange={setActionFilter} options={actionOptions} />
          <FilterSelect label="Fynd Status" value={statusFilter} onChange={setStatusFilter} options={statusOptions} />
          <FilterSelect label="Event Type" value={eventTypeFilter} onChange={setEventTypeFilter} options={eventTypeOptions} />
          <FilterSelect label="Carrier" value={carrierFilter} onChange={setCarrierFilter} options={carrierOptions} />
          <FilterInput label="Shipment ID" value={shipmentSearch} onChange={setShipmentSearch} />
          <FilterInput label="Order ID" value={orderSearch} onChange={setOrderSearch} />
          <FilterInput label="Customer" value={customerSearch} onChange={setCustomerSearch} />

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={inputStyle}
            />
          </div>

          <button onClick={applyFilters} style={filterBtnStyle}>Filter</button>

          {hasActiveFilters && (
            <button onClick={clearFilters} style={clearBtnStyle}>Clear</button>
          )}

          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "#9CA3AF", alignSelf: "center" }}>
            {totalCount} log{totalCount !== 1 ? "s" : ""}{hasActiveFilters ? " (filtered)" : ""}
          </span>
        </div>

        {/* Log Table */}
        <div style={{
          background: "white", borderRadius: 10,
          border: "1px solid #E5E7EB", overflow: "hidden",
        }}>
          {logs.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#9CA3AF" }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: "0 auto 12px", color: "#D1D5DB" }}>
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No webhook logs found</div>
              <div style={{ fontSize: 12 }}>
                {hasActiveFilters
                  ? "Try adjusting your filters."
                  : "Webhook logs will appear here when Fynd sends shipment status updates."}
              </div>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#F9FAFB", borderBottom: "1px solid #E5E7EB" }}>
                    <th style={thStyle}>Timestamp</th>
                    <th style={thStyle}>Event Type</th>
                    <th style={thStyle}>Shipment ID</th>
                    <th style={thStyle}>Fynd Order</th>
                    <th style={thStyle}>Shopify Order</th>
                    <th style={thStyle}>Fynd Status</th>
                    <th style={thStyle}>Carrier / AWB</th>
                    <th style={thStyle}>Customer</th>
                    <th style={thStyle}>Action</th>
                    <th style={thStyle}>Return Case</th>
                    <th style={thStyle}>Error</th>
                    <th style={{ ...thStyle, width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => {
                    const isExpanded = expandedRows.has(log.id);
                    return (
                      <React.Fragment key={log.id}>
                        <tr style={{
                          borderBottom: isExpanded ? "none" : "1px solid #F3F4F6",
                          background: log.action === "error" ? "#FEF2F2" : undefined,
                        }}>
                          {/* Timestamp */}
                          <td style={tdStyle}>
                            <div style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                              {formatTimestamp(log.createdAt)}
                            </div>
                          </td>
                          {/* Event Type */}
                          <td style={tdStyle}>
                            {log.eventType ? (
                              <span style={{
                                display: "inline-block", padding: "2px 6px",
                                fontSize: 10, fontWeight: 500, borderRadius: 4,
                                background: "#EDE9FE", color: "#6D28D9",
                              }}>
                                {log.eventType}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Shipment ID */}
                          <td style={tdStyle}>
                            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#374151" }}>
                              {log.shipmentId ?? "—"}
                            </span>
                          </td>
                          {/* Fynd Order ID */}
                          <td style={tdStyle}>
                            <span style={{ fontFamily: "monospace", fontSize: 11, color: "#374151" }}>
                              {log.orderId ?? "—"}
                            </span>
                          </td>
                          {/* Shopify Order (affiliate_order_id) */}
                          <td style={tdStyle}>
                            <span style={{
                              fontFamily: "monospace", fontSize: 11,
                              color: log.affiliateOrderId ? "#059669" : "#D1D5DB",
                              fontWeight: log.affiliateOrderId ? 600 : 400,
                            }}>
                              {log.affiliateOrderId ?? "—"}
                            </span>
                          </td>
                          {/* Fynd Status */}
                          <td style={tdStyle}>
                            {(log.fyndStatus || log.refundStatus) ? (
                              <span style={{
                                display: "inline-block", padding: "2px 7px",
                                fontSize: 11, fontWeight: 500,
                                background: "#F3F4F6", borderRadius: 4, color: "#374151",
                              }}>
                                {log.fyndStatus || log.refundStatus}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Carrier / AWB */}
                          <td style={tdStyle}>
                            {(log.carrier || log.awbNumber) ? (
                              <div style={{ fontSize: 11 }}>
                                {log.carrier && <div style={{ fontWeight: 500, color: "#374151" }}>{log.carrier}</div>}
                                {log.awbNumber && (
                                  log.trackingUrl ? (
                                    <a href={log.trackingUrl} target="_blank" rel="noopener noreferrer" style={{
                                      fontFamily: "monospace", color: "#3B82F6", textDecoration: "none", fontSize: 10,
                                    }}>
                                      {log.awbNumber}
                                    </a>
                                  ) : (
                                    <span style={{ fontFamily: "monospace", color: "#6B7280", fontSize: 10 }}>{log.awbNumber}</span>
                                  )
                                )}
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Customer */}
                          <td style={tdStyle}>
                            {(log.customerName || log.customerEmail) ? (
                              <div style={{ fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>
                                {log.customerName && <div style={{ fontWeight: 500, color: "#374151", whiteSpace: "nowrap" }}>{log.customerName}</div>}
                                {log.customerEmail && <div style={{ color: "#6B7280", whiteSpace: "nowrap", fontSize: 10 }}>{log.customerEmail}</div>}
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Action */}
                          <td style={tdStyle}>
                            <ActionBadge action={log.action} />
                          </td>
                          {/* Return Case */}
                          <td style={tdStyle}>
                            {log.returnCaseId ? (
                              <Link
                                to={`/app/returns/${log.returnCaseId}`}
                                style={{ fontSize: 12, color: "#3B82F6", fontWeight: 500, textDecoration: "none" }}
                              >
                                View
                              </Link>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Error */}
                          <td style={tdStyle}>
                            {log.error ? (
                              <span style={{
                                fontSize: 11, color: "#DC2626", maxWidth: 160,
                                display: "inline-block", overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }} title={log.error}>
                                {log.error}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          {/* Expand */}
                          <td style={tdStyle}>
                            <button
                              onClick={() => toggleRow(log.id)}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                padding: 4, color: "#9CA3AF", fontSize: 14,
                              }}
                              title={isExpanded ? "Collapse" : "View details"}
                              aria-label={isExpanded ? "Collapse details" : "Expand details"}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={TOTAL_COLUMNS} style={{
                              padding: "0 14px 14px",
                              borderBottom: "1px solid #F3F4F6",
                              background: "#F9FAFB",
                            }}>
                              {/* Order Info */}
                              <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", marginBottom: 8, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
                                  Order Info
                                </div>
                                <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                                  <InfoItem label="Log ID" value={log.id} mono />
                                  <InfoItem label="Fynd Order ID" value={log.orderId} mono />
                                  <InfoItem label="Shopify Order (Affiliate)" value={log.affiliateOrderId} mono />
                                  <InfoItem label="Shipment ID" value={log.shipmentId} mono />
                                  <InfoItem label="Event Type" value={log.eventType} />
                                  <InfoItem label="Fynd Status" value={log.fyndStatus || log.refundStatus} />
                                  <InfoItem label="Shop Domain" value={log.shopDomain} />
                                  {log.returnCaseId && <InfoItem label="Return Case ID" value={log.returnCaseId} mono />}
                                </div>
                              </div>

                              {/* Customer Info */}
                              {(log.customerName || log.customerEmail || log.customerPhone) && (
                                <div style={{ marginBottom: 12 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", marginBottom: 8, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
                                    Customer Info
                                  </div>
                                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                                    <InfoItem label="Name" value={log.customerName} />
                                    <InfoItem label="Email" value={log.customerEmail} />
                                    <InfoItem label="Phone" value={log.customerPhone} />
                                  </div>
                                </div>
                              )}

                              {/* Shipping Info */}
                              {(log.carrier || log.awbNumber || log.trackingUrl) && (
                                <div style={{ marginBottom: 12 }}>
                                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", marginBottom: 8, textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>
                                    Shipping Info
                                  </div>
                                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                                    <InfoItem label="Carrier" value={log.carrier} />
                                    <InfoItem label="AWB Number" value={log.awbNumber} mono />
                                    {log.trackingUrl && (
                                      <div style={{ minWidth: 120 }}>
                                        <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>Tracking URL</span>
                                        <div style={{ fontSize: 12, marginTop: 2 }}>
                                          <a href={log.trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#3B82F6", textDecoration: "none", wordBreak: "break-all" }}>
                                            {log.trackingUrl.length > 60 ? log.trackingUrl.slice(0, 60) + "..." : log.trackingUrl}
                                          </a>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}

                              {/* Error */}
                              {log.error && (
                                <div style={{ marginBottom: 12 }}>
                                  <span style={{ fontSize: 10, fontWeight: 600, color: "#DC2626", textTransform: "uppercase" as const }}>Error Details</span>
                                  <div style={{
                                    fontSize: 12, color: "#991B1B", padding: "8px 10px",
                                    background: "#FEE2E2", borderRadius: 6, marginTop: 4,
                                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                                  }}>
                                    {log.error}
                                  </div>
                                </div>
                              )}

                              {/* Payload Viewer */}
                              <PayloadViewer rawPayload={log.rawPayload} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "12px 18px", borderTop: "1px solid #E5E7EB",
              background: "#F9FAFB",
            }}>
              <span style={{ fontSize: 12, color: "#6B7280" }}>
                Page {page} of {totalPages} ({totalCount} total)
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                  style={paginationBtnStyle(page <= 1)}
                >
                  Previous
                </button>
                {getPageNumbers(page, totalPages).map((p, i) =>
                  p === null ? (
                    <span key={`dots-${i}`} style={{ padding: "0 4px", color: "#9CA3AF" }}>...</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => goToPage(p)}
                      style={{
                        ...paginationBtnStyle(false),
                        background: p === page ? "#0F172A" : "white",
                        color: p === page ? "white" : "#374151",
                        fontWeight: p === page ? 700 : 500,
                        minWidth: 32,
                      }}
                    >
                      {p}
                    </button>
                  )
                )}
                <button
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                  style={paginationBtnStyle(page >= totalPages)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

/* ── Shared Filter Components ── */

function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, minWidth: 130 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search..."
        style={{ ...inputStyle, width: 130 }}
      />
    </div>
  );
}

/* ── Shared Styles ── */

const inputStyle: React.CSSProperties = {
  padding: "7px 10px", fontSize: 13, borderRadius: 6,
  border: "1px solid #D1D5DB", background: "white",
};

const filterBtnStyle: React.CSSProperties = {
  padding: "7px 16px", fontSize: 13, fontWeight: 600,
  borderRadius: 6, border: "none",
  background: "#0F172A", color: "white", cursor: "pointer",
  height: 34,
};

const clearBtnStyle: React.CSSProperties = {
  padding: "7px 14px", fontSize: 13, fontWeight: 500,
  borderRadius: 6, border: "1px solid #D1D5DB",
  background: "white", color: "#6B7280", cursor: "pointer",
  height: 34,
};

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  color: "#6B7280",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 12px",
  verticalAlign: "middle",
};

function paginationBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 6,
    border: "1px solid #D1D5DB",
    background: disabled ? "#F3F4F6" : "white",
    color: disabled ? "#D1D5DB" : "#374151",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function getPageNumbers(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | null)[] = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push(null, total);
  } else if (current >= total - 3) {
    pages.push(1, null);
    for (let i = total - 4; i <= total; i++) pages.push(i);
  } else {
    pages.push(1, null, current - 1, current, current + 1, null, total);
  }
  return pages;
}
