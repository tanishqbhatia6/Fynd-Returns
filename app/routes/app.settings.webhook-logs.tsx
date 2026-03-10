import React, { useState } from "react";
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
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? "";

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  if (actionFilter) where.action = actionFilter;
  if (statusFilter) where.refundStatus = statusFilter;
  if (shipmentSearch) where.shipmentId = { contains: shipmentSearch, mode: "insensitive" };
  if (orderSearch) where.orderId = { contains: orderSearch, mode: "insensitive" };

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

  // Wrap in try/catch to prevent loader crash from blanking the page
  try {
    const [totalCount, logs, allLogs, distinctActions, distinctStatuses] = await Promise.all([
      prisma.fyndWebhookLog.count({ where }),
      prisma.fyndWebhookLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      // Get all logs for analytics (count by action using simple query)
      prisma.fyndWebhookLog.findMany({
        select: { action: true },
      }),
      // Dynamic action options from DB
      prisma.fyndWebhookLog.findMany({
        select: { action: true },
        distinct: ["action"],
        where: { action: { not: null } },
      }),
      // Dynamic refundStatus options from DB
      prisma.fyndWebhookLog.findMany({
        select: { refundStatus: true },
        distinct: ["refundStatus"],
        where: { refundStatus: { not: null } },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

    // Compute analytics summary from raw data
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

    // Build dynamic dropdown options
    const actionOptions = [
      { value: "", label: "All actions" },
      ...distinctActions
        .map((r) => r.action)
        .filter((a): a is string => !!a)
        .sort()
        .map((a) => ({ value: a, label: a.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) })),
    ];
    const statusOptions = [
      { value: "", label: "All statuses" },
      ...distinctStatuses
        .map((r) => r.refundStatus)
        .filter((s): s is string => !!s)
        .sort()
        .map((s) => ({ value: s, label: s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) })),
    ];

    return {
      logs: logs.map((l) => ({
        id: l.id,
        shipmentId: l.shipmentId,
        orderId: l.orderId,
        refundStatus: l.refundStatus,
        action: l.action,
        returnCaseId: l.returnCaseId,
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
      filters: { actionFilter, statusFilter, shipmentSearch, orderSearch, dateFrom, dateTo },
      actionOptions,
      statusOptions,
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
      filters: { actionFilter, statusFilter, shipmentSearch, orderSearch, dateFrom, dateTo },
      actionOptions: [{ value: "", label: "All actions" }],
      statusOptions: [{ value: "", label: "All statuses" }],
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

export default function WebhookLogsPage() {
  const { logs, page, totalPages, totalCount, analytics, filters, actionOptions, statusOptions, loaderError } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  // Local filter state
  const [actionFilter, setActionFilter] = useState(filters.actionFilter);
  const [statusFilter, setStatusFilter] = useState(filters.statusFilter);
  const [shipmentSearch, setShipmentSearch] = useState(filters.shipmentSearch);
  const [orderSearch, setOrderSearch] = useState(filters.orderSearch);
  const [dateFrom, setDateFrom] = useState(filters.dateFrom);
  const [dateTo, setDateTo] = useState(filters.dateTo);

  function applyFilters() {
    const params = new URLSearchParams();
    if (actionFilter) params.set("action", actionFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (shipmentSearch) params.set("shipment", shipmentSearch);
    if (orderSearch) params.set("order", orderSearch);
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

  function formatPayload(raw: string | null) {
    if (!raw) return "No payload data";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  const hasActiveFilters = !!(actionFilter || statusFilter || shipmentSearch || orderSearch || dateFrom || dateTo);

  return (
    <s-page heading="Fynd Webhook Logs">
      <div className="app-content">

        {/* ── Loader Error ── */}
        {loaderError && (
          <div style={{
            padding: "14px 18px", marginBottom: 16,
            background: "#FEF2F2", border: "1px solid #FECACA",
            borderRadius: 10, color: "#991B1B", fontSize: 13,
          }}>
            Failed to load webhook logs: {loaderError}
          </div>
        )}

        {/* ── Analytics Summary ── */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          <StatCard label="Total Webhooks" value={analytics.total} color="#0F172A" />
          <StatCard label="Processed" value={analytics.successCount} color="#059669" sub="refund actions" />
          <StatCard label="Errors" value={analytics.errorCount} color={analytics.errorCount > 0 ? "#DC2626" : "#059669"} />
          <StatCard label="Ignored" value={analytics.ignoredCount} color="#6B7280" sub={analytics.duplicateCount > 0 ? `+ ${analytics.duplicateCount} duplicates` : undefined} />
          <StatCard label="Success Rate" value={`${analytics.successRate}%`} color={analytics.successRate >= 95 ? "#059669" : analytics.successRate >= 80 ? "#D97706" : "#DC2626"} />
        </div>

        {/* ── Action Breakdown ── */}
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
                  refund_completed: "#059669",
                  refund_in_progress: "#3B82F6",
                  ignored: "#D1D5DB",
                  error: "#DC2626",
                  duplicate_ignored: "#F59E0B",
                };
                return (
                  <div key={action} style={{
                    width: `${pct}%`, minWidth: pct > 0 ? 4 : 0,
                    background: colors[action] ?? "#9CA3AF",
                    borderRadius: 2,
                  }} title={`${action}: ${count}`} />
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {Object.entries(analytics.actionCounts).map(([action, count]) => {
                const colors: Record<string, string> = {
                  refund_completed: "#059669",
                  refund_in_progress: "#3B82F6",
                  ignored: "#9CA3AF",
                  error: "#DC2626",
                  duplicate_ignored: "#F59E0B",
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

        {/* ── Filters ── */}
        <div style={{
          display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end",
          marginBottom: 16, padding: "14px 18px",
          background: "white", borderRadius: 10,
          border: "1px solid #E5E7EB",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>Action</label>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB", background: "white",
                minWidth: 140,
              }}
            >
              {actionOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>Fynd Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB", background: "white",
                minWidth: 140,
              }}
            >
              {statusOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>Shipment ID</label>
            <input
              type="text"
              value={shipmentSearch}
              onChange={(e) => setShipmentSearch(e.target.value)}
              placeholder="Search..."
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB", width: 140,
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>Order ID</label>
            <input
              type="text"
              value={orderSearch}
              onChange={(e) => setOrderSearch(e.target.value)}
              placeholder="Search..."
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB", width: 140,
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB",
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280" }}>To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{
                padding: "7px 10px", fontSize: 13, borderRadius: 6,
                border: "1px solid #D1D5DB",
              }}
            />
          </div>

          <button
            onClick={applyFilters}
            style={{
              padding: "7px 16px", fontSize: 13, fontWeight: 600,
              borderRadius: 6, border: "none",
              background: "#0F172A", color: "white", cursor: "pointer",
              height: 34,
            }}
          >
            Filter
          </button>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              style={{
                padding: "7px 14px", fontSize: 13, fontWeight: 500,
                borderRadius: 6, border: "1px solid #D1D5DB",
                background: "white", color: "#6B7280", cursor: "pointer",
                height: 34,
              }}
            >
              Clear
            </button>
          )}

          <div style={{ flex: 1 }} />

          <span style={{ fontSize: 12, color: "#9CA3AF", alignSelf: "center" }}>
            {totalCount} log{totalCount !== 1 ? "s" : ""}
            {hasActiveFilters ? " (filtered)" : ""}
          </span>
        </div>

        {/* ── Log Table ── */}
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
                    <th style={thStyle}>Shipment ID</th>
                    <th style={thStyle}>Order ID</th>
                    <th style={thStyle}>Fynd Status</th>
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
                          <td style={tdStyle}>
                            <div style={{ whiteSpace: "nowrap", fontSize: 12 }}>
                              {formatTimestamp(log.createdAt)}
                            </div>
                          </td>
                          <td style={tdStyle}>
                            <span style={{ fontFamily: "monospace", fontSize: 12, color: "#374151" }}>
                              {log.shipmentId ?? "—"}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <span style={{ fontFamily: "monospace", fontSize: 12, color: "#374151" }}>
                              {log.orderId ?? "—"}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              display: "inline-block", padding: "2px 7px",
                              fontSize: 11, fontWeight: 500,
                              background: "#F3F4F6", borderRadius: 4, color: "#374151",
                            }}>
                              {log.refundStatus ?? "—"}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            <ActionBadge action={log.action} />
                          </td>
                          <td style={tdStyle}>
                            {log.returnCaseId ? (
                              <Link
                                to={`/app/returns/${log.returnCaseId}`}
                                style={{
                                  fontSize: 12, color: "#3B82F6", fontWeight: 500,
                                  textDecoration: "none",
                                }}
                              >
                                View
                              </Link>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            {log.error ? (
                              <span style={{
                                fontSize: 11, color: "#DC2626", maxWidth: 200,
                                display: "inline-block", overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap",
                              }} title={log.error}>
                                {log.error}
                              </span>
                            ) : (
                              <span style={{ fontSize: 12, color: "#D1D5DB" }}>—</span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <button
                              onClick={() => toggleRow(log.id)}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                padding: 4, color: "#9CA3AF", fontSize: 14,
                              }}
                              title={isExpanded ? "Collapse" : "View raw payload"}
                              aria-label={isExpanded ? "Collapse payload" : "Expand payload"}
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
                            <td colSpan={8} style={{
                              padding: "0 14px 14px",
                              borderBottom: "1px solid #F3F4F6",
                              background: "#F9FAFB",
                            }}>
                              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
                                <div>
                                  <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>Log ID</span>
                                  <div style={{ fontSize: 12, fontFamily: "monospace", color: "#374151" }}>{log.id}</div>
                                </div>
                                {log.returnCaseId && (
                                  <div>
                                    <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>Return Case ID</span>
                                    <div style={{ fontSize: 12, fontFamily: "monospace", color: "#374151" }}>{log.returnCaseId}</div>
                                  </div>
                                )}
                              </div>
                              {log.error && (
                                <div style={{ marginBottom: 10 }}>
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
                              <div>
                                <span style={{ fontSize: 10, fontWeight: 600, color: "#9CA3AF", textTransform: "uppercase" as const }}>Raw Payload</span>
                                <pre style={{
                                  fontSize: 11, lineHeight: 1.5,
                                  padding: "10px 12px", marginTop: 4,
                                  background: "#1E293B", color: "#E2E8F0",
                                  borderRadius: 6, overflow: "auto",
                                  maxHeight: 300, whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}>
                                  {formatPayload(log.rawPayload)}
                                </pre>
                              </div>
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

          {/* ── Pagination ── */}
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
                {/* Show page numbers around current */}
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

const thStyle: React.CSSProperties = {
  padding: "10px 14px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  color: "#6B7280",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 14px",
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
