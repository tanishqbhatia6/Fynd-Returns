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
function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#64748b";
}

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  processing: "🔄",
  "in progress": "🔄",
  approved: "✅",
  completed: "✅",
  rejected: "❌",
  cancelled: "🚫",
  initiated: "📝",
};

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "initiated", label: "📝 Initiated" },
  { value: "pending", label: "⏳ Pending" },
  { value: "processing", label: "🔄 Processing" },
  { value: "approved", label: "✅ Approved" },
  { value: "completed", label: "✅ Completed" },
  { value: "rejected", label: "❌ Rejected" },
  { value: "cancelled", label: "🚫 Cancelled" },
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
          events: { orderBy: { happenedAt: "desc" }, take: 3 },
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

  const processingCount = allCount - pendingCount - approvedCount - rejectedCount;

  return (
    <s-page heading="Returns">
      <div className="app-content">
        {error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
            <span>⚠️</span>
            <div>
              <p style={{ fontWeight: 600, marginBottom: 4 }}>{error}</p>
              <p style={{ fontSize: 13, opacity: 0.85 }}>Try refreshing the page or contact support if the issue persists.</p>
            </div>
          </div>
        )}

        {/* ── Summary Stats ── */}
        <div className="app-stats-row">
          <div className="app-stat-pill">
            <span className="app-stat-pill-value" style={{ color: "#3b82f6" }}>{allCount}</span>
            <span className="app-stat-pill-label">Total</span>
          </div>
          <div className="app-stat-pill" style={{ cursor: pendingCount > 0 ? "pointer" : "default" }} onClick={() => pendingCount > 0 && setSearchParams({ status: "pending" })}>
            <span className="app-stat-pill-value" style={{ color: "#d97706" }}>{pendingCount}</span>
            <span className="app-stat-pill-label">Pending</span>
          </div>
          <div className="app-stat-pill" style={{ cursor: processingCount > 0 ? "pointer" : "default" }} onClick={() => processingCount > 0 && setSearchParams({ status: "processing" })}>
            <span className="app-stat-pill-value" style={{ color: "#3b82f6" }}>{processingCount > 0 ? processingCount : 0}</span>
            <span className="app-stat-pill-label">In Progress</span>
          </div>
          <div className="app-stat-pill" style={{ cursor: approvedCount > 0 ? "pointer" : "default" }} onClick={() => approvedCount > 0 && setSearchParams({ status: "approved" })}>
            <span className="app-stat-pill-value" style={{ color: "#059669" }}>{approvedCount}</span>
            <span className="app-stat-pill-label">Approved</span>
          </div>
          <div className="app-stat-pill" style={{ cursor: rejectedCount > 0 ? "pointer" : "default" }} onClick={() => rejectedCount > 0 && setSearchParams({ status: "rejected" })}>
            <span className="app-stat-pill-value" style={{ color: "#dc2626" }}>{rejectedCount}</span>
            <span className="app-stat-pill-label">Rejected</span>
          </div>
        </div>

        {/* ── Search & Filter Bar ── */}
        <div className="app-search-bar">
          <Form method="get" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 320px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                🔍 Search
              </label>
              <input
                name="query"
                type="text"
                placeholder="Order #, Return ID, AWB, Email, Phone..."
                defaultValue={query}
                className="app-input"
                style={{ maxWidth: "100%", fontSize: 14 }}
              />
            </div>
            <div style={{ flex: "0 0 200px" }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--rpm-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Status
              </label>
              <select name="status" defaultValue={status} className="app-select" style={{ maxWidth: "100%" }}>
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <s-button type="submit" variant="primary">Search</s-button>
              {(query || status) && (
                <Link to="/app/returns">
                  <s-button variant="secondary">Clear</s-button>
                </Link>
              )}
            </div>
            {totalCount > 0 && (
              <a
                href={`/api/returns/export?${new URLSearchParams({ query, status }).toString()}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none", marginLeft: "auto" }}
              >
                <s-button variant="secondary">📥 Export CSV</s-button>
              </a>
            )}
          </Form>
        </div>

        {/* ── Results Summary ── */}
        {totalCount > 0 && (
          <div className="app-results-bar">
            <span style={{ fontSize: 13, color: "var(--rpm-text-muted)" }}>
              Showing <strong style={{ color: "var(--rpm-text)", fontWeight: 700 }}>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalCount)}</strong> of{" "}
              <strong style={{ color: "var(--rpm-text)", fontWeight: 700 }}>{totalCount}</strong> returns
            </span>
            {status && (
              <span className="app-chip">
                {STATUS_ICONS[status] || "📋"} {status}
                <Link to={`/app/returns${query ? `?query=${query}` : ""}`} className="app-chip-remove" title="Clear status filter">×</Link>
              </span>
            )}
          </div>
        )}

        {/* ── Returns Table or Empty State ── */}
        {returns.length === 0 ? (
          <div className="app-empty-state">
            <div style={{ fontSize: 56, marginBottom: 16, opacity: 0.4 }}>📦</div>
            <p className="app-empty-state-title">No returns found</p>
            <p className="app-empty-state-desc" style={{ maxWidth: 400, margin: "0 auto 24px" }}>
              {query || status
                ? "No returns match your search criteria. Try adjusting your filters or clearing them."
                : "Returns will appear here when customers submit them via your portal. Share your portal URL to get started."}
            </p>
            {!query && !status && (
              <Link to="/app/portal" style={{ textDecoration: "none" }}>
                <s-button variant="primary">🌐 View Customer Portal</s-button>
              </Link>
            )}
            {(query || status) && (
              <Link to="/app/returns" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">Clear all filters</s-button>
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="app-table-wrapper">
              <div className="app-table-responsive">
                <table className="app-table">
                  <thead>
                    <tr>
                      <th>Return ID</th>
                      <th>Order</th>
                      <th className="app-hide-mobile">Fynd Order</th>
                      <th className="app-hide-mobile">Forward AWB</th>
                      <th className="app-hide-mobile">Return AWB</th>
                      <th>Status</th>
                      <th className="app-hide-mobile">Email</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr
                        key={r.id}
                        onClick={() => navigate(`/app/returns/${r.id}`)}
                        style={{ cursor: "pointer" }}
                      >
                        <td>
                          <Link
                            to={`/app/returns/${r.id}`}
                            className="app-link"
                            style={{ fontFamily: "var(--rpm-font-mono)", fontSize: 12.5, fontWeight: 700, letterSpacing: "0.02em" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(r as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(r.id)}
                          </Link>
                        </td>
                        <td>
                          <span style={{ fontWeight: 600, color: "var(--rpm-text)", fontSize: 13.5 }}>
                            {r.shopifyOrderName || "—"}
                          </span>
                        </td>
                        <td className="app-hide-mobile" style={{ fontFamily: "var(--rpm-font-mono)", fontSize: 12, color: "var(--rpm-text-subtle)" }}>
                          {(r as { fyndOrderId?: string | null }).fyndOrderId
                            ? String((r as { fyndOrderId: string }).fyndOrderId).length > 18
                              ? String((r as { fyndOrderId: string }).fyndOrderId).slice(0, 18) + "…"
                              : (r as { fyndOrderId: string }).fyndOrderId
                            : "—"}
                        </td>
                        <td className="app-hide-mobile" style={{ fontSize: 13, color: "var(--rpm-text-muted)" }}>{r.forwardAwb || "—"}</td>
                        <td className="app-hide-mobile" style={{ fontSize: 13, color: "var(--rpm-text-muted)" }}>{r.returnAwb || "—"}</td>
                        <td>
                          <span
                            className="app-status-badge"
                            style={{
                              background: `${getStatusColor(r.status)}14`,
                              color: getStatusColor(r.status),
                              border: `1px solid ${getStatusColor(r.status)}35`,
                            }}
                          >
                            <span className="app-status-dot" style={{ background: getStatusColor(r.status) }} />
                            {r.status}
                          </span>
                        </td>
                        <td className="app-hide-mobile" style={{ color: "var(--rpm-text-muted)", fontSize: 13 }}>
                          {r.customerEmailNorm
                            ? r.customerEmailNorm.length > 22
                              ? r.customerEmailNorm.slice(0, 22) + "…"
                              : r.customerEmailNorm
                            : "—"}
                        </td>
                        <td style={{ color: "var(--rpm-text-muted)", fontSize: 13, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {new Date(r.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Pagination ── */}
            {totalPages > 1 && (
              <div className="app-pagination">
                <button
                  className="app-pagination-btn"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  ← Prev
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p: number;
                  if (totalPages <= 7) {
                    p = i + 1;
                  } else if (page <= 4) {
                    p = i + 1;
                  } else if (page >= totalPages - 3) {
                    p = totalPages - 6 + i;
                  } else {
                    p = page - 3 + i;
                  }
                  return (
                    <button
                      key={p}
                      className={`app-pagination-btn ${p === page ? "active" : ""}`}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  );
                })}
                <button
                  className="app-pagination-btn"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </s-page>
  );
}
