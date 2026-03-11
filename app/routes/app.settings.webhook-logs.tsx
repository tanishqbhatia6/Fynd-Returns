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
  const searchQuery = (url.searchParams.get("q") ?? "").trim();
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  if (actionFilter) where.action = actionFilter;
  if (statusFilter) where.fyndStatus = statusFilter;
  if (searchQuery) {
    where.OR = [
      { shipmentId: { contains: searchQuery, mode: "insensitive" } },
      { orderId: { contains: searchQuery, mode: "insensitive" } },
      { affiliateOrderId: { contains: searchQuery, mode: "insensitive" } },
      { carrier: { contains: searchQuery, mode: "insensitive" } },
      { awbNumber: { contains: searchQuery, mode: "insensitive" } },
      { customerName: { contains: searchQuery, mode: "insensitive" } },
      { customerEmail: { contains: searchQuery, mode: "insensitive" } },
      { error: { contains: searchQuery, mode: "insensitive" } },
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
    const [totalCount, logs, allLogs, distinctActions, distinctStatuses] = await Promise.all([
      prisma.fyndWebhookLog.count({ where }),
      prisma.fyndWebhookLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.fyndWebhookLog.findMany({ select: { action: true } }),
      prisma.fyndWebhookLog.findMany({
        select: { action: true },
        distinct: ["action"],
        where: { action: { not: { equals: null } } },
      }),
      prisma.fyndWebhookLog.findMany({
        select: { fyndStatus: true },
        distinct: ["fyndStatus"],
        where: { fyndStatus: { not: { equals: null } } },
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

    const mkOpts = (items: string[], allLabel: string) => [
      { value: "", label: allLabel },
      ...items.sort().map((s) => ({
        value: s,
        label: s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      })),
    ];

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
      analytics: { total: totalAll, successCount, errorCount, ignoredCount, duplicateCount, successRate, actionCounts },
      filters: { actionFilter, statusFilter, searchQuery, dateFrom, dateTo },
      actionOptions: mkOpts(distinctActions.map((r) => r.action).filter((a): a is string => !!a), "All actions"),
      statusOptions: mkOpts(distinctStatuses.map((r) => r.fyndStatus).filter((s): s is string => !!s), "All statuses"),
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
      filters: { actionFilter: "", statusFilter: "", searchQuery: "", dateFrom: "", dateTo: "" },
      actionOptions: [{ value: "", label: "All actions" }],
      statusOptions: [{ value: "", label: "All statuses" }],
      loaderError: err instanceof Error ? err.message : "Failed to load webhook logs",
    };
  }
};

/* ─── Badge Components ─── */

function ActionBadge({ action }: { action: string | null }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    refund_in_progress: { bg: "#DBEAFE", color: "#1E40AF", label: "In Progress" },
    refund_completed: { bg: "#D1FAE5", color: "#065F46", label: "Completed" },
    ignored: { bg: "#F3F4F6", color: "#6B7280", label: "Ignored" },
    error: { bg: "#FEE2E2", color: "#991B1B", label: "Error" },
    duplicate_ignored: { bg: "#FEF3C7", color: "#92400E", label: "Duplicate" },
  };
  const a = action ?? "unknown";
  const s = map[a] ?? { bg: "#F3F4F6", color: "#6B7280", label: a.replace(/_/g, " ") };
  return (
    <span style={{
      display: "inline-block", fontSize: 10, fontWeight: 600, padding: "2px 7px",
      borderRadius: 4, background: s.bg, color: s.color, whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span style={{ color: "#D1D5DB", fontSize: 11 }}>—</span>;
  return (
    <span style={{
      display: "inline-block", fontSize: 10, fontWeight: 500, padding: "2px 6px",
      borderRadius: 4, background: "#F3F4F6", color: "#374151", whiteSpace: "nowrap",
      maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis",
    }} title={status}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: number | string; color: string; sub?: string }) {
  return (
    <div style={{
      flex: "1 1 100px", padding: "12px 14px",
      background: "white", borderRadius: 10, border: "1px solid #E5E7EB",
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const, letterSpacing: "0.04em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/* ─── JSON Tree Viewer ─── */

function JsonNode({ k, value, depth }: { k?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  const renderValue = () => {
    if (value === null) return <span style={{ color: "#A78BFA" }}>null</span>;
    if (typeof value === "boolean") return <span style={{ color: "#F59E0B" }}>{String(value)}</span>;
    if (typeof value === "number") return <span style={{ color: "#10B981" }}>{value}</span>;
    if (typeof value === "string") {
      const display = value.length > 120 ? value.slice(0, 120) + "..." : value;
      return <span style={{ color: "#F87171" }}>&quot;{display}&quot;</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return <span style={{ color: "#6B7280" }}>[]</span>;
      return (
        <>
          <button onClick={() => setOpen(!open)} style={toggleBtnStyle}>
            {open ? "\u25BE" : "\u25B8"} [{value.length}]
          </button>
          {open && (
            <div style={{ paddingLeft: 14, borderLeft: "1px solid #334155", marginLeft: 2, marginTop: 2 }}>
              {value.map((item, i) => <JsonNode key={i} k={String(i)} value={item} depth={depth + 1} />)}
            </div>
          )}
        </>
      );
    }

    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return <span style={{ color: "#6B7280" }}>{"{}"}</span>;
      return (
        <>
          <button onClick={() => setOpen(!open)} style={toggleBtnStyle}>
            {open ? "\u25BE" : "\u25B8"} {"{"}
            {entries.length}
            {"}"}
          </button>
          {open && (
            <div style={{ paddingLeft: 14, borderLeft: "1px solid #334155", marginLeft: 2, marginTop: 2 }}>
              {entries.map(([ek, ev]) => <JsonNode key={ek} k={ek} value={ev} depth={depth + 1} />)}
            </div>
          )}
        </>
      );
    }

    return <span style={{ color: "#9CA3AF" }}>{String(value)}</span>;
  };

  return (
    <div style={{ lineHeight: 1.7, fontSize: 11.5, fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
      {k !== undefined && <span style={{ color: "#93C5FD" }}>{k}</span>}
      {k !== undefined && <span style={{ color: "#6B7280" }}>: </span>}
      {renderValue()}
    </div>
  );
}

const toggleBtnStyle: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", color: "#9CA3AF",
  fontSize: 11, padding: 0, fontFamily: "inherit",
};

/* ─── Payload Viewer ─── */

function PayloadViewer({ rawPayload }: { rawPayload: string | null }) {
  const [mode, setMode] = useState<"tree" | "formatted" | "raw">("tree");
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");

  if (!rawPayload) return <div style={{ padding: 10, color: "#6B7280", fontSize: 12 }}>No payload</div>;

  let parsed: unknown = null;
  let isValid = false;
  try { parsed = JSON.parse(rawPayload); isValid = true; } catch { /* truncated */ }

  const formatted = isValid ? JSON.stringify(parsed, null, 2) : rawPayload;
  const displayText = search
    ? formatted.split("\n").filter((l) => l.toLowerCase().includes(search.toLowerCase())).join("\n")
    : formatted;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(rawPayload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [rawPayload]);

  return (
    <div style={{
      background: "#0F172A", borderRadius: 8, overflow: "hidden",
      border: "1px solid #1E293B",
    }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", gap: 6, alignItems: "center", padding: "6px 10px",
        background: "#1E293B", borderBottom: "1px solid #334155", flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: "#64748B", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>Payload</span>
        <div style={{ flex: 1 }} />
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            padding: "3px 8px", fontSize: 11, borderRadius: 4,
            border: "1px solid #475569", background: "#0F172A", color: "#E2E8F0", width: 140,
          }}
        />
        <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #475569" }}>
          {(["tree", "formatted", "raw"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: "3px 8px", fontSize: 10, fontWeight: 600, border: "none", cursor: "pointer",
              background: mode === m ? "#3B82F6" : "transparent",
              color: mode === m ? "white" : "#64748B",
            }}>
              {m === "tree" ? "Tree" : m === "formatted" ? "Pretty" : "Raw"}
            </button>
          ))}
        </div>
        <button onClick={handleCopy} style={{
          padding: "3px 8px", fontSize: 10, fontWeight: 600, borderRadius: 4,
          border: "1px solid #475569", background: copied ? "#059669" : "transparent",
          color: copied ? "white" : "#64748B", cursor: "pointer",
        }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {/* Content */}
      <div style={{ padding: "8px 10px", maxHeight: 400, overflow: "auto", color: "#E2E8F0" }}>
        {mode === "tree" && isValid ? (
          <JsonNode value={parsed} depth={0} />
        ) : mode === "formatted" && isValid ? (
          <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'SF Mono', Menlo, Consolas, monospace" }}>
            {displayText}
          </pre>
        ) : (
          <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "'SF Mono', Menlo, Consolas, monospace", color: "#94A3B8" }}>
            {displayText}
            {!isValid && (
              <div style={{ marginTop: 8, padding: "4px 8px", background: "#7C2D12", borderRadius: 4, color: "#FED7AA", fontSize: 10 }}>
                Payload was truncated — showing raw text. New webhooks will capture the full payload.
              </div>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ─── Detail Row (Expanded) ─── */

type LogEntry = ReturnType<typeof useLoaderData<typeof loader>>["logs"][number];

function DetailPanel({ log }: { log: LogEntry }) {
  return (
    <div style={{ padding: "12px 16px", background: "#F8FAFC", borderBottom: "1px solid #E5E7EB" }}>
      {/* Info Grid */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
        gap: "10px 20px", marginBottom: 14,
      }}>
        <Field label="Log ID" value={log.id} mono />
        <Field label="Fynd Order ID" value={log.orderId} mono />
        <Field label="Shopify Order (Affiliate)" value={log.affiliateOrderId} mono highlight />
        <Field label="Shipment ID" value={log.shipmentId} mono />
        <Field label="Event Type" value={log.eventType} />
        <Field label="Fynd Status" value={log.fyndStatus || log.refundStatus} />
        <Field label="Action" value={log.action?.replace(/_/g, " ")} />
        <Field label="Carrier" value={log.carrier} />
        <Field label="AWB Number" value={log.awbNumber} mono />
        {log.trackingUrl && (
          <div>
            <div style={fieldLabelStyle}>Tracking URL</div>
            <a href={log.trackingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "#3B82F6", textDecoration: "none", wordBreak: "break-all" }}>
              {log.trackingUrl.length > 50 ? log.trackingUrl.slice(0, 50) + "..." : log.trackingUrl}
            </a>
          </div>
        )}
        <Field label="Customer Name" value={log.customerName} />
        <Field label="Customer Email" value={log.customerEmail} />
        <Field label="Customer Phone" value={log.customerPhone} />
        <Field label="Shop Domain" value={log.shopDomain} />
        {log.returnCaseId && <Field label="Return Case" value={log.returnCaseId} mono />}
      </div>

      {/* Error */}
      {log.error && (
        <div style={{
          padding: "8px 10px", marginBottom: 12,
          background: "#FEE2E2", borderRadius: 6, border: "1px solid #FECACA",
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#991B1B", textTransform: "uppercase" as const, marginBottom: 3 }}>Error</div>
          <div style={{ fontSize: 12, color: "#7F1D1D", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{log.error}</div>
        </div>
      )}

      {/* Payload */}
      <PayloadViewer rawPayload={log.rawPayload} />
    </div>
  );
}

function Field({ label, value, mono, highlight }: { label: string; value: string | null | undefined; mono?: boolean; highlight?: boolean }) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      <div style={{
        fontSize: 12, marginTop: 2, wordBreak: "break-all",
        fontFamily: mono ? "'SF Mono', Menlo, Consolas, monospace" : "inherit",
        color: value ? (highlight ? "#059669" : "#1E293B") : "#D1D5DB",
        fontWeight: highlight && value ? 600 : 400,
      }}>
        {value || "—"}
      </div>
    </div>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: "#94A3B8",
  textTransform: "uppercase", letterSpacing: "0.04em",
};

/* ─── Main Page ─── */

export default function WebhookLogsPage() {
  const { logs, page, totalPages, totalCount, analytics, filters, actionOptions, statusOptions, loaderError } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const [actionFilter, setActionFilter] = useState(filters.actionFilter);
  const [statusFilter, setStatusFilter] = useState(filters.statusFilter);
  const [searchQuery, setSearchQuery] = useState(filters.searchQuery);
  const [dateFrom, setDateFrom] = useState(filters.dateFrom);
  const [dateTo, setDateTo] = useState(filters.dateTo);

  const applyFilters = () => {
    const p = new URLSearchParams();
    if (actionFilter) p.set("action", actionFilter);
    if (statusFilter) p.set("status", statusFilter);
    if (searchQuery) p.set("q", searchQuery);
    if (dateFrom) p.set("dateFrom", dateFrom);
    if (dateTo) p.set("dateTo", dateTo);
    p.set("page", "1");
    setSearchParams(p);
  };

  const clearFilters = () => {
    setActionFilter(""); setStatusFilter(""); setSearchQuery(""); setDateFrom(""); setDateTo("");
    setSearchParams({ page: "1" });
  };

  const goToPage = (p: number) => {
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (searchQuery) params.set("q", searchQuery);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    params.set("page", String(p));
    setSearchParams(params);
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
    }).format(d);
  };

  const hasFilters = !!(actionFilter || statusFilter || searchQuery || dateFrom || dateTo);

  return (
    <s-page heading="Fynd Webhook Logs">
      <div className="app-content" style={{ maxWidth: 1100 }}>

        {loaderError && (
          <div style={{ padding: "12px 16px", marginBottom: 14, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8, color: "#991B1B", fontSize: 13 }}>
            {loaderError}
          </div>
        )}

        {/* Stats */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <StatCard label="Total" value={analytics.total} color="#0F172A" />
          <StatCard label="Processed" value={analytics.successCount} color="#059669" />
          <StatCard label="Errors" value={analytics.errorCount} color={analytics.errorCount > 0 ? "#DC2626" : "#059669"} />
          <StatCard label="Ignored" value={analytics.ignoredCount} color="#6B7280" />
          <StatCard label="Success" value={`${analytics.successRate}%`} color={analytics.successRate >= 95 ? "#059669" : "#DC2626"} />
        </div>

        {/* Action Breakdown Bar */}
        {analytics.total > 0 && (
          <div style={{ marginBottom: 16, padding: "10px 14px", background: "white", borderRadius: 8, border: "1px solid #E5E7EB" }}>
            <div style={{ display: "flex", gap: 4, height: 6, borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
              {Object.entries(analytics.actionCounts).map(([action, count]) => {
                const pct = (count / analytics.total) * 100;
                const c: Record<string, string> = { refund_completed: "#059669", refund_in_progress: "#3B82F6", ignored: "#D1D5DB", error: "#DC2626", duplicate_ignored: "#F59E0B" };
                return <div key={action} style={{ width: `${pct}%`, minWidth: pct > 0 ? 3 : 0, background: c[action] ?? "#9CA3AF", borderRadius: 2 }} title={`${action}: ${count}`} />;
              })}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {Object.entries(analytics.actionCounts).map(([action, count]) => {
                const c: Record<string, string> = { refund_completed: "#059669", refund_in_progress: "#3B82F6", ignored: "#9CA3AF", error: "#DC2626", duplicate_ignored: "#F59E0B" };
                return (
                  <div key={action} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: c[action] ?? "#9CA3AF" }} />
                    <span style={{ color: "#374151" }}>{action.replace(/_/g, " ")}</span>
                    <span style={{ color: "#9CA3AF" }}>({count})</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters */}
        <div style={{
          display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end",
          marginBottom: 14, padding: "10px 14px",
          background: "white", borderRadius: 8, border: "1px solid #E5E7EB",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={filterLabelStyle}>Action</label>
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} style={selectStyle}>
              {actionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={filterLabelStyle}>Status</label>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
              {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 180px" }}>
            <label style={filterLabelStyle}>Search</label>
            <input
              type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Shipment, order, carrier, customer, AWB..."
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
              style={{ ...inputBaseStyle, width: "100%" }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={filterLabelStyle}>From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputBaseStyle} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <label style={filterLabelStyle}>To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputBaseStyle} />
          </div>
          <button onClick={applyFilters} style={primaryBtnStyle}>Filter</button>
          {hasFilters && <button onClick={clearFilters} style={ghostBtnStyle}>Clear</button>}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#9CA3AF" }}>{totalCount} log{totalCount !== 1 ? "s" : ""}{hasFilters ? " (filtered)" : ""}</span>
        </div>

        {/* Table */}
        <div style={{ background: "white", borderRadius: 8, border: "1px solid #E5E7EB", overflow: "hidden" }}>
          {logs.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "#9CA3AF" }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No webhook logs found</div>
              <div style={{ fontSize: 12 }}>{hasFilters ? "Try adjusting your filters." : "Webhook logs appear when Fynd sends updates."}</div>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "110px" }} />
                <col style={{ width: "22%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "90px" }} />
                <col style={{ width: "70px" }} />
                <col style={{ width: "36px" }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#F9FAFB", borderBottom: "1px solid #E5E7EB" }}>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>IDs</th>
                  <th style={thStyle}>Status / Customer</th>
                  <th style={thStyle}>Carrier / AWB</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Case</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const isExpanded = expandedRows.has(log.id);
                  return (
                    <React.Fragment key={log.id}>
                      <tr
                        onClick={() => toggleRow(log.id)}
                        style={{
                          borderBottom: isExpanded ? "none" : "1px solid #F3F4F6",
                          background: log.action === "error" ? "#FEF2F2" : undefined,
                          cursor: "pointer",
                        }}
                      >
                        {/* Time */}
                        <td style={tdStyle}>
                          <div style={{ fontSize: 11, color: "#6B7280", whiteSpace: "nowrap" }}>{fmtTime(log.createdAt)}</div>
                          {log.eventType && <div style={{ fontSize: 10, color: "#A78BFA", marginTop: 1 }}>{log.eventType}</div>}
                        </td>
                        {/* IDs */}
                        <td style={tdStyle}>
                          {log.shipmentId && (
                            <div style={{ fontSize: 11, fontFamily: "monospace", color: "#374151", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={log.shipmentId}>
                              <span style={{ color: "#9CA3AF", fontSize: 9 }}>SHP </span>{log.shipmentId}
                            </div>
                          )}
                          {log.orderId && (
                            <div style={{ fontSize: 11, fontFamily: "monospace", color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={log.orderId}>
                              <span style={{ color: "#9CA3AF", fontSize: 9 }}>ORD </span>{log.orderId}
                            </div>
                          )}
                          {log.affiliateOrderId && (
                            <div style={{ fontSize: 11, fontFamily: "monospace", color: "#059669", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={log.affiliateOrderId}>
                              <span style={{ color: "#9CA3AF", fontSize: 9, fontWeight: 400 }}>SPF </span>{log.affiliateOrderId}
                            </div>
                          )}
                          {!log.shipmentId && !log.orderId && !log.affiliateOrderId && <span style={{ color: "#D1D5DB", fontSize: 11 }}>—</span>}
                        </td>
                        {/* Status + Customer */}
                        <td style={tdStyle}>
                          <StatusPill status={log.fyndStatus || log.refundStatus} />
                          {log.customerName && (
                            <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={`${log.customerName} ${log.customerEmail ?? ""}`}>
                              {log.customerName}
                            </div>
                          )}
                          {!log.customerName && log.customerEmail && (
                            <div style={{ fontSize: 10, color: "#6B7280", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{log.customerEmail}</div>
                          )}
                        </td>
                        {/* Carrier + AWB */}
                        <td style={tdStyle}>
                          {log.carrier && <div style={{ fontSize: 11, color: "#374151", fontWeight: 500 }}>{log.carrier}</div>}
                          {log.awbNumber && (
                            <div style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={log.awbNumber}>
                              {log.awbNumber}
                            </div>
                          )}
                          {!log.carrier && !log.awbNumber && <span style={{ color: "#D1D5DB", fontSize: 11 }}>—</span>}
                        </td>
                        {/* Action */}
                        <td style={tdStyle}>
                          <ActionBadge action={log.action} />
                          {log.error && (
                            <div style={{ fontSize: 10, color: "#DC2626", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 100 }} title={log.error}>
                              {log.error.slice(0, 40)}...
                            </div>
                          )}
                        </td>
                        {/* Return Case */}
                        <td style={tdStyle}>
                          {log.returnCaseId ? (
                            <Link
                              to={`/app/returns/${log.returnCaseId}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ fontSize: 11, color: "#3B82F6", fontWeight: 500, textDecoration: "none" }}
                            >
                              View
                            </Link>
                          ) : (
                            <span style={{ color: "#D1D5DB", fontSize: 11 }}>—</span>
                          )}
                        </td>
                        {/* Chevron */}
                        <td style={{ ...tdStyle, textAlign: "center" }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2"
                            style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <DetailPanel log={log} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 14px", borderTop: "1px solid #E5E7EB", background: "#F9FAFB",
            }}>
              <span style={{ fontSize: 12, color: "#6B7280" }}>Page {page}/{totalPages}</span>
              <div style={{ display: "flex", gap: 4 }}>
                <PageBtn label="Prev" disabled={page <= 1} onClick={() => goToPage(page - 1)} />
                {getPageNums(page, totalPages).map((p, i) =>
                  p === null ? (
                    <span key={`d${i}`} style={{ padding: "0 3px", color: "#9CA3AF", fontSize: 12 }}>...</span>
                  ) : (
                    <PageBtn key={p} label={String(p)} active={p === page} onClick={() => goToPage(p)} />
                  )
                )}
                <PageBtn label="Next" disabled={page >= totalPages} onClick={() => goToPage(page + 1)} />
              </div>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

/* ─── Small Helpers ─── */

function PageBtn({ label, disabled, active, onClick }: { label: string; disabled?: boolean; active?: boolean; onClick: () => void }) {
  return (
    <button disabled={disabled} onClick={onClick} style={{
      padding: "4px 10px", fontSize: 11, fontWeight: active ? 700 : 500,
      borderRadius: 5, border: "1px solid #D1D5DB",
      background: active ? "#0F172A" : disabled ? "#F3F4F6" : "white",
      color: active ? "white" : disabled ? "#D1D5DB" : "#374151",
      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, minWidth: 28,
    }}>
      {label}
    </button>
  );
}

function getPageNums(cur: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (cur <= 4) return [1, 2, 3, 4, 5, null, total];
  if (cur >= total - 3) return [1, null, total - 4, total - 3, total - 2, total - 1, total];
  return [1, null, cur - 1, cur, cur + 1, null, total];
}

/* ─── Shared Styles ─── */

const thStyle: React.CSSProperties = {
  padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 600,
  color: "#9CA3AF", textTransform: "uppercase", letterSpacing: "0.04em",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px", verticalAlign: "top",
};

const filterLabelStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, color: "#9CA3AF",
};

const inputBaseStyle: React.CSSProperties = {
  padding: "6px 8px", fontSize: 12, borderRadius: 5,
  border: "1px solid #D1D5DB", background: "white",
};

const selectStyle: React.CSSProperties = {
  ...inputBaseStyle, minWidth: 110,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px", fontSize: 12, fontWeight: 600,
  borderRadius: 5, border: "none",
  background: "#0F172A", color: "white", cursor: "pointer", height: 30,
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "6px 12px", fontSize: 12, fontWeight: 500,
  borderRadius: 5, border: "1px solid #D1D5DB",
  background: "white", color: "#6B7280", cursor: "pointer", height: 30,
};
