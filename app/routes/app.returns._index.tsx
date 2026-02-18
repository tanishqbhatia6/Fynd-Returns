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
              padding: 48,
              textAlign: "center",
              background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
              borderRadius: 8,
              border: "1px dashed var(--p-color-border-secondary, #e1e3e5)",
            }}
          >
            <p style={{ fontSize: 18, fontWeight: 500, marginBottom: 8 }}>
              No returns available yet
            </p>
            <p style={{ color: "#6d7175", marginBottom: 16, maxWidth: 400, margin: "0 auto 16px" }}>
              Returns will appear here when customers initiate them via the customer portal.
              Share your portal URL with customers to get started.
            </p>
            <Link to="/app/portal">
              <s-button variant="primary">View Customer Portal URL</s-button>
            </Link>
          </div>
        ) : (
          <s-data-table>
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Return #</th>
                  <th>Forward AWB</th>
                  <th>Return AWB</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f1f2f4" }}>
                    <td style={{ padding: "12px 16px" }}>
                      <Link to={`/app/returns/${r.id}`} style={{ color: "#005bd3", textDecoration: "none", fontWeight: 500 }}>
                        {r.shopifyOrderName || r.id}
                      </Link>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{r.fyndReturnNo || "—"}</td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{r.forwardAwb || "—"}</td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{r.returnAwb || "—"}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: 500,
                          background: `${getStatusColor(r.status)}20`,
                          color: getStatusColor(r.status),
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-data-table>
        )}
      </s-section>
    </s-page>
  );
}
