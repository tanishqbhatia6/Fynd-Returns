import type { LoaderFunctionArgs } from "react-router";
import { Form, Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_COLORS: Record<string, string> = {
  pending: "#b98900", processing: "#005bd3", "in progress": "#005bd3",
  approved: "#008060", completed: "#008060", rejected: "#d72c0d",
  cancelled: "#6d7175", initiated: "#b98900",
};
function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#6d7175";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") || "";
  const status = url.searchParams.get("status") || "";

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
    where.OR = [
      { shopifyOrderName: { contains: query.trim(), mode: "insensitive" } },
      { fyndOrderId: { contains: query.trim(), mode: "insensitive" } },
      { forwardAwb: { contains: query.trim(), mode: "insensitive" } },
      { returnAwb: { contains: query.trim(), mode: "insensitive" } },
      { fyndReturnNo: { contains: query.trim(), mode: "insensitive" } },
      { customerEmailNorm: { contains: query.trim(), mode: "insensitive" } },
      { customerPhoneNorm: { contains: query.trim(), mode: "insensitive" } },
    ];
  }

  let returns: Awaited<
    ReturnType<typeof prisma.returnCase.findMany<{ include: object }>>
  > = [];
  try {
    returns = await prisma.returnCase.findMany({
      where,
      include: {
        items: true,
        events: { orderBy: { happenedAt: "desc" }, take: 5 },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  } catch (err) {
    console.error("Returns loader error:", err);
    return { returns: [], query, status, error: "Failed to load returns. Please try again." };
  }

  return { returns, query, status, error: null };
};

export default function ReturnsList() {
  const { returns, query, status, error } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();

  return (
    <s-page heading="Returns">
      <div className="app-content">
      {error && (
        <s-section>
          <p style={{ color: "#d72c0d", marginBottom: 16 }}>{error}</p>
          <p style={{ color: "#6d7175", fontSize: 14 }}>Please try again or contact support if the issue persists.</p>
        </s-section>
      )}
      <s-section heading="Search & filter">
        <Form method="get" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, alignItems: "flex-end" }}>
          <s-text-field
            name="query"
            label="Search"
            placeholder="Order #, AWB, Return #, Email, Phone"
            defaultValue={query}
          />
          <s-text-field
            name="status"
            label="Status"
            placeholder="Status filter"
            defaultValue={status}
          />
          <s-button type="submit">Apply</s-button>
          {(query || status) && (
            <Link to="/app/returns">
              <s-button variant="secondary">Clear</s-button>
            </Link>
          )}
          {returns.length > 0 && (
            <a
              href={`/api/returns/export?${new URLSearchParams({ query, status }).toString()}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: "none" }}
            >
              <s-button variant="secondary">Export CSV</s-button>
            </a>
          )}
        </Form>
      </s-section>

      <s-section heading="Returns list">
        {returns.length === 0 ? (
          <div
            style={{
              padding: 56,
              textAlign: "center",
              background: "linear-gradient(180deg, var(--rpm-surface-subtle) 0%, var(--rpm-surface-elevated) 100%)",
              borderRadius: "var(--rpm-radius-xl)",
              border: "2px dashed var(--rpm-border-strong)",
              boxShadow: "var(--rpm-shadow-sm)",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.4 }}>📦</div>
            <p style={{ fontSize: 20, fontWeight: 600, marginBottom: 10, color: "var(--rpm-text)", letterSpacing: "-0.02em" }}>
              No returns yet
            </p>
            <p style={{ color: "var(--rpm-text-muted)", marginBottom: 24, maxWidth: 420, margin: "0 auto 24px", lineHeight: 1.6 }}>
              Returns will appear here when customers initiate them via the customer portal.
              Share your portal URL with customers to get started.
            </p>
            <Link to="/app/portal" style={{ textDecoration: "none" }}>
              <s-button variant="primary">View Customer Portal URL</s-button>
            </Link>
          </div>
        ) : (
          <s-data-table>
            <table className="app-table" style={{ width: "100%", borderCollapse: "collapse", borderRadius: "var(--rpm-radius-lg)", overflow: "hidden", boxShadow: "var(--rpm-shadow-sm)" }}>
              <thead>
                <tr style={{ background: "var(--rpm-surface-elevated)", borderBottom: "var(--rpm-border)" }}>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Order</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Fynd Order ID</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Fynd Return #</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Forward AWB</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Return AWB</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Status</th>
                  <th style={{ padding: "14px 18px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "var(--rpm-border)", background: "var(--rpm-surface)" }}>
                    <td style={{ padding: "14px 18px" }}>
                      <Link to={`/app/returns/${r.id}`} className="app-link">
                        {r.shopifyOrderName || r.id}
                      </Link>
                    </td>
                    <td style={{ padding: "14px 18px", color: "var(--rpm-text-muted)", fontFamily: "monospace", fontSize: 13 }}>
                      {(r as { fyndOrderId?: string | null }).fyndOrderId || (r.shopifyOrderName ?? "").replace(/^#/, "").trim() || "—"}
                    </td>
                    <td style={{ padding: "14px 18px", color: "var(--rpm-text-muted)" }}>{r.fyndReturnNo || "—"}</td>
                    <td style={{ padding: "14px 18px", color: "var(--rpm-text-muted)" }}>{r.forwardAwb || "—"}</td>
                    <td style={{ padding: "14px 18px", color: "var(--rpm-text-muted)" }}>{r.returnAwb || "—"}</td>
                    <td style={{ padding: "14px 18px" }}>
                      <span
                        className="app-status-badge"
                        style={{
                          padding: "5px 12px",
                          borderRadius: 20,
                          fontSize: 12,
                          fontWeight: 600,
                          background: `${getStatusColor(r.status)}18`,
                          color: getStatusColor(r.status),
                          border: `1px solid ${getStatusColor(r.status)}40`,
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "14px 18px", color: "var(--rpm-text-muted)", fontSize: 13 }}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-data-table>
        )}
      </s-section>
      </div>
    </s-page>
  );
}
