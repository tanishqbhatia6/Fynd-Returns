import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { formatReturnRequestId } from "../lib/return-request-id";

type CustomerSummary = {
  email: string;
  phone: string | null;
  returnCount: number;
  totalRefundAmount: number;
  currency: string;
  firstReturnDate: string;
  lastReturnDate: string;
  returns: Array<{
    id: string;
    returnRequestNo: string | null;
    orderName: string;
    status: string;
    createdAt: string;
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const sortBy = url.searchParams.get("sort") ?? "count";

  const where: Record<string, unknown> = { shopId: shop.id };
  if (query) {
    where.OR = [
      { customerEmailNorm: { contains: query, mode: "insensitive" } },
      { customerPhoneNorm: { contains: query, mode: "insensitive" } },
    ];
  }

  const allReturns = await prisma.returnCase.findMany({
    where,
    select: {
      id: true,
      returnRequestNo: true,
      shopifyOrderName: true,
      customerEmailNorm: true,
      customerPhoneNorm: true,
      status: true,
      refundJson: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const grouped = new Map<string, CustomerSummary>();
  for (const r of allReturns) {
    const email = (r.customerEmailNorm || "").toLowerCase().trim();
    if (!email) continue;

    let existing = grouped.get(email);
    if (!existing) {
      existing = {
        email,
        phone: r.customerPhoneNorm,
        returnCount: 0,
        totalRefundAmount: 0,
        currency: "",
        firstReturnDate: r.createdAt.toISOString(),
        lastReturnDate: r.createdAt.toISOString(),
        returns: [],
      };
      grouped.set(email, existing);
    }

    existing.returnCount++;
    if (!existing.phone && r.customerPhoneNorm) existing.phone = r.customerPhoneNorm;

    const d = r.createdAt.toISOString();
    if (d < existing.firstReturnDate) existing.firstReturnDate = d;
    if (d > existing.lastReturnDate) existing.lastReturnDate = d;

    if (r.refundJson) {
      try {
        const refund = JSON.parse(r.refundJson) as { amount?: string; currency?: string };
        if (refund.amount) existing.totalRefundAmount += parseFloat(refund.amount) || 0;
        if (refund.currency && !existing.currency) existing.currency = refund.currency;
      } catch { /* ignore */ }
    }

    existing.returns.push({
      id: r.id,
      returnRequestNo: r.returnRequestNo,
      orderName: r.shopifyOrderName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    });
  }

  let customers = Array.from(grouped.values());

  if (sortBy === "amount") {
    customers.sort((a, b) => b.totalRefundAmount - a.totalRefundAmount);
  } else if (sortBy === "recent") {
    customers.sort((a, b) => new Date(b.lastReturnDate).getTime() - new Date(a.lastReturnDate).getTime());
  } else {
    customers.sort((a, b) => b.returnCount - a.returnCount);
  }

  return { customers, query, sortBy };
};

function formatMoney(amount: number): string {
  return amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CustomersPage() {
  const { customers, query, sortBy } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const C = {
    card: { padding: 20, background: "#fff", borderRadius: 12, border: "1px solid #e3e5e7", marginBottom: 16 } as const,
    label: { fontSize: 11, color: "#6d7175", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" } as const,
  };

  return (
    <s-page heading="Customers">
      <div className="app-content">
        <div style={{ ...C.card, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <input
              type="text"
              placeholder="Search by email or phone..."
              defaultValue={query}
              className="app-input"
              style={{ width: "100%", fontSize: 13 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const val = (e.target as HTMLInputElement).value.trim();
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    if (val) next.set("q", val);
                    else next.delete("q");
                    return next;
                  });
                }
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["count", "amount", "recent"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  next.set("sort", s);
                  return next;
                })}
                style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: sortBy === s ? "1px solid #2563EB" : "1px solid #E5E7EB",
                  background: sortBy === s ? "#EFF6FF" : "#fff",
                  color: sortBy === s ? "#2563EB" : "#6B7280",
                }}
              >
                {s === "count" ? "Most Returns" : s === "amount" ? "Highest Refund" : "Most Recent"}
              </button>
            ))}
          </div>
        </div>

        {customers.length === 0 ? (
          <div style={{ ...C.card, padding: 40, textAlign: "center", color: "#9CA3AF" }}>
            {query ? `No customers found matching "${query}"` : "No return data yet"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 0.8fr 1fr 1fr 1fr", gap: 0, padding: "10px 20px", background: "#F9FAFB", borderRadius: "12px 12px 0 0", border: "1px solid #e3e5e7", borderBottom: "none" }}>
              <div style={C.label}>Email</div>
              <div style={C.label}>Phone</div>
              <div style={C.label}>Returns</div>
              <div style={C.label}>Total Refunded</div>
              <div style={C.label}>First Return</div>
              <div style={C.label}>Last Return</div>
            </div>
            {customers.map((cust, idx) => (
              <details key={cust.email} style={{ border: "1px solid #e3e5e7", borderTop: idx === 0 ? "1px solid #e3e5e7" : "none", background: "#fff", ...(idx === customers.length - 1 ? { borderRadius: "0 0 12px 12px" } : {}) }}>
                <summary style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 0.8fr 1fr 1fr 1fr", gap: 0, padding: "14px 20px", cursor: "pointer", alignItems: "center", listStyle: "none" }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cust.email}</div>
                  <div style={{ fontSize: 13, color: "#6B7280" }}>{cust.phone || "—"}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{cust.returnCount}</span>
                    {cust.returnCount >= 3 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: "#FEE2E2", color: "#DC2626", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Serial
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    {cust.totalRefundAmount > 0 ? `${formatMoney(cust.totalRefundAmount)}${cust.currency ? ` ${cust.currency}` : ""}` : "—"}
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>{new Date(cust.firstReturnDate).toLocaleDateString()}</div>
                  <div style={{ fontSize: 12, color: "#6B7280" }}>{new Date(cust.lastReturnDate).toLocaleDateString()}</div>
                </summary>
                <div style={{ padding: "0 20px 16px", borderTop: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 8, marginTop: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>Return History</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {cust.returns.map((r) => (
                      <Link key={r.id} to={`/app/returns/${r.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#F9FAFB", borderRadius: 8, textDecoration: "none", color: "inherit", border: "1px solid #F3F4F6" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "monospace", color: "#374151" }}>
                            {r.returnRequestNo || formatReturnRequestId(r.id)}
                          </span>
                          <span style={{ fontSize: 12, color: "#6B7280" }}>Order {r.orderName || "—"}</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase",
                            background: r.status === "approved" ? "#F0FDF4" : r.status === "rejected" ? "#FEF2F2" : r.status === "completed" ? "#EFF6FF" : "#FFF7ED",
                            color: r.status === "approved" ? "#15803D" : r.status === "rejected" ? "#DC2626" : r.status === "completed" ? "#1D4ED8" : "#C2410C",
                          }}>
                            {r.status}
                          </span>
                          <span style={{ fontSize: 11, color: "#9CA3AF" }}>{new Date(r.createdAt).toLocaleDateString()}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </s-page>
  );
}
