import React, { useState, useCallback, useRef, useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams, useNavigate, useRevalidator, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { getStatusColor, getStatusBg } from "../lib/status-colors";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "initiated", label: "Initiated" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "approved", label: "Approved" },
  { value: "completed", label: "Completed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") || "";
  const status = url.searchParams.get("status") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const resolutionType = url.searchParams.get("resolutionType") || "";
  const sourceChannel = url.searchParams.get("sourceChannel") || "";
  const dateFrom = url.searchParams.get("from") || "";
  const dateTo = url.searchParams.get("to") || "";

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

  const where: Record<string, unknown> = { shopId: shop.id };
  if (status) where.status = status;
  if (resolutionType) where.resolutionType = resolutionType;
  if (sourceChannel) where.sourceChannel = sourceChannel === "web" ? null : sourceChannel;
  if (dateFrom || dateTo) {
    const createdAt: Record<string, Date> = {};
    if (dateFrom) createdAt.gte = new Date(dateFrom + "T00:00:00");
    if (dateTo) createdAt.lte = new Date(dateTo + "T23:59:59.999");
    where.createdAt = createdAt;
  }
  if (query.trim()) {
    const q = query.trim();
    where.OR = [
      { shopifyOrderName: { contains: q, mode: "insensitive" } },
      { returnRequestNo: { contains: q, mode: "insensitive" } },
      { fyndOrderId: { contains: q, mode: "insensitive" } },
      { forwardAwb: { contains: q, mode: "insensitive" } },
      { returnAwb: { contains: q, mode: "insensitive" } },
      { fyndReturnNo: { contains: q, mode: "insensitive" } },
      { customerEmailNorm: { contains: q, mode: "insensitive" } },
      { customerPhoneNorm: { contains: q, mode: "insensitive" } },
    ];
  }

  try {
    const [returns, totalCount, pendingCount, approvedCount, rejectedCount, allCount] = await Promise.all([
      prisma.returnCase.findMany({
        where,
        include: { items: { take: 3 } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.returnCase.count({ where }),
      prisma.returnCase.count({ where: { shopId: shop.id, status: { in: ["pending", "initiated"] } } }),
      prisma.returnCase.count({ where: { shopId: shop.id, status: { in: ["approved", "completed"] } } }),
      prisma.returnCase.count({ where: { shopId: shop.id, status: "rejected" } }),
      prisma.returnCase.count({ where: { shopId: shop.id } }),
    ]);
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    return { returns, query, status, resolutionType, sourceChannel, page, totalCount, totalPages, pendingCount, approvedCount, rejectedCount, allCount, error: null, shopLocale: shop?.settings?.shopLocale ?? "en", shopTimezone: shop?.settings?.shopTimezone ?? "UTC" };
  } catch (err) {
    console.error("Returns loader error:", err);
    return { returns: [], query, status, resolutionType: "", sourceChannel: "", page: 1, totalCount: 0, totalPages: 1, pendingCount: 0, approvedCount: 0, rejectedCount: 0, allCount: 0, error: "Failed to load returns. Please try again.", shopLocale: "en", shopTimezone: "UTC" };
  }
};

/* Styles moved to app/styles.css — see .returns-* classes */

export default function ReturnsList() {
  const { returns, query, status, page, totalCount, totalPages, pendingCount, approvedCount, rejectedCount, allCount, error, shopLocale, shopTimezone } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkSuccess, setBulkSuccess] = useState<string | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const rejectInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setSelectedIds(new Set()); }, [page, status, query]);
  useEffect(() => { if (showRejectModal && rejectInputRef.current) rejectInputRef.current.focus(); }, [showRejectModal]);
  useEffect(() => {
    if (bulkSuccess || bulkError) {
      const t = setTimeout(() => { setBulkSuccess(null); setBulkError(null); }, 5000);
      return () => clearTimeout(t);
    }
  }, [bulkSuccess, bulkError]);

  const selectableReturns = returns.filter(
    (r) => !["approved", "rejected", "completed", "cancelled"].includes(r.status.toLowerCase()),
  );
  const selectableIds = new Set(selectableReturns.map((r) => r.id));

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (selectableReturns.length > 0 && selectableReturns.every((r) => prev.has(r.id))) return new Set();
      return new Set(selectableReturns.map((r) => r.id));
    });
  }, [selectableReturns]);

  const executeBulkAction = useCallback(
    async (action: "bulk_approve" | "bulk_reject" | "bulk_change_resolution", extra?: { reason?: string; resolutionType?: string }) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      setBulkLoading(true);
      setBulkError(null);
      setBulkSuccess(null);
      try {
        const payload: Record<string, unknown> = { action, returnIds: ids };
        if (extra?.reason) payload.rejectionReason = extra.reason;
        if (extra?.resolutionType) payload.resolutionType = extra.resolutionType;
        const res = await fetch("/api/returns/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as { successCount?: number; errorCount?: number; error?: string; results?: Array<{ id: string; success: boolean; error?: string }> };
        if (!res.ok) { setBulkError(data.error || "Bulk action failed"); return; }
        const label = action === "bulk_approve" ? "approved" : action === "bulk_reject" ? "rejected" : "updated";
        if (data.errorCount && data.errorCount > 0) {
          const firstError = (data.results ?? []).find((r) => !r.success)?.error ?? "Unknown error";
          setBulkSuccess(`${data.successCount} ${label}, ${data.errorCount} failed: ${firstError}`);
        } else {
          setBulkSuccess(`${data.successCount} return${data.successCount === 1 ? "" : "s"} ${label} successfully`);
        }
        setSelectedIds(new Set());
        revalidator.revalidate();
      } catch (err) {
        setBulkError(err instanceof Error ? err.message : "Network error");
      } finally {
        setBulkLoading(false);
      }
    },
    [selectedIds, revalidator],
  );

  const handleBulkApprove = useCallback(() => executeBulkAction("bulk_approve"), [executeBulkAction]);
  const handleBulkRejectConfirm = useCallback(() => {
    const reason = rejectionReason.trim();
    if (!reason) return;
    setShowRejectModal(false);
    setRejectionReason("");
    executeBulkAction("bulk_reject", { reason });
  }, [rejectionReason, executeBulkAction]);
  const handleBulkResolutionChange = useCallback((resolutionType: string) => {
    executeBulkAction("bulk_change_resolution", { resolutionType });
  }, [executeBulkAction]);

  const goToPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(p));
    setSearchParams(next);
  };

  const allSelectableSelected = selectableReturns.length > 0 && selectableReturns.every((r) => selectedIds.has(r.id));
  const someSelected = selectedIds.size > 0;
  const inProgressCount = Math.max(0, allCount - pendingCount - approvedCount - rejectedCount);

  const fmtDateParts = (d: string | Date): { date: string; time: string } => {
    try {
      const dt = new Date(d);
      return {
        date: new Intl.DateTimeFormat(shopLocale || "en", { day: "numeric", month: "short", year: "2-digit" }).format(dt),
        time: new Intl.DateTimeFormat(shopLocale || "en", { hour: "2-digit", minute: "2-digit" }).format(dt),
      };
    } catch { return { date: String(d).slice(0, 10), time: "" }; }
  };

  const stats = [
    { label: "Total", value: allCount, color: "#334155", bg: "#f8fafc", border: "#e2e8f0", filterStatus: "" },
    { label: "Pending", value: pendingCount, color: "#d97706", bg: "#fffbeb", border: "#fde68a", filterStatus: "pending" },
    { label: "In Progress", value: inProgressCount, color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe", filterStatus: "processing" },
    { label: "Approved", value: approvedCount, color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", filterStatus: "approved" },
    { label: "Rejected", value: rejectedCount, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", filterStatus: "rejected" },
  ];

  return (
    <s-page fullWidth heading="Returns">
      <div className="app-content layout-full">
        {/* ── Error Banner ── */}
        {error && (
          <div style={{ padding: "12px 16px", marginBottom: 16, borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div><strong>{error}</strong><span style={{ opacity: 0.8, marginLeft: 6 }}>Try refreshing the page.</span></div>
          </div>
        )}

        {/* ── Success / Error toast ── */}
        {bulkSuccess && (
          <div style={{ padding: "10px 16px", marginBottom: 12, borderRadius: 8, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 13, fontWeight: 600 }}>
            {bulkSuccess}
          </div>
        )}
        {bulkError && (
          <div style={{ padding: "10px 16px", marginBottom: 12, borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13, fontWeight: 600 }}>
            {bulkError}
          </div>
        )}

        {/* ── Stats Bar ── */}
        <div className="returns-stats-row">
          {stats.map((s) => {
            const isActive = (status === s.filterStatus) || (!status && s.filterStatus === "");
            return (
              <div
                key={s.label}
                onClick={() => s.value > 0 || s.filterStatus === "" ? setSearchParams(s.filterStatus ? { status: s.filterStatus } : {}) : undefined}
                className={`returns-stat-card${isActive ? " returns-stat-card--active" : ""}`}
                style={{
                  background: isActive ? s.bg : undefined,
                  borderColor: isActive ? s.color : s.border,
                  cursor: s.value > 0 || s.filterStatus === "" ? "pointer" : "default",
                }}
              >
                <div className="stat-value" style={{ color: s.color }}>{s.value}</div>
                <div className="stat-label" style={{ color: s.color }}>{s.label}</div>
              </div>
            );
          })}
        </div>

        {/* ── Search & Filter Toolbar ── */}
        <Form method="get" className="returns-toolbar">
          <div style={{ flex: "1 1 240px", minWidth: 180 }}>
            <label className="field-label">Search</label>
            <input
              name="query"
              type="text"
              placeholder="Order #, Return ID, AWB, Email, Phone..."
              defaultValue={query}
              className="app-input"
              style={{ width: "100%", padding: "9px 14px", fontSize: 13 }}
            />
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="field-label">Status</label>
            <select name="status" defaultValue={status} className="app-select" style={{ width: "100%", padding: "9px 14px", fontSize: 13 }}>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="field-label">Resolution</label>
            <select name="resolutionType" defaultValue={searchParams.get("resolutionType") || ""} className="app-select" style={{ width: "100%", padding: "9px 14px", fontSize: 13 }}>
              <option value="">All types</option>
              <option value="refund">Refund</option>
              <option value="exchange">Exchange</option>
              <option value="store_credit">Store Credit</option>
              <option value="replacement">Replacement</option>
            </select>
          </div>
          <div style={{ flex: "0 0 140px" }}>
            <label className="field-label">Channel</label>
            <select name="sourceChannel" defaultValue={searchParams.get("sourceChannel") || ""} className="app-select" style={{ width: "100%", padding: "9px 14px", fontSize: 13 }}>
              <option value="">All channels</option>
              <option value="web">Online Store</option>
              <option value="pos">POS</option>
              <option value="draft_order">Draft Order</option>
              <option value="b2b">B2B</option>
            </select>
          </div>
          <div style={{ flex: "0 0 130px" }}>
            <label className="field-label">From</label>
            <input type="date" name="from" defaultValue={searchParams.get("from") || ""} className="app-input" style={{ width: "100%", padding: "7px 10px", fontSize: 13 }} />
          </div>
          <div style={{ flex: "0 0 130px" }}>
            <label className="field-label">To</label>
            <input type="date" name="to" defaultValue={searchParams.get("to") || ""} className="app-input" style={{ width: "100%", padding: "7px 10px", fontSize: 13 }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", paddingBottom: 1 }}>
            <button type="submit" className="app-btn-primary" style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Search</button>
            {(query || status || searchParams.get("resolutionType") || searchParams.get("sourceChannel") || searchParams.get("from") || searchParams.get("to")) && (
              <Link to="/app/returns" style={{ textDecoration: "none" }}>
                <button type="button" style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Clear</button>
              </Link>
            )}
          </div>
          <Link to="/app/returns/create" style={{ textDecoration: "none" }}>
            <button type="button" style={{ padding: "9px 16px", borderRadius: 8, border: "none", background: "#059669", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Create Return
            </button>
          </Link>
          {totalCount > 0 && (
            <a
              href={(() => {
                const p = new URLSearchParams();
                if (query) p.set("query", query);
                if (status) p.set("status", status);
                const range = searchParams.get("range");
                const fromDate = searchParams.get("from");
                const toDate = searchParams.get("to");
                if (range) p.set("range", range);
                if (fromDate) p.set("from", fromDate);
                if (toDate) p.set("to", toDate);
                return `/api/returns/export?${p.toString()}`;
              })()}
              target="_blank" rel="noopener noreferrer"
              style={{ textDecoration: "none", marginLeft: "auto" }}
            >
              <button type="button" style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Export current view
              </button>
            </a>
          )}
        </Form>

        {/* ── Count Bar ── */}
        {totalCount > 0 && (
          <div className="returns-count-bar">
            <span style={{ fontSize: 12, color: "#6b7280" }}>
              Showing <strong style={{ color: "#111827" }}>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)}</strong> of <strong style={{ color: "#111827" }}>{totalCount}</strong>
            </span>
            {status && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: "#eef2ff", color: "#4f46e5", border: "1px solid #c7d2fe" }}>
                {status}
                <Link to={`/app/returns${query ? `?query=${query}` : ""}`} style={{ textDecoration: "none", color: "inherit", marginLeft: 6, opacity: 0.7 }}>×</Link>
              </span>
            )}
          </div>
        )}

        {/* ── Table or Empty ── */}
        {returns.length === 0 ? (
          <div className="returns-empty-state">
            <div style={{ marginBottom: 14, opacity: 0.4 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            </div>
            <p style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: "#111827" }}>No returns found</p>
            <p style={{ maxWidth: 360, margin: "0 auto 20px", fontSize: 13, color: "#6b7280", lineHeight: 1.5 }}>
              {query || status
                ? "No returns match your criteria. Try adjusting your filters."
                : "Returns will appear here when customers submit them via your portal."}
            </p>
            {!query && !status && (
              <Link to="/app/portal" style={{ textDecoration: "none" }}>
                <button type="button" style={{ padding: "9px 20px", borderRadius: 8, border: "none", background: "#4f46e5", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>View Portal</button>
              </Link>
            )}
            {(query || status) && (
              <Link to="/app/returns" style={{ textDecoration: "none" }}>
                <button type="button" style={{ padding: "9px 16px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Clear filters</button>
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="returns-table-wrap">
              <div style={{ overflowX: "auto" }}>
                <table className="returns-table" style={{ minWidth: 1200, tableLayout: "auto" }}>
                  <colgroup>
                    <col style={{ width: 44 }} />
                    <col style={{ minWidth: 130 }} />
                    <col style={{ minWidth: 180 }} />
                    <col style={{ minWidth: 120 }} />
                    <col className="app-hide-mobile" style={{ minWidth: 260 }} />
                    <col className="app-hide-mobile" style={{ minWidth: 200 }} />
                    <col style={{ minWidth: 110 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="checkbox-th">
                        <input
                          type="checkbox"
                          checked={allSelectableSelected}
                          onChange={toggleSelectAll}
                          disabled={selectableReturns.length === 0}
                          title={allSelectableSelected ? "Deselect all" : "Select all actionable returns"}
                          style={{ width: 16, height: 16, cursor: selectableReturns.length === 0 ? "default" : "pointer", accentColor: "#4f46e5", opacity: selectableReturns.length === 0 ? 0.25 : 1, margin: 0, display: "block" }}
                        />
                      </th>
                      <th>Return ID</th>
                      <th>Order</th>
                      <th>Status</th>
                      <th className="app-hide-mobile">Fynd Details</th>
                      <th className="app-hide-mobile">Customer</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => {
                      const fyndRetId = r.fyndReturnId;
                      const fyndRetNo = r.fyndReturnNo;
                      const fyndShipId = r.fyndShipmentId;
                      const fyndOrdId = r.fyndOrderId;
                      // Aging indicator for pending returns
                      const ageDays = Math.floor((Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60 * 24));
                      const isPending = ["initiated", "pending", "processing"].includes(r.status.toLowerCase());
                      const ageColor = !isPending ? null : ageDays > 5 ? "#DC2626" : ageDays > 2 ? "#D97706" : "#16A34A";
                      const hasFynd = !!(fyndRetId || fyndRetNo || fyndShipId);
                      const isSelectable = selectableIds.has(r.id);
                      const isSelected = selectedIds.has(r.id);
                      const resType = r.resolutionType;

                      return (
                        <tr
                          key={r.id}
                          onClick={() => navigate(`/app/returns/${r.id}`)}
                          style={{
                            cursor: "pointer",
                            background: isSelected ? "rgba(79, 70, 229, 0.04)" : undefined,
                            transition: "background 0.1s",
                          }}
                          onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = "#f8fafc"; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = isSelected ? "rgba(79, 70, 229, 0.04)" : ""; }}
                        >
                          {/* Checkbox */}
                          <td
                            className="checkbox-cell"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isSelectable) toggleSelection(r.id);
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={!isSelectable}
                              onChange={() => {}}
                              title={isSelectable ? undefined : `Cannot select: return is ${r.status}`}
                              style={{ width: 16, height: 16, cursor: !isSelectable ? "default" : "pointer", accentColor: "#4f46e5", opacity: !isSelectable ? 0.25 : 1, margin: 0, display: "block" }}
                            />
                          </td>

                          {/* Return ID */}
                          <td>
                            <Link
                              to={`/app/returns/${r.id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="return-id-link"
                            >
                              {r.returnRequestNo ?? formatReturnRequestId(r.id)}
                            </Link>
                          </td>

                          {/* Order */}
                          <td>
                            <div className="order-name">{r.shopifyOrderName || "—"}</div>
                            {fyndOrdId && (
                              <div className="fynd-sub" title={String(fyndOrdId)}>
                                Fynd: {String(fyndOrdId)}
                              </div>
                            )}
                          </td>

                          {/* Status */}
                          <td>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                              {/* Primary status badge */}
                              <span style={{
                                display: "inline-flex", alignItems: "center", gap: 5,
                                padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700,
                                background: getStatusBg(r.status), color: getStatusColor(r.status),
                                textTransform: "capitalize", lineHeight: 1.3,
                              }}>
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: getStatusColor(r.status), flexShrink: 0 }} />
                                {r.status}
                              </span>
                              {/* Tags row: resolution + refund + sync */}
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                                {resType && resType !== "refund" && (
                                  <span style={{
                                    padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                                    textTransform: "uppercase", letterSpacing: "0.02em",
                                    ...({
                                      exchange: { background: "#DCFCE7", color: "#166534" },
                                      store_credit: { background: "#F3E8FF", color: "#6B21A8" },
                                      replacement: { background: "#FFF7ED", color: "#C2410C" },
                                    } as Record<string, { background: string; color: string }>)[resType] ?? { background: "#f3f4f6", color: "#374151" },
                                  }}>{resType.replace(/_/g, " ")}</span>
                                )}
                                {r.refundStatus && r.refundStatus !== "none" && (
                                  <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: "#EDE9FE", color: "#7c3aed", textTransform: "capitalize" }}>{r.refundStatus}</span>
                                )}
                                {(() => {
                                  const syncStatus = (r as Record<string, unknown>).fyndSyncStatus as string | null;
                                  if (!syncStatus) return null;
                                  const syncCfg: Record<string, { label: string; bg: string; color: string }> = {
                                    synced: { label: "Synced", bg: "#ECFDF5", color: "#059669" },
                                    processing: { label: "Syncing", bg: "#EFF6FF", color: "#2563EB" },
                                    failed: { label: "Sync failed", bg: "#FEF2F2", color: "#DC2626" },
                                    retry_scheduled: { label: "Retrying", bg: "#FFFBEB", color: "#D97706" },
                                    pending_consolidation: { label: "Queued", bg: "#FFF7ED", color: "#B45309" },
                                    pending: { label: "Pending", bg: "#F3F4F6", color: "#6B7280" },
                                  };
                                  const c = syncCfg[syncStatus];
                                  if (!c) return null;
                                  return <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, background: c.bg, color: c.color }}>{c.label}</span>;
                                })()}
                                {(() => {
                                  const ch = (r as Record<string, unknown>).sourceChannel as string | null | undefined;
                                  if (!ch || ch === "web") return null;
                                  const cfg: Record<string, { label: string; bg: string; color: string }> = {
                                    pos: { label: "POS", bg: "#FFF7ED", color: "#C2410C" },
                                    draft_order: { label: "DRAFT", bg: "#EDE9FE", color: "#6D28D9" },
                                    b2b: { label: "B2B", bg: "#ECFDF5", color: "#065F46" },
                                  };
                                  const c = cfg[ch] ?? { label: ch.toUpperCase(), bg: "#F3F4F6", color: "#374151" };
                                  return <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: c.bg, color: c.color }}>{c.label}</span>;
                                })()}
                                {!!(r as Record<string, unknown>).cancellationRequestedAt && r.status.toLowerCase() === "approved" && (
                                  <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#FFFBEB", color: "#92400E", border: "1px solid #FDE68A" }}>Cancel req.</span>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Fynd Details */}
                          <td className="app-hide-mobile">
                            {(hasFynd || fyndOrdId) ? (
                              <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, lineHeight: 1.4 }}>
                                {fyndOrdId && (
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <span style={{ color: "#9ca3af", fontWeight: 500, flexShrink: 0 }}>Order:</span>
                                    <span style={{ fontFamily: "monospace", color: "#374151", wordBreak: "break-all" }}>{fyndOrdId}</span>
                                  </div>
                                )}
                                {(fyndRetId || fyndRetNo) && (
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <span style={{ color: "#9ca3af", fontWeight: 500, flexShrink: 0 }}>Return:</span>
                                    <span style={{ fontFamily: "monospace", color: "#374151", wordBreak: "break-all" }}>{fyndRetId || fyndRetNo}</span>
                                  </div>
                                )}
                                {fyndShipId && (
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <span style={{ color: "#9ca3af", fontWeight: 500, flexShrink: 0 }}>Shipment:</span>
                                    <span style={{ fontFamily: "monospace", color: "#374151", wordBreak: "break-all" }}>{fyndShipId}</span>
                                  </div>
                                )}
                                {r.forwardAwb && (
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <span style={{ color: "#9ca3af", fontWeight: 500, flexShrink: 0 }}>Fwd AWB:</span>
                                    <span style={{ fontFamily: "monospace", color: "#374151" }}>{r.forwardAwb}</span>
                                  </div>
                                )}
                                {r.returnAwb && (
                                  <div style={{ display: "flex", gap: 4 }}>
                                    <span style={{ color: "#9ca3af", fontWeight: 500, flexShrink: 0 }}>Ret AWB:</span>
                                    <span style={{ fontFamily: "monospace", color: "#374151" }}>{r.returnAwb}</span>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
                            )}
                          </td>

                          {/* Customer */}
                          <td className="app-hide-mobile">
                            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                {r.customerName ? (
                                  <span style={{ fontSize: 13, color: "#111827", fontWeight: 500 }}>{r.customerName}</span>
                                ) : (
                                  <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
                                )}
                                {(r as { fraudRiskLevel?: string | null }).fraudRiskLevel && (r as { fraudRiskLevel?: string }).fraudRiskLevel !== "low" && (() => {
                                  const fl = (r as { fraudRiskLevel?: string }).fraudRiskLevel!;
                                  const c = fl === "critical" ? "#DC2626" : fl === "high" ? "#EA580C" : "#D97706";
                                  const bg = fl === "critical" ? "#FEE2E2" : fl === "high" ? "#FFEDD5" : "#FEF3C7";
                                  return <span title={`${fl} fraud risk`} style={{ flexShrink: 0, width: 8, height: 8, borderRadius: 4, background: c, boxShadow: `0 0 0 2px ${bg}` }} />;
                                })()}
                                {(r as { isGiftReturn?: boolean }).isGiftReturn && (
                                  <span title="Gift return" style={{ flexShrink: 0, fontSize: 10, padding: "1px 5px", borderRadius: 4, background: "#EDE9FE", color: "#7C3AED", fontWeight: 700 }}>GIFT</span>
                                )}
                              </div>
                              {r.customerEmailNorm && (
                                <span style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.3 }}>{r.customerEmailNorm}</span>
                              )}
                              {(r as { customerPhoneNorm?: string | null }).customerPhoneNorm && (
                                <span style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.3 }}>{(r as { customerPhoneNorm?: string }).customerPhoneNorm}</span>
                              )}
                            </div>
                          </td>

                          {/* Created */}
                          <td className="text-tabular nowrap">
                            {(() => { const p = fmtDateParts(r.createdAt); return (
                              <div style={{ lineHeight: 1.4 }}>
                                <div style={{ fontSize: 12, color: "#374151", fontWeight: 500 }}>{p.date}</div>
                                <div style={{ fontSize: 11, color: "#9ca3af" }}>{p.time}</div>
                              </div>
                            ); })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Pagination ── */}
            {totalPages > 1 && (
              <div className="returns-pagination">
                <button className="app-pagination-btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p: number;
                  if (totalPages <= 7) p = i + 1;
                  else if (page <= 4) p = i + 1;
                  else if (page >= totalPages - 3) p = totalPages - 6 + i;
                  else p = page - 3 + i;
                  return (
                    <button key={p} className={`app-pagination-btn ${p === page ? "active" : ""}`} onClick={() => goToPage(p)}>{p}</button>
                  );
                })}
                <button className="app-pagination-btn" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Floating Bulk Action Bar ── */}
      <div className={`returns-bulk-bar ${someSelected ? "returns-bulk-bar--visible" : "returns-bulk-bar--hidden"}`}>
        <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.95 }}>
          {selectedIds.size} selected
        </span>
        <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.2)" }} />
        <button onClick={handleBulkApprove} disabled={bulkLoading} className="bulk-btn bulk-btn--approve">
          {bulkLoading ? "Processing..." : "Approve"}
        </button>
        <button onClick={() => setShowRejectModal(true)} disabled={bulkLoading} className="bulk-btn bulk-btn--reject">
          Reject
        </button>
        <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.15)" }} />
        <select
          disabled={bulkLoading}
          defaultValue=""
          onChange={(e) => { if (e.target.value) { handleBulkResolutionChange(e.target.value); e.target.value = ""; } }}
          className="bulk-select"
        >
          <option value="" disabled>Change resolution...</option>
          <option value="refund">Refund</option>
          <option value="exchange">Exchange</option>
          <option value="store_credit">Store Credit</option>
          <option value="replacement">Replacement</option>
        </select>
        <button onClick={() => setSelectedIds(new Set())} disabled={bulkLoading} className="bulk-btn--clear">
          Clear
        </button>
      </div>

      {/* ── Rejection Modal ── */}
      {showRejectModal && (
        <div className="returns-modal-overlay" onClick={() => { setShowRejectModal(false); setRejectionReason(""); }}>
          <div className="returns-modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 700, color: "#1e293b" }}>
              Reject {selectedIds.size} Return{selectedIds.size === 1 ? "" : "s"}
            </h3>
            <p style={{ margin: "0 0 16px", fontSize: 13, color: "#64748b" }}>
              Provide a reason that will be shown to affected customers.
            </p>
            <textarea
              ref={rejectInputRef}
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Rejection reason (required)..."
              maxLength={500}
              rows={3}
              style={{
                width: "100%", padding: "10px 14px", borderRadius: 8,
                border: "1px solid #d1d5db", fontSize: 13, resize: "vertical",
                fontFamily: "inherit", outline: "none", boxSizing: "border-box",
                transition: "border-color 0.15s, box-shadow 0.15s",
              }}
              onFocus={(e) => { e.target.style.borderColor = "#6366f1"; e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.12)"; }}
              onBlur={(e) => { e.target.style.borderColor = "#d1d5db"; e.target.style.boxShadow = "none"; }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleBulkRejectConfirm();
                if (e.key === "Escape") { setShowRejectModal(false); setRejectionReason(""); }
              }}
            />
            <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "right", marginTop: 4 }}>
              {rejectionReason.length}/500
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
              <button
                onClick={() => { setShowRejectModal(false); setRejectionReason(""); }}
                style={{
                  padding: "8px 18px", borderRadius: 7, border: "1px solid #d1d5db",
                  background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600, cursor: "pointer",
                }}
              >Cancel</button>
              <button
                onClick={handleBulkRejectConfirm}
                disabled={!rejectionReason.trim()}
                style={{
                  padding: "8px 18px", borderRadius: 7, border: "none",
                  background: rejectionReason.trim() ? "#dc2626" : "#e5e7eb",
                  color: rejectionReason.trim() ? "#fff" : "#9ca3af",
                  fontSize: 13, fontWeight: 700,
                  cursor: rejectionReason.trim() ? "pointer" : "not-allowed",
                }}
              >Reject All</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 640px) {
          .app-hide-mobile { display: none !important; }
        }
      `}</style>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <s-page fullWidth heading="Returns">
      <div className="app-content layout-full">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <a href="/app/returns" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</a>
        </div>
      </div>
    </s-page>
  );
}
