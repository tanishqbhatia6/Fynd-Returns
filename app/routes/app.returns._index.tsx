import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatReturnRequestId } from "../lib/return-request-id";

const STATUS_COLORS: Record<string, string> = {
  pending: "#d97706",
  processing: "#3b82f6",
  "in progress": "#3b82f6",
  approved: "#059669",
  completed: "#059669",
  rejected: "#dc2626",
  cancelled: "#64748b",
  initiated: "#f59e0b",
};

const STATUS_BG: Record<string, string> = {
  pending: "#fffbeb",
  processing: "#eff6ff",
  "in progress": "#eff6ff",
  approved: "#ecfdf5",
  completed: "#ecfdf5",
  rejected: "#fef2f2",
  cancelled: "#f8fafc",
  initiated: "#fffbeb",
};

function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#64748b";
}

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

  const goToPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", String(p));
    setSearchParams(next);
  };

  const inProgressCount = Math.max(0, allCount - pendingCount - approvedCount - rejectedCount);

  return (
    <s-page heading="Returns">
      <div className="app-content">
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 16 }}>
            <span>⚠️</span>
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
        <div style={{
          padding: "14px 16px",
          background: "var(--rpm-surface)",
          borderRadius: 12,
          border: "var(--rpm-border)",
          marginBottom: 16,
        }}>
          <Form method="get" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 220px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Search
              </label>
              <input
                name="query"
                type="text"
                placeholder="Order #, Return ID, AWB, Email..."
                defaultValue={query}
                className="app-input"
                style={{ maxWidth: "100%", padding: "8px 12px", fontSize: 13 }}
              />
            </div>
            <div style={{ flex: "0 0 160px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                Status
              </label>
              <select name="status" defaultValue={status} className="app-select" style={{ maxWidth: "100%", padding: "8px 12px", fontSize: 13 }}>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
                <s-button variant="secondary">📥 CSV</s-button>
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
            <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.4 }}>📦</div>
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
            {/* Card-wrapped table */}
            <div style={{
              background: "var(--rpm-surface)",
              borderRadius: 12,
              border: "var(--rpm-border)",
              overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
                      <th style={thStyle}>Return ID</th>
                      <th style={thStyle}>Order</th>
                      <th style={thStyle}>Status</th>
                      <th style={{ ...thStyle }} className="app-hide-mobile">Return AWB</th>
                      <th style={{ ...thStyle }} className="app-hide-mobile">Customer</th>
                      <th style={thStyle}>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map((r, i) => {
                      const statusBg = STATUS_BG[r.status.toLowerCase()] ?? "#f8fafc";
                      return (
                        <tr
                          key={r.id}
                          onClick={() => navigate(`/app/returns/${r.id}`)}
                          style={{
                            borderBottom: "1px solid #f1f5f9",
                            cursor: "pointer",
                            transition: "background 0.12s",
                            background: i % 2 === 1 ? "#fafbfc" : "white",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "#eef4ff")}
                          onMouseLeave={(e) => (e.currentTarget.style.background = i % 2 === 1 ? "#fafbfc" : "white")}
                        >
                          <td style={tdStyle}>
                            <Link
                              to={`/app/returns/${r.id}`}
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: "var(--rpm-accent)", fontWeight: 700, textDecoration: "none", fontSize: 12, fontFamily: "var(--rpm-font-mono, monospace)", letterSpacing: "0.01em" }}
                            >
                              {(r as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(r.id)}
                            </Link>
                          </td>
                          <td style={tdStyle}>
                            <span style={{ fontWeight: 600, color: "var(--rpm-text)", fontSize: 13 }}>
                              {r.shopifyOrderName || "—"}
                            </span>
                            {(r as { fyndOrderId?: string | null }).fyndOrderId && (
                              <div style={{ fontSize: 10, color: "var(--rpm-text-subtle)", marginTop: 1, fontFamily: "var(--rpm-font-mono, monospace)" }}>
                                Fynd: {String((r as { fyndOrderId: string }).fyndOrderId).slice(0, 16)}{String((r as { fyndOrderId: string }).fyndOrderId).length > 16 ? "…" : ""}
                              </div>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              display: "inline-flex", alignItems: "center", gap: 5,
                              padding: "4px 10px", borderRadius: 6,
                              fontSize: 11, fontWeight: 700,
                              background: statusBg,
                              color: getStatusColor(r.status),
                              textTransform: "capitalize",
                              whiteSpace: "nowrap",
                            }}>
                              <span style={{ width: 6, height: 6, borderRadius: "50%", background: getStatusColor(r.status), flexShrink: 0 }} />
                              {r.status}
                            </span>
                            {r.refundStatus && r.refundStatus !== "none" && (
                              <div style={{ fontSize: 10, color: "#7c3aed", marginTop: 2 }}>💰 {r.refundStatus}</div>
                            )}
                          </td>
                          <td style={tdStyle} className="app-hide-mobile">
                            <span style={{ fontSize: 12, color: r.returnAwb ? "var(--rpm-text)" : "var(--rpm-text-subtle)" }}>
                              {r.returnAwb || "—"}
                            </span>
                            {(r as { fyndShipmentId?: string | null }).fyndShipmentId && !r.returnAwb && (
                              <div style={{ fontSize: 10, color: "var(--rpm-text-subtle)", fontFamily: "var(--rpm-font-mono, monospace)" }}>
                                Fynd #{String((r as { fyndShipmentId: string }).fyndShipmentId).slice(0, 14)}
                              </div>
                            )}
                          </td>
                          <td style={tdStyle} className="app-hide-mobile">
                            <span style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>
                              {r.customerEmailNorm
                                ? r.customerEmailNorm.length > 20 ? r.customerEmailNorm.slice(0, 20) + "…" : r.customerEmailNorm
                                : "—"}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
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
      </div>
    </s-page>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontWeight: 700,
  fontSize: 10,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  background: "#f8fafc",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
};
