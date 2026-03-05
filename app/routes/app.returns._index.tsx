import React, { useState, useCallback, useRef, useEffect } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams, useNavigate, useRevalidator } from "react-router";
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
        include: {
          items: { take: 3 },
        },
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
    return { returns, query, status, page, totalCount, totalPages, pendingCount, approvedCount, rejectedCount, allCount, error: null };
  } catch (err) {
    console.error("Returns loader error:", err);
    return { returns: [], query, status, page: 1, totalCount: 0, totalPages: 1, pendingCount: 0, approvedCount: 0, rejectedCount: 0, allCount: 0, error: "Failed to load returns. Please try again." };
  }
};

export default function ReturnsList() {
  const { returns, query, status, page, totalCount, totalPages, pendingCount, approvedCount, rejectedCount, allCount, error } = useLoaderData<typeof loader>();
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

  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, status, query]);

  useEffect(() => {
    if (showRejectModal && rejectInputRef.current) {
      rejectInputRef.current.focus();
    }
  }, [showRejectModal]);

  useEffect(() => {
    if (bulkSuccess || bulkError) {
      const timer = setTimeout(() => {
        setBulkSuccess(null);
        setBulkError(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [bulkSuccess, bulkError]);

  const selectableReturns = returns.filter(
    (r) => !["approved", "rejected", "completed", "cancelled"].includes(r.status.toLowerCase()),
  );
  const selectableIds = new Set(selectableReturns.map((r) => r.id));

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = selectableReturns.length > 0 && selectableReturns.every((r) => prev.has(r.id));
      if (allSelected) return new Set();
      return new Set(selectableReturns.map((r) => r.id));
    });
  }, [selectableReturns]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const executeBulkAction = useCallback(
    async (action: "bulk_approve" | "bulk_reject", reason?: string) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;

      setBulkLoading(true);
      setBulkError(null);
      setBulkSuccess(null);

      try {
        const res = await fetch("/api/returns/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            returnIds: ids,
            ...(reason ? { rejectionReason: reason } : {}),
          }),
        });

        const data = (await res.json()) as {
          successCount?: number;
          errorCount?: number;
          error?: string;
          results?: Array<{ id: string; success: boolean; error?: string }>;
        };

        if (!res.ok) {
          setBulkError(data.error || "Bulk action failed");
          return;
        }

        const label = action === "bulk_approve" ? "approved" : "rejected";
        if (data.errorCount && data.errorCount > 0) {
          const failedItems = (data.results ?? []).filter((r) => !r.success);
          const firstError = failedItems[0]?.error ?? "Unknown error";
          setBulkSuccess(
            `${data.successCount} ${label}, ${data.errorCount} failed: ${firstError}`,
          );
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

  const handleBulkApprove = useCallback(() => {
    executeBulkAction("bulk_approve");
  }, [executeBulkAction]);

  const handleBulkRejectConfirm = useCallback(() => {
    const reason = rejectionReason.trim();
    if (!reason) return;
    setShowRejectModal(false);
    setRejectionReason("");
    executeBulkAction("bulk_reject", reason);
  }, [rejectionReason, executeBulkAction]);

  const goToPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(p));
    setSearchParams(next);
  };

  const allSelectableSelected = selectableReturns.length > 0 && selectableReturns.every((r) => selectedIds.has(r.id));
  const someSelected = selectedIds.size > 0;
  const inProgressCount = Math.max(0, allCount - pendingCount - approvedCount - rejectedCount);

  return (
    <s-page heading="Returns">
      <div className="app-content">
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 16 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>{error}</p>
              <p style={{ fontSize: 13, opacity: 0.85 }}>Try refreshing the page or contact support.</p>
            </div>
          </div>
        )}

        {/* ── Compact Stats Bar ── */}
        <div style={{
          display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap",
        }}>
          {[
            { label: "Total", value: allCount, color: "#334155", bg: "#f1f5f9", border: "#e2e8f0", filterStatus: "" },
            { label: "Pending", value: pendingCount, color: "#d97706", bg: "#fffbeb", border: "#fde68a", filterStatus: "pending" },
            { label: "In Progress", value: inProgressCount, color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe", filterStatus: "processing" },
            { label: "Approved", value: approvedCount, color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", filterStatus: "approved" },
            { label: "Rejected", value: rejectedCount, color: "#dc2626", bg: "#fef2f2", border: "#fecaca", filterStatus: "rejected" },
          ].map(s => (
            <div
              key={s.label}
              onClick={() => s.value > 0 ? setSearchParams(s.filterStatus ? { status: s.filterStatus } : {}) : undefined}
              style={{
                flex: "1 1 100px",
                minWidth: 100,
                padding: "12px 14px",
                background: s.bg,
                borderRadius: 10,
                border: `1px solid ${s.border}`,
                cursor: s.value > 0 ? "pointer" : "default",
                textAlign: "center",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color, lineHeight: 1, marginBottom: 2, fontVariantNumeric: "tabular-nums" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: s.color, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Search & Filter ── */}
        <div className="app-search-bar">
          <Form method="get" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 260px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Search
              </label>
              <input
                name="query"
                type="text"
                placeholder="Order #, Return ID, AWB, Email, Phone..."
                defaultValue={query}
                className="app-input"
                style={{ maxWidth: "100%", padding: "10px 14px", fontSize: 13 }}
              />
            </div>
            <div style={{ flex: "0 0 170px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Status
              </label>
              <select name="status" defaultValue={status} className="app-select" style={{ maxWidth: "100%", padding: "10px 14px", fontSize: 13 }}>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <s-button type="submit" variant="primary">Search</s-button>
              {(query || status) && (
                <Link to="/app/returns"><s-button variant="secondary">Clear</s-button></Link>
              )}
            </div>
            {totalCount > 0 && (
              <a
                href={`/api/returns/export?${new URLSearchParams({ query, status }).toString()}`}
                target="_blank" rel="noopener noreferrer"
                style={{ textDecoration: "none", marginLeft: "auto" }}
              >
                <s-button variant="secondary">Export CSV</s-button>
              </a>
            )}
          </Form>
        </div>

        {/* ── Count + Active Filter ── */}
        {totalCount > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 2px", flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>
              Showing <strong style={{ color: "var(--rpm-text)" }}>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)}</strong> of <strong style={{ color: "var(--rpm-text)" }}>{totalCount}</strong>
            </span>
            {status && (
              <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: "var(--rpm-accent-subtle)", color: "var(--rpm-accent)", border: "1px solid var(--rpm-accent-light)" }}>
                {status} <Link to={`/app/returns${query ? `?query=${query}` : ""}`} style={{ textDecoration: "none", color: "inherit", marginLeft: 4 }}>×</Link>
              </span>
            )}
          </div>
        )}

        {/* ── Table or Empty ── */}
        {returns.length === 0 ? (
          <div className="app-empty-state" style={{ padding: 48 }}>
            <div style={{ marginBottom: 14 }}><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{opacity:0.4}}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></div>
            <p className="app-empty-state-title" style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>No returns found</p>
            <p className="app-empty-state-desc" style={{ maxWidth: 360, margin: "0 auto 20px" }}>
              {query || status
                ? "No returns match your criteria. Try adjusting your filters."
                : "Returns will appear here when customers submit them via your portal."}
            </p>
            {!query && !status && (
              <Link to="/app/portal" style={{ textDecoration: "none" }}><s-button variant="primary">View Portal</s-button></Link>
            )}
            {(query || status) && (
              <Link to="/app/returns" style={{ textDecoration: "none" }}><s-button variant="secondary">Clear filters</s-button></Link>
            )}
          </div>
        ) : (
          <>
            <div className="app-table-wrapper">
              <div style={{ overflowX: "auto" }}>
                <table className="app-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36, padding: "8px 6px", textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={allSelectableSelected}
                          onChange={toggleSelectAll}
                          disabled={selectableReturns.length === 0}
                          title={allSelectableSelected ? "Deselect all" : "Select all actionable returns"}
                          style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#4f46e5" }}
                        />
                      </th>
                      <th>Return ID</th>
                      <th>Order</th>
                      <th>Status</th>
                      <th className="app-hide-mobile">Fynd Return ID</th>
                      <th className="app-hide-mobile">Customer</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => {
                      const statusBg = getStatusBg(r.status);
                      const fyndRetId = (r as { fyndReturnId?: string | null }).fyndReturnId;
                      const fyndRetNo = (r as { fyndReturnNo?: string | null }).fyndReturnNo;
                      const fyndShipId = (r as { fyndShipmentId?: string | null }).fyndShipmentId;
                      const fyndOrdId = (r as { fyndOrderId?: string | null }).fyndOrderId;
                      const hasFynd = !!(fyndRetId || fyndRetNo || fyndShipId);
                      const isSelectable = selectableIds.has(r.id);
                      const isSelected = selectedIds.has(r.id);
                      return (
                        <tr
                          key={r.id}
                          onClick={() => navigate(`/app/returns/${r.id}`)}
                          style={isSelected ? { background: "rgba(79, 70, 229, 0.06)" } : undefined}
                        >
                          <td style={{ width: 36, padding: "8px 6px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            {isSelectable ? (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelection(r.id)}
                                style={{ width: 16, height: 16, cursor: "pointer", accentColor: "#4f46e5" }}
                              />
                            ) : (
                              <input
                                type="checkbox"
                                disabled
                                title={`Cannot select: return is ${r.status}`}
                                style={{ width: 16, height: 16, opacity: 0.3 }}
                              />
                            )}
                          </td>
                          <td>
                            <Link
                              to={`/app/returns/${r.id}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: "var(--rpm-accent)", fontWeight: 700, textDecoration: "none", fontSize: 12, fontFamily: "var(--rpm-font-mono, monospace)", letterSpacing: "0.01em" }}
                            >
                              {(r as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(r.id)}
                            </Link>
                          </td>
                          <td>
                            <span style={{ fontWeight: 600, color: "var(--rpm-text)", fontSize: 13 }}>
                              {r.shopifyOrderName || "—"}
                            </span>
                            {fyndOrdId && (
                              <div style={{ fontSize: 10, color: "var(--rpm-text-subtle)", marginTop: 2, fontFamily: "var(--rpm-font-mono, monospace)" }}>
                                Fynd: {String(fyndOrdId).slice(0, 16)}{String(fyndOrdId).length > 16 ? "…" : ""}
                              </div>
                            )}
                          </td>
                          <td>
                            <span className="app-status-badge" style={{
                              padding: "4px 10px", borderRadius: 6,
                              fontSize: 11, fontWeight: 700,
                              background: statusBg,
                              color: getStatusColor(r.status),
                              textTransform: "capitalize",
                            }}>
                              <span className="app-status-dot" style={{ background: getStatusColor(r.status) }} />
                              {r.status}
                            </span>
                            {(r as { resolutionType?: string }).resolutionType && (r as { resolutionType?: string }).resolutionType !== "refund" && (
                              <span style={{
                                display: "inline-block", marginLeft: 6, padding: "2px 7px", borderRadius: 4,
                                fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", verticalAlign: "middle",
                                ...({
                                  exchange: { background: "#DCFCE7", color: "#166534" },
                                  store_credit: { background: "#F3E8FF", color: "#6B21A8" },
                                  replacement: { background: "#FFF7ED", color: "#C2410C" },
                                } as Record<string, { background: string; color: string }>)[(r as { resolutionType?: string }).resolutionType!] ?? {},
                              }}>
                                {((r as { resolutionType?: string }).resolutionType!).replace(/_/g, " ")}
                              </span>
                            )}
                            {r.refundStatus && r.refundStatus !== "none" && (
                              <div style={{ fontSize: 10, color: "#7c3aed", marginTop: 3, fontWeight: 600, textTransform: "capitalize" }}>{r.refundStatus}</div>
                            )}
                            {hasFynd && r.status === "approved" && (
                              <div style={{ fontSize: 10, color: "#059669", marginTop: 3, fontWeight: 600 }}>Fynd synced</div>
                            )}
                          </td>
                          <td className="app-hide-mobile">
                            {hasFynd ? (
                              <div>
                                <div style={{ fontSize: 11, color: "var(--rpm-text)", fontFamily: "var(--rpm-font-mono, monospace)", fontWeight: 600 }}>
                                  {fyndRetId || fyndRetNo || fyndShipId}
                                </div>
                                {fyndRetNo && fyndRetId && (
                                  <div style={{ fontSize: 10, color: "var(--rpm-text-muted)", fontFamily: "var(--rpm-font-mono, monospace)", marginTop: 2 }}>
                                    #{fyndRetNo}
                                  </div>
                                )}
                                {r.returnAwb && (
                                  <div style={{ fontSize: 10, color: "var(--rpm-text-muted)", fontFamily: "var(--rpm-font-mono, monospace)", marginTop: 2 }}>
                                    AWB: {r.returnAwb}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span style={{ fontSize: 12, color: "var(--rpm-text-subtle)" }}>—</span>
                            )}
                          </td>
                          <td className="app-hide-mobile">
                            <span style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>
                              {r.customerEmailNorm
                                ? r.customerEmailNorm.length > 24 ? r.customerEmailNorm.slice(0, 24) + "…" : r.customerEmailNorm
                                : "—"}
                            </span>
                          </td>
                          <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                            <span style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>
                              {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" })}
                            </span>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 16, padding: "12px 0" }}>
                <button className="app-pagination-btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>←</button>
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
                <button className="app-pagination-btn" disabled={page >= totalPages} onClick={() => goToPage(page + 1)}>→</button>
              </div>
            )}
          </>
        )}
        {/* Bulk action success/error banner */}
        {bulkSuccess && (
          <div style={{
            padding: "10px 16px", marginTop: 12, borderRadius: 8,
            background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46",
            fontSize: 13, fontWeight: 600,
          }}>
            {bulkSuccess}
          </div>
        )}
        {bulkError && (
          <div style={{
            padding: "10px 16px", marginTop: 12, borderRadius: 8,
            background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b",
            fontSize: 13, fontWeight: 600,
          }}>
            {bulkError}
          </div>
        )}
      </div>

      {/* Floating bulk action bar */}
      <div
        style={{
          position: "fixed",
          bottom: someSelected ? 24 : -80,
          left: "50%",
          transform: "translateX(-50%)",
          background: "#1F2937",
          color: "#fff",
          borderRadius: 12,
          padding: "12px 20px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          boxShadow: "0 8px 32px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.12)",
          zIndex: 1000,
          transition: "bottom 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          whiteSpace: "nowrap",
          maxWidth: "calc(100vw - 48px)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, opacity: 0.95 }}>
          {selectedIds.size} return{selectedIds.size === 1 ? "" : "s"} selected
        </span>
        <div style={{ width: 1, height: 24, background: "rgba(255,255,255,0.2)" }} />
        <button
          onClick={handleBulkApprove}
          disabled={bulkLoading}
          style={{
            padding: "7px 16px", borderRadius: 7, border: "none",
            background: "#059669", color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: bulkLoading ? "wait" : "pointer",
            opacity: bulkLoading ? 0.6 : 1,
            transition: "opacity 0.15s, background 0.15s",
          }}
          onMouseEnter={(e) => { if (!bulkLoading) (e.target as HTMLButtonElement).style.background = "#047857"; }}
          onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "#059669"; }}
        >
          {bulkLoading ? "Processing..." : "Approve Selected"}
        </button>
        <button
          onClick={() => setShowRejectModal(true)}
          disabled={bulkLoading}
          style={{
            padding: "7px 16px", borderRadius: 7, border: "none",
            background: "#dc2626", color: "#fff",
            fontSize: 13, fontWeight: 700, cursor: bulkLoading ? "wait" : "pointer",
            opacity: bulkLoading ? 0.6 : 1,
            transition: "opacity 0.15s, background 0.15s",
          }}
          onMouseEnter={(e) => { if (!bulkLoading) (e.target as HTMLButtonElement).style.background = "#b91c1c"; }}
          onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "#dc2626"; }}
        >
          Reject Selected
        </button>
        <button
          onClick={clearSelection}
          disabled={bulkLoading}
          style={{
            padding: "7px 14px", borderRadius: 7,
            border: "1px solid rgba(255,255,255,0.25)", background: "transparent",
            color: "rgba(255,255,255,0.85)",
            fontSize: 12, fontWeight: 600, cursor: "pointer",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.background = "rgba(255,255,255,0.1)"; }}
          onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.background = "transparent"; }}
        >
          Clear Selection
        </button>
      </div>

      {/* Rejection reason modal */}
      {showRejectModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1100,
            background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => { setShowRejectModal(false); setRejectionReason(""); }}
        >
          <div
            style={{
              background: "#fff", borderRadius: 14, padding: "28px 28px 24px",
              width: "100%", maxWidth: 460,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
              animation: "fadeInScale 0.2s ease-out",
            }}
            onClick={(e) => e.stopPropagation()}
          >
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
                fontFamily: "inherit", outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) => { e.target.style.borderColor = "#6366f1"; e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.15)"; }}
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
                  background: "#fff", color: "#374151", fontSize: 13, fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkRejectConfirm}
                disabled={!rejectionReason.trim()}
                style={{
                  padding: "8px 18px", borderRadius: 7, border: "none",
                  background: rejectionReason.trim() ? "#dc2626" : "#e5e7eb",
                  color: rejectionReason.trim() ? "#fff" : "#9ca3af",
                  fontSize: 13, fontWeight: 700,
                  cursor: rejectionReason.trim() ? "pointer" : "not-allowed",
                  transition: "background 0.15s",
                }}
              >
                Reject All
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes fadeInScale {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </s-page>
  );
}

