import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    let shop = await prisma.shop.findUnique({
      where: { shopDomain: session.shop },
    });
    if (!shop) {
      shop = await prisma.shop.create({
        data: { shopDomain: session.shop },
      });
    }

    const now = new Date();
    const periods = {
      last7: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      last30: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      last90: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    };

    const [total, byPeriod, byStatus, byReason, refundedCount] = await Promise.all([
      prisma.returnCase.count({ where: { shopId: shop.id } }),
      Promise.all([
        prisma.returnCase.count({ where: { shopId: shop.id, createdAt: { gte: periods.last7 } } }),
        prisma.returnCase.count({ where: { shopId: shop.id, createdAt: { gte: periods.last30 } } }),
        prisma.returnCase.count({ where: { shopId: shop.id, createdAt: { gte: periods.last90 } } }),
      ]),
      prisma.returnCase.groupBy({
        by: ["status"],
        where: { shopId: shop.id },
        _count: true,
      }),
      prisma.returnItem.groupBy({
        by: ["reasonCode"],
        where: { returnCase: { shopId: shop.id } },
        _count: true,
      }),
      prisma.returnCase.count({ where: { shopId: shop.id, refundStatus: "refunded" } }),
    ]);

    const statusBreakdown = byStatus.reduce((acc, x) => ({ ...acc, [x.status]: x._count }), {} as Record<string, number>);
    const reasonBreakdown = byReason
      .filter((r) => r.reasonCode && r.reasonCode.trim() !== "")
      .map((r) => ({ reason: r.reasonCode!, count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      total,
      last7: byPeriod[0],
      last30: byPeriod[1],
      last90: byPeriod[2],
      refundedCount,
      statusBreakdown,
      reasonBreakdown,
      error: null,
    };
  } catch (err) {
    console.error("Reports loader error:", err);
    return {
      total: 0,
      last7: 0,
      last30: 0,
      last90: 0,
      refundedCount: 0,
      statusBreakdown: {} as Record<string, number>,
      reasonBreakdown: [] as { reason: string; count: number }[],
      error: "Failed to load reports",
    };
  }
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#b98900", processing: "#005bd3", "in progress": "#005bd3",
  approved: "#008060", completed: "#008060", rejected: "#d72c0d",
  cancelled: "#6d7175", initiated: "#b98900",
};
function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#6d7175";
}

export default function Reports() {
  const { total, last7, last30, last90, refundedCount, statusBreakdown, reasonBreakdown, error } =
    useLoaderData<typeof loader>();

  const cardStyle = {
    padding: 20,
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #e1e3e5",
    boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
  };

  return (
    <s-page heading="Reports">
      {error && (
        <div style={{ ...cardStyle, marginBottom: 24, borderColor: "#d72c0d", background: "#fef2f2" }}>
          <p style={{ color: "#d72c0d" }}>{error}</p>
        </div>
      )}

      <s-section heading="Overview">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 16 }}>
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Total returns</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{total}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Last 7 days</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{last7}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Last 30 days</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{last30}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Last 90 days</div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{last90}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Refunded</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#008060" }}>{refundedCount}</div>
          </div>
        </div>
      </s-section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
        <s-section heading="By status">
          {Object.keys(statusBreakdown).length === 0 ? (
            <p style={{ color: "#6d7175" }}>No data yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {Object.entries(statusBreakdown)
                .sort(([, a], [, b]) => b - a)
                .map(([status, count]) => (
                  <div key={status}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 14 }}>
                      <span style={{ fontWeight: 500 }}>{status}</span>
                      <span style={{ color: "#6d7175" }}>{count}</span>
                    </div>
                    <div style={{ height: 8, background: "#f1f2f4", borderRadius: 4, overflow: "hidden" }}>
                      <div
                        style={{
                          width: `${(count / Math.max(...Object.values(statusBreakdown), 1)) * 100}%`,
                          height: "100%",
                          background: getStatusColor(status),
                          borderRadius: 4,
                          minWidth: count > 0 ? 4 : 0,
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </s-section>

        <s-section heading="By reason">
          {reasonBreakdown.length === 0 ? (
            <p style={{ color: "#6d7175" }}>No data yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {reasonBreakdown.map(({ reason, count }) => (
                <div key={reason} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{reason}</span>
                  <span style={{ fontWeight: 600 }}>{count}</span>
                </div>
              ))}
            </div>
          )}
        </s-section>
      </div>

      <s-section heading="Quick links">
        <Link to="/app/returns">
          <s-button variant="primary">View returns</s-button>
        </Link>
      </s-section>
    </s-page>
  );
}
